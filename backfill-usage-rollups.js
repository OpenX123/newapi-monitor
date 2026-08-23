const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dayStart = Math.floor((Date.now() / 1000 + 28800) / 86400) * 86400 - 28800;
const days = Math.min(30, Math.max(1, parseInt((process.argv.find(arg => arg.startsWith('--days=')) || '').split('=')[1]) || 30));
const cacheTokens = `CASE WHEN m.log_id IS NOT NULL THEN COALESCE(m.cache_tokens, 0) ELSE COALESCE(NULLIF(SUBSTRING(l.other FROM '"cache_tokens":([0-9]+)'), '')::bigint, 0) END`;
const anthropicUsage = `CASE WHEN m.usage_semantic IS NOT NULL THEN m.usage_semantic = 'anthropic' ELSE l.other LIKE '%"usage_semantic":"anthropic"%' END`;

function parseOther(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function metrics(other) {
  const json = parseOther(other);
  const affinity = json?.admin_info?.channel_affinity || {};
  const signal = `${affinity.reason || ''} ${affinity.override_template?.rule_name || ''}`.toLowerCase();
  let traceType = '';
  if (signal.includes('claude cli trace')) traceType = 'claude cli trace';
  else if (signal.includes('codex cli trace')) traceType = 'codex cli trace';
  else if (affinity.key_path === 'metadata.user_id') traceType = 'key_path:metadata.user_id';
  else if (affinity.key_path === 'prompt_cache_key') traceType = 'key_path:prompt_cache_key';
  return {
    userAgent: typeof json.user_agent === 'string' ? json.user_agent : '',
    cacheTokens: Number.isFinite(Number(json.cache_tokens)) ? Math.max(0, Math.trunc(Number(json.cache_tokens))) : 0,
    usageSemantic: String(json.usage_semantic || '').toLowerCase() === 'anthropic' ? 'anthropic' : '',
    traceType,
  };
}

async function backfillMetrics(pool, since) {
  let lastId = 0;
  let total = 0;
  while (true) {
    const { rows } = await pool.query(`SELECT id, other FROM logs WHERE created_at >= $1 AND id > $2 AND type IN (2, 5) ORDER BY id LIMIT 500`, [since, lastId]);
    if (!rows.length) break;
    const params = [];
    const values = [];
    for (const row of rows) {
      const value = metrics(row.other);
      const offset = params.length;
      params.push(String(row.id), value.userAgent, value.cacheTokens, value.usageSemantic, value.traceType);
      values.push(`($${offset + 1}, $${offset + 2}, 0, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
      lastId = Number(row.id);
    }
    await pool.query(`INSERT INTO monitor_log_user_agents (log_id, user_agent, matched_delta_seconds, cache_tokens, usage_semantic, trace_type) VALUES ${values.join(',')} ON CONFLICT (log_id) DO UPDATE SET user_agent = CASE WHEN EXCLUDED.user_agent <> '' THEN EXCLUDED.user_agent ELSE monitor_log_user_agents.user_agent END, cache_tokens = EXCLUDED.cache_tokens, usage_semantic = EXCLUDED.usage_semantic, trace_type = EXCLUDED.trace_type`, params);
    total += rows.length;
    await sleep(50);
  }
  return { total, lastId };
}

async function buildDay(pool, from) {
  await pool.query('DELETE FROM monitor_usage_rollups WHERE bucket_start >= $1 AND bucket_start < $2', [from, from + 86400]);
  const result = await pool.query(`
    INSERT INTO monitor_usage_rollups (
      bucket_start, dimension_hash, token_id, token_name, username, user_id, model_name, grp,
      channel_id, channel_name, ip, user_agent, call_count, usage_count, quota, prompt_tokens,
      completion_tokens, total_tokens, cache_tokens, fresh_input_tokens, first_at, last_at
    )
    SELECT (l.created_at / 3600) * 3600,
      MD5(CONCAT_WS(CHR(31), COALESCE(l.token_id, 0), COALESCE(l.token_name, ''), COALESCE(l.username, ''),
        COALESCE(l.user_id, 0), COALESCE(l.model_name, ''), COALESCE(l."group", ''), COALESCE(l.channel_id, 0),
        COALESCE(l.channel_name, ''), COALESCE(l.ip, ''), CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END)),
      COALESCE(l.token_id, 0), COALESCE(l.token_name, ''), COALESCE(l.username, ''), COALESCE(l.user_id, 0),
      COALESCE(l.model_name, ''), COALESCE(l."group", ''), COALESCE(l.channel_id, 0), COALESCE(l.channel_name, ''),
      COALESCE(l.ip, ''), CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END,
      COUNT(*), COUNT(*) FILTER (WHERE l.type = 2),
      COALESCE(SUM(l.quota) FILTER (WHERE l.type = 2), 0), COALESCE(SUM(l.prompt_tokens) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(l.completion_tokens) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(COALESCE(l.prompt_tokens, 0) + COALESCE(l.completion_tokens, 0)
        + CASE WHEN ${anthropicUsage} THEN ${cacheTokens} ELSE 0 END) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(${cacheTokens}) FILTER (WHERE l.type = 2), 0),
      COALESCE(SUM(CASE WHEN ${anthropicUsage} THEN COALESCE(l.prompt_tokens, 0)
        ELSE GREATEST(COALESCE(l.prompt_tokens, 0) - ${cacheTokens}, 0) END) FILTER (WHERE l.type = 2), 0),
      MIN(l.created_at), MAX(l.created_at)
    FROM logs l LEFT JOIN monitor_log_user_agents m ON m.log_id = l.id
    WHERE l.created_at >= $1 AND l.created_at < $2 AND l.type IN (2, 5)
    GROUP BY (l.created_at / 3600) * 3600, COALESCE(l.token_id, 0), COALESCE(l.token_name, ''),
      COALESCE(l.username, ''), COALESCE(l.user_id, 0), COALESCE(l.model_name, ''), COALESCE(l."group", ''),
      COALESCE(l.channel_id, 0), COALESCE(l.channel_name, ''), COALESCE(l.ip, ''),
      CASE WHEN l.type = 2 THEN COALESCE(m.user_agent, '') ELSE '' END
  `, [from, from + 86400]);
  return result.rowCount;
}

async function main() {
  require('dotenv').config();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const since = dayStart - (days - 1) * 86400;
    const metricResult = await backfillMetrics(pool, since);
    const { rows: cursorRows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM logs');
    await pool.query(`INSERT INTO monitor_kv (key, value) VALUES ('metrics:last_log_id', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(metricResult.lastId || cursorRows[0].max_id)]);
    const rollups = [];
    for (let day = since; day < dayStart; day += 86400) {
      rollups.push({ day, rows: await buildDay(pool, day) });
      await sleep(100);
    }
    console.log(JSON.stringify({ days, metricRows: metricResult.total, rollups }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { metrics };
