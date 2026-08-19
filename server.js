require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createClient } = require('redis');
const nodemailer = require('nodemailer');
const express = require('express');
const app = express();
app.set('trust proxy', 1);
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
  redisHost: process.env.REDIS_HOST || '',
  redisPort: parseInt(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || '',
  redisDb: parseInt(process.env.REDIS_DB) || 0,
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || 'newapi-monitor',
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS) || 120,
  // logs.quota 的计费单位换算（NewAPI 的 QuotaPerUnit），默认 500000 quota = $1，面板一律按美元展示
  quotaPerUnit: parseFloat(process.env.QUOTA_PER_UNIT) || 500000,
  timezone: 'Asia/Shanghai',
  dashboardAccessKey: process.env.DASHBOARD_ACCESS_KEY,
  // 通知渠道：环境变量只作为初始默认值，面板保存后以 monitor_kv 为准
  // 兼容旧部署：只配了 SMTP_USER 没配 SMTP_HOST 时沿用原来的 smtp.qq.com 默认值
  smtpHost: process.env.SMTP_HOST || (process.env.SMTP_USER ? 'smtp.qq.com' : ''),
  smtpPort: parseInt(process.env.SMTP_PORT) || 587,
  smtpSecure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || '',
  feishuWebhook: process.env.FEISHU_WEBHOOK || '',
  feishuSecret: process.env.FEISHU_SECRET || '',
  notifyScript: String(process.env.NOTIFY_SCRIPT || 'true').toLowerCase() !== 'false',
  // 聚焦模式默认只保留「脚本阈值」与「多 IP」告警；其余类别可在面板按需启用。
  alertDailyLimit: String(process.env.ALERT_DAILY_LIMIT || 'false').toLowerCase() === 'true',
  alertUsageAnomaly: String(process.env.ALERT_USAGE_ANOMALY || 'false').toLowerCase() === 'true',
  alertIpUsers: String(process.env.ALERT_IP_USERS || 'false').toLowerCase() === 'true',
  alertSubscription: String(process.env.ALERT_SUBSCRIPTION || 'false').toLowerCase() === 'true',
  // 脚本 trace 告警只在达到对应客户端的日调用量后触发，避免少量正常调用产生噪音。
  scriptClaudeAlertCalls: parseInt(process.env.SCRIPT_CLAUDE_ALERT_CALLS) || 1500,
  scriptGptAlertCalls: parseInt(process.env.SCRIPT_GPT_ALERT_CALLS) || 800,
  // 自动禁用策略：notify_only（只告警，默认）| auto（告警并禁用 Token）
  // 默认保持「只告警」，避免升级后突然把正在跑任务的客户断掉
  disablePolicy: process.env.DISABLE_POLICY === 'auto' ? 'auto' : 'notify_only',
  disableOnScript: String(process.env.DISABLE_ON_SCRIPT || '').toLowerCase() === 'true',
  // 实时推送：SSE 监听 logs 游标的间隔，无人订阅时不查库
  realtimeIntervalMs: parseInt(process.env.REALTIME_INTERVAL_MS) || 5000,
  // 实时风控规则：与面板轮询解耦，即使没人看面板也持续跑
  ruleIntervalMs: parseInt(process.env.RULE_INTERVAL_MS) || 60000,
  ruleEnabled: String(process.env.RULE_ENABLED || 'true').toLowerCase() !== 'false',
  surgeWindowMin: parseInt(process.env.SURGE_WINDOW_MIN) || 5,      // 滑动窗口长度（分钟）
  surgeCalls: parseInt(process.env.SURGE_CALLS) || 300,             // 窗口内调用数绝对阈值
  surgeRatio: parseFloat(process.env.SURGE_RATIO) || 5,             // 相对上一窗口的倍数
  surgeMinCalls: parseInt(process.env.SURGE_MIN_CALLS) || 30,       // 倍数规则的最低调用数，避免 1→5 误报
  surgeCostUsd: parseFloat(process.env.SURGE_COST_USD) || 5,        // 窗口内费用阈值（美元）
  shareIpPerToken: parseInt(process.env.SHARE_IP_PER_TOKEN) || 2,   // 单 Token 窗口内 IP 数
  shareUsersPerIp: parseInt(process.env.SHARE_USERS_PER_IP) || 2,   // 单 IP 窗口内用户数
  alertCooldownMin: parseInt(process.env.ALERT_COOLDOWN_MIN) || 30, // 同一对象同类告警的冷却时间
  // 订阅余量低于此百分比时提醒续费，设为 0 关闭
  subscriptionAlertPct: process.env.SUBSCRIPTION_ALERT_PCT != null ? parseFloat(process.env.SUBSCRIPTION_ALERT_PCT) : 20,
};
let pollTimer = null;
let ruleTimer = null;
let subscriptionTimer = null;
let httpServer = null;
let redis = null;
let redisReady = false;

// ==================== 面板访问鉴权 ====================
// 未设置 DASHBOARD_ACCESS_KEY 时保持兼容旧部署，不启用登录。
const AUTH_COOKIE = 'newapi_monitor_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();
function parseCookies(header = '') { return Object.fromEntries(header.split(';').map(item => { const index = item.indexOf('='); return index === -1 ? [] : [item.slice(0,index).trim(), decodeURIComponent(item.slice(index + 1).trim())]; }).filter(([key]) => key)); }
function accessKeyMatches(key) { const expected = Buffer.from(CONFIG.dashboardAccessKey || ''); const supplied = Buffer.from(String(key || '')); return expected.length > 0 && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied); }
function isAuthenticated(req) { if (!CONFIG.dashboardAccessKey) return true; const session = sessions.get(parseCookies(req.headers.cookie)[AUTH_COOKIE]); return Boolean(session && session.expiresAt > Date.now()); }
function setSessionCookie(req,res,token,maxAge=SESSION_TTL_MS) { const attributes = [AUTH_COOKIE + '=' + encodeURIComponent(token),'Path=/','HttpOnly','SameSite=Strict','Max-Age=' + Math.floor(maxAge / 1000)]; if (req.secure) attributes.push('Secure'); res.setHeader('Set-Cookie',attributes.join('; ')); }
// 登录失败退避：同一 IP 连续失败会被锁定，防止访问密钥被暴力枚举
const loginFailures = new Map();
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
function loginGate(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return { locked: false };
  if (rec.lockedUntil > Date.now()) return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  if (rec.lockedUntil) loginFailures.delete(ip);
  return { locked: false };
}
function loginFailed(ip) {
  const rec = loginFailures.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILURES) { rec.lockedUntil = Date.now() + LOGIN_LOCK_MS; rec.count = 0; }
  loginFailures.set(ip, rec);
}
app.post('/api/auth/login',(req,res) => {
  if (!CONFIG.dashboardAccessKey) return res.json({success:true,authEnabled:false});
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const gate = loginGate(ip);
  if (gate.locked) return res.status(429).json({ success:false, message:`尝试过于频繁，请 ${gate.retryAfter} 秒后再试` });
  if (!accessKeyMatches(req.body?.accessKey)) { loginFailed(ip); return res.status(401).json({success:false,message:'访问密钥错误'}); }
  loginFailures.delete(ip);
  const token=crypto.randomBytes(32).toString('base64url');
  sessions.set(token,{expiresAt:Date.now()+SESSION_TTL_MS});
  setSessionCookie(req,res,token);
  res.json({success:true});
});
// 健康检查：编排层用它判断容器是否还活着，不需要鉴权
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, redis: redisReady, sse: sseClients.size, uptime: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, message: err.message });
  }
});
app.post('/api/auth/logout',(req,res) => { sessions.delete(parseCookies(req.headers.cookie)[AUTH_COOKIE]); setSessionCookie(req,res,'',0); res.json({success:true}); });
app.use((req,res,next) => { if (req.path === '/login.html' || req.path === '/favicon.ico' || isAuthenticated(req)) return next(); if (req.path.startsWith('/api/')) return res.status(401).json({success:false,message:'未登录或登录已过期'}); res.redirect('/login.html'); });
app.use(express.static(path.join(__dirname,'public')));


// ==================== 通知渠道 ====================
// SMTP 连接按当前配置惰性构建，配置变更后自动重建，无需重启
let transporter = null;
let transporterKey = '';
function createSmtpTransport({ host, port, secure, user, pass }) {
  return nodemailer.createTransport({
    host,
    port,
    secure: secure || port === 465,
    auth: { user, pass },
  });
}
function getTransporter() {
  if (!CONFIG.smtpHost || !CONFIG.smtpUser) return null;
  const key = [CONFIG.smtpHost, CONFIG.smtpPort, CONFIG.smtpSecure, CONFIG.smtpUser, CONFIG.smtpPass].join('|');
  if (transporter && transporterKey === key) return transporter;
  transporter = createSmtpTransport({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    secure: CONFIG.smtpSecure,
    user: CONFIG.smtpUser,
    pass: CONFIG.smtpPass,
  });
  transporterKey = key;
  return transporter;
}

function postJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return reject(new Error('URL 格式不正确')); }
    const client = parsed.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 10000,
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(body);
  });
}

// 飞书自定义机器人签名：以 "{timestamp}\n{secret}" 为 key 对空串做 HMAC-SHA256
function feishuSign(timestamp, secret) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

// override 用于面板「发送测试消息」：测的是表单里还没保存的值，不传则读已保存配置
async function sendFeishu({ title, level = 'info', lines = [] }, override = {}) {
  const webhook = override.webhook || CONFIG.feishuWebhook;
  const secret = override.secret || CONFIG.feishuSecret;
  if (!webhook) throw new Error('未配置飞书 Webhook');
  const template = level === 'danger' ? 'red' : level === 'warning' ? 'orange' : 'blue';
  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template, title: { tag: 'plain_text', content: title } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `NewAPI Monitor · ${formatInTimezone(Date.now())}` }] },
      ],
    },
  };
  if (secret) {
    payload.timestamp = String(Math.floor(Date.now() / 1000));
    payload.sign = feishuSign(payload.timestamp, secret);
  }
  const res = await postJson(webhook, payload);
  if (res.status !== 200 || (res.json && res.json.code !== 0)) {
    throw new Error(`飞书返回 ${res.status} ${res.json ? res.json.msg || res.json.code : res.raw.slice(0, 120)}`);
  }
  return true;
}

async function sendEmail({ title, lines = [] }, override = null) {
  const smtp = override || {
    host: CONFIG.smtpHost, port: CONFIG.smtpPort, secure: CONFIG.smtpSecure,
    user: CONFIG.smtpUser, pass: CONFIG.smtpPass, from: CONFIG.smtpFrom, to: CONFIG.notifyEmail,
  };
  if (!smtp.host || !smtp.user) throw new Error('未配置 SMTP');
  // 测试用的一次性连接不进缓存，避免未保存的表单值污染正式告警通道
  const mailer = override ? createSmtpTransport(smtp) : getTransporter();
  if (!mailer) throw new Error('未配置 SMTP');
  const to = smtp.to || smtp.user;
  if (!to) throw new Error('未配置收件邮箱');
  try {
    await mailer.sendMail({
      from: smtp.from || `"NewAPI Monitor" <${smtp.user}>`,
      to,
      subject: title,
      text: lines.map(l => l.replace(/\*\*/g, '')).join('\n'),
    });
  } finally {
    if (override) mailer.close();
  }
  return true;
}

// 统一告警出口：任一渠道失败不影响其他渠道，返回每个渠道的结果
async function notifyAlert(alert) {
  const results = [];
  const channels = [];
  if (getTransporter()) channels.push(['email', sendEmail]);
  if (CONFIG.feishuWebhook) channels.push(['feishu', sendFeishu]);
  for (const [name, send] of channels) {
    try {
      await send(alert);
      results.push({ channel: name, ok: true });
    } catch (err) {
      results.push({ channel: name, ok: false, message: err.message });
      console.error(`  通知失败 [${name}]: ${err.message}`);
    }
  }
  if (results.some(r => r.ok)) broadcastEvent({ type: 'alert', title: alert.title, level: alert.level || 'info' });
  return results;
}

function formatInTimezone(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: CONFIG.timezone });
}

function maskSecret(value, keep = 6) {
  if (!value) return '';
  const text = String(value);
  return text.length <= keep ? '******' : `******${text.slice(-keep)}`;
}

// ==================== 实时推送（SSE） ====================
const sseClients = new Set();
let realtimeTimer = null;
let lastBroadcastId = 0;

