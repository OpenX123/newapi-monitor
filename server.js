require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const express = require('express');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ==================== 环境变量配置 ====================
const CONFIG = {
  baseUrl: process.env.NEWAPI_BASE_URL,
  token: process.env.NEWAPI_ACCESS_TOKEN,
  userId: process.env.NEWAPI_USER_ID || '1',
  dailyLimit: parseInt(process.env.DAILY_LIMIT) || 2000,
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 300000,
  port: parseInt(process.env.PORT) || 3456,
  notifyEmail: process.env.SMTP_USER || '',
};
let pollTimer = null;

// ==================== 邮件配置 ====================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.qq.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ==================== PostgreSQL ====================
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  // logs 表由 NewAPI 自动创建维护，这里只创建监控辅助表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitor_actions (
      id SERIAL PRIMARY KEY,
      token_id INTEGER,
      token_name TEXT,
      username TEXT,
      action TEXT,
      reason TEXT,
      daily_count INTEGER,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    );

    CREATE TABLE IF NOT EXISTS monitor_whitelist (
      token_id INTEGER PRIMARY KEY,
      token_name TEXT,
      note TEXT,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    );

    CREATE TABLE IF NOT EXISTS monitor_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// kv 存储
async function getKV(key, def = '0') {
  const { rows } = await pool.query('SELECT value FROM monitor_kv WHERE key=$1', [key]);
  return rows.length > 0 ? rows[0].value : def;
}
async function setKV(key, value) {
  await pool.query('INSERT INTO monitor_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(value)]);
}

// 启动时从 kv 加载持久化配置
async function loadSavedConfig() {
  const { rows } = await pool.query("SELECT key, value FROM monitor_kv WHERE key IN ('dailyLimit', 'pollInterval', 'notifyEmail')");
  for (const row of rows) {
    if (row.key === 'dailyLimit') CONFIG.dailyLimit = parseInt(row.value);
    if (row.key === 'pollInterval') CONFIG.pollInterval = parseInt(row.value);
    if (row.key === 'notifyEmail') CONFIG.notifyEmail = row.value;
  }
}

// ==================== one-api 请求封装 ====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function apiRequest(urlPath, method = 'GET', body = null, userId = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, CONFIG.baseUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'New-Api-User': String(userId || CONFIG.userId),
        'Content-Type': 'application/json',
      },
    };
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ==================== 直接从 PostgreSQL logs 表聚合 ====================
function getRangeTs(range) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === '3d') return Math.floor(todayStart.getTime() / 1000) - 2 * 86400;
  if (range === '7d') return Math.floor(todayStart.getTime() / 1000) - 6 * 86400;
  if (range === '30d') return Math.floor(todayStart.getTime() / 1000) - 29 * 86400;
  return Math.floor(todayStart.getTime() / 1000);
}

async function getTodayAggregation() {
  const ts = getRangeTs('today');
  const totalRes = await pool.query('SELECT COUNT(*) as cnt FROM logs WHERE created_at >= $1', [ts]);
  const total = parseInt(totalRes.rows[0].cnt);
  const tokensRes = await pool.query(`
    SELECT token_id, token_name, username, user_id,
      COUNT(*) as count, SUM(quota) as quota,
      SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens
    FROM logs WHERE created_at >= $1 GROUP BY token_id, token_name, username, user_id ORDER BY count DESC
  `, [ts]);
  const tokens = tokensRes.rows.map(r => ({
    ...r,
    count: parseInt(r.count),
    quota: parseInt(r.quota) || 0,
    prompt_tokens: parseInt(r.prompt_tokens) || 0,
    completion_tokens: parseInt(r.completion_tokens) || 0,
  }));

  for (const t of tokens) {
    const modelRes = await pool.query(`
      SELECT model_name, COUNT(*) as cnt FROM logs
      WHERE created_at >= $1 AND token_id = $2 GROUP BY model_name ORDER BY cnt DESC LIMIT 3
    `, [ts, t.token_id]);
    t.models = {};
    for (const m of modelRes.rows) t.models[m.model_name] = parseInt(m.cnt);
  }
  return { tokens, total };
}

