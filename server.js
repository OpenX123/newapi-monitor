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
  timezone: 'Asia/Shanghai',
  dashboardAccessKey: process.env.DASHBOARD_ACCESS_KEY,
};
let pollTimer = null;
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
app.post('/api/auth/login',(req,res) => { if (!CONFIG.dashboardAccessKey) return res.json({success:true,authEnabled:false}); if (!accessKeyMatches(req.body?.accessKey)) return res.status(401).json({success:false,message:'访问密钥错误'}); const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{expiresAt:Date.now()+SESSION_TTL_MS}); setSessionCookie(req,res,token); res.json({success:true}); });
app.post('/api/auth/logout',(req,res) => { sessions.delete(parseCookies(req.headers.cookie)[AUTH_COOKIE]); setSessionCookie(req,res,'',0); res.json({success:true}); });
app.use((req,res,next) => { if (req.path === '/login.html' || req.path === '/favicon.ico' || isAuthenticated(req)) return next(); if (req.path.startsWith('/api/')) return res.status(401).json({success:false,message:'未登录或登录已过期'}); res.redirect('/login.html'); });
app.use(express.static(path.join(__dirname,'public')));


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
  `);
  await pool.query('ALTER TABLE monitor_actions ADD COLUMN IF NOT EXISTS action_meta JSONB');
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
  const { rows } = await pool.query("SELECT key, value FROM monitor_kv WHERE key IN ('dailyLimit', 'pollInterval', 'notifyEmail', 'timezone')");
  for (const row of rows) {
    if (row.key === 'dailyLimit') CONFIG.dailyLimit = parseInt(row.value);
    if (row.key === 'pollInterval') CONFIG.pollInterval = parseInt(row.value);
    if (row.key === 'notifyEmail') CONFIG.notifyEmail = row.value;
    if (row.key === 'timezone' && isValidTimeZone(row.value)) CONFIG.timezone = row.value;
  }
}

// ==================== Redis 缓存 ====================
function cacheKey(key) {
  return `${CONFIG.redisKeyPrefix}:${key}`;
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
    return { category_code: 'quota', category_label: '配额/余额不足' };
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

async function fetchLogsSinceId(lastLogId, minCreatedAt = 0) {
  const { rows } = await pool.query(`
    SELECT id, created_at, username, token_name, token_id, user_id, model_name,
      quota, prompt_tokens, completion_tokens, channel_name, "group" as grp, other
    FROM logs
    WHERE id > $1 AND created_at >= $2
    ORDER BY id ASC
  `, [lastLogId, minCreatedAt]);
  return rows.map(r => ({
    ...r,
    id: parseInt(r.id) || 0,
    created_at: parseInt(r.created_at) || 0,
    token_id: parseInt(r.token_id) || 0,
    user_id: parseInt(r.user_id) || 0,
    quota: parseInt(r.quota) || 0,
    prompt_tokens: parseInt(r.prompt_tokens) || 0,
    completion_tokens: parseInt(r.completion_tokens) || 0,
  }));
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
        models: {},
      });
    }
    const token = tokensMap.get(key);
    token.count += 1;
    token.quota += row.quota || 0;
    token.prompt_tokens += row.prompt_tokens || 0;
    token.completion_tokens += row.completion_tokens || 0;
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
  }).sort((a, b) => b.count - a.count);

  return {
    ...snapshot,
    totalLogs: (snapshot.totalLogs || 0) + rows.length,
    dbTotal: (snapshot.dbTotal || 0) + rows.length,
    tokens,
  };
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
      WHERE ${filterSql} AND created_at >= $2
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
    WITH filtered AS (
      SELECT
        token_id, token_name, username, user_id,
        CASE
          WHEN other IS NOT NULL AND other <> '' AND LEFT(other, 1) = '{' THEN other::jsonb
          ELSE '{}'::jsonb
        END AS other_json
      FROM logs
      WHERE created_at >= $1
    ),
    labeled AS (
      SELECT
        token_id, token_name, username, user_id,
        CASE
          WHEN LOWER(COALESCE(other_json->'admin_info'->'channel_affinity'->>'reason', '')) LIKE '%claude cli trace%'
            OR LOWER(COALESCE(other_json->'admin_info'->'channel_affinity'->'override_template'->>'rule_name', '')) LIKE '%claude cli trace%' THEN 'claude cli trace'
          WHEN LOWER(COALESCE(other_json->'admin_info'->'channel_affinity'->>'reason', '')) LIKE '%codex cli trace%'
            OR LOWER(COALESCE(other_json->'admin_info'->'channel_affinity'->'override_template'->>'rule_name', '')) LIKE '%codex cli trace%' THEN 'codex cli trace'
          WHEN COALESCE(other_json->'admin_info'->'channel_affinity'->>'key_path', '') = 'metadata.user_id' THEN 'key_path:metadata.user_id'
          WHEN COALESCE(other_json->'admin_info'->'channel_affinity'->>'key_path', '') = 'prompt_cache_key' THEN 'key_path:prompt_cache_key'
          ELSE NULL
        END AS trace_type
      FROM filtered
    )
    SELECT
      token_id, token_name, username, user_id,
      COUNT(*) AS total_calls,
      COUNT(*) FILTER (WHERE trace_type IS NOT NULL) AS flagged_calls,
      COALESCE(JSON_AGG(DISTINCT trace_type) FILTER (WHERE trace_type IS NOT NULL), '[]'::json) AS trace_types
    FROM labeled
    GROUP BY token_id, token_name, username, user_id
    HAVING COUNT(*) FILTER (WHERE trace_type IS NOT NULL) >= $2
    ORDER BY flagged_calls DESC, total_calls DESC
  `, [ts, 30]);

  return rows.map(r => {
    const totalCalls = parseInt(r.total_calls) || 0;
    const flaggedCalls = parseInt(r.flagged_calls) || 0;
    return {
      token_id: parseInt(r.token_id) || 0,
      token_name: r.token_name,
      username: r.username,
      user_id: parseInt(r.user_id) || 0,
      trace_types: Array.isArray(r.trace_types) ? r.trace_types : [],
      ...buildScriptDisableDecision(flaggedCalls, totalCalls),
    };
  }).filter(r => r.eligible);
}