function broadcastEvent(payload) {
  if (!sseClients.size) return;
  const frame = `data: ${JSON.stringify({ ...payload, at: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(frame); } catch { sseClients.delete(client); }
  }
}

// 只在有人订阅时查库；游标查询是单条 MAX 聚合，代价固定
async function watchRealtime() {
  if (!sseClients.size) return;
  try {
    const cursor = await getLatestLogCursor();
    if (!lastBroadcastId) { lastBroadcastId = cursor.maxId; return; }
    if (cursor.maxId > lastBroadcastId) {
      const added = cursor.maxId - lastBroadcastId;
      lastBroadcastId = cursor.maxId;
      broadcastEvent({ type: 'logs', maxId: cursor.maxId, added });
    }
  } catch (err) {
    console.error('实时监听出错:', err.message);
  }
}

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
      action_meta JSONB,
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

    CREATE TABLE IF NOT EXISTS monitor_log_user_agents (
      log_id BIGINT PRIMARY KEY,
      user_agent TEXT NOT NULL,
      matched_delta_seconds INTEGER NOT NULL,
      cache_tokens BIGINT NOT NULL DEFAULT 0,
      trace_type TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
    );

    CREATE TABLE IF NOT EXISTS monitor_usage_rollups (
      bucket_start INTEGER NOT NULL,
      dimension_hash TEXT NOT NULL,
      token_id BIGINT NOT NULL DEFAULT 0,
      token_name TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      user_id BIGINT NOT NULL DEFAULT 0,
      model_name TEXT NOT NULL DEFAULT '',
      grp TEXT NOT NULL DEFAULT '',
      channel_id BIGINT NOT NULL DEFAULT 0,
      channel_name TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      call_count BIGINT NOT NULL DEFAULT 0,
      usage_count BIGINT NOT NULL DEFAULT 0,
      quota BIGINT NOT NULL DEFAULT 0,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens DOUBLE PRECISION NOT NULL DEFAULT 0,
      cache_tokens BIGINT NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (bucket_start, dimension_hash)
    );
  `);
  await pool.query('ALTER TABLE monitor_log_user_agents ADD COLUMN IF NOT EXISTS cache_tokens BIGINT NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE monitor_log_user_agents ADD COLUMN IF NOT EXISTS trace_type TEXT NOT NULL DEFAULT ''");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_monitor_usage_rollups_bucket ON monitor_usage_rollups (bucket_start)');
  await pool.query('ALTER TABLE monitor_actions ADD COLUMN IF NOT EXISTS action_meta JSONB');
  // 告警冷却查询（按 action + subject + 时间）每分钟对每个活跃 Token 执行一次，没有索引会全表扫
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_monitor_actions_action_created
      ON monitor_actions (action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_monitor_actions_subject
      ON monitor_actions ((action_meta->>'subject'), created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_monitor_actions_token
      ON monitor_actions (token_id, created_at DESC);
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
// monitor_kv 中可覆盖环境变量的配置项 → CONFIG 字段与解析方式
const KV_CONFIG_KEYS = {
  dailyLimit: v => parseInt(v),
  pollInterval: v => parseInt(v),
  notifyEmail: v => v,
  timezone: v => (isValidTimeZone(v) ? v : CONFIG.timezone),
  smtpHost: v => v,
  smtpPort: v => parseInt(v) || 587,
  smtpSecure: v => v === 'true',
  smtpUser: v => v,
  smtpPass: v => v,
  smtpFrom: v => v,
  feishuWebhook: v => v,
  feishuSecret: v => v,
  notifyScript: v => v === 'true',
  alertDailyLimit: v => v === 'true',
  alertUsageAnomaly: v => v === 'true',
  alertIpUsers: v => v === 'true',
  alertSubscription: v => v === 'true',
  scriptClaudeAlertCalls: v => parseInt(v) || 1500,
  scriptGptAlertCalls: v => parseInt(v) || 800,
  disablePolicy: v => (v === 'auto' ? 'auto' : 'notify_only'),
  disableOnScript: v => v === 'true',
  ruleEnabled: v => v === 'true',
  surgeWindowMin: v => parseInt(v) || 5,
  surgeCalls: v => parseInt(v) || 300,
  surgeRatio: v => parseFloat(v) || 5,
  surgeMinCalls: v => parseInt(v) || 30,
  surgeCostUsd: v => parseFloat(v) || 5,
  shareIpPerToken: v => parseInt(v) || 2,
  shareUsersPerIp: v => parseInt(v) || 2,
  alertCooldownMin: v => parseInt(v) || 30,
  subscriptionAlertPct: v => (v === '' ? 0 : parseFloat(v) || 0),
};

async function loadSavedConfig() {
  const keys = Object.keys(KV_CONFIG_KEYS);
  const { rows } = await pool.query('SELECT key, value FROM monitor_kv WHERE key = ANY($1)', [keys]);
  for (const row of rows) {
    const parse = KV_CONFIG_KEYS[row.key];
    if (parse) CONFIG[row.key] = parse(row.value);
  }
}

// ==================== Redis 缓存 ====================
// 聚合结果结构变化时递增，避免升级后读到旧口径的缓存（v15：GPT / Claude 缓存明细）
const CACHE_SCHEMA_VERSION = 'v15';
function cacheKey(key) {
  return `${CONFIG.redisKeyPrefix}:${CACHE_SCHEMA_VERSION}:${key}`;
}

async function initRedis() {
  if (!CONFIG.redisHost) return;
  redis = createClient({
    socket: {
      host: CONFIG.redisHost,
      port: CONFIG.redisPort,
      reconnectStrategy: (retries) => Math.min(retries * 250, 3000),
    },
    password: CONFIG.redisPassword || undefined,
    database: CONFIG.redisDb,
  });
  redis.on('error', (err) => {
    redisReady = false;
    console.error('Redis 错误:', err.message);
  });
  redis.on('ready', () => {
    redisReady = true;
    console.log(`🧠 Redis 已连接: ${CONFIG.redisHost}:${CONFIG.redisPort}/${CONFIG.redisDb}`);
  });
  try {
    await redis.connect();
  } catch (err) {
    redisReady = false;
    console.error('Redis 初始化失败，将回退为直查数据库:', err.message);
  }
}

async function cacheGet(key) {
  if (!redisReady) return null;
  try {
    return await redis.get(cacheKey(key));
  } catch (err) {
    redisReady = false;
    console.error('Redis 读取失败:', err.message);
    return null;
  }
}

async function cacheGetJson(key) {
  const raw = await cacheGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cacheSetJson(key, value, ttlSeconds = CONFIG.cacheTtlSeconds) {
  if (!redisReady) return;
  try {
    await redis.set(cacheKey(key), JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    redisReady = false;
    console.error('Redis 写入失败:', err.message);
  }
}

async function cacheDeleteByPrefix(prefix) {
  if (!redisReady) return;
  try {
    const keys = [];
    for await (const key of redis.scanIterator({ MATCH: `${cacheKey(prefix)}*`, COUNT: 100 })) {
      keys.push(key);
    }
    if (keys.length) await redis.del(keys);
  } catch (err) {
    redisReady = false;
    console.error('Redis 删除失败:', err.message);
  }
}

async function withCacheLock(lockName, fn) {
  if (!redisReady) return fn();
  const lock = cacheKey(`lock:${lockName}`);
  try {
    const acquired = await redis.set(lock, String(Date.now()), { NX: true, EX: 10 });
    if (acquired) {
      try {
        return await fn();
      } finally {
        await redis.del(lock).catch(() => {});
      }
    }
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const exists = await redis.exists(lock).catch(() => 0);
      if (!exists) break;
    }
    return await fn();
  } catch (err) {
    redisReady = false;
    console.error('Redis 锁失败:', err.message);
    return await fn();
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
function isValidTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneDateParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

function getTimeZoneOffsetMs(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) - timestamp;
}

function getRangeTs(range) {
  // 数据库存 UTC 秒；所有日界线按面板配置的 IANA 时区计算。
  const timeZone = CONFIG.timezone;
  const { year, month, day } = getTimeZoneDateParts(Date.now(), timeZone);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  const todayStart = Math.floor((localMidnightAsUtc - getTimeZoneOffsetMs(localMidnightAsUtc, timeZone)) / 1000);
  if (range === '3d') return todayStart - 2 * 86400;
  if (range === '7d') return todayStart - 6 * 86400;
  if (range === '30d') return todayStart - 29 * 86400;
  return todayStart;
}

function getRangeAnchor(range) {
  const now = new Date();
  const cnStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return `${range}:${cnStr}`;
}

function parseOtherJson(text) {
  if (!text || typeof text !== 'string' || text[0] !== '{') return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const NORMALIZATION_RULES = [
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '<UUID>' },
  { pattern: /\(cch_session_id:\s*[0-9a-zA-Z-]+\)/gi, replacement: '(cch_session_id: <ID>)' },
  { pattern: /\b(session|request|trace|log|span)_id[=:]\s*[a-zA-Z0-9_-]+/gi, replacement: '$1_id=<ID>' },
  { pattern: /\(\d+\)/g, replacement: '(<NUM>)' },
  { pattern: /\b\d{7,}\b/g, replacement: '<ID>' },
  { pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, replacement: '<TIME>' },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, replacement: '<IP>' },
  { pattern: /\b[0-9a-f]{16,32}\b/gi, replacement: '<HEX>' },
  { pattern: /https?:\/\/[^\s]+/gi, replacement: '<URL>' },
];

function normalizeErrorContent(content) {
  if (!content || content === '') return '(空)';
  let normalized = content;
  for (const rule of NORMALIZATION_RULES) {
    normalized = normalized.replace(rule.pattern, rule.replacement);
  }
  return normalized.length > 200 ? normalized.slice(0, 200) + '...' : normalized;
}

function compactErrorText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

function classifyMainFailure(row) {
  const statusCode = String(row.status_code || 'unknown').toLowerCase();
  const errorType = compactErrorText(row.error_type);
  const content = compactErrorText(row.content);
  const haystack = `${statusCode} ${errorType} ${content}`;

  if (includesAny(haystack, [
    'insufficient_quota', 'quota exceeded', 'quota exhausted', 'out of quota',
    'billing', 'balance', 'credit', '余额不足', '额度不足', '配额不足',
  ])) {
    return { category_code: 'quota', category_label: '余额不足' };
  }

  if (includesAny(haystack, [
    'rate limit', 'too many requests', 'rate_limit', 'request limit',
    'requests per min', '频率限制', '限流', '请求过多',
  ])) {
    return { category_code: 'rate_limit', category_label: '限流/请求过多' };
  }

  if (includesAny(haystack, [
    'invalid_api_key', 'invalid api key', 'unauthorized', 'authentication',
    'auth', 'forbidden', 'permission', 'access token', 'api key',
    '令牌无效', '鉴权失败', '认证失败', '权限不足', '未授权',
  ])) {
    return { category_code: 'auth', category_label: '鉴权/权限问题' };
  }

  if (includesAny(haystack, [
    'model_not_found', 'no such model', 'model does not exist', 'unsupported model',
    '模型不存在', '模型不可用', '不支持该模型',
  ])) {
    return { category_code: 'model', category_label: '模型不存在/不可用' };
  }

  if (includesAny(haystack, [
    'context_length', 'maximum context length', 'max context length', 'token limit',
    'too many tokens', 'context window', '上下文长度', '超出上下文', 'token 超限',
  ])) {
    return { category_code: 'context_length', category_label: '上下文/Token 超限' };
  }

  if (includesAny(haystack, [
    'content_filter', 'content filter', 'safety', 'moderation', 'policy',
    '内容审核', '安全策略', '内容过滤', '策略拦截',
  ])) {
    return { category_code: 'policy', category_label: '内容审核/策略拦截' };
  }

  if (includesAny(haystack, [
    'timeout', 'timed out', 'deadline exceeded', 'connection timeout',
    'read timeout', 'connect timeout', '超时', '请求超时', '连接超时',
  ])) {
    return { category_code: 'timeout', category_label: '超时/响应过慢' };
  }

  if (includesAny(haystack, [
    'connection reset', 'connection aborted', 'connection refused', 'broken pipe',
    'econnreset', 'econnrefused', 'socket hang up', 'network', 'upstream connect',
    '断开连接', '连接重置', '网络错误', '上游连接失败',
  ])) {
    return { category_code: 'network', category_label: '网络/连接异常' };
  }

  if (statusCode.startsWith('5') || includesAny(haystack, [
    'internal server error', 'bad gateway', 'gateway error', 'service unavailable',
    'server error', 'overloaded', 'upstream', '服务器错误', '服务不可用', '网关错误',
  ])) {
    return { category_code: 'upstream_5xx', category_label: '上游服务异常' };
  }

  if (statusCode.startsWith('4') || includesAny(haystack, [
    'invalid request', 'bad request', 'unprocessable', 'parameter',
    '参数错误', '请求参数', '请求格式错误',
  ])) {
    return { category_code: 'invalid_request', category_label: '请求参数/格式错误' };
  }

  if (errorType && errorType !== 'unknown') {
    return { category_code: `error_type:${errorType}`, category_label: row.error_type };
  }

  if (statusCode && statusCode !== 'unknown') {
    return { category_code: `status:${statusCode}`, category_label: `HTTP ${row.status_code}` };
  }

  return { category_code: 'unknown', category_label: '未知主失败' };
}

function classifyStreamFailure(row) {
  const endReason = compactErrorText(row.stream_end_reason);
  const content = compactErrorText(row.content);
  const haystack = `${endReason} ${content}`;

  if (includesAny(haystack, [
    'timeout', 'timed out', 'deadline exceeded', '超时', '等待超时',
  ])) {
    return { category_code: 'stream_timeout', category_label: '流式超时' };
  }

  if (includesAny(haystack, [
    'client_disconnect', 'disconnect', 'connection reset', 'socket closed',
    'broken pipe', 'econnreset', '连接断开', '连接重置', '客户端断开',
  ])) {
    return { category_code: 'stream_disconnect', category_label: '流式连接断开' };
  }

  if (includesAny(haystack, [
    'cancel', 'aborted', 'abort', '取消', '中止',
  ])) {
    return { category_code: 'stream_cancelled', category_label: '流式被取消/中止' };
  }

  if (includesAny(haystack, [
    'upstream', 'provider', 'server error', 'internal error', '服务异常', '上游异常',
  ])) {
    return { category_code: 'stream_upstream', category_label: '流式上游异常' };
  }

  if (endReason && endReason !== 'unknown') {
    return { category_code: `stream:${endReason}`, category_label: `流式中断/${row.stream_end_reason}` };
  }

  return { category_code: 'stream:unknown', category_label: '未知流式中断' };
}

function classifyErrorGroup(row) {
  return row.type === 5 ? classifyMainFailure(row) : classifyStreamFailure(row);
}

function extractScriptSignals(otherText) {
  const other = parseOtherJson(otherText);
  const affinity = other.admin_info && other.admin_info.channel_affinity ? other.admin_info.channel_affinity : {};
  const reason = String(affinity.reason || '').toLowerCase();
  const ruleName = String((affinity.override_template && affinity.override_template.rule_name) || '').toLowerCase();
  const keyPath = String(affinity.key_path || '');
  const signals = [];
  const traceTypes = new Set();

  if (reason.includes('claude cli trace') || ruleName.includes('claude cli trace')) {
    signals.push('命中 claude cli trace');
    traceTypes.add('claude cli trace');
  }
  if (reason.includes('codex cli trace') || ruleName.includes('codex cli trace')) {
    signals.push('命中 codex cli trace');
    traceTypes.add('codex cli trace');
  }
  if (keyPath === 'metadata.user_id') {
    signals.push('命中 metadata.user_id 链路');
    traceTypes.add('key_path:metadata.user_id');
  }
  if (keyPath === 'prompt_cache_key') {
    signals.push('命中 prompt_cache_key 链路');
    traceTypes.add('key_path:prompt_cache_key');
  }

  return {
    matched: signals.length > 0,
    reason,
    ruleName,
    keyPath,
    signals,
    traceTypes: Array.from(traceTypes),
  };
}

function buildScriptDisableDecision(flaggedCalls, totalCalls) {
  const ratio = totalCalls > 0 ? flaggedCalls / totalCalls : 0;
  return {
    flagged_calls: flaggedCalls,
    total_calls: totalCalls,
    flagged_ratio: +ratio.toFixed(4),
    ratio_pct: +(ratio * 100).toFixed(1),
    eligible: false,
  };
}

async function getLatestLogCursor() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(MAX(id), 0) AS max_id,
      COALESCE(MAX(created_at), 0) AS max_created_at
    FROM logs
    WHERE created_at IS NOT NULL
  `);
  return {
    maxId: parseInt(rows[0].max_id) || 0,
    maxCreatedAt: parseInt(rows[0].max_created_at) || 0,
    anchor: getRangeAnchor('today'),
  };
}

async function readCacheEnvelope(key) {
  return await cacheGetJson(key);
}

async function writeCacheEnvelope(key, value, meta = {}, ttlSeconds = CONFIG.cacheTtlSeconds) {
  await cacheSetJson(key, { meta, value }, ttlSeconds);
}

async function getOrBuildCached(key, range, builder, ttlSeconds = CONFIG.cacheTtlSeconds) {
  const anchor = getRangeAnchor(range);
  const cursor = await getLatestLogCursor();
  const cached = await readCacheEnvelope(key);
  if (cached && cached.meta && cached.meta.anchor === anchor && cached.meta.lastLogId === cursor.maxId) {
    return cached.value;
  }
  return await withCacheLock(key, async () => {
    const secondRead = await readCacheEnvelope(key);
    if (secondRead && secondRead.meta && secondRead.meta.anchor === anchor && secondRead.meta.lastLogId === cursor.maxId) {
      return secondRead.value;
    }
    const value = await builder();
    await writeCacheEnvelope(key, value, { anchor, lastLogId: cursor.maxId }, ttlSeconds);
    return value;
  });
}

// NewAPI logs.type：1=充值 2=消费 3=管理 4=系统 5=错误 7=登录
// 只有 type=2 携带真实用量，其余类型（含登录事件）不是 API 调用，混进来会虚增调用次数。
// 统计口径：
//   调用次数 → 真实 API 请求（成功 2 + 失败 5）
//   费用 / token → 仅消费日志（2）
const REQUEST_LOGS = 'type IN (2, 5)';
// OpenAI 口径：prompt/input tokens 已包含 cached tokens；缓存只是输入的拆分项。
// 因此总 Token = prompt + completion，不能再次叠加缓存读取。
// 缓存 token 用正则从 other 文本里取，避免 other 非法 JSON 或非整数值导致整条聚合报错。
const CACHE_TOKENS_EXPR = `COALESCE(NULLIF(SUBSTRING(other FROM '"cache_tokens":([0-9]+)'), '')::bigint, 0)`;
// 输入 Token 排序：普通模型缓存按套餐 20% 折算，GPT-5.6 按官方 cached/input 价格比 10% 折算。
// ponytail: 只维护有不同官方缓存比的明确别名；新型号出现时再补这里。
const GPT_CACHE_WEIGHT_EXPR = `CASE WHEN LOWER(COALESCE(model_name, '')) IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 0.1 ELSE 0.2 END`;
const RAW_INPUT_TOKENS_EXPR = `GREATEST(COALESCE(prompt_tokens, 0) - ${CACHE_TOKENS_EXPR}, 0) + ${CACHE_TOKENS_EXPR} * ${GPT_CACHE_WEIGHT_EXPR}`;
const ROLLUP_INPUT_TOKENS_EXPR = `GREATEST(COALESCE(prompt_tokens, 0) - COALESCE(cache_tokens, 0), 0) + COALESCE(cache_tokens, 0) * ${GPT_CACHE_WEIGHT_EXPR}`;
const GPT_MODEL_EXPR = `LOWER(COALESCE(model_name, '')) ~ '(gpt|codex)'`;
const CLAUDE_MODEL_EXPR = `LOWER(COALESCE(model_name, '')) LIKE '%claude%'`;
const RAW_GPT_INPUT_TOKENS_EXPR = `CASE WHEN ${GPT_MODEL_EXPR} THEN ${RAW_INPUT_TOKENS_EXPR} ELSE 0 END`;
const RAW_CLAUDE_INPUT_TOKENS_EXPR = `CASE WHEN ${CLAUDE_MODEL_EXPR} THEN ${RAW_INPUT_TOKENS_EXPR} ELSE 0 END`;
const ROLLUP_GPT_INPUT_TOKENS_EXPR = `CASE WHEN ${GPT_MODEL_EXPR} THEN ${ROLLUP_INPUT_TOKENS_EXPR} ELSE 0 END`;
const ROLLUP_CLAUDE_INPUT_TOKENS_EXPR = `CASE WHEN ${CLAUDE_MODEL_EXPR} THEN ${ROLLUP_INPUT_TOKENS_EXPR} ELSE 0 END`;
const RAW_GPT_CACHE_TOKENS_EXPR = `CASE WHEN ${GPT_MODEL_EXPR} THEN ${CACHE_TOKENS_EXPR} ELSE 0 END`;
const RAW_CLAUDE_CACHE_TOKENS_EXPR = `CASE WHEN ${CLAUDE_MODEL_EXPR} THEN ${CACHE_TOKENS_EXPR} ELSE 0 END`;
const ROLLUP_GPT_CACHE_TOKENS_EXPR = `CASE WHEN ${GPT_MODEL_EXPR} THEN COALESCE(cache_tokens, 0) ELSE 0 END`;
const ROLLUP_CLAUDE_CACHE_TOKENS_EXPR = `CASE WHEN ${CLAUDE_MODEL_EXPR} THEN COALESCE(cache_tokens, 0) ELSE 0 END`;
const GPT_CACHE_WEIGHTS = Object.freeze({ 'gpt-5.6-sol': 0.1, 'gpt-5.6-terra': 0.1, 'gpt-5.6-luna': 0.1 });
function weightedInputTokens(promptTokens, cacheTokens, modelName) {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const cache = Math.max(0, Number(cacheTokens) || 0);
  const weight = GPT_CACHE_WEIGHTS[String(modelName || '').toLowerCase()] ?? 0.2;
  return Math.max(prompt - cache, 0) + cache * weight;
}
const USER_AGENT_EXPR = `NULLIF(SUBSTRING(other FROM '"user_agent":"([^"\\\\]*)"'), '')`;
const SAFE_OTHER_JSON_EXPR = `(CASE
        WHEN other NOT LIKE '%"user_agent"%' AND other NOT LIKE '%"request_body"%' AND other NOT LIKE '%"channel_affinity"%' THEN '{}'::jsonb
        WHEN other IS JSON THEN other::jsonb
        ELSE '{}'::jsonb
      END)`;
const CLIENT_USER_AGENT_EXPR = `LOWER(COALESCE(other_json->>'user_agent', ''))`;
const CLIENT_SIGNAL_EXPR = `LOWER(
        COALESCE(other_json->'admin_info'->'channel_affinity'->>'reason', '') || ' ' ||
        COALESCE(other_json->'admin_info'->'channel_affinity'->'override_template'->>'rule_name', '')
      )`;
const CLIENT_EXPR = `CASE
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%codex desktop%' THEN 'Codex Desktop'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%opencode%' THEN 'OpenCode'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%trae%' THEN 'Trae'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%claude-vscode%' THEN 'Claude VS Code'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%claude-cli%' THEN 'Claude CLI'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%anthropic/python%' THEN 'Claude Python SDK'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%anthropic/js%' THEN 'Claude JS SDK'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%asyncopenai%' OR ${CLIENT_USER_AGENT_EXPR} LIKE '%openai/python%' THEN 'OpenAI Python SDK'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%litellm%' THEN 'LiteLLM'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%undici%' THEN 'undici'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%python-requests%' THEN 'Python requests'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%python-urllib%' THEN 'Python urllib'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%go-http-client%' THEN 'Go HTTP'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%curl/%' THEN 'curl'
        WHEN ${CLIENT_USER_AGENT_EXPR} LIKE '%chrome/%' THEN 'Chrome'
        WHEN ${CLIENT_USER_AGENT_EXPR} <> '' THEN LEFT(other_json->>'user_agent', 48)
        WHEN ${CLIENT_SIGNAL_EXPR} LIKE '%opencode%' THEN 'OpenCode (Trace)'
        WHEN ${CLIENT_SIGNAL_EXPR} LIKE '%trae%' THEN 'Trae (Trace)'
        WHEN ${CLIENT_SIGNAL_EXPR} LIKE '%claude%' THEN 'Claude (Trace)'
        WHEN ${CLIENT_SIGNAL_EXPR} LIKE '%codex%' THEN 'Codex (Trace)'
        ELSE NULL
      END`;
const USAGE_AGG = `COUNT(*) as count,
      SUM(quota) FILTER (WHERE type = 2) as quota,
      SUM(prompt_tokens) FILTER (WHERE type = 2) as prompt_tokens,
      SUM(completion_tokens) FILTER (WHERE type = 2) as completion_tokens,
      SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) FILTER (WHERE type = 2) as total_tokens,
      SUM(${CACHE_TOKENS_EXPR}) FILTER (WHERE type = 2) as cache_tokens,
      SUM(${RAW_INPUT_TOKENS_EXPR}) FILTER (WHERE type = 2) as input_tokens,
      SUM(${RAW_GPT_INPUT_TOKENS_EXPR}) FILTER (WHERE type = 2) as gpt_input_tokens,
      SUM(${RAW_CLAUDE_INPUT_TOKENS_EXPR}) FILTER (WHERE type = 2) as claude_input_tokens,
      SUM(${RAW_GPT_CACHE_TOKENS_EXPR}) FILTER (WHERE type = 2) as gpt_cache_tokens,
      SUM(${RAW_CLAUDE_CACHE_TOKENS_EXPR}) FILTER (WHERE type = 2) as claude_cache_tokens`;

function parseUsageRow(r) {
  const row = {
    ...r,
    count: parseInt(r.count) || 0,
    quota: parseInt(r.quota) || 0,
    prompt_tokens: parseInt(r.prompt_tokens) || 0,
    completion_tokens: parseInt(r.completion_tokens) || 0,
    total_tokens: parseFloat(r.total_tokens) || 0,
    cache_tokens: parseInt(r.cache_tokens) || 0,
    input_tokens: r.input_tokens != null
      ? parseFloat(r.input_tokens) || 0
      : weightedInputTokens(r.prompt_tokens, r.cache_tokens, r.model_name),
    gpt_input_tokens: parseFloat(r.gpt_input_tokens) || 0,
    claude_input_tokens: parseFloat(r.claude_input_tokens) || 0,
    gpt_cache_tokens: parseInt(r.gpt_cache_tokens) || 0,
    claude_cache_tokens: parseInt(r.claude_cache_tokens) || 0,
    ip_count: parseInt(r.ip_count) || 0,
    clients: Array.isArray(r.clients) ? r.clients : [],
  };
  if (r.cost_usd !== undefined) {
    row.cost_usd = parseFloat(r.cost_usd) || 0;
    row.cost_priced_calls = parseInt(r.cost_priced_calls) || 0;
  }
  return row;
}

async function fetchLogsSinceId(lastLogId, minCreatedAt = 0) {
  const { rows } = await pool.query(`
    SELECT id, created_at, type, username, token_name, token_id, user_id, model_name,
      quota, prompt_tokens, completion_tokens, channel_name, "group" as grp, other
    FROM logs
    WHERE id > $1 AND created_at >= $2 AND ${REQUEST_LOGS}
    ORDER BY id ASC
  `, [lastLogId, minCreatedAt]);
  return rows.map(r => ({
    ...r,
    id: parseInt(r.id) || 0,
    created_at: parseInt(r.created_at) || 0,
    type: parseInt(r.type) || 0,
    token_id: parseInt(r.token_id) || 0,
    user_id: parseInt(r.user_id) || 0,
    quota: parseInt(r.quota) || 0,
    prompt_tokens: parseInt(r.prompt_tokens) || 0,
    completion_tokens: parseInt(r.completion_tokens) || 0,
    cache_tokens: extractCacheTokens(r.other),
    user_agent: extractUserAgent(r.other),
    trace_type: extractTraceType(r.other),
  }));
}

// 与 SQL 侧 CACHE_TOKENS_EXPR 保持一致的 JS 实现，供增量合并使用
function extractCacheTokens(other) {
  const m = /"cache_tokens":([0-9]+)/.exec(other || '');
  return m ? parseInt(m[1]) || 0 : 0;
}

function extractUserAgent(other) {
  const m = /"user_agent":"((?:\\.|[^"\\])*)"/.exec(other || '');
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return ''; }
}

function extractTraceType(other) {
  const json = parseOtherJson(other);
  const affinity = json?.admin_info?.channel_affinity || {};
  const signal = `${affinity.reason || ''} ${affinity.override_template?.rule_name || ''}`.toLowerCase();
  if (signal.includes('claude cli trace')) return 'claude cli trace';
  if (signal.includes('codex cli trace')) return 'codex cli trace';
  if (affinity.key_path === 'metadata.user_id') return 'key_path:metadata.user_id';
  if (affinity.key_path === 'prompt_cache_key') return 'key_path:prompt_cache_key';
  return '';
}

async function cacheLogMetrics(rows) {
  const entries = rows.map(row => [row.id, row.user_agent || '', row.cache_tokens, row.trace_type]);
  for (let i = 0; i < entries.length; i += 500) {
    const values = [];
    const params = [];
    for (const [id, userAgent, cacheTokens, traceType] of entries.slice(i, i + 500)) {
      const offset = params.length;
      params.push(id, userAgent, cacheTokens, traceType);
      values.push(`($${offset + 1}, $${offset + 2}, 0, $${offset + 3}, $${offset + 4})`);
    }
    await pool.query(`INSERT INTO monitor_log_user_agents (log_id, user_agent, matched_delta_seconds, cache_tokens, trace_type) VALUES ${values.join(',')} ON CONFLICT (log_id) DO UPDATE SET user_agent = CASE WHEN EXCLUDED.user_agent <> '' THEN EXCLUDED.user_agent ELSE monitor_log_user_agents.user_agent END, cache_tokens = EXCLUDED.cache_tokens, trace_type = EXCLUDED.trace_type`, params);
  }
}

function upsertRecentLogs(existing, rows, limit = 100) {
  const seen = new Set();
  const merged = [...rows, ...(existing || [])].filter(item => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  merged.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  return merged.slice(0, limit);
}

function mergeTodaySnapshot(snapshot, rows) {
  const tokensMap = new Map((snapshot.tokens || []).map(t => [String(t.token_id), {
    ...t,
    count: parseInt(t.count) || 0,
    quota: parseInt(t.quota) || 0,
    prompt_tokens: parseInt(t.prompt_tokens) || 0,
    completion_tokens: parseInt(t.completion_tokens) || 0,
    total_tokens: parseFloat(t.total_tokens) || 0,
    cache_tokens: parseInt(t.cache_tokens) || 0,
    input_tokens: parseFloat(t.input_tokens) || 0,
    gpt_input_tokens: parseFloat(t.gpt_input_tokens) || 0,
    claude_input_tokens: parseFloat(t.claude_input_tokens) || 0,
    gpt_cache_tokens: parseInt(t.gpt_cache_tokens) || 0,
    claude_cache_tokens: parseInt(t.claude_cache_tokens) || 0,
    models: t.models || {},
  }]));

  for (const row of rows) {
    const key = String(row.token_id);
    if (!tokensMap.has(key)) {
      tokensMap.set(key, {
        token_id: row.token_id,
        token_name: row.token_name,
        username: row.username,
        user_id: row.user_id,
        count: 0,
        quota: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_tokens: 0,
        input_tokens: 0,
        gpt_input_tokens: 0,
        claude_input_tokens: 0,
        gpt_cache_tokens: 0,
        claude_cache_tokens: 0,
        models: {},
      });
    }
    const token = tokensMap.get(key);
    token.count += 1;
    // 失败日志（type=5）不产生扣费与 token 用量，只计入调用次数
    if (row.type === 2) {
      token.quota += row.quota || 0;
      token.prompt_tokens += row.prompt_tokens || 0;
      token.completion_tokens += row.completion_tokens || 0;
      token.total_tokens += (row.prompt_tokens || 0) + (row.completion_tokens || 0);
      token.cache_tokens += row.cache_tokens || 0;
      const familyInput = weightedInputTokens(row.prompt_tokens, row.cache_tokens, row.model_name);
      token.input_tokens += familyInput;
      if (/(gpt|codex)/i.test(row.model_name || '')) token.gpt_input_tokens += familyInput;
      if (/claude/i.test(row.model_name || '')) token.claude_input_tokens += familyInput;
      if (/(gpt|codex)/i.test(row.model_name || '')) token.gpt_cache_tokens += row.cache_tokens || 0;
      if (/claude/i.test(row.model_name || '')) token.claude_cache_tokens += row.cache_tokens || 0;
    }
    if (row.model_name) token.models[row.model_name] = (token.models[row.model_name] || 0) + 1;
  }

  const tokens = Array.from(tokensMap.values()).map(t => {
    const topModels = Object.entries(t.models || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return {
      ...t,
      models: Object.fromEntries(topModels),
    };
  }).sort((a, b) => b.input_tokens - a.input_tokens || b.count - a.count);

  return {
    ...snapshot,
    totalLogs: (snapshot.totalLogs || 0) + rows.length,
    dbTotal: (snapshot.dbTotal || 0) + rows.length,
    tokens,
  };
}

async function getTodayAggregation() {
  const ts = getRangeTs('today');
  const totalRes = await pool.query(`SELECT COUNT(*) as cnt FROM logs WHERE created_at >= $1 AND ${REQUEST_LOGS}`, [ts]);
  const total = parseInt(totalRes.rows[0].cnt);
  const tokensRes = await pool.query(`
    SELECT l.token_id, l.token_name, l.username, l.user_id,
      COUNT(*) as count,
      SUM(l.quota) FILTER (WHERE l.type = 2) as quota,
      SUM(l.prompt_tokens) FILTER (WHERE l.type = 2) as prompt_tokens,
      SUM(l.completion_tokens) FILTER (WHERE l.type = 2) as completion_tokens,
      SUM(COALESCE(l.prompt_tokens, 0) + COALESCE(l.completion_tokens, 0)) FILTER (WHERE l.type = 2) as total_tokens,
      SUM(COALESCE(m.cache_tokens, 0)) FILTER (WHERE l.type = 2) as cache_tokens,
      SUM(GREATEST(COALESCE(l.prompt_tokens, 0) - COALESCE(m.cache_tokens, 0), 0)
        + COALESCE(m.cache_tokens, 0) * CASE WHEN LOWER(COALESCE(l.model_name, '')) IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 0.1 ELSE 0.2 END)
        FILTER (WHERE l.type = 2) as input_tokens,
      SUM(CASE WHEN LOWER(COALESCE(l.model_name, '')) ~ '(gpt|codex)' THEN
        GREATEST(COALESCE(l.prompt_tokens, 0) - COALESCE(m.cache_tokens, 0), 0)
          + COALESCE(m.cache_tokens, 0) * CASE WHEN LOWER(COALESCE(l.model_name, '')) IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 0.1 ELSE 0.2 END
        ELSE 0 END) FILTER (WHERE l.type = 2) as gpt_input_tokens,
      SUM(CASE WHEN LOWER(COALESCE(l.model_name, '')) LIKE '%claude%' THEN
        GREATEST(COALESCE(l.prompt_tokens, 0) - COALESCE(m.cache_tokens, 0), 0)
          + COALESCE(m.cache_tokens, 0) * CASE WHEN LOWER(COALESCE(l.model_name, '')) IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna') THEN 0.1 ELSE 0.2 END
        ELSE 0 END) FILTER (WHERE l.type = 2) as claude_input_tokens,
      SUM(CASE WHEN LOWER(COALESCE(l.model_name, '')) ~ '(gpt|codex)' THEN COALESCE(m.cache_tokens, 0) ELSE 0 END)
        FILTER (WHERE l.type = 2) as gpt_cache_tokens,
      SUM(CASE WHEN LOWER(COALESCE(l.model_name, '')) LIKE '%claude%' THEN COALESCE(m.cache_tokens, 0) ELSE 0 END)
        FILTER (WHERE l.type = 2) as claude_cache_tokens
    FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
    WHERE l.created_at >= $1 AND l.${REQUEST_LOGS}
    GROUP BY l.token_id, l.token_name, l.username, l.user_id ORDER BY input_tokens DESC NULLS LAST
  `, [ts]);
  const tokens = tokensRes.rows.map(parseUsageRow);

  // 每个 token 取 TOP3 模型：用窗口函数一次查完。
  // 原来是每个 token 单独查一次，活跃 token 一多，快照重建时间线性膨胀（实测 16 个 token 要 5.9s，现在 0.35s）
  const modelRes = await pool.query(`
    WITH ranked AS (
      SELECT token_id, model_name, COUNT(*) AS cnt,
        ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY COUNT(*) DESC) AS rn
      FROM logs WHERE created_at >= $1 AND ${REQUEST_LOGS}
      GROUP BY token_id, model_name
    )
    SELECT token_id, model_name, cnt FROM ranked WHERE rn <= 3
  `, [ts]);
  const modelsByToken = new Map();
  for (const m of modelRes.rows) {
    const key = String(parseInt(m.token_id) || 0);
    if (!modelsByToken.has(key)) modelsByToken.set(key, {});
    modelsByToken.get(key)[m.model_name] = parseInt(m.cnt) || 0;
  }
  for (const t of tokens) t.models = modelsByToken.get(String(t.token_id)) || {};
  return { tokens, total };
}

async function getScriptTraceStatsForFilter(filterCol, filterVal, ts) {
  const filterSql = filterCol === 'username' ? 'username = $1' : 'token_id = $1';
  const { rows } = await pool.query(`
    WITH filtered AS (
      SELECT
        CASE
          WHEN other IS NOT NULL AND other <> '' AND LEFT(other, 1) = '{' THEN other::jsonb
          ELSE '{}'::jsonb
        END AS other_json
      FROM logs
      WHERE ${filterSql} AND created_at >= $2 AND ${REQUEST_LOGS}
    ),
    expanded AS (
      SELECT
        COALESCE(NULLIF(LOWER(other_json->'admin_info'->'channel_affinity'->>'reason'), ''), '') AS reason,
        COALESCE(NULLIF(LOWER(other_json->'admin_info'->'channel_affinity'->'override_template'->>'rule_name'), ''), '') AS rule_name,
        COALESCE(NULLIF(other_json->'admin_info'->'channel_affinity'->>'key_path', ''), '') AS key_path
      FROM filtered
    ),
    labeled AS (
      SELECT
        CASE
          WHEN reason LIKE '%claude cli trace%' OR rule_name LIKE '%claude cli trace%' THEN 'claude cli trace'
          WHEN reason LIKE '%codex cli trace%' OR rule_name LIKE '%codex cli trace%' THEN 'codex cli trace'
          WHEN key_path = 'metadata.user_id' THEN 'key_path:metadata.user_id'
          WHEN key_path = 'prompt_cache_key' THEN 'key_path:prompt_cache_key'
          ELSE NULL
        END AS trace_type
      FROM expanded
    )
    SELECT
      (SELECT COUNT(*) FROM labeled) AS total_calls,
      (SELECT COUNT(*) FROM labeled WHERE trace_type IS NOT NULL) AS flagged_calls,
      COALESCE((
        SELECT JSON_AGG(JSON_BUILD_OBJECT('type', trace_type, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT trace_type, COUNT(*) AS cnt
          FROM labeled
          WHERE trace_type IS NOT NULL
          GROUP BY trace_type
        ) grouped
      ), '[]'::json) AS breakdown
  `, [filterVal, ts]);

  const row = rows[0] || {};
  const totalCalls = parseInt(row.total_calls) || 0;
  const flaggedCalls = parseInt(row.flagged_calls) || 0;
  const breakdown = Array.isArray(row.breakdown) ? row.breakdown : [];
  const decision = buildScriptDisableDecision(flaggedCalls, totalCalls);
  return {
    ...decision,
    trace_types: breakdown.map(item => item.type),
    breakdown: breakdown.map(item => ({
      type: item.type,
      count: parseInt(item.count) || 0,
    })),
  };
}

async function getScriptDisableCandidates(ts) {
  const { rows } = await pool.query(`
    SELECT
      l.token_id, l.token_name, l.username, l.user_id,
      COUNT(*) AS total_calls,
      COUNT(*) FILTER (WHERE COALESCE(m.trace_type, '') <> '') AS flagged_calls,
      COUNT(*) FILTER (WHERE m.trace_type = 'claude cli trace' OR LOWER(COALESCE(l.model_name, '')) LIKE '%claude%') AS claude_calls,
      COUNT(*) FILTER (WHERE m.trace_type = 'codex cli trace' OR LOWER(COALESCE(l.model_name, '')) ~ '(gpt|codex)') AS gpt_calls,
      COALESCE(JSON_AGG(DISTINCT m.trace_type) FILTER (WHERE COALESCE(m.trace_type, '') <> ''), '[]'::json) AS trace_types
    FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
    WHERE l.created_at >= $1 AND l.${REQUEST_LOGS}
    GROUP BY l.token_id, l.token_name, l.username, l.user_id
    HAVING COUNT(*) FILTER (WHERE m.trace_type = 'claude cli trace' OR LOWER(COALESCE(l.model_name, '')) LIKE '%claude%') >= $2
        OR COUNT(*) FILTER (WHERE m.trace_type = 'codex cli trace' OR LOWER(COALESCE(l.model_name, '')) ~ '(gpt|codex)') >= $3
    ORDER BY flagged_calls DESC, total_calls DESC
  `, [ts, CONFIG.scriptClaudeAlertCalls, CONFIG.scriptGptAlertCalls]);

  return rows.map(r => {
    const totalCalls = parseInt(r.total_calls) || 0;
    const flaggedCalls = parseInt(r.flagged_calls) || 0;
    const claudeCalls = parseInt(r.claude_calls) || 0;
    const gptCalls = parseInt(r.gpt_calls) || 0;
    const alertReasons = [];
    if (claudeCalls >= CONFIG.scriptClaudeAlertCalls) alertReasons.push(`Claude ${claudeCalls} 次 ≥ ${CONFIG.scriptClaudeAlertCalls}`);
    if (gptCalls >= CONFIG.scriptGptAlertCalls) alertReasons.push(`GPT ${gptCalls} 次 ≥ ${CONFIG.scriptGptAlertCalls}`);
    return {
      token_id: parseInt(r.token_id) || 0,
      token_name: r.token_name,
      username: r.username,
      user_id: parseInt(r.user_id) || 0,
      trace_types: Array.isArray(r.trace_types) ? r.trace_types : [],
      claude_calls: claudeCalls,
      gpt_calls: gptCalls,
      alert_reasons: alertReasons,
      ...buildScriptDisableDecision(flaggedCalls, totalCalls),
      eligible: alertReasons.length > 0,
    };
  }).filter(r => r.eligible);
}

const ROLLUP_USAGE_AGG = `SUM(call_count) as count,
      SUM(quota) as quota,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(cache_tokens) as cache_tokens,
      SUM(${ROLLUP_INPUT_TOKENS_EXPR}) as input_tokens,
      SUM(${ROLLUP_GPT_INPUT_TOKENS_EXPR}) as gpt_input_tokens,
      SUM(${ROLLUP_CLAUDE_INPUT_TOKENS_EXPR}) as claude_input_tokens,
      SUM(${ROLLUP_GPT_CACHE_TOKENS_EXPR}) as gpt_cache_tokens,
      SUM(${ROLLUP_CLAUDE_CACHE_TOKENS_EXPR}) as claude_cache_tokens`;
// 两个中转站的 gpt-5.6-sol 都实际落到 Terra；缓存写入按普通新输入计费。
const TERRA_COST_AGG = `SUM(CASE WHEN model_name IN ('gpt-5.6-sol', 'gpt-5.6-terra') THEN
        (GREATEST(prompt_tokens - cache_tokens, 0) * 0.16 + cache_tokens * 0.016 + completion_tokens * 0.96) / 1000000.0
        ELSE 0 END) as cost_usd,
      SUM(CASE WHEN model_name IN ('gpt-5.6-sol', 'gpt-5.6-terra') THEN usage_count ELSE 0 END) as cost_priced_calls`;

function getUsageSource(range) {
  const ts = getRangeTs(range);
  const today = getRangeTs('today');
  return {
    params: [ts, today],
    sql: `
      SELECT token_id, token_name, username, user_id, ip, model_name, grp AS "group", channel_id, channel_name,
        user_agent, bucket_start, call_count, usage_count, quota, prompt_tokens, completion_tokens,
        total_tokens, cache_tokens, first_at, last_at
      FROM monitor_usage_rollups WHERE bucket_start >= $1 AND bucket_start < $2
      UNION ALL
      SELECT l.token_id, COALESCE(l.token_name, ''), COALESCE(l.username, ''), COALESCE(l.user_id, 0), COALESCE(l.ip, ''),
        COALESCE(l.model_name, ''), COALESCE(l."group", ''), COALESCE(l.channel_id, 0), COALESCE(l.channel_name, ''),
        CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END,
        (l.created_at / 3600) * 3600, 1, CASE WHEN l.type = 2 THEN 1 ELSE 0 END,
        CASE WHEN l.type = 2 THEN COALESCE(l.quota, 0) ELSE 0 END,
        CASE WHEN l.type = 2 THEN COALESCE(l.prompt_tokens, 0) ELSE 0 END,
        CASE WHEN l.type = 2 THEN COALESCE(l.completion_tokens, 0) ELSE 0 END,
        CASE WHEN l.type = 2 THEN COALESCE(l.prompt_tokens, 0) + COALESCE(l.completion_tokens, 0) ELSE 0 END,
        CASE WHEN l.type = 2 THEN COALESCE(m.cache_tokens, 0) ELSE 0 END,
        l.created_at, l.created_at
      FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
      WHERE l.created_at >= GREATEST($1, $2) AND l.${REQUEST_LOGS}`,
  };
}

async function buildUsageRollupDay(dayStart) {
  await pool.query(`
    INSERT INTO monitor_usage_rollups (
      bucket_start, dimension_hash, token_id, token_name, username, user_id, model_name, grp,
      channel_id, channel_name, ip, user_agent, call_count, usage_count, quota, prompt_tokens,
      completion_tokens, total_tokens, cache_tokens, first_at, last_at
    )
    SELECT (l.created_at / 3600) * 3600,
      MD5(CONCAT_WS(CHR(31), COALESCE(l.token_id, 0), COALESCE(l.token_name, ''), COALESCE(l.username, ''),
        COALESCE(l.user_id, 0), COALESCE(l.model_name, ''), COALESCE(l."group", ''), COALESCE(l.channel_id, 0),
        COALESCE(l.channel_name, ''), COALESCE(l.ip, ''), CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END)),
      COALESCE(l.token_id, 0), COALESCE(l.token_name, ''), COALESCE(l.username, ''), COALESCE(l.user_id, 0),
      COALESCE(l.model_name, ''), COALESCE(l."group", ''), COALESCE(l.channel_id, 0), COALESCE(l.channel_name, ''),
      COALESCE(l.ip, ''), CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END,
      COUNT(*), COUNT(*) FILTER (WHERE l.type = 2),
      COALESCE(SUM(l.quota) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(l.prompt_tokens) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(l.completion_tokens) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(COALESCE(l.prompt_tokens, 0) + COALESCE(l.completion_tokens, 0)) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(m.cache_tokens) FILTER (WHERE l.type = 2), 0), MIN(l.created_at), MAX(l.created_at)
    FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
    WHERE l.created_at >= $1 AND l.created_at < $2 AND l.${REQUEST_LOGS}
    GROUP BY (l.created_at / 3600) * 3600, COALESCE(l.token_id, 0), COALESCE(l.token_name, ''),
      COALESCE(l.username, ''), COALESCE(l.user_id, 0), COALESCE(l.model_name, ''), COALESCE(l."group", ''),
      COALESCE(l.channel_id, 0), COALESCE(l.channel_name, ''), COALESCE(l.ip, ''),
      CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END
    ON CONFLICT (bucket_start, dimension_hash) DO UPDATE SET
      call_count = EXCLUDED.call_count, usage_count = EXCLUDED.usage_count, quota = EXCLUDED.quota,
      prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens,
      total_tokens = EXCLUDED.total_tokens, cache_tokens = EXCLUDED.cache_tokens,
      first_at = EXCLUDED.first_at, last_at = EXCLUDED.last_at
  `, [dayStart, dayStart + 86400]);
}

async function ensureRecentUsageRollup() {
  const start = getRangeTs('30d');
  const today = getRangeTs('today');
  const { rows } = await pool.query('SELECT DISTINCT bucket_start FROM monitor_usage_rollups WHERE bucket_start >= $1 AND bucket_start < $2', [start, today]);
  const existing = new Set(rows.map(row => start + Math.floor((Number(row.bucket_start) - start) / 86400) * 86400));
  for (let day = start; day < today; day += 86400) {
    if (!existing.has(day)) { await buildUsageRollupDay(day); break; }
  }
}

async function getAggregation(range, dimension) {
  const source = getUsageSource(range);
  const dims = {
    token: { group: 'token_id, token_name, username, user_id', select: `token_id, token_name, username, user_id,
      COUNT(DISTINCT NULLIF(ip, '')) as ip_count` },
    user:  { group: 'username', select: 'username, COUNT(DISTINCT token_id) as token_count' },
    model: { group: 'model_name', select: 'model_name' },
    group: { group: '"group"', select: '"group" as grp' },
    channel: { group: 'channel_id, channel_name', select: 'channel_id as channel, channel_name' },
    ip: { group: "COALESCE(NULLIF(ip, ''), '(未记录)')", select: "COALESCE(NULLIF(ip, ''), '(未记录)') as ip, COUNT(DISTINCT username) as user_count, COUNT(DISTINCT token_id) as token_count, MIN(first_at) as first_at, MAX(last_at) as last_at" },
  };
  const d = dims[dimension] || dims.token;
  const select = d.select;
  const costAgg = dimension === 'token' ? `, ${TERRA_COST_AGG}` : '';
  const result = await pool.query(`
    WITH source AS MATERIALIZED (${source.sql})
    SELECT ${select}, ${ROLLUP_USAGE_AGG}${costAgg}
    FROM source GROUP BY ${d.group} ORDER BY ${dimension === 'ip' ? 'count' : 'input_tokens'} DESC NULLS LAST
  `, source.params);
  const rows = result.rows.map(parseUsageRow);
  if (dimension === 'token') {
    const uaRes = await pool.query(`
      WITH source AS MATERIALIZED (${source.sql})
      SELECT token_id, user_agent, SUM(usage_count) AS count FROM source
      WHERE user_agent <> '' GROUP BY token_id, user_agent
    `, source.params);
    const byToken = new Map();
    for (const r of uaRes.rows) {
      if (!r.user_agent) continue;
      const token = String(r.token_id);
      const counts = byToken.get(token) || new Map();
      counts.set(r.user_agent, (counts.get(r.user_agent) || 0) + (parseInt(r.count) || 0));
      byToken.set(token, counts);
    }
    for (const row of rows) {
      const counts = byToken.get(String(row.token_id)) || new Map();
      row.user_agents = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    }
  }
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, total };
}

async function getHourlyTrend(range) {
  const source = getUsageSource(range);
  const labelExpr = range === 'today'
    ? "LPAD(EXTRACT(HOUR FROM TO_TIMESTAMP(bucket_start) AT TIME ZONE $3)::TEXT, 2, '0') || ':00'"
    : "TO_CHAR(TO_TIMESTAMP(bucket_start) AT TIME ZONE $3, 'MM-DD HH24') || 'h'";
  const res = await pool.query(`
    WITH source AS MATERIALIZED (${source.sql})
    SELECT ${labelExpr} as label,
      SUM(call_count) as count,
      SUM(quota) as quota,
      SUM(total_tokens) as total_tokens,
      COUNT(DISTINCT token_id) as active_tokens,
      COUNT(DISTINCT username) as active_users
    FROM source GROUP BY bucket_start, label ORDER BY bucket_start
  `, [...source.params, CONFIG.timezone]);
  return res.rows.map(r => ({
    label: r.label,
    count: parseInt(r.count),
    quota: parseInt(r.quota) || 0,
    total_tokens: parseFloat(r.total_tokens) || 0,
    active_tokens: parseInt(r.active_tokens),
    active_users: parseInt(r.active_users),
  }));
}

async function getDistribution(range) {
  const source = getUsageSource(range);
  // 模型分布 TOP 10
  const modelRes = await pool.query(`
    WITH source AS MATERIALIZED (${source.sql})
    SELECT model_name, ${ROLLUP_USAGE_AGG}
    FROM source GROUP BY model_name ORDER BY count DESC LIMIT 10
  `, source.params);
  // 用户分布 TOP 10（按调用次数）
  const userRes = await pool.query(`
    WITH source AS MATERIALIZED (${source.sql})
    SELECT username, ${ROLLUP_USAGE_AGG}
    FROM source GROUP BY username ORDER BY count DESC LIMIT 10
  `, source.params);
  // 用户 token 用量 TOP 10（调用次数少但吃 token 的用户不会被漏掉）
  const userTokenRes = await pool.query(`
    WITH source AS MATERIALIZED (${source.sql})
    SELECT username, ${ROLLUP_USAGE_AGG}
    FROM source GROUP BY username ORDER BY input_tokens DESC NULLS LAST LIMIT 10
  `, source.params);
  // Token/Key 分布 TOP 10
  const tokenRes = await pool.query(`
    WITH source AS MATERIALIZED (${source.sql})
    SELECT token_id, token_name, username, ${ROLLUP_USAGE_AGG}
    FROM source GROUP BY token_id, token_name, username ORDER BY count DESC LIMIT 10
  `, source.params);
  return {
    models: modelRes.rows.map(parseUsageRow),
    users: userRes.rows.map(parseUsageRow),
    users_by_tokens: userTokenRes.rows.map(parseUsageRow),
    tokens: tokenRes.rows.map(parseUsageRow),
  };
}

async function fetchStatData() {
  let statData = { quota: 0, rpm: 0, tpm: 0 };
  try {
    const stat = await apiRequest('/api/log/stat');
    if (stat.success) statData = stat.data;
  } catch {}
  return statData;
}

async function getSnapshotTodayCached() {
  const key = 'snapshot:today';
  const cached = await readCacheEnvelope(key);
  const todayAnchor = getRangeAnchor('today');
  if (cached && cached.meta && cached.meta.anchor === todayAnchor) {
    latestSnapshot = cached.value;
    return cached.value;
  }
  return await withCacheLock(key, async () => {
    const secondRead = await readCacheEnvelope(key);
    if (secondRead && secondRead.meta && secondRead.meta.anchor === todayAnchor) {
      latestSnapshot = secondRead.value;
      return secondRead.value;
    }
    const { tokens, total } = await getTodayAggregation();
    const statData = await fetchStatData();
    latestSnapshot = {
      time: Date.now(),
      totalLogs: total,
      dbTotal: total,
      stat: statData,
      tokens,
    };
    const cursor = await getLatestLogCursor();
    await writeCacheEnvelope(key, latestSnapshot, { anchor: todayAnchor, lastLogId: cursor.maxId }, CONFIG.cacheTtlSeconds);
    return latestSnapshot;
  });
}

// 报错明细的行数上限：正常量级（30 天约 4.5 万行）远低于此值，只作为异常膨胀时的兜底
const ERROR_ROWS_LIMIT = parseInt(process.env.ERROR_ROWS_LIMIT) || 200000;

async function getErrorAnalysis(range) {
  return await getOrBuildCached(`error-analysis:v4:${range}`, range, async () => {
    const ts = getRangeTs(range);

    const [countRes, channelCountRes, errorRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as cnt FROM logs WHERE created_at >= $1 AND ${REQUEST_LOGS}`, [ts]),
      pool.query(`
        SELECT
          COALESCE(NULLIF(channel_id::text, ''), 'unknown') AS channel_key,
          COALESCE(NULLIF(channel_name, ''), 'unknown') AS channel_name,
          COUNT(*) AS total_requests
        FROM logs
        WHERE created_at >= $1 AND ${REQUEST_LOGS}
        GROUP BY COALESCE(NULLIF(channel_id::text, ''), 'unknown'), COALESCE(NULLIF(channel_name, ''), 'unknown')
      `, [ts]),
      // 关键：字段解析和「是否失败」的判断都下推到 SQL，绝不把 other 整列传回 Node。
      // 原来这里会把范围内所有带 JSON 的消费日志全查回来再在 JS 里过滤：
      // 30 天 = 26 万行、238MB 文本进内存；下推后只剩真实失败行（约 4.5 万行、2.7MB）。
      pool.query(`
        WITH parsed AS (
          SELECT id, created_at, type, content, username, token_name, token_id, model_name,
            channel_id, channel_name,
            CASE
              WHEN REPLACE(other, chr(92) || 'u0000', '') IS JSON
              THEN REPLACE(other, chr(92) || 'u0000', '')::jsonb
              ELSE '{}'::jsonb
            END AS oj
          FROM logs
          WHERE created_at >= $1
            AND (type = 5 OR (type = 2 AND other IS NOT NULL AND other <> '' AND LEFT(other, 1) = '{'))
        )
        SELECT id, created_at, type, content, username, token_name, token_id, model_name,
          COALESCE(
            NULLIF(NULLIF(channel_id::text, ''), '0'),
            NULLIF(NULLIF(oj->>'channel_id', ''), '0'),
            NULLIF(NULLIF(oj->'admin_info'->'channel_affinity'->>'channel_id', ''), '0'),
            'unknown'
          ) AS resolved_channel_key,
          COALESCE(
            NULLIF(channel_name, ''),
            NULLIF(oj->>'channel_name', ''),
            NULLIF(NULLIF(oj->'admin_info'->'channel_affinity'->>'channel_id', ''), '0')
          ) AS resolved_channel_raw,
          COALESCE(NULLIF(oj->>'status_code', ''), 'unknown') AS status_code,
          COALESCE(NULLIF(oj->>'error_type', ''), 'unknown') AS error_type,
          COALESCE(oj->'stream_status'->>'status', '') AS stream_status,
          COALESCE(NULLIF(oj->'stream_status'->>'end_reason', ''), 'unknown') AS stream_end_reason
        FROM parsed
        WHERE type = 5 OR COALESCE(oj->'stream_status'->>'status', '') = 'error'
        ORDER BY created_at DESC
        LIMIT $2
      `, [ts, ERROR_ROWS_LIMIT]),
    ]);

    const totalRequests = parseInt(countRes.rows[0].cnt) || 0;
    const channelTotalMap = new Map(channelCountRes.rows.map(r => [r.channel_key, {
      channel_name: r.channel_name,
      total_requests: parseInt(r.total_requests) || 0,
    }]));

    // SQL 已经完成解析与过滤，这里只做类型规整
    const normalizedRows = errorRes.rows.map(r => ({
      id: r.id,
      created_at: parseInt(r.created_at) || 0,
      type: parseInt(r.type) || 0,
      content: r.content || '',
      username: r.username || '',
      token_name: r.token_name || '',
      token_id: parseInt(r.token_id) || 0,
      model_name: r.model_name || '',
      resolved_channel_key: r.resolved_channel_key || 'unknown',
      resolved_channel: r.resolved_channel_raw || r.resolved_channel_key || 'unknown',
      status_code: r.status_code || 'unknown',
      error_type: r.error_type || 'unknown',
      stream_status: r.stream_status || '',
      stream_end_reason: r.stream_end_reason || 'unknown',
    }));
    const truncated = normalizedRows.length >= ERROR_ROWS_LIMIT;

    const mainFailures = normalizedRows.filter(r => r.type === 5);
    const streamInterrupts = normalizedRows.filter(r => r.type === 2);
    const totalFailures = normalizedRows.length;

    const affectedChannels = new Set(normalizedRows.map(r => r.resolved_channel_key)).size;
    const summary = {
      total_requests: totalRequests,
      main_failures: mainFailures.length,
      stream_interrupts: streamInterrupts.length,
      total_failures: totalFailures,
      affected_channels: affectedChannels,
      main_failure_rate: totalRequests ? +(mainFailures.length * 100 / totalRequests).toFixed(2) : 0,
      stream_interrupt_rate: totalRequests ? +(streamInterrupts.length * 100 / totalRequests).toFixed(2) : 0,
      total_failure_rate: totalRequests ? +(totalFailures * 100 / totalRequests).toFixed(2) : 0,
      truncated,          // 命中行数上限时为 true，前端需提示统计只覆盖最近 N 条
      row_limit: ERROR_ROWS_LIMIT,
    };

    const channelMap = new Map();
    for (const r of normalizedRows) {
      if (!channelMap.has(r.resolved_channel_key)) {
        channelMap.set(r.resolved_channel_key, {
          channel_name: r.resolved_channel,
          total_requests: 0,
          main_failures: 0,
          stream_interrupts: 0,
          total_failures: 0,
          status_codes: new Map(),
        });
      }
      const ch = channelMap.get(r.resolved_channel_key);
      ch.main_failures += r.type === 5 ? 1 : 0;
      ch.stream_interrupts += r.type === 2 ? 1 : 0;
      ch.total_failures += 1;
      if (r.type === 5 && r.status_code !== 'unknown') {
        ch.status_codes.set(r.status_code, (ch.status_codes.get(r.status_code) || 0) + 1);
      }
    }
    for (const [key, ch] of channelMap) {
      const totalInfo = channelTotalMap.get(key);
      if (totalInfo) {
        ch.total_requests = totalInfo.total_requests;
        ch.channel_name = totalInfo.channel_name !== 'unknown' ? totalInfo.channel_name : ch.channel_name;
      }
    }
    const channels = Array.from(channelMap.entries())
      .map(([, ch]) => {
        const topStatusCodes = Array.from(ch.status_codes.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([status_code, count]) => ({ status_code, count }));
        return {
          channel_name: ch.channel_name,
          total_requests: ch.total_requests,
          main_failures: ch.main_failures,
          stream_interrupts: ch.stream_interrupts,
          total_failures: ch.total_failures,
          main_failure_rate: ch.total_requests ? +(ch.main_failures * 100 / ch.total_requests).toFixed(2) : 0,
          stream_interrupt_rate: ch.total_requests ? +(ch.stream_interrupts * 100 / ch.total_requests).toFixed(2) : 0,
          total_failure_rate: ch.total_requests ? +(ch.total_failures * 100 / ch.total_requests).toFixed(2) : 0,
          top_status_codes: topStatusCodes,
        };
      })
      .sort((a, b) => b.total_failure_rate - a.total_failure_rate || b.total_failures - a.total_failures || b.total_requests - a.total_requests)
      .slice(0, 100);

    const statusCodeMap = new Map();
    for (const r of mainFailures) {
      if (r.status_code === 'unknown') continue;
      statusCodeMap.set(r.status_code, (statusCodeMap.get(r.status_code) || 0) + 1);
    }
    const statusCodesChannelMap = new Map();
    for (const r of mainFailures) {
      if (r.status_code === 'unknown') continue;
      if (!statusCodesChannelMap.has(r.status_code)) {
        statusCodesChannelMap.set(r.status_code, new Set());
      }
      statusCodesChannelMap.get(r.status_code).add(r.resolved_channel_key);
    }
    const status_codes = Array.from(statusCodeMap.entries())
      .map(([status_code, count]) => ({
        status_code,
        count,
        channel_count: statusCodesChannelMap.get(status_code)?.size || 0,
      }))
      .sort((a, b) => b.count - a.count);

    const streamReasonMap = new Map();
    for (const r of streamInterrupts) {
      streamReasonMap.set(r.stream_end_reason, (streamReasonMap.get(r.stream_end_reason) || 0) + 1);
    }
    const streamReasonChannelMap = new Map();
    for (const r of streamInterrupts) {
      if (!streamReasonChannelMap.has(r.stream_end_reason)) {
        streamReasonChannelMap.set(r.stream_end_reason, new Set());
      }
      streamReasonChannelMap.get(r.stream_end_reason).add(r.resolved_channel_key);
    }
    const stream_reasons = Array.from(streamReasonMap.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        channel_count: streamReasonChannelMap.get(reason)?.size || 0,
      }))
      .sort((a, b) => b.count - a.count);

    const recent_errors = normalizedRows.slice(0, 50).map(r => ({
      ...r,
      label: r.type === 5 ? (r.status_code || 'unknown') : `stream:${r.stream_end_reason || 'unknown'}`,
    }));

    const groupMap = new Map();
    for (const r of normalizedRows) {
      const category = classifyErrorGroup(r);
      const normalizedContent = normalizeErrorContent(r.content);
      const groupKey = `${r.type}|${category.category_code}`;
      const channelName = r.resolved_channel || 'unknown';
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          type: r.type,
          category_code: category.category_code,
          category_label: category.category_label,
          status_code: r.status_code,
          stream_end_reason: r.stream_end_reason,
          count: 0,
          channel_set: new Set(),
          channel_counts: new Map(),
          variants: new Map(),
          first_at: r.created_at,
          last_at: r.created_at,
        });
      }
      const g = groupMap.get(groupKey);
      g.count++;
      g.channel_set.add(r.resolved_channel_key);
      if (!g.channel_counts.has(r.resolved_channel_key)) {
        g.channel_counts.set(r.resolved_channel_key, {
          channel_key: r.resolved_channel_key,
          channel_name: channelName,
          count: 0,
        });
      }
      const channelStat = g.channel_counts.get(r.resolved_channel_key);
      channelStat.count++;
      if (!channelStat.channel_name || channelStat.channel_name === 'unknown') {
        channelStat.channel_name = channelName;
      }
      if (!g.variants.has(normalizedContent)) {
        g.variants.set(normalizedContent, {
          normalized_content: normalizedContent,
          content: r.content,
          count: 0,
          last_at: r.created_at,
          channel_name: channelName,
        });
      }
      const variant = g.variants.get(normalizedContent);
      variant.count++;
      if (r.created_at >= variant.last_at) {
        variant.last_at = r.created_at;
        variant.content = r.content;
        variant.channel_name = channelName;
      }
      if (r.created_at < g.first_at) g.first_at = r.created_at;
      if (r.created_at > g.last_at) g.last_at = r.created_at;
    }
    const error_groups = Array.from(groupMap.values())
      .map(g => {
        const sortedExamples = Array.from(g.variants.values())
          .sort((a, b) => b.count - a.count || b.last_at - a.last_at)[0];
        const examples = Array.from(g.variants.values())
          .sort((a, b) => b.count - a.count || b.last_at - a.last_at)
          .slice(0, 5)
          .map(example => ({
            content: example.content || '',
            normalized_content: example.normalized_content || '(空)',
            count: example.count,
            last_at: example.last_at,
            channel_name: example.channel_name || 'unknown',
          }));
        const top_channels = Array.from(g.channel_counts.values())
          .sort((a, b) => b.count - a.count || a.channel_name.localeCompare(b.channel_name))
          .slice(0, 3);
        return {
          content: sortedExamples?.content || '',
          normalized_content: sortedExamples?.normalized_content || '(空)',
          type: g.type,
          category_code: g.category_code,
          category_label: g.category_label,
          status_code: g.status_code,
          stream_end_reason: g.stream_end_reason,
          count: g.count,
          channel_count: g.channel_set.size,
          channels: Array.from(g.channel_set).slice(0, 10),
          top_channels,
          examples,
          example_count: g.variants.size,
          variant_count: g.variants.size,
          first_at: g.first_at,
          last_at: g.last_at,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);

    return {
      summary,
      channels,
      status_codes,
      stream_reasons,
      recent_errors,
      error_groups,
    };
  });
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