async function getAggregation(range, dimension) {
  const ts = getRangeTs(range);
  const dims = {
    token: { group: 'token_id, token_name, username, user_id', select: 'token_id, token_name, username, user_id' },
    user:  { group: 'username', select: 'username, COUNT(DISTINCT token_id) as token_count' },
    model: { group: 'model_name', select: 'model_name' },
    group: { group: '"group"', select: '"group" as grp' },
    channel: { group: 'channel_id, channel_name', select: 'channel_id as channel, channel_name' },
  };
  const d = dims[dimension] || dims.token;
  const result = await pool.query(`
    SELECT ${d.select}, COUNT(*) as count, SUM(quota) as quota,
      SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens
    FROM logs WHERE created_at >= $1 GROUP BY ${d.group} ORDER BY count DESC
  `, [ts]);
  const rows = result.rows.map(r => ({
    ...r,
    count: parseInt(r.count),
    quota: parseInt(r.quota) || 0,
    prompt_tokens: parseInt(r.prompt_tokens) || 0,
    completion_tokens: parseInt(r.completion_tokens) || 0,
  }));
  const totalRes = await pool.query('SELECT COUNT(*) as cnt FROM logs WHERE created_at >= $1', [ts]);
  const total = parseInt(totalRes.rows[0].cnt);
  return { rows, total };
}

async function getHourlyTrend(range) {
  const ts = getRangeTs(range);
  const labelExpr = range === 'today'
    ? "LPAD(EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE 'Asia/Shanghai')::TEXT, 2, '0') || ':00'"
    : "TO_CHAR(TO_TIMESTAMP(created_at) AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24') || 'h'";
  const res = await pool.query(`
    SELECT ${labelExpr} as label,
      COUNT(*) as count, SUM(quota) as quota,
      COUNT(DISTINCT token_id) as active_tokens,
      COUNT(DISTINCT username) as active_users
    FROM logs WHERE created_at >= $1 GROUP BY label ORDER BY label
  `, [ts]);
  return res.rows.map(r => ({
    label: r.label,
    count: parseInt(r.count),
    quota: parseInt(r.quota) || 0,
    active_tokens: parseInt(r.active_tokens),
    active_users: parseInt(r.active_users),
  }));
}

async function getDistribution(range) {
  const ts = getRangeTs(range);
  // 模型分布 TOP 10
  const modelRes = await pool.query(`
    SELECT model_name, COUNT(*) as count, SUM(quota) as quota
    FROM logs WHERE created_at >= $1 GROUP BY model_name ORDER BY count DESC LIMIT 10
  `, [ts]);
  // 用户分布 TOP 10
  const userRes = await pool.query(`
    SELECT username, COUNT(*) as count, SUM(quota) as quota
    FROM logs WHERE created_at >= $1 GROUP BY username ORDER BY count DESC LIMIT 10
  `, [ts]);
  // Token/Key 分布 TOP 10
  const tokenRes = await pool.query(`
    SELECT token_id, token_name, username, COUNT(*) as count, SUM(quota) as quota
    FROM logs WHERE created_at >= $1 GROUP BY token_id, token_name, username ORDER BY count DESC LIMIT 10
  `, [ts]);
  const parse = r => ({ ...r, count: parseInt(r.count), quota: parseInt(r.quota) || 0 });
  return { models: modelRes.rows.map(parse), users: userRes.rows.map(parse), tokens: tokenRes.rows.map(parse) };
}

// ==================== token 启用/禁用 ====================
let whitelistSet = new Set();

async function loadWhitelist() {
  const { rows } = await pool.query('SELECT token_id FROM monitor_whitelist');
  whitelistSet = new Set(rows.map(r => r.token_id));
}

async function setTokenStatus(tokenId, userId, status) {
  try {
    const detail = await apiRequest(`/api/token/${tokenId}`, 'GET', null, userId);
    if (!detail.success || !detail.data) return { success: false, message: '获取token详情失败' };
    detail.data.status = status;
    return await apiRequest('/api/token/', 'PUT', detail.data, userId);
  } catch (err) {
    if (err.statusCode === 401) {
       return { success: false, message: '权限不足（NewAPI 限制 Access Token 只能操作管理员自己的 Token，请前往后台手动处理该用户的 Token）' };
    }
    return { success: false, message: err.message };
  }
}

async function getTokenStatuses() {
  const statuses = {};
  try {
    const res = await apiRequest('/api/token/?p=1&page_size=200');
    if (res.success && res.data && res.data.items) {
      for (const t of res.data.items) statuses[t.id] = t.status;
    }
  } catch {}
  return statuses;
}

