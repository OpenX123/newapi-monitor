// 数据库集成测试：把面板会发出的每条 SQL 在真实库上跑一遍（只读）
// 需要 DATABASE_URL；未配置时自动跳过。运行：npm run test:db
const { check, section, summary, extract, constant } = require('./lib');

if (!process.env.DATABASE_URL) {
  console.log('跳过数据库测试：未设置 DATABASE_URL');
  process.exit(0);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const REQUEST_LOGS = constant('REQUEST_LOGS');
const CACHE_TOKENS_EXPR = constant('CACHE_TOKENS_EXPR');
const USAGE_AGG = constant('USAGE_AGG').replace(/\$\{CACHE_TOKENS_EXPR\}/g, CACHE_TOKENS_EXPR);
const TS = 'EXTRACT(EPOCH FROM NOW())::bigint - 86400';
const TZ = 'Asia/Shanghai';

// 报错分析的 SQL 直接从 server.js 抽出来跑，保证测的是线上那条
function errorAnalysisSql() {
  const { serverSource } = require('./lib');
  const m = /pool\.query\(`\s*(WITH parsed AS[\s\S]*?)`, \[ts, ERROR_ROWS_LIMIT\]\)/.exec(serverSource());
  if (!m) throw new Error('未找到报错分析查询');
  return m[1];
}

async function run(name, sql, params = []) {
  const t0 = Date.now();
  try {
    const { rows } = await pool.query(sql, params);
    return check(name, true, `${Date.now() - t0}ms, ${rows.length} 行`);
  } catch (err) {
    return check(name, false, err.message);
  }
}

(async () => {
  section('聚合查询（各维度）');
  const dims = {
    token: { group: 'token_id, token_name, username, user_id', select: 'token_id, token_name, username, user_id' },
    user: { group: 'username', select: 'username, COUNT(DISTINCT token_id) as token_count' },
    model: { group: 'model_name', select: 'model_name' },
    group: { group: '"group"', select: '"group" as grp' },
    channel: { group: 'channel_id, channel_name', select: 'channel_id as channel, channel_name' },
    ip: { group: "COALESCE(NULLIF(ip, ''), '(未记录)')", select: "COALESCE(NULLIF(ip, ''), '(未记录)') as ip, COUNT(DISTINCT username) as user_count, COUNT(DISTINCT token_id) as token_count, MIN(created_at) as first_at, MAX(created_at) as last_at" },
  };
  for (const [name, d] of Object.entries(dims)) {
    await run(`dim=${name}`, `SELECT ${d.select}, ${USAGE_AGG}
      FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} GROUP BY ${d.group} ORDER BY count DESC LIMIT 3`);
  }

  section('趋势 / 分布 / 快照');
  await run('每小时趋势', `SELECT LPAD(EXTRACT(HOUR FROM TO_TIMESTAMP(created_at) AT TIME ZONE '${TZ}')::TEXT, 2, '0') || ':00' as label,
      COUNT(*) as count, SUM(quota) FILTER (WHERE type = 2) as quota,
      SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0) + (${CACHE_TOKENS_EXPR} * 0.6)) FILTER (WHERE type = 2) as total_tokens,
      COUNT(DISTINCT token_id) as active_tokens, COUNT(DISTINCT username) as active_users
    FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} GROUP BY label ORDER BY label LIMIT 3`);
  await run('用户 token 用量 TOP', `SELECT username, ${USAGE_AGG}
    FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} GROUP BY username ORDER BY total_tokens DESC NULLS LAST LIMIT 3`);
  await run('快照模型分布（窗口函数，非 N+1）', `WITH ranked AS (
      SELECT token_id, model_name, COUNT(*) AS cnt,
        ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY COUNT(*) DESC) AS rn
      FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} GROUP BY token_id, model_name)
    SELECT token_id, model_name, cnt FROM ranked WHERE rn <= 3 LIMIT 5`);

  section('明细与分析');
  await run('调用记录分页', `SELECT id, created_at, type, username, token_name, token_id, model_name, quota,
      prompt_tokens, completion_tokens, ${CACHE_TOKENS_EXPR} as cache_tokens, channel_name, "group" as grp, ip
    FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} ORDER BY created_at DESC LIMIT 3`);
  await run('报错分析（字段解析已下推 SQL）', errorAnalysisSql().replace('$1', TS).replace('$2', '1000'));
  await run('单用户行为分析', `SELECT COUNT(*) as total_calls, COUNT(DISTINCT token_id) as token_count,
      COUNT(DISTINCT model_name) as model_count, user_id,
      SUM(quota) FILTER (WHERE type = 2) as total_quota,
      SUM(${CACHE_TOKENS_EXPR}) FILTER (WHERE type = 2) as total_cache
    FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} GROUP BY user_id LIMIT 1`);

  section('实时风控规则');
  const win = 300;
  await run('突增 / 费用 / 多 IP 主查询', `SELECT token_id, token_name, username, user_id,
      COUNT(*) FILTER (WHERE created_at >= EXTRACT(EPOCH FROM NOW())::bigint - ${win}) AS cur_calls,
      COUNT(*) FILTER (WHERE created_at <  EXTRACT(EPOCH FROM NOW())::bigint - ${win}) AS prev_calls,
      COALESCE(SUM(quota) FILTER (WHERE created_at >= EXTRACT(EPOCH FROM NOW())::bigint - ${win} AND type = 2), 0) AS cur_quota,
      COUNT(DISTINCT ip) FILTER (WHERE created_at >= EXTRACT(EPOCH FROM NOW())::bigint - ${win} AND COALESCE(ip,'') <> '') AS cur_ips
    FROM logs WHERE created_at >= EXTRACT(EPOCH FROM NOW())::bigint - ${win * 2} AND ${REQUEST_LOGS}
    GROUP BY token_id, token_name, username, user_id HAVING COUNT(*) > 0`);
  await run('同 IP 多账号', `SELECT ip, COUNT(DISTINCT username) AS users, COUNT(DISTINCT token_id) AS tokens,
      COUNT(*) AS calls, STRING_AGG(DISTINCT username, ', ') AS usernames
    FROM logs WHERE created_at >= ${TS} AND ${REQUEST_LOGS} AND COALESCE(ip, '') <> ''
    GROUP BY ip HAVING COUNT(DISTINCT username) >= 2`);

  section('订阅余量');
  await run('每用户当前订阅', `WITH recent AS (
      SELECT DISTINCT ON (username) username, user_id, id, created_at, other
      FROM logs WHERE type = 2 AND created_at >= EXTRACT(EPOCH FROM NOW())::bigint - 604800
        AND other LIKE '%"subscription_remain"%'
      ORDER BY username, id DESC)
    SELECT username, other::jsonb->>'subscription_plan_title' AS plan,
      (other::jsonb->>'subscription_remain')::bigint AS remain,
      (other::jsonb->>'subscription_total')::bigint AS total
    FROM recent WHERE (other::jsonb->>'subscription_total')::bigint > 0 LIMIT 5`);

  section('监控表索引');
  const { rows: idx } = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'monitor_actions'`);
  const names = idx.map(r => r.indexname).join(',');
  check('告警冷却查询有索引', /idx_monitor_actions_subject/.test(names),
    /idx_monitor_actions_subject/.test(names) ? '' : `当前只有 [${names || '无'}]，索引由 initDB() 创建，重启服务后生效`);

  await pool.end();
  process.exit(summary() ? 0 : 1);
})().catch(async err => {
  console.error('测试异常:', err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