async function recordAction({ tokenId, tokenName, username, action, reason, dailyCount = null, meta = null }) {
  await pool.query(
    `INSERT INTO monitor_actions (token_id, token_name, username, action, reason, action_meta, daily_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tokenId, tokenName || null, username || null, action, reason || null, meta ? JSON.stringify(meta) : null, dailyCount]
  );
  await cacheDeleteByPrefix('actions:recent');
}

// ==================== 定时监控 ====================
let latestSnapshot = null;
let isPolling = false;

// 真正执行禁用。此前这个能力只在手动 API 里存在，轮询分支从来没调用过 setTokenStatus——
// 也就是说「自动禁用」一直没有生效。现在按 disablePolicy 决定：
//   notify_only（默认）→ 只告警，行为与升级前一致
//   auto              → 调 NewAPI 禁用 Token，并落一条 auto_disable 记录
async function maybeDisableToken({ token, enabled, action, reason, meta }) {
  if (!enabled) return false;
  if (!token.token_id || whitelistSet.has(token.token_id)) return false;
  if (!token.user_id) {
    console.warn(`  ⏭️ 缺少 user_id，无法禁用 Token #${token.token_id}`);
    return false;
  }
  // 当天已经禁用过就不重复调用
  const dup = await pool.query(
    'SELECT 1 FROM monitor_actions WHERE token_id = $1 AND action = $2 AND created_at >= $3 LIMIT 1',
    [token.token_id, action, getRangeTs('today')]
  );
  if (dup.rows.length > 0) return false;

  const result = await setTokenStatus(token.token_id, token.user_id, 2);
  await recordAction({
    tokenId: token.token_id,
    tokenName: token.token_name,
    username: token.username,
    action,
    reason: result.success ? reason : `${reason}（禁用失败：${result.message || '未知错误'}）`,
    dailyCount: token.count,
    meta: { ...meta, disabled: !!result.success, error: result.success ? undefined : result.message },
  });
  if (result.success) {
    console.log(`  🔒 已禁用 Token #${token.token_id}（${reason}）`);
    await notifyAlert({
      title: `🔒 [已自动禁用] ${token.username} / ${token.token_name || token.token_id}`,
      level: 'danger',
      lines: [`**原因**：${reason}`, `**Token**：${token.token_name}（ID: ${token.token_id}）`, '如需恢复，请在面板中手动启用。'],
    });
  } else {
    console.error(`  ❌ 禁用 Token #${token.token_id} 失败: ${result.message}`);
  }
  return !!result.success;
}