// ==================== 定时监控 ====================
let latestSnapshot = null;
let isPolling = false;

async function pollAndCheck() {
  if (isPolling) return;
  isPolling = true;
  try {
    console.log(`[${new Date().toLocaleString()}] 开始查询数据库...`);
    const { tokens, total } = await getTodayAggregation();

    let statData = { quota: 0, rpm: 0, tpm: 0 };
    try {
      const stat = await apiRequest('/api/log/stat');
      if (stat.success) statData = stat.data;
    } catch {}

    latestSnapshot = {
      time: Date.now(),
      totalLogs: total,
      dbTotal: total,
      stat: statData,
      tokens,
    };

    console.log(`[${new Date().toLocaleString()}] 今日共 ${total} 条日志，${tokens.length} 个 token`);

    // 自动通知并尝试禁用超标 token
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfDayUnix = Math.floor(today.getTime() / 1000);

    for (const t of tokens) {
      if (t.count > CONFIG.dailyLimit && !whitelistSet.has(t.token_id)) {
        console.log(`⚠️ token ${t.token_name}(${t.token_id}) 今日 ${t.count} 次，超标！`);
        const checkRes = await pool.query(
          "SELECT 1 FROM monitor_actions WHERE token_id = $1 AND action = 'notify' AND created_at >= $2",
          [t.token_id, startOfDayUnix]
        );
        if (checkRes.rows.length === 0) {
          try {
            const mailTo = CONFIG.notifyEmail || process.env.SMTP_USER;
            await transporter.sendMail({
              from: `"NewAPI Monitor" <${process.env.SMTP_USER}>`,
              to: mailTo,
              subject: `🚨 [超限警告] Token: ${t.token_name} (用户: ${t.username})`,
              text: `用户 ${t.username} 的 Token "${t.token_name}" (ID: ${t.token_id})\n今日调用量已达到 ${t.count} 次，超过了设定的限制 ${CONFIG.dailyLimit} 次。\n\n系统已请求禁用该 Token。\n\n时间: ${new Date().toLocaleString()}`,
            });
            console.log(`  📧 邮件通知成功 (Token #${t.token_id})`);
            await pool.query(
              'INSERT INTO monitor_actions (token_id, token_name, username, action, reason, daily_count) VALUES ($1, $2, $3, $4, $5, $6)',
              [t.token_id, t.token_name, t.username, 'notify', `日调用 ${t.count} 次超限`, t.count]
            );
          } catch(e) {
            console.error(`  📧 发送邮件错误 (Token #${t.token_id}): ${e.message}`);
          }
        }

        try {
          const r = await setTokenStatus(t.token_id, t.user_id, 2);
          if (r.success) console.log(`  成功自动禁用 (Token #${t.token_id})`);
        } catch (e) { }
      }
    }
  } catch (err) {
    console.error('轮询出错:', err.message);
  } finally {
    isPolling = false;
  }
}

// ==================== API 路由 ====================
app.get('/api/snapshot', (req, res) => {
  res.json({ success: true, data: latestSnapshot });
});

app.post('/api/poll', async (req, res) => {
  await pollAndCheck();
  res.json({ success: true, data: latestSnapshot });
});

app.get('/api/stats', async (req, res) => {
  const range = req.query.range || 'today';
  const dim = req.query.dim || 'token';
  const data = await getAggregation(range, dim);
  res.json({ success: true, data });
});

app.get('/api/trend', async (req, res) => {
  const range = req.query.range || 'today';
  const data = await getHourlyTrend(range);
  res.json({ success: true, data });
});

app.get('/api/distribution', async (req, res) => {
  const range = req.query.range || 'today';
  const data = await getDistribution(range);
  res.json({ success: true, data });
});

