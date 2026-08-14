const fs = require('fs');
const readline = require('readline');

const apply = process.argv.includes('--apply');
const hours = Math.max(1, parseInt((process.argv.find(a => a.startsWith('--hours=')) || '').split('=')[1]) || 24);
const accessLog = process.env.NEWAPI_ACCESS_LOG || '/opt/1panel/www/sites/cloud.yiyongai.cn/log/access.log';
const since = Math.floor(Date.now() / 1000) - hours * 3600;

function accessTimestamp(value) {
  const match = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(value);
  if (!match) return 0;
  const [, day, month, year, hour, minute, second, offset] = match;
  return Math.floor(Date.parse(`${day} ${month} ${year} ${hour}:${minute}:${second} GMT${offset}`) / 1000);
}

function parseAccessLine(line) {
  const match = /^(\S+) .* \[([^\]]+)\] "POST ([^ ?"]+)[^"]*" \d+ \S+ "[^"]*" "([^"]*)"/.exec(line);
  if (!match) return null;
  const [, ip, time, path, userAgent] = match;
  return { ip, timestamp: accessTimestamp(time), path, userAgent };
}

async function main() {
  require('dotenv').config();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
  const direct = apply ? await pool.query(`
    INSERT INTO monitor_log_user_agents (log_id, user_agent, matched_delta_seconds, cache_tokens)
    SELECT l.id, SUBSTRING(l.other FROM '"user_agent":"([^"\\\\]*)"'), 0, COALESCE(NULLIF(SUBSTRING(l.other FROM '"cache_tokens":([0-9]+)'), '')::bigint, 0)
    FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
    WHERE l.created_at >= $1 AND l.type = 2 AND l.other LIKE '%"user_agent"%' AND m.log_id IS NULL
    ON CONFLICT (log_id) DO NOTHING
  `, [since]) : { rowCount: 0 };
  if (apply) await pool.query(`
    UPDATE monitor_log_user_agents m
    SET cache_tokens = COALESCE(NULLIF(SUBSTRING(l.other FROM '"cache_tokens":([0-9]+)'), '')::bigint, 0)
    FROM logs l WHERE l.id = m.log_id AND l.created_at >= $1 AND l.type = 2
  `, [since]);
  const { rows: logs } = await pool.query(`
    SELECT l.id, l.created_at, l.ip, SUBSTRING(l.other FROM '"request_path":"([^"\\\\]*)"') AS request_path
    FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
    WHERE l.created_at >= $1 AND l.type = 2 AND l.other NOT LIKE '%"user_agent"%' AND m.log_id IS NULL
    ORDER BY l.created_at
  `, [since]);

  const entries = new Map();
  const stream = readline.createInterface({ input: fs.createReadStream(accessLog), crlfDelay: Infinity });
  for await (const line of stream) {
    const entry = parseAccessLine(line);
    if (!entry || entry.timestamp < since || !entry.path.startsWith('/v1/') || !entry.userAgent || entry.userAgent === '-') continue;
    const { ip, path, timestamp, userAgent } = entry;
    const key = `${ip}|${path}`;
    const list = entries.get(key) || [];
    list.push({ timestamp, userAgent, used: false });
    entries.set(key, list);
  }

  const matched = [];
  for (const log of logs) {
    const candidates = entries.get(`${log.ip}|${log.request_path}`) || [];
    let best = null;
    for (const entry of candidates) {
      if (entry.used) continue;
      const delta = Math.abs(entry.timestamp - Number(log.created_at));
      if (delta <= 3 && (!best || delta < best.delta)) best = { entry, delta };
    }
    if (!best) continue;
    best.entry.used = true;
    matched.push([String(log.id), best.entry.userAgent, best.delta]);
  }

  console.log(JSON.stringify({ hours, direct: direct.rowCount, missing: logs.length, matched: matched.length, coverage: logs.length ? +(matched.length * 100 / logs.length).toFixed(1) : 100, apply }));
  if (!apply || matched.length === 0) return;
  for (let i = 0; i < matched.length; i += 500) {
    const chunk = matched.slice(i, i + 500);
    const values = [];
    const params = [];
    for (const row of chunk) {
      const offset = params.length;
      params.push(...row);
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
    }
    await pool.query(`INSERT INTO monitor_log_user_agents (log_id, user_agent, matched_delta_seconds) VALUES ${values.join(',')} ON CONFLICT (log_id) DO NOTHING`, params);
  }
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { accessTimestamp, parseAccessLine };