async function pollAndCheck() {
  if (isPolling) return;
  isPolling = true;
  try {
    console.log(`[${new Date().toLocaleString()}] 开始查询数据库...`);
    const startOfDayUnix = getRangeTs('today');
    const prevCursor = await cacheGetJson('state:cursor');
    const nowCursor = await getLatestLogCursor();
    const todaySnapshotEnvelope = await readCacheEnvelope('snapshot:today');

    const metricsLastId = parseInt(await getKV('metrics:last_log_id')) || 0;
    if (metricsLastId && metricsLastId < nowCursor.maxId) {
      await cacheLogMetrics(await fetchLogsSinceId(metricsLastId));
    }
    await setKV('metrics:last_log_id', nowCursor.maxId);
    await ensureRecentUsageRollup();

    if (prevCursor && prevCursor.maxId && prevCursor.maxId < nowCursor.maxId) {
      const rows = await fetchLogsSinceId(prevCursor.maxId);
      await cacheLogMetrics(rows);
      if (todaySnapshotEnvelope && prevCursor.anchor === nowCursor.anchor && rows.length > 0 && todaySnapshotEnvelope.value) {
        const statData = await fetchStatData();
        latestSnapshot = mergeTodaySnapshot(todaySnapshotEnvelope.value, rows.filter(r => r.created_at >= startOfDayUnix));
        latestSnapshot.time = Date.now();
        latestSnapshot.stat = statData;
        await writeCacheEnvelope('snapshot:today', latestSnapshot, { anchor: nowCursor.anchor, lastLogId: nowCursor.maxId }, CONFIG.cacheTtlSeconds);
      }
    }

    if (!latestSnapshot || !todaySnapshotEnvelope || !todaySnapshotEnvelope.meta || todaySnapshotEnvelope.meta.anchor !== nowCursor.anchor) {
      latestSnapshot = await getSnapshotTodayCached();
    } else if (!latestSnapshot) {
      latestSnapshot = todaySnapshotEnvelope.value;
    }

    const { tokens, totalLogs: total } = latestSnapshot;
    await cacheSetJson('state:cursor', nowCursor, 86400);
    await Promise.all([
      cacheDeleteByPrefix('stats:'),
      cacheDeleteByPrefix('trend:'),
      cacheDeleteByPrefix('distribution:'),
      cacheDeleteByPrefix('recent-logs:'),
      cacheDeleteByPrefix('dashboard:'),
      cacheDeleteByPrefix('token-statuses'),
    ]);

    console.log(`[${new Date().toLocaleString()}] 今日共 ${total} 条日志，${tokens.length} 个 token`);

    // 自动通知并尝试禁用超标 token
    for (const t of tokens) {
      if (CONFIG.alertDailyLimit && t.count > CONFIG.dailyLimit && !whitelistSet.has(t.token_id)) {
        console.log(`⚠️ token ${t.token_name}(${t.token_id}) 今日 ${t.count} 次，超标！`);
        const checkRes = await pool.query(
          "SELECT 1 FROM monitor_actions WHERE token_id = $1 AND action = 'notify' AND created_at >= $2",
          [t.token_id, startOfDayUnix]
        );
        if (checkRes.rows.length === 0) {
          const usd = ((t.quota || 0) / CONFIG.quotaPerUnit).toFixed(2);
          const results = await notifyAlert({
            title: `🚨 [超限警告] Token: ${t.token_name} (用户: ${t.username})`,
            level: 'danger',
            lines: [
              `**用户**：${t.username}`,
              `**Token**：${t.token_name}（ID: ${t.token_id}）`,
              `**今日调用**：${t.count} 次，已超过阈值 ${CONFIG.dailyLimit} 次`,
              `**Token 用量**：${(t.total_tokens || 0).toLocaleString()}（缓存读取 ${(t.cache_tokens || 0).toLocaleString()}）`,
              `**费用**：$${usd}`,
            ],
          });
          const okChannels = results.filter(r => r.ok).map(r => r.channel);
          if (okChannels.length) {
            console.log(`  🔔 已通知 [${okChannels.join(', ')}] (Token #${t.token_id})`);
            await recordAction({
              tokenId: t.token_id,
              tokenName: t.token_name,
              username: t.username,
              action: 'notify',
              reason: `日调用 ${t.count} 次超限`,
              dailyCount: t.count,
              meta: { policy: 'daily_limit', limit: CONFIG.dailyLimit, channels: okChannels },
            });
          } else if (results.length === 0) {
            console.warn(`  🔕 未配置任何通知渠道，跳过 (Token #${t.token_id})`);
          }
          await maybeDisableToken({
            token: t,
            enabled: CONFIG.disablePolicy === 'auto',
            action: 'auto_disable',
            reason: `日调用 ${t.count} 次超过阈值 ${CONFIG.dailyLimit}`,
            meta: { policy: 'daily_limit', limit: CONFIG.dailyLimit },
          });
        }

      }
    }

    const candidates = await getScriptDisableCandidates(Math.floor(Date.now() / 1000) - 86400);
    for (const item of candidates) {
      if (!item.token_id || whitelistSet.has(item.token_id)) continue;
      console.log(`⚠️ token ${item.token_name}(${item.token_id}) 命中脚本 trace，比例 ${item.ratio_pct}% / 次数 ${item.flagged_calls}`);
      if (!CONFIG.notifyScript) continue;
      // 与超限告警一样按天去重，避免每轮轮询重复轰炸
      const dup = await pool.query(
        "SELECT 1 FROM monitor_actions WHERE token_id = $1 AND action = 'notify_script' AND created_at >= $2",
        [item.token_id, startOfDayUnix]
      );
      if (dup.rows.length > 0) continue;
      const results = await notifyAlert({
        title: `🤖 [脚本行为] Token: ${item.token_name} (用户: ${item.username})`,
        level: 'warning',
        lines: [
          `**用户**：${item.username}`,
          `**Token**：${item.token_name}（ID: ${item.token_id}）`,
          `**触发条件**：${item.alert_reasons.join('；')}`,
          `**Claude / GPT 调用**：${item.claude_calls} / ${item.gpt_calls}`,
          `**Trace 命中**：${item.flagged_calls} / ${item.total_calls}（${item.ratio_pct}%）`,
          `**Trace 类型**：${(item.trace_types || []).join('、') || '未知'}`,
        ],
      });
      const okChannels = results.filter(r => r.ok).map(r => r.channel);
      if (okChannels.length) {
        await recordAction({
          tokenId: item.token_id,
          tokenName: item.token_name,
          username: item.username,
          action: 'notify_script',
          reason: `脚本告警：${item.alert_reasons.join('；')}`,
          dailyCount: item.total_calls,
          meta: { policy: 'script_trace', trace_types: item.trace_types, channels: okChannels },
        });
      }
      await maybeDisableToken({
        token: { token_id: item.token_id, token_name: item.token_name, username: item.username, user_id: item.user_id, count: item.total_calls },
        enabled: CONFIG.disablePolicy === 'auto' && CONFIG.disableOnScript,
        action: 'auto_disable_script',
        reason: `脚本告警：${item.alert_reasons.join('；')}`,
        meta: { policy: 'script_trace', trace_types: item.trace_types },
      });
    }
  } catch (err) {
    console.error('轮询出错:', err.message);
  } finally {
    isPolling = false;
  }
}