async function getAggregation(range, dimension) {
  const ts = getRangeTs(range);
  const dims = {
    token: { group: 'token_id, token_name, username, user_id', select: 'token_id, token_name, username, user_id' },
    user:  { group: 'username', select: 'username, COUNT(DISTINCT token_id) as token_count' },
    model: { group: 'model_name', select: 'model_name' },
    group: { group: '"group"', select: '"group" as grp' },
    channel: { group: 'channel_id, channel_name', select: 'channel_id as channel, channel_name' },
    ip: { group: "COALESCE(NULLIF(ip, ''), '(未记录)')", select: "COALESCE(NULLIF(ip, ''), '(未记录)') as ip, COUNT(DISTINCT username) as user_count, COUNT(DISTINCT token_id) as token_count, MIN(created_at) as first_at, MAX(created_at) as last_at" },
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
    ? "LPAD(EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE $2)::TEXT, 2, '0') || ':00'"
    : "TO_CHAR(TO_TIMESTAMP(created_at) AT TIME ZONE $2, 'MM-DD HH24') || 'h'";
  const res = await pool.query(`
    SELECT ${labelExpr} as label,
      COUNT(*) as count, SUM(quota) as quota,
      COUNT(DISTINCT token_id) as active_tokens,
      COUNT(DISTINCT username) as active_users
    FROM logs WHERE created_at >= $1 GROUP BY label ORDER BY label
  `, [ts, CONFIG.timezone]);
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

async function getErrorAnalysis(range) {
  return await getOrBuildCached(`error-analysis:v3:${range}`, range, async () => {
    const ts = getRangeTs(range);

    const [countRes, channelCountRes, errorRes] = await Promise.all([
      pool.query('SELECT COUNT(*) as cnt FROM logs WHERE created_at >= $1', [ts]),
      pool.query(`
        SELECT
          COALESCE(NULLIF(channel_id::text, ''), 'unknown') AS channel_key,
          COALESCE(NULLIF(channel_name, ''), 'unknown') AS channel_name,
          COUNT(*) AS total_requests
        FROM logs
        WHERE created_at >= $1
        GROUP BY COALESCE(NULLIF(channel_id::text, ''), 'unknown'), COALESCE(NULLIF(channel_name, ''), 'unknown')
      `, [ts]),
      pool.query(`
        SELECT id, created_at, type, content, username, token_name, token_id, model_name,
          channel_id, channel_name, other
        FROM logs
        WHERE created_at >= $1
          AND (type = 5 OR (type = 2 AND other IS NOT NULL AND other <> '' AND LEFT(other, 1) = '{'))
        ORDER BY created_at DESC
      `, [ts]),
    ]);

    const totalRequests = parseInt(countRes.rows[0].cnt) || 0;
    const channelTotalMap = new Map(channelCountRes.rows.map(r => [r.channel_key, {
      channel_name: r.channel_name,
      total_requests: parseInt(r.total_requests) || 0,
    }]));

    const normalizedRows = errorRes.rows
      .map(r => {
        const otherJson = parseOtherJson(r.other);
        const channelKey = String(r.channel_id || otherJson.channel_id || otherJson.admin_info?.channel_affinity?.channel_id || 'unknown');
        return {
          id: r.id,
          created_at: parseInt(r.created_at) || 0,
          type: parseInt(r.type) || 0,
          content: r.content || '',
          username: r.username || '',
          token_name: r.token_name || '',
          token_id: parseInt(r.token_id) || 0,
          model_name: r.model_name || '',
          resolved_channel_key: channelKey,
          resolved_channel: String(r.channel_name || otherJson.channel_name || otherJson.admin_info?.channel_affinity?.channel_id || channelKey),
          status_code: String(otherJson.status_code || 'unknown'),
          error_type: String(otherJson.error_type || 'unknown'),
          stream_status: String(otherJson.stream_status?.status || ''),
          stream_end_reason: String(otherJson.stream_status?.end_reason || 'unknown'),
        };
      })
      .filter(r => r.type === 5 || (r.type === 2 && r.stream_status === 'error'));

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

async function pollAndCheck() {
  if (isPolling) return;
  isPolling = true;
  try {
    console.log(`[${new Date().toLocaleString()}] 开始查询数据库...`);
    const startOfDayUnix = getRangeTs('today');
    const prevCursor = await cacheGetJson('state:cursor');
    const nowCursor = await getLatestLogCursor();
    const todaySnapshotEnvelope = await readCacheEnvelope('snapshot:today');

    if (todaySnapshotEnvelope && prevCursor && prevCursor.maxId && prevCursor.anchor === nowCursor.anchor && prevCursor.maxId < nowCursor.maxId) {
      const rows = await fetchLogsSinceId(prevCursor.maxId, startOfDayUnix);
      if (rows.length > 0 && todaySnapshotEnvelope.value) {
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
              text: `用户 ${t.username} 的 Token "${t.token_name}" (ID: ${t.token_id})\n今日调用量已达到 ${t.count} 次，超过了设定的限制 ${CONFIG.dailyLimit} 次。\n\n请留意该 Token 的使用情况。\n\n时间: ${new Date().toLocaleString()}`,
            });
            console.log(`  📧 邮件通知成功 (Token #${t.token_id})`);
            await recordAction({
              tokenId: t.token_id,
              tokenName: t.token_name,
              username: t.username,
              action: 'notify',
              reason: `日调用 ${t.count} 次超限`,
              dailyCount: t.count,
              meta: { policy: 'daily_limit', limit: CONFIG.dailyLimit },
            });
          } catch(e) {
            console.error(`  📧 发送邮件错误 (Token #${t.token_id}): ${e.message}`);
          }
        }

      }
    }

    const candidates = await getScriptDisableCandidates(Math.floor(Date.now() / 1000) - 86400);
    for (const item of candidates) {
      if (!item.token_id || whitelistSet.has(item.token_id)) continue;
      console.log(`⚠️ token ${item.token_name}(${item.token_id}) 命中脚本 trace，比例 ${item.ratio_pct}% / 次数 ${item.flagged_calls}`);
    }
  } catch (err) {
    console.error('轮询出错:', err.message);
  } finally {
    isPolling = false;
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

app.get('/api/user-analysis', async (req, res) => {
  const { username, token_id, token_name, range } = req.query;
  if (!username && !token_id) return res.json({ success: false, message: '缺少 username 或 token_id' });
  const ts = getRangeTs(range || 'today');

  const filterCol = username ? 'username' : 'token_id';
  const filterVal = username ? username : parseInt(token_id);

  try {
    // 1. 基本统计
    const basicRes = await pool.query(`
      SELECT COUNT(*) as total_calls, COUNT(DISTINCT token_id) as token_count,
        COUNT(DISTINCT model_name) as model_count, user_id,
        MIN(created_at) as first_at, MAX(created_at) as last_at,
        SUM(quota) as total_quota, SUM(prompt_tokens) as total_prompt,
        SUM(completion_tokens) as total_completion
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 GROUP BY user_id
    `, [filterVal, ts]);
    if (basicRes.rows.length === 0) return res.json({ success: true, data: null });
    const basic = basicRes.rows[0];
    basic.total_calls = parseInt(basic.total_calls);
    basic.total_quota = parseInt(basic.total_quota) || 0;
    basic.total_prompt = parseInt(basic.total_prompt) || 0;
    basic.total_completion = parseInt(basic.total_completion) || 0;
    const scriptTraceStats = await getScriptTraceStatsForFilter(filterCol, filterVal, ts);
    const autoDisableWindowStats = filterCol === 'token_id'
      ? await getScriptTraceStatsForFilter(filterCol, filterVal, Math.floor(Date.now() / 1000) - 86400)
      : scriptTraceStats;
    const scriptSignals = scriptTraceStats.breakdown.map(item => `${item.type} × ${item.count}`);

    // 2. 每小时分布
    const hourlyRes = await pool.query(`
      SELECT EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE $3)::INT as hour,
        COUNT(*) as count
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 GROUP BY hour ORDER BY hour
    `, [filterVal, ts, CONFIG.timezone]);
    const hourly = hourlyRes.rows.map(r => ({ hour: r.hour, count: parseInt(r.count) }));

    // 3. 调用间隔分析（最近5000条，含时间序列用于散点图）
    const intRes = await pool.query(`
      WITH ordered AS (
        SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) as prev_at
        FROM logs WHERE ${filterCol} = $1 AND created_at >= $2
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
      SELECT model_name, COUNT(*) as count, SUM(quota) as quota
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2
      GROUP BY model_name ORDER BY count DESC LIMIT 20
    `, [filterVal, ts]);
    const models = modelRes.rows.map(r => ({ ...r, count: parseInt(r.count), quota: parseInt(r.quota) || 0 }));

    // 5. 并发检测
    const concurRes = await pool.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT created_at FROM logs WHERE ${filterCol} = $1 AND created_at >= $2
        GROUP BY created_at HAVING COUNT(*) > 1
      ) t
    `, [filterVal, ts]);
    const concurrentPoints = parseInt(concurRes.rows[0].cnt);

    // 6. 连续快速调用
    const streakRes = await pool.query(`
      WITH ordered AS (
        SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) as prev_at
        FROM logs WHERE ${filterCol} = $1 AND created_at >= $2
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

    // 7. 深夜活跃
    const nightRes = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE $3) BETWEEN 0 AND 5) as n
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2
    `, [filterVal, ts, CONFIG.timezone]);
    const nightCalls = parseInt(nightRes.rows[0].n);

    // 8. 会话检测（间隔 > 300s 即视为新会话）
    const sessionRes = await pool.query(`
      WITH ordered AS (
        SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) as prev_at
        FROM logs WHERE ${filterCol} = $1 AND created_at >= $2
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

    // 9. 星期分布
    const weekdayRes = await pool.query(`
      SELECT EXTRACT(DOW FROM TO_TIMESTAMP(created_at) AT TIME ZONE $3)::INT as dow,
        COUNT(*) as count
      FROM logs WHERE ${filterCol} = $1 AND created_at >= $2 GROUP BY dow ORDER BY dow
    `, [filterVal, ts, CONFIG.timezone]);
    const weekday = new Array(7).fill(0);
    for (const r of weekdayRes.rows) weekday[r.dow] = parseInt(r.count);

    // 10. 脚本评分（v4：分离夜间/白天独立分析）
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
      username: username || token_name || token_id, basic, hourly, intervals, intervalTimeline,
      models, concurrentPoints, streaks, sessions, weekday,
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
    const where = ip ? 'WHERE created_at >= $1 AND ip = $2' : 'WHERE created_at >= $1';
    const values = ip ? [ts, ip] : [ts];
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as cnt FROM logs ${where}`, values),
      pool.query(`
        SELECT id, created_at, username, token_name, token_id, model_name, quota,
          prompt_tokens, completion_tokens, channel_name, "group" as grp, ip
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
  res.json({ success: true, data: { dailyLimit: CONFIG.dailyLimit, pollInterval: CONFIG.pollInterval, notifyEmail: CONFIG.notifyEmail, timezone: CONFIG.timezone, baseUrl: CONFIG.baseUrl } });
});

app.put('/api/config', async (req, res) => {
  const { dailyLimit, pollInterval, notifyEmail, timezone } = req.body;
  const normalizedTimeZone = timezone == null ? null : String(timezone).trim();
  if (normalizedTimeZone != null && !isValidTimeZone(normalizedTimeZone)) {
    return res.status(400).json({ success: false, message: '无效时区，请使用 IANA 时区名称，例如 Asia/Shanghai' });
  }
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
  if (timezone != null) {
    CONFIG.timezone = normalizedTimeZone;
    await setKV('timezone', CONFIG.timezone);
  }
  console.log(`⚙️ 配置已更新: dailyLimit=${CONFIG.dailyLimit}, pollInterval=${CONFIG.pollInterval}, notifyEmail=${CONFIG.notifyEmail}, timezone=${CONFIG.timezone}`);
  await Promise.all([
    cacheDeleteByPrefix('dashboard:'),
    cacheDeleteByPrefix('stats:'),
    cacheDeleteByPrefix('trend:'),
    cacheDeleteByPrefix('distribution:'),
    cacheDeleteByPrefix('recent-logs:'),
  ]);
  res.json({ success: true, data: { dailyLimit: CONFIG.dailyLimit, pollInterval: CONFIG.pollInterval, notifyEmail: CONFIG.notifyEmail, timezone: CONFIG.timezone } });});

// ==================== 启动 ====================
async function main() {
  await initDB();
  await loadSavedConfig();
  await loadWhitelist();
  await initRedis();

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