app.get('/api/recent-logs', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.p) || 1);
  const pageSize = Math.min(100, parseInt(req.query.page_size) || 20);
  const range = req.query.range || 'today';
  const ts = getRangeTs(range);
  const offset = (page - 1) * pageSize;
  const [countRes, dataRes] = await Promise.all([
    pool.query('SELECT COUNT(*) as cnt FROM logs WHERE created_at >= $1', [ts]),
    pool.query(`
      SELECT id, created_at, username, token_name, token_id, model_name, quota,
        prompt_tokens, completion_tokens, channel_name, "group" as grp
      FROM logs WHERE created_at >= $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [ts, pageSize, offset]),
  ]);
  res.json({
    success: true,
    data: { items: dataRes.rows, total: parseInt(countRes.rows[0].cnt), page, pageSize },
  });
});

app.get('/api/actions', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { rows } = await pool.query('SELECT * FROM monitor_actions ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ success: true, data: rows });
});

app.post('/api/token/:id/disable', async (req, res) => {
  const tokenId = parseInt(req.params.id);
  const userId = req.body.user_id;
  if (!userId) return res.json({ success: false, message: '缺少 user_id' });
  const result = await setTokenStatus(tokenId, userId, 2);
  if (result.success) {
    await pool.query('INSERT INTO monitor_actions (token_id, action, reason) VALUES ($1, $2, $3)', [tokenId, 'manual_disable', '手动禁用']);
  }
  res.json(result);
});

app.post('/api/token/:id/enable', async (req, res) => {
  const tokenId = parseInt(req.params.id);
  const userId = req.body.user_id;
  if (!userId) return res.json({ success: false, message: '缺少 user_id' });
  const result = await setTokenStatus(tokenId, userId, 1);
  if (result.success) {
    await pool.query('INSERT INTO monitor_actions (token_id, action, reason) VALUES ($1, $2, $3)', [tokenId, 'manual_enable', '手动启用']);
  }
  res.json(result);
});

app.get('/api/token-status', async (req, res) => {
  const statuses = await getTokenStatuses();
  res.json({ success: true, data: statuses });
});

app.get('/api/whitelist', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM monitor_whitelist');
  res.json({ success: true, data: rows });
});

app.post('/api/whitelist', async (req, res) => {
  const { token_id, token_name, note } = req.body;
  await pool.query(
    'INSERT INTO monitor_whitelist (token_id, token_name, note) VALUES ($1, $2, $3) ON CONFLICT (token_id) DO UPDATE SET token_name=$2, note=$3',
    [token_id, token_name || '', note || '']
  );
  whitelistSet.add(token_id);
  res.json({ success: true });
});

app.delete('/api/whitelist/:id', async (req, res) => {
  const tokenId = parseInt(req.params.id);
  await pool.query('DELETE FROM monitor_whitelist WHERE token_id = $1', [tokenId]);
  whitelistSet.delete(tokenId);
  res.json({ success: true });
});

app.get('/api/config', (req, res) => {
  res.json({ success: true, data: { dailyLimit: CONFIG.dailyLimit, pollInterval: CONFIG.pollInterval, notifyEmail: CONFIG.notifyEmail, baseUrl: CONFIG.baseUrl } });
});

app.put('/api/config', async (req, res) => {
  const { dailyLimit, pollInterval, notifyEmail } = req.body;
  if (dailyLimit != null) {
    CONFIG.dailyLimit = parseInt(dailyLimit);
    await setKV('dailyLimit', CONFIG.dailyLimit);
  }
  if (pollInterval != null) {
    CONFIG.pollInterval = parseInt(pollInterval);
    await setKV('pollInterval', CONFIG.pollInterval);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollAndCheck, CONFIG.pollInterval);
  }
  if (notifyEmail != null) {
    CONFIG.notifyEmail = notifyEmail;
    await setKV('notifyEmail', CONFIG.notifyEmail);
  }
  console.log(`⚙️ 配置已更新: dailyLimit=${CONFIG.dailyLimit}, pollInterval=${CONFIG.pollInterval}, notifyEmail=${CONFIG.notifyEmail}`);
  res.json({ success: true, data: { dailyLimit: CONFIG.dailyLimit, pollInterval: CONFIG.pollInterval, notifyEmail: CONFIG.notifyEmail } });
});

// ==================== 启动 ====================
async function main() {
  await initDB();
  await loadSavedConfig();
  await loadWhitelist();

  app.listen(CONFIG.port, () => {
    console.log(`🚀 NewAPI Monitor http://localhost:${CONFIG.port}`);
    console.log(`📊 日调用限制: ${CONFIG.dailyLimit} 次 | 轮询: ${CONFIG.pollInterval / 1000}s`);
    console.log(`🐘 数据库: PostgreSQL (直连 NewAPI logs 表)`);
    pollAndCheck();
    pollTimer = setInterval(pollAndCheck, CONFIG.pollInterval);
  });
}

main().catch(err => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