// ==================== 订阅余量 ====================
// NewAPI 把订阅信息写在 logs.other 里（subscription_remain / total / plan_title）。
// 取每个用户「最近一条消费日志」的订阅快照，也就是他当前正在消耗的那个套餐。
async function getSubscriptions(hours = 168) {
  const seconds = Math.max(1, hours) * 3600;
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT DISTINCT ON (username) username, user_id, id, created_at, other
      FROM logs
      WHERE type = 2 AND created_at >= EXTRACT(EPOCH FROM NOW())::bigint - $1
        AND other LIKE '%"subscription_remain"%'
      ORDER BY username, id DESC
    )
    SELECT username, user_id, created_at,
      other::jsonb->>'subscription_plan_title' AS plan,
      (other::jsonb->>'subscription_remain')::bigint AS remain,
      (other::jsonb->>'subscription_total')::bigint  AS total,
      (other::jsonb->>'subscription_used')::bigint   AS used
    FROM recent
    WHERE (other::jsonb->>'subscription_total')::bigint > 0
  `, [seconds]);
  return rows.map(r => {
    const remain = parseInt(r.remain) || 0;
    const total = parseInt(r.total) || 0;
    return {
      username: r.username,
      user_id: parseInt(r.user_id) || 0,
      plan: r.plan || '未知套餐',
      last_at: parseInt(r.created_at) || 0,
      remain, total,
      used: parseInt(r.used) || 0,
      remain_usd: +(remain / CONFIG.quotaPerUnit).toFixed(2),
      total_usd: +(total / CONFIG.quotaPerUnit).toFixed(2),
      remain_pct: total ? +(remain * 100 / total).toFixed(1) : 0,
    };
  }).sort((a, b) => a.remain_pct - b.remain_pct);
}

// 余量低于阈值时提醒续费；按用户 + 档位去重，从 20% 掉到 5% 会再提醒一次
async function checkSubscriptions() {
  if (!CONFIG.alertSubscription || !CONFIG.subscriptionAlertPct) return;
  try {
    const subs = await getSubscriptions(168);
    for (const s of subs) {
      if (s.remain_pct > CONFIG.subscriptionAlertPct) continue;
      const tier = s.remain_pct <= 0 ? 'empty' : s.remain_pct <= 5 ? '5' : s.remain_pct <= 10 ? '10' : String(CONFIG.subscriptionAlertPct);
      await alertOnce({
        kind: 'alert_subscription',
        subject: `sub:${s.username}:${tier}`,
        alert: {
          title: `📉 [订阅余量告急] ${s.username}`,
          level: s.remain_pct <= 5 ? 'danger' : 'warning',
          lines: [
            `**用户**：${s.username}`,
            `**套餐**：${s.plan}`,
            `**剩余**：$${s.remain_usd} / $${s.total_usd}（**${s.remain_pct}%**）`,
            s.remain_pct <= 0 ? '套餐已耗尽，请联系客户续费。' : '建议提前触达续费。',
          ],
        },
        record: {
          tokenId: 0, username: s.username,
          reason: `订阅剩余 ${s.remain_pct}%（$${s.remain_usd} / $${s.total_usd}）`,
          meta: { policy: 'subscription_low', plan: s.plan, remain_usd: s.remain_usd, total_usd: s.total_usd, pct: s.remain_pct },
        },
      });
    }
  } catch (err) {
    console.error('订阅余量检查出错:', err.message);
  }
}

// ==================== 实时风控规则 ====================
// 与 pollAndCheck（日累计阈值）互补：这里看的是「最近几分钟发生了什么」，
// 所以一个脚本刚开始刷就能告警，而不用等日累计撞线。
let isRuleRunning = false;

// 同一对象同类告警在冷却期内只发一次；即使没配通知渠道也落库，面板「通知记录」即告警日志
async function alertOnce({ kind, subject, alert, record }) {
  const since = Math.floor(Date.now() / 1000) - CONFIG.alertCooldownMin * 60;
  const dup = await pool.query(
    "SELECT 1 FROM monitor_actions WHERE action = $1 AND action_meta->>'subject' = $2 AND created_at >= $3 LIMIT 1",
    [kind, String(subject), since]
  );
  if (dup.rows.length > 0) return false;
  const results = await notifyAlert(alert);
  await recordAction({
    ...record,
    action: kind,
    meta: { ...(record.meta || {}), subject: String(subject), channels: results.filter(r => r.ok).map(r => r.channel) },
  });
  return true;
}

async function runRealtimeRules() {
  if (!CONFIG.ruleEnabled || isRuleRunning) return;
  isRuleRunning = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowSec = Math.max(1, CONFIG.surgeWindowMin) * 60;
    const curFrom = now - windowSec;
    const prevFrom = now - windowSec * 2;

    // 一条查询同时拿到：本窗口/上一窗口调用数、本窗口费用与 token 用量、本窗口 IP 数
    const { rows } = await pool.query(`
      SELECT token_id, token_name, username, user_id,
        COUNT(*) FILTER (WHERE created_at >= $1) AS cur_calls,
        COUNT(*) FILTER (WHERE created_at <  $1) AS prev_calls,
        COALESCE(SUM(quota) FILTER (WHERE created_at >= $1 AND type = 2), 0) AS cur_quota,
        COALESCE(SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)) FILTER (WHERE created_at >= $1 AND type = 2), 0) AS cur_tokens,
        COUNT(DISTINCT ip) FILTER (WHERE created_at >= $1 AND COALESCE(ip, '') <> '') AS cur_ips
      FROM logs WHERE created_at >= $2 AND ${REQUEST_LOGS}
      GROUP BY token_id, token_name, username, user_id
      HAVING COUNT(*) FILTER (WHERE created_at >= $1) > 0
    `, [curFrom, prevFrom]);

    const win = CONFIG.surgeWindowMin;
    for (const r of rows) {
      const tokenId = parseInt(r.token_id) || 0;
      if (whitelistSet.has(tokenId)) continue;
      const cur = parseInt(r.cur_calls) || 0;
      const prev = parseInt(r.prev_calls) || 0;
      const usd = (parseInt(r.cur_quota) || 0) / CONFIG.quotaPerUnit;
      const tokens = parseInt(r.cur_tokens) || 0;
      const ips = parseInt(r.cur_ips) || 0;
      const who = `${r.username} / ${r.token_name || tokenId}`;
      const base = { tokenId, tokenName: r.token_name, username: r.username };

      // 规则 1+2：用量异常 —— 调用量突增（绝对/相对）与费用速率共用一条告警和一个冷却，
      // 否则同一次事件会同时推突增和费用两条消息，纯噪音。
      const ratio = prev > 0 ? cur / prev : (cur >= CONFIG.surgeMinCalls ? Infinity : 0);
      const hitAbs = cur >= CONFIG.surgeCalls;
      const hitRatio = cur >= CONFIG.surgeMinCalls && ratio >= CONFIG.surgeRatio;
      const hitCost = CONFIG.surgeCostUsd > 0 && usd >= CONFIG.surgeCostUsd;
      const triggers = [];
      if (hitAbs) triggers.push(`窗口调用数 ${cur} ≥ ${CONFIG.surgeCalls}`);
      if (hitRatio) triggers.push(`较上一窗口放大 ${ratio === Infinity ? '∞' : ratio.toFixed(1)}× ≥ ${CONFIG.surgeRatio}×`);
      if (hitCost) triggers.push(`窗口费用 $${usd.toFixed(2)} ≥ $${CONFIG.surgeCostUsd}`);
      if (CONFIG.alertUsageAnomaly && triggers.length) {
        const costOnly = hitCost && !hitAbs && !hitRatio;
        await alertOnce({
          kind: 'alert_usage',
          subject: `token:${tokenId}`,
          alert: {
            title: `${costOnly ? '💸 [费用飙升]' : '⚡ [用量异常]'} ${who}`,
            level: 'danger',
            lines: [
              `**${win} 分钟内调用**：${cur} 次${prev ? `（上一窗口 ${prev} 次，${ratio === Infinity ? '∞' : ratio.toFixed(1)}×）` : '（上一窗口无调用）'}`,
              `**Token 用量**：${tokens.toLocaleString()}`,
              `**费用**：$${usd.toFixed(2)}，约 **$${(usd * 60 / win).toFixed(2)}/小时**`,
              `**来源 IP 数**：${ips}`,
              `触发条件：${triggers.join('；')}`,
            ],
          },
          record: {
            ...base,
            reason: costOnly
              ? `${win} 分钟内消耗 $${usd.toFixed(2)}（约 $${(usd * 60 / win).toFixed(2)}/h）`
              : `${win} 分钟内 ${cur} 次调用、$${usd.toFixed(2)}`,
            dailyCount: cur,
            meta: { policy: 'usage_anomaly', cur, prev, usd: +usd.toFixed(4), tokens, triggers },
          },
        });
      }

      // 规则 3：单个 Token 短时间内来自多个 IP —— 账号共享/转卖的典型特征
      if (ips >= CONFIG.shareIpPerToken) {
        await alertOnce({
          kind: 'alert_token_ips',
          subject: `token:${tokenId}`,
          alert: {
            title: `👥 [疑似共享] ${who}`,
            level: 'warning',
            lines: [
              `**${win} 分钟内来源 IP**：${ips} 个`,
              `**调用次数**：${cur} 次`,
              `触发条件：单 Token 窗口内 IP 数 ≥ ${CONFIG.shareIpPerToken}`,
            ],
          },
          record: { ...base, reason: `${win} 分钟内来自 ${ips} 个 IP`, dailyCount: cur, meta: { policy: 'token_multi_ip', ips } },
        });
      }
    }

    // 规则 4：同一 IP 下出现多个账号
    if (CONFIG.alertIpUsers && CONFIG.shareUsersPerIp > 1) {
      const ipRes = await pool.query(`
        SELECT ip, COUNT(DISTINCT username) AS users, COUNT(DISTINCT token_id) AS tokens,
          COUNT(*) AS calls, STRING_AGG(DISTINCT username, ', ') AS usernames
        FROM logs WHERE created_at >= $1 AND ${REQUEST_LOGS} AND COALESCE(ip, '') <> ''
        GROUP BY ip HAVING COUNT(DISTINCT username) >= $2
      `, [curFrom, CONFIG.shareUsersPerIp]);
      for (const r of ipRes.rows) {
        await alertOnce({
          kind: 'alert_ip_users',
          subject: `ip:${r.ip}`,
          alert: {
            title: `🌐 [同 IP 多账号] ${r.ip}`,
            level: 'warning',
            lines: [
              `**IP**：${r.ip}`,
              `**${win} 分钟内账号数**：${r.users}（${r.usernames}）`,
              `**Token 数**：${r.tokens} · **调用**：${r.calls} 次`,
              `触发条件：单 IP 窗口内账号数 ≥ ${CONFIG.shareUsersPerIp}`,
            ],
          },
          record: { tokenId: 0, username: r.usernames, reason: `IP ${r.ip} 下有 ${r.users} 个账号`, dailyCount: parseInt(r.calls) || 0, meta: { policy: 'ip_multi_user', ip: r.ip, users: parseInt(r.users) || 0 } },
        });
      }
    }
  } catch (err) {
    console.error('实时规则出错:', err.message);
  } finally {
    isRuleRunning = false;
  }
}

// ==================== API 路由 ====================
app.get('/api/snapshot', async (req, res) => {
  const data = latestSnapshot || await getSnapshotTodayCached();
  res.json({ success: true, data });
});

app.post('/api/poll', async (req, res) => {
  await pollAndCheck();
  res.json({ success: true, data: latestSnapshot });
});

app.get('/api/stats', async (req, res) => {
  const range = req.query.range || 'today';
  const dim = req.query.dim || 'token';
  const data = await getOrBuildCached(`stats:${range}:${dim}`, range, () => getAggregation(range, dim));
  res.json({ success: true, data });
});

app.get('/api/trend', async (req, res) => {
  const range = req.query.range || 'today';
  const data = await getOrBuildCached(`trend:${range}`, range, () => getHourlyTrend(range));
  res.json({ success: true, data });
});

app.get('/api/distribution', async (req, res) => {
  const range = req.query.range || 'today';
  const data = await getOrBuildCached(`distribution:${range}`, range, () => getDistribution(range));
  res.json({ success: true, data });
});

app.get('/api/dashboard', async (req, res) => {
  const range = req.query.range || 'today';
  const dim = req.query.dim || 'token';
  const data = await getOrBuildCached(`dashboard:${range}:${dim}`, range, async () => {
    const [snapshot, stats, statuses, actions, whitelist] = await Promise.all([
      range === 'today' ? getSnapshotTodayCached() : null,
      getAggregation(range, dim),
      getTokenStatuses(),
      pool.query('SELECT * FROM monitor_actions ORDER BY id DESC LIMIT 50').then(r => r.rows),
      pool.query('SELECT * FROM monitor_whitelist').then(r => r.rows),
    ]);
    return {
      config: {
        dailyLimit: CONFIG.dailyLimit,
        pollInterval: CONFIG.pollInterval,
        notifyEmail: CONFIG.notifyEmail,
        baseUrl: CONFIG.baseUrl,
        quotaPerUnit: CONFIG.quotaPerUnit,
      },
      whitelist,
      snapshot,
      stats,
      tokenStatuses: statuses,
      actions,
    };
  });
  res.json({ success: true, data });
});

app.get('/api/subscriptions', async (req, res) => {
  const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 168));
  try {
    const data = await getOrBuildCached(`subscriptions:${hours}`, 'today', () => getSubscriptions(hours));
    res.json({ success: true, data, alertPct: CONFIG.subscriptionAlertPct });
  } catch (err) {
    console.error('订阅余量查询错误:', err.message);
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/error-analysis', async (req, res) => {
  const range = req.query.range || 'today';
  try {
    const data = await getErrorAnalysis(range);
    res.json({ success: true, data });
  } catch (err) {
    console.error('报错分析错误:', err.message);
    res.json({ success: false, message: err.message });
  }
});

const USER_REQUEST_PAGE_SIZE = 3;

async function getUserAnalysisRequests(filterCol, filterVal, ts, page = 1) {
  const safePage = Math.min(10000, Math.max(1, parseInt(page) || 1));
  const result = await pool.query(`
    SELECT id, created_at, model_name, ip, request_id, COALESCE(other_json->>'user_agent', backfill_user_agent) AS user_agent,
      COALESCE((${CLIENT_EXPR}), backfill_user_agent) AS client, other_json->'request_body' AS request_body
    FROM (
      SELECT l.id, l.created_at, l.model_name, l.ip, l.request_id, ${SAFE_OTHER_JSON_EXPR.replaceAll('other', 'l.other')} AS other_json,
        m.user_agent AS backfill_user_agent
      FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
      WHERE l.${filterCol} = $1 AND l.created_at >= $2 AND l.type = 2
      ORDER BY l.created_at DESC LIMIT $3 OFFSET $4
    ) recent ORDER BY created_at DESC
  `, [filterVal, ts, USER_REQUEST_PAGE_SIZE, (safePage - 1) * USER_REQUEST_PAGE_SIZE]);
  return result.rows.map(r => ({
    ...r,
    id: String(r.id),
    created_at: parseInt(r.created_at) || 0,
  }));
}

app.get('/api/user-analysis/requests', async (req, res) => {
  const { username, token_id, range, page } = req.query;
  if (!username && !token_id) return res.json({ success: false, message: '缺少 username 或 token_id' });
  const filterCol = username ? 'username' : 'token_id';
  const filterVal = username ? username : parseInt(token_id);
  const safePage = Math.min(10000, Math.max(1, parseInt(page) || 1));
  try {
    const items = await getUserAnalysisRequests(filterCol, filterVal, getRangeTs(range || 'today'), safePage);
    res.json({ success: true, data: { items, page: safePage, pageSize: USER_REQUEST_PAGE_SIZE } });
  } catch (err) {
    console.error('请求明细查询错误:', err.message);
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/user-analysis', async (req, res) => {
  const { username, token_id, token_name, range } = req.query;
  if (!username && !token_id) return res.json({ success: false, message: '缺少 username 或 token_id' });
  const ts = getRangeTs(range || 'today');

  const filterCol = username ? 'username' : 'token_id';
  const filterVal = username ? username : parseInt(token_id);

  try {
    // 1. 基本统计
    const basicRes = await pool.query(`
      SELECT COUNT(*) as total_calls, COUNT(*) FILTER (WHERE type = 2) as request_count, COUNT(DISTINCT token_id) as token_count,
        COUNT(DISTINCT model_name) as model_count, user_id,
        COUNT(DISTINCT NULLIF(ip, '')) as ip_count,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(ip, '')), NULL) as ips,
        MIN(created_at) as first_at, MAX(created_at) as last_at,
        SUM(quota) FILTER (WHERE type = 2) as total_quota,
        SUM(prompt_tokens) FILTER (WHERE type = 2) as total_prompt,
        SUM(completion_tokens) FILTER (WHERE type = 2) as total_completion,
        SUM(${CACHE_TOKENS_EXPR}) FILTER (WHERE type = 2) as total_cache
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS} GROUP BY user_id
    `, [filterVal, ts]);
    if (basicRes.rows.length === 0) return res.json({ success: true, data: null });
    const basic = basicRes.rows[0];
    basic.total_calls = parseInt(basic.total_calls);
    basic.request_count = parseInt(basic.request_count) || 0;
    basic.total_quota = parseInt(basic.total_quota) || 0;
    basic.total_prompt = parseInt(basic.total_prompt) || 0;
    basic.total_completion = parseInt(basic.total_completion) || 0;
    basic.total_cache = parseInt(basic.total_cache) || 0;
    basic.ip_count = parseInt(basic.ip_count) || 0;
    const ips = Array.isArray(basic.ips) ? basic.ips : [];
    delete basic.ips;
    basic.total_tokens = basic.total_prompt + basic.total_completion;
    const scriptTraceStats = await getScriptTraceStatsForFilter(filterCol, filterVal, ts);
    const autoDisableWindowStats = filterCol === 'token_id'
      ? await getScriptTraceStatsForFilter(filterCol, filterVal, Math.floor(Date.now() / 1000) - 86400)
      : scriptTraceStats;
    const scriptSignals = scriptTraceStats.breakdown.map(item => `${item.type} × ${item.count}`);

    // 2. 每小时分布
    const hourlyRes = await pool.query(`
      SELECT EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE $3)::INT as hour,
        COUNT(*) as count
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS} GROUP BY hour ORDER BY hour
    `, [filterVal, ts, CONFIG.timezone]);
    const hourly = hourlyRes.rows.map(r => ({ hour: r.hour, count: parseInt(r.count) }));

    // 3. 调用间隔分析（最近5000条，含时间序列用于散点图）
    const intRes = await pool.query(`
      WITH ordered AS (
        SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) as prev_at
        FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS}
      )
      SELECT created_at, (created_at - prev_at) as gap FROM ordered WHERE prev_at IS NOT NULL
      ORDER BY created_at DESC LIMIT 5000
    `, [filterVal, ts]);
    let intervals = null;
    let intervalTimeline = []; // 用于散点图
    if (intRes.rows.length > 0) {
      const gaps = intRes.rows.map(r => parseInt(r.gap)).sort((a, b) => a - b);
      // 时间序列（采样最多200点用于散点图，避免前端卡顿）
      const timelineRaw = intRes.rows.map(r => ({ t: parseInt(r.created_at), gap: parseInt(r.gap) })).reverse();
      const step = Math.max(1, Math.floor(timelineRaw.length / 200));
      intervalTimeline = timelineRaw.filter((_, i) => i % step === 0);

      const len = gaps.length;
      const avg = gaps.reduce((s, v) => s + v, 0) / len;
      const stddev = Math.sqrt(gaps.reduce((s, v) => s + (v - avg) ** 2, 0) / len);
      const sub1 = gaps.filter(v => v <= 1).length;
      const sub3 = gaps.filter(v => v <= 3).length;
      const sub5 = gaps.filter(v => v <= 5).length;
      const sub10 = gaps.filter(v => v <= 10).length;
      // 直方图
      const buckets = [0,1,2,3,5,10,30,60,300,600,3600,Infinity];
      const hist = new Array(buckets.length - 1).fill(0);
      for (const v of gaps) { for (let i = 0; i < buckets.length - 1; i++) { if (v >= buckets[i] && v < buckets[i+1]) { hist[i]++; break; } } }
      intervals = {
        count: len, avg: +avg.toFixed(2), median: gaps[Math.floor(len/2)],
        min: gaps[0], max: gaps[len-1], p5: gaps[Math.floor(len*0.05)], p95: gaps[Math.floor(len*0.95)],
        stddev: +stddev.toFixed(2), cv: +(stddev/avg).toFixed(4),
        sub1, sub3, sub5, sub10, hist,
      };
    }

    // 4. 模型分布
    const modelRes = await pool.query(`
      SELECT model_name, ${USAGE_AGG}
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS}
      GROUP BY model_name ORDER BY count DESC LIMIT 20
    `, [filterVal, ts]);
    const models = modelRes.rows.map(parseUsageRow);

    const uaRes = await pool.query(`
      SELECT m.user_agent, COUNT(*) AS count
      FROM logs l JOIN monitor_log_user_agents m ON m.log_id = l.id
      WHERE l.${filterCol} = $1 AND l.created_at >= $2 AND l.type = 2
      GROUP BY m.user_agent ORDER BY count DESC
    `, [filterVal, ts]);
    const uaCounts = new Map();
    for (const r of uaRes.rows) {
      if (!r.user_agent) continue;
      uaCounts.set(r.user_agent, (uaCounts.get(r.user_agent) || 0) + (parseInt(r.count) || 0));
    }
    const userAgents = [...uaCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    // 5. 最近请求明细（请求体从网关审计副本读取，历史日志可能没有）
    const recentRequests = await getUserAnalysisRequests(filterCol, filterVal, ts);

    // 6. 并发检测
    const concurRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT created_at FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS}
        GROUP BY created_at HAVING COUNT(*) > 1
      ) t
    `, [filterVal, ts]);
    const concurrentPoints = parseInt(concurRes.rows[0].cnt);

    // 7. 连续快速调用
    const streakRes = await pool.query(`
      WITH ordered AS (
        SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) as prev_at
        FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS}
      ),
      flagged AS (
        SELECT created_at, CASE WHEN (created_at - prev_at) <= 2 THEN 0 ELSE 1 END as ng
        FROM ordered WHERE prev_at IS NOT NULL
      ),
      grouped AS (SELECT *, SUM(ng) OVER (ORDER BY created_at) as grp FROM flagged)
      SELECT COUNT(*)+1 as len FROM grouped WHERE ng = 0
      GROUP BY grp HAVING COUNT(*) >= 4
      ORDER BY len DESC LIMIT 10
    `, [filterVal, ts]);
    const streaks = streakRes.rows.map(r => parseInt(r.len));

    // 8. 深夜活跃
    const nightRes = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE $3) BETWEEN 0 AND 5) as n
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS}
    `, [filterVal, ts, CONFIG.timezone]);
    const nightCalls = parseInt(nightRes.rows[0].n);

    // 9. 会话检测（间隔 > 300s 即视为新会话）
    const sessionRes = await pool.query(`
      WITH ordered AS (
        SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) as prev_at
        FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS}
      ),
      breaks AS (
        SELECT created_at, prev_at,
          CASE WHEN prev_at IS NULL OR (created_at - prev_at) > 300 THEN 1 ELSE 0 END as is_break
        FROM ordered
      ),
      sessions AS (
        SELECT *, SUM(is_break) OVER (ORDER BY created_at) as session_id FROM breaks
      )
      SELECT session_id, COUNT(*) as calls, MIN(created_at) as start_at, MAX(created_at) as end_at,
        MAX(created_at) - MIN(created_at) as duration
      FROM sessions GROUP BY session_id ORDER BY session_id
    `, [filterVal, ts]);
    const sessionList = sessionRes.rows.map(r => ({
      calls: parseInt(r.calls), duration: parseInt(r.duration) || 0,
      start: parseInt(r.start_at), end: parseInt(r.end_at),
    }));
    const sessions = {
      count: sessionList.length,
      avgDuration: sessionList.length > 0 ? Math.round(sessionList.reduce((s, v) => s + v.duration, 0) / sessionList.length) : 0,
      avgCalls: sessionList.length > 0 ? Math.round(sessionList.reduce((s, v) => s + v.calls, 0) / sessionList.length) : 0,
      maxDuration: sessionList.length > 0 ? Math.max(...sessionList.map(s => s.duration)) : 0,
      maxCalls: sessionList.length > 0 ? Math.max(...sessionList.map(s => s.calls)) : 0,
    };

    // 10. 星期分布
    const weekdayRes = await pool.query(`
      SELECT EXTRACT(DOW FROM TO_TIMESTAMP(created_at) AT TIME ZONE $3)::INT as dow,
        COUNT(*) as count
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 AND ${REQUEST_LOGS} GROUP BY dow ORDER BY dow
    `, [filterVal, ts, CONFIG.timezone]);
    const weekday = new Array(7).fill(0);
    for (const r of weekdayRes.rows) weekday[r.dow] = parseInt(r.count);

    // 11. 脚本评分（v4：分离夜间/白天独立分析）
    let score = 0; const reasons = [];

    // 先把 hourly 按时段分类
    const nightHourly = hourly.filter(h => h.hour >= 0 && h.hour <= 6);
    const dayHourly = hourly.filter(h => h.hour >= 7 && h.hour <= 23);
    const nightActiveHours = nightHourly.length; // 0-6 点中有几个小时有调用
    const dayActiveHours = dayHourly.length;
    const nightCallsFromHourly = nightHourly.reduce((s, h) => s + h.count, 0);
    const dayCallsFromHourly = dayHourly.reduce((s, h) => s + h.count, 0);
    const activeHours = hourly.length;

    // ===== 维度1：夜间活跃模式（0-6点，最强信号）=====
    // 正常人凌晨不会持续多个小时都有调用
    if (nightActiveHours >= 5) { score += 5; reasons.push(`凌晨${nightActiveHours}个小时持续活跃（通宵脚本）`); }
    else if (nightActiveHours >= 3) { score += 3; reasons.push(`凌晨${nightActiveHours}个小时活跃`); }
    else if (nightActiveHours === 0 && basic.total_calls > 50) { score -= 2; reasons.push('凌晨无活动（正常作息）'); }

    // ===== 维度2：夜间调用量占比 =====
    const nightPct = basic.total_calls > 0 ? nightCalls / basic.total_calls : 0;
    if (nightPct > 0.4) { score += 3; reasons.push(`深夜占比${(nightPct*100).toFixed(1)}%`); }
    else if (nightPct > 0.2) { score += 2; reasons.push(`深夜占比${(nightPct*100).toFixed(1)}%`); }

    // ===== 维度3：白天+夜间全覆盖 =====
    // 如果白天和夜间都在活跃，说明 7x24 运行
    if (nightActiveHours >= 3 && dayActiveHours >= 5) {
      score += 3; reasons.push(`昼夜全覆盖（夜${nightActiveHours}h+日${dayActiveHours}h）`);
    }

    // ===== 维度4：总活跃时间跨度 =====
    if (activeHours >= 16) { score += 2; reasons.push(`横跨${activeHours}小时`); }
    else if (activeHours <= 3) { score -= 2; reasons.push(`仅活跃${activeHours}小时（短时使用）`); }

    // ===== 维度5：间隔规律性 =====
    if (intervals) {
      if (intervals.cv < 0.3) { score += 2; reasons.push(`间隔极度规律(CV=${intervals.cv})`); }
      else if (intervals.cv < 0.5) { score += 1; reasons.push(`间隔较规律`); }
    }

    // ===== 维度6：并发 =====
    if (concurrentPoints > 20) { score += 2; reasons.push(`${concurrentPoints}个并发时间点`); }
    else if (concurrentPoints > 5) { score += 1; reasons.push(`${concurrentPoints}个并发时间点`); }

    // ===== 维度7：连续快速调用 =====
    if (streaks.length >= 5) { score += 2; reasons.push(`${streaks.length}段机器式连续调用`); }
    else if (streaks.length >= 2) { score += 1; reasons.push(`${streaks.length}段连续调用`); }
    else if (streaks.length === 0 && basic.total_calls > 100) { score -= 1; reasons.push('无连续爆发'); }

    // ===== 维度8：星期分布 =====
    const weekdaySum = weekday[1]+weekday[2]+weekday[3]+weekday[4]+weekday[5];
    const weekendSum = weekday[0]+weekday[6];
    if (weekdaySum > 0 && weekendSum > 0) {
      const weekdayAvg = weekdaySum / 5;
      const weekendAvg = weekendSum / 2;
      if (weekendAvg >= weekdayAvg * 0.8) { score += 1; reasons.push('周末与工作日无差异'); }
    }

    // 兜底
    score = Math.max(0, score);
    const maxScore = 20;

    // 调用密度（仅展示，不影响评分）
    const density = activeHours > 0 ? Math.round(basic.total_calls / activeHours) : 0;

    res.json({ success: true, data: {
      username: username || token_name || token_id, basic, ips, hourly, intervals, intervalTimeline,
      models, userAgents,
      recentRequests, recentRequestsPage: { page: 1, pageSize: USER_REQUEST_PAGE_SIZE, total: basic.request_count },
      concurrentPoints, streaks, sessions, weekday,
      nightCalls, nightPct: +(nightPct * 100).toFixed(1),
      activeHours, nightActiveHours, dayActiveHours, density,
      scriptSignals,
      scriptTraceStats,
      autoDisableEligible: !!(filterCol === 'token_id' && autoDisableWindowStats.eligible),
      autoDisableWindowStats,
      score: { value: Math.min(score, maxScore), max: maxScore, reasons },
    }});
  } catch (err) {
    console.error('用户分析错误:', err.message);
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/recent-logs', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.p) || 1);
  const pageSize = Math.min(100, parseInt(req.query.page_size) || 20);
  const range = req.query.range || 'today';
  const ip = String(req.query.ip || '').trim();
  const data = await getOrBuildCached(`recent-logs:${range}:${page}:${pageSize}:ip:${ip || '-'}`, range, async () => {
    const ts = getRangeTs(range);
    const offset = (page - 1) * pageSize;
    const where = ip
      ? `WHERE created_at >= $1 AND ip = $2 AND ${REQUEST_LOGS}`
      : `WHERE created_at >= $1 AND ${REQUEST_LOGS}`;
    const values = ip ? [ts, ip] : [ts];
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as cnt FROM logs ${where}`, values),
      pool.query(`
        SELECT id, created_at, type, username, token_name, token_id, model_name, quota,
          prompt_tokens, completion_tokens, ${CACHE_TOKENS_EXPR} as cache_tokens,
          channel_name, "group" as grp, ip
        FROM logs ${where}
        ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `, [...values, pageSize, offset]),
    ]);
    return { items: dataRes.rows, total: parseInt(countRes.rows[0].cnt), page, pageSize };
  });  res.json({
    success: true,
    data,
  });
});

app.get('/api/actions', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const data = await getOrBuildCached(`actions:recent:${limit}`, 'today', async () => {
    const { rows } = await pool.query('SELECT * FROM monitor_actions ORDER BY id DESC LIMIT $1', [limit]);
    return rows;
  }, 30);
  res.json({ success: true, data });
});

app.post('/api/token/:id/disable', async (req, res) => {
  const tokenId = parseInt(req.params.id);
  const userId = req.body.user_id;
  if (!userId) return res.json({ success: false, message: '缺少 user_id' });
  const result = await setTokenStatus(tokenId, userId, 2);
  if (result.success) {
    await recordAction({ tokenId, action: 'manual_disable', reason: '手动禁用' });
  }
  res.json(result);
});

app.post('/api/token/:id/enable', async (req, res) => {
  const tokenId = parseInt(req.params.id);
  const userId = req.body.user_id;
  if (!userId) return res.json({ success: false, message: '缺少 user_id' });
  const result = await setTokenStatus(tokenId, userId, 1);
  if (result.success) {
    await recordAction({ tokenId, action: 'manual_enable', reason: '手动启用' });
  }
  res.json(result);
});

app.get('/api/token-status', async (req, res) => {
  const statuses = await getOrBuildCached('token-statuses', 'today', () => getTokenStatuses(), 30);
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
  await cacheDeleteByPrefix('dashboard:');
  res.json({ success: true });
});

app.delete('/api/whitelist/:id', async (req, res) => {
  const tokenId = parseInt(req.params.id);
  await pool.query('DELETE FROM monitor_whitelist WHERE token_id = $1', [tokenId]);
  whitelistSet.delete(tokenId);
  await cacheDeleteByPrefix('dashboard:');
  res.json({ success: true });
});

app.get('/api/config', (req, res) => {
  res.json({ success: true, data: publicConfig() });
});

// 密钥类字段永远不回传明文：webhook 只回掩码，密码/签名只回“是否已设置”
function publicConfig() {
  return {
    dailyLimit: CONFIG.dailyLimit,
    pollInterval: CONFIG.pollInterval,
    notifyEmail: CONFIG.notifyEmail,
    timezone: CONFIG.timezone,
    baseUrl: CONFIG.baseUrl,
    quotaPerUnit: CONFIG.quotaPerUnit,
    realtimeIntervalMs: CONFIG.realtimeIntervalMs,
    smtpHost: CONFIG.smtpHost,
    smtpPort: CONFIG.smtpPort,
    smtpSecure: CONFIG.smtpSecure,
    smtpUser: CONFIG.smtpUser,
    smtpFrom: CONFIG.smtpFrom,
    smtpPassSet: Boolean(CONFIG.smtpPass),
    feishuWebhookMasked: maskSecret(CONFIG.feishuWebhook, 8),
    feishuWebhookSet: Boolean(CONFIG.feishuWebhook),
    feishuSecretSet: Boolean(CONFIG.feishuSecret),
    notifyScript: CONFIG.notifyScript,
    alertDailyLimit: CONFIG.alertDailyLimit,
    alertUsageAnomaly: CONFIG.alertUsageAnomaly,
    alertIpUsers: CONFIG.alertIpUsers,
    alertSubscription: CONFIG.alertSubscription,
    scriptClaudeAlertCalls: CONFIG.scriptClaudeAlertCalls,
    scriptGptAlertCalls: CONFIG.scriptGptAlertCalls,
    disablePolicy: CONFIG.disablePolicy,
    disableOnScript: CONFIG.disableOnScript,
    ruleEnabled: CONFIG.ruleEnabled,
    ruleIntervalMs: CONFIG.ruleIntervalMs,
    surgeWindowMin: CONFIG.surgeWindowMin,
    surgeCalls: CONFIG.surgeCalls,
    surgeRatio: CONFIG.surgeRatio,
    surgeMinCalls: CONFIG.surgeMinCalls,
    surgeCostUsd: CONFIG.surgeCostUsd,
    shareIpPerToken: CONFIG.shareIpPerToken,
    shareUsersPerIp: CONFIG.shareUsersPerIp,
    alertCooldownMin: CONFIG.alertCooldownMin,
    subscriptionAlertPct: CONFIG.subscriptionAlertPct,
    channels: {
      email: Boolean(getTransporter()),
      feishu: Boolean(CONFIG.feishuWebhook),
    },
  };
}

app.put('/api/config', async (req, res) => {
  const body = req.body || {};
  const timezone = body.timezone;
  const normalizedTimeZone = timezone == null ? null : String(timezone).trim();
  if (normalizedTimeZone != null && !isValidTimeZone(normalizedTimeZone)) {
    return res.status(400).json({ success: false, message: '无效时区，请使用 IANA 时区名称，例如 Asia/Shanghai' });
  }
  // 掩码原样回传视为「不修改」，其余情况必须是合法 URL
  if (body.feishuWebhook && !String(body.feishuWebhook).startsWith('******')) {
    try { new URL(String(body.feishuWebhook).trim()); }
    catch { return res.status(400).json({ success: false, message: '飞书 Webhook 需要是完整的 http(s) 地址' }); }
  }

  const apply = async (key, value, parse = v => v) => {
    if (value == null) return;
    CONFIG[key] = parse(value);
    await setKV(key, CONFIG[key]);
  };

  await apply('dailyLimit', body.dailyLimit, v => parseInt(v));
  if (body.pollInterval != null) {
    await apply('pollInterval', body.pollInterval, v => parseInt(v));
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollAndCheck, CONFIG.pollInterval);
  }
  await apply('notifyEmail', body.notifyEmail, v => String(v).trim());
  if (timezone != null) await apply('timezone', normalizedTimeZone);
  await apply('smtpHost', body.smtpHost, v => String(v).trim());
  await apply('smtpPort', body.smtpPort, v => parseInt(v) || 587);
  await apply('smtpSecure', body.smtpSecure, v => Boolean(v));
  await apply('smtpUser', body.smtpUser, v => String(v).trim());
  await apply('smtpFrom', body.smtpFrom, v => String(v).trim());
  await apply('notifyScript', body.notifyScript, v => Boolean(v));
  await apply('alertDailyLimit', body.alertDailyLimit, v => Boolean(v));
  await apply('alertUsageAnomaly', body.alertUsageAnomaly, v => Boolean(v));
  await apply('alertIpUsers', body.alertIpUsers, v => Boolean(v));
  await apply('alertSubscription', body.alertSubscription, v => Boolean(v));
  await apply('scriptClaudeAlertCalls', body.scriptClaudeAlertCalls, v => Math.max(1, parseInt(v) || 1500));
  await apply('scriptGptAlertCalls', body.scriptGptAlertCalls, v => Math.max(1, parseInt(v) || 800));
  await apply('disablePolicy', body.disablePolicy, v => (v === 'auto' ? 'auto' : 'notify_only'));
  await apply('disableOnScript', body.disableOnScript, v => Boolean(v));
  await apply('ruleEnabled', body.ruleEnabled, v => Boolean(v));
  await apply('surgeWindowMin', body.surgeWindowMin, v => Math.max(1, parseInt(v) || 5));
  await apply('surgeCalls', body.surgeCalls, v => Math.max(1, parseInt(v) || 300));
  await apply('surgeRatio', body.surgeRatio, v => Math.max(1, parseFloat(v) || 5));
  await apply('surgeMinCalls', body.surgeMinCalls, v => Math.max(1, parseInt(v) || 30));
  await apply('surgeCostUsd', body.surgeCostUsd, v => Math.max(0, parseFloat(v) || 0));
  await apply('shareIpPerToken', body.shareIpPerToken, v => Math.max(1, parseInt(v) || 2));
  await apply('shareUsersPerIp', body.shareUsersPerIp, v => Math.max(1, parseInt(v) || 2));
  await apply('alertCooldownMin', body.alertCooldownMin, v => Math.max(1, parseInt(v) || 30));
  await apply('subscriptionAlertPct', body.subscriptionAlertPct, v => Math.min(100, Math.max(0, parseFloat(v) || 0)));
  // 空字符串 = 保持原值；显式传 null 才是清空
  if (body.smtpPass) await apply('smtpPass', body.smtpPass);
  if (body.smtpPass === null) await apply('smtpPass', '');
  if (body.feishuWebhook && !String(body.feishuWebhook).startsWith('******')) {
    await apply('feishuWebhook', String(body.feishuWebhook).trim());
  }
  if (body.feishuWebhook === null) await apply('feishuWebhook', '');
  if (body.feishuSecret) await apply('feishuSecret', String(body.feishuSecret).trim());
  if (body.feishuSecret === null) await apply('feishuSecret', '');

  console.log(`⚙️ 配置已更新: dailyLimit=${CONFIG.dailyLimit}, pollInterval=${CONFIG.pollInterval}, 通知渠道=${[getTransporter() && 'email', CONFIG.feishuWebhook && 'feishu'].filter(Boolean).join('+') || '无'}`);
  await Promise.all([
    cacheDeleteByPrefix('dashboard:'),
    cacheDeleteByPrefix('stats:'),
    cacheDeleteByPrefix('trend:'),
    cacheDeleteByPrefix('distribution:'),
    cacheDeleteByPrefix('recent-logs:'),
  ]);
  res.json({ success: true, data: publicConfig() });
});

// 面板上「发送测试」按钮位于「保存设置」之前，用户往往还没保存就点测试。
// 这里接受表单里的当前值：密钥类字段留空或仍是掩码 = 沿用已保存的值，其余字段以传入值为准。
function testOverrides(body) {
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  const str = (key, fallback) => (has(key) && body[key] != null ? String(body[key]).trim() : fallback);
  const secret = (key, fallback) => {
    const v = has(key) && body[key] != null ? String(body[key]).trim() : '';
    return !v || v.startsWith('******') ? fallback : v;
  };
  return {
    smtp: {
      host: str('smtpHost', CONFIG.smtpHost),
      port: has('smtpPort') ? (parseInt(body.smtpPort) || 587) : CONFIG.smtpPort,
      secure: has('smtpSecure') ? Boolean(body.smtpSecure) : CONFIG.smtpSecure,
      user: str('smtpUser', CONFIG.smtpUser),
      pass: secret('smtpPass', CONFIG.smtpPass),
      from: str('smtpFrom', CONFIG.smtpFrom),
      to: str('notifyEmail', CONFIG.notifyEmail),
    },
    feishu: {
      webhook: secret('feishuWebhook', CONFIG.feishuWebhook),
      secret: secret('feishuSecret', CONFIG.feishuSecret),
    },
  };
}

// 通知渠道连通性测试：channel = email | feishu | all
app.post('/api/notify/test', async (req, res) => {
  const body = req.body || {};
  const channel = String(body.channel || 'all');
  const override = testOverrides(body);
  const alert = {
    title: '✅ NewAPI Monitor 测试通知',
    level: 'info',
    lines: [
      '这是一条测试消息，收到即代表通知渠道配置正确。',
      `**当前阈值**：日调用 ${CONFIG.dailyLimit} 次`,
      `**轮询间隔**：${Math.round(CONFIG.pollInterval / 1000)} 秒`,
    ],
  };
  const results = [];
  const run = async (name, fn) => {
    try { await fn(alert); results.push({ channel: name, ok: true }); }
    catch (err) { results.push({ channel: name, ok: false, message: err.message }); }
  };
  if (channel === 'email' || channel === 'all') await run('email', a => sendEmail(a, override.smtp));
  if (channel === 'feishu' || channel === 'all') await run('feishu', a => sendFeishu(a, override.feishu));
  if (!results.length) return res.json({ success: false, message: '未知渠道' });
  res.json({ success: results.some(r => r.ok), data: results });
});

// SSE 实时事件流：有新日志时推送，前端据此刷新当前面板
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 5000\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'hello', intervalMs: CONFIG.realtimeIntervalMs, at: Date.now() })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

// ==================== 启动 ====================
async function main() {
  await initDB();
  await loadSavedConfig();
  await loadWhitelist();
  await initRedis();

  if (!CONFIG.dashboardAccessKey) {
    console.warn('⚠️  未设置 DASHBOARD_ACCESS_KEY：面板与所有 API 无需登录即可访问，公网部署务必配置');
  }
  httpServer = app.listen(CONFIG.port, () => {
    console.log(`🚀 NewAPI Monitor http://localhost:${CONFIG.port}`);
    console.log(`📊 日调用限制: ${CONFIG.dailyLimit} 次 | 轮询: ${CONFIG.pollInterval / 1000}s | 实时推送: ${CONFIG.realtimeIntervalMs / 1000}s`);
    console.log(`🔔 通知渠道: ${[getTransporter() && 'SMTP', CONFIG.feishuWebhook && '飞书'].filter(Boolean).join(' + ') || '未配置'}`);
    console.log(`🐘 数据库: PostgreSQL (直连 NewAPI logs 表)`);
    pollAndCheck();
    pollTimer = setInterval(pollAndCheck, CONFIG.pollInterval);
    realtimeTimer = setInterval(watchRealtime, CONFIG.realtimeIntervalMs);
    runRealtimeRules();
    ruleTimer = setInterval(runRealtimeRules, CONFIG.ruleIntervalMs);
    // 订阅余量变化慢，跟着轮询节奏走即可
    checkSubscriptions();
    subscriptionTimer = setInterval(checkSubscriptions, Math.max(CONFIG.pollInterval, 300000));
  });
}

// 优雅退出：停掉定时器、断开 SSE、关掉连接池，避免容器滚动更新时写到一半被杀
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在退出...`);
  for (const timer of [pollTimer, ruleTimer, subscriptionTimer, realtimeTimer]) if (timer) clearInterval(timer);
  for (const client of sseClients) { try { client.end(); } catch {} }
  sseClients.clear();
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  try { if (redis && redisReady) await redis.quit(); } catch {}
  try { await pool.end(); } catch {}
  console.log('已安全退出');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(err => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
