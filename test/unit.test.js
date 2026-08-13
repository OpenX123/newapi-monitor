// 不需要数据库的单元测试：通知渠道、格式化、配置安全性
// 运行：npm test
const http = require('http');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { check, equal, section, summary, serverSource, extract } = require('./lib');

// ---------- 飞书发送（对着本地 mock 服务跑真实实现）----------
async function testFeishu() {
  section('飞书机器人');
  // 抽出真实实现，跳过依赖 nodemailer / express 的部分
  const code = extract('function postJson(', 'async function sendEmail(')
    + extract('function formatInTimezone(', '// ==================== 实时推送');
  const CONFIG = { feishuWebhook: '', feishuSecret: '', timezone: 'Asia/Shanghai' };
  const sandbox = eval(`(function(){ ${code}
    return { postJson, feishuSign, sendFeishu, maskSecret }; })()`);

  let lastRequest = null;
  let mockCode = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      lastRequest = { path: req.url, headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockCode === 0 ? { code: 0, msg: 'success' } : { code: mockCode, msg: 'sign match fail' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  CONFIG.feishuWebhook = `http://127.0.0.1:${server.address().port}/open-apis/bot/v2/hook/abc123`;

  await sandbox.sendFeishu({ title: '🚨 [超限警告] Token: test', level: 'danger', lines: ['**用户**：zzz'] });
  check('发送成功并命中 hook 路径', lastRequest && lastRequest.path === '/open-apis/bot/v2/hook/abc123');
  equal('消息类型为交互卡片', lastRequest.body.msg_type, 'interactive');
  equal('danger 用红色卡片', lastRequest.body.card.header.template, 'red');
  equal('标题透传', lastRequest.body.card.header.title.content, '🚨 [超限警告] Token: test');
  check('未配置密钥时不带签名字段', !lastRequest.body.sign && !lastRequest.body.timestamp);

  CONFIG.feishuSecret = 'my-secret-key';
  await sandbox.sendFeishu({ title: '🤖 x', level: 'warning', lines: ['x'] });
  const { timestamp, sign } = lastRequest.body;
  const expect = crypto.createHmac('sha256', `${timestamp}\nmy-secret-key`).update('').digest('base64');
  equal('签名与飞书官方算法一致', sign, expect);
  check('时间戳为秒级且接近当前', Math.abs(Date.now() / 1000 - Number(timestamp)) < 60);
  equal('warning 用橙色卡片', lastRequest.body.card.header.template, 'orange');

  mockCode = 19021;
  let err = '';
  try { await sandbox.sendFeishu({ title: 'x', lines: [] }); } catch (e) { err = e.message; }
  check('飞书返回错误码时抛异常', err.includes('19021') || err.includes('sign match fail'), err);

  mockCode = 0;
  CONFIG.feishuWebhook = '';
  err = '';
  try { await sandbox.sendFeishu({ title: 'x', lines: [] }); } catch (e) { err = e.message; }
  equal('未配置 Webhook 时提示明确', err, '未配置飞书 Webhook');

  CONFIG.feishuWebhook = 'not-a-url';
  err = '';
  try { await sandbox.sendFeishu({ title: 'x', lines: [] }); } catch (e) { err = e.message; }
  check('非法 URL 被拦截', err.includes('URL'), err);

  equal('掩码只保留尾部', sandbox.maskSecret('https://open.feishu.cn/hook/9f8e7d6c', 8), '******9f8e7d6c');
  equal('掩码空值返回空', sandbox.maskSecret(''), '');
  server.close();
}

// ---------- 通知测试按钮的取值 ----------
function testNotifyOverrides() {
  section('通知测试取值');
  const src = serverSource();
  const CONFIG = {
    smtpHost: 'smtp.qq.com', smtpPort: 587, smtpSecure: false, smtpUser: 'a@qq.com',
    smtpPass: 'saved-pass', smtpFrom: '', notifyEmail: 'to@qq.com',
    feishuWebhook: 'https://saved/hook', feishuSecret: 'saved-secret',
  };
  const testOverrides = eval(`(function(){ ${extract('function testOverrides(', '// 通知渠道连通性测试')}
    return testOverrides; })()`);

  const empty = testOverrides({ channel: 'feishu' });
  equal('不传字段时沿用已保存 Webhook', empty.feishu.webhook, 'https://saved/hook');
  equal('不传字段时沿用已保存密码', empty.smtp.pass, 'saved-pass');

  const typed = testOverrides({ feishuWebhook: ' https://new/hook ', feishuSecret: '' });
  equal('表单里刚填的 Webhook 立刻可测', typed.feishu.webhook, 'https://new/hook');
  equal('签名留空沿用已保存', typed.feishu.secret, 'saved-secret');
  equal('掩码回传不覆盖 Webhook', testOverrides({ feishuWebhook: '******cbd09bc1' }).feishu.webhook, 'https://saved/hook');

  const mail = testOverrides({ smtpHost: 'smtp.163.com', smtpPort: '465', smtpSecure: true, smtpPass: '', notifyEmail: '' });
  equal('SMTP 主机以表单为准', mail.smtp.host, 'smtp.163.com');
  equal('端口转成数字', mail.smtp.port, 465);
  equal('密码留空沿用已保存', mail.smtp.pass, 'saved-pass');
  equal('收件邮箱可以留空', mail.smtp.to, '');

  check('测试路由把表单值传给渠道',
    /sendEmail\(a, override\.smtp\)/.test(src) && /sendFeishu\(a, override\.feishu\)/.test(src));
  check('测试用的 SMTP 连接不写进缓存', /override \? createSmtpTransport\(smtp\) : getTransporter\(\)/.test(src));
}

// ---------- 前端格式化 ----------
function testFormatters() {
  section('前端格式化');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const slice = app.slice(app.indexOf('function formatUSD'), app.indexOf('function formatNumber'));
  const config = { quotaPerUnit: 500000 };
  const { formatUSD, formatTokens, tokenUsageCell, clientTags } =
    eval(`(function(){ ${slice} return { formatUSD, formatTokens, tokenUsageCell, clientTags }; })()`);

  equal('0 额度显示 $0', formatUSD(0), '$0');
  equal('500000 quota = $1', formatUSD(500000), '$1.00');
  equal('大额取整', formatUSD(500000000), '$1000');
  equal('小额保留精度', formatUSD(5000), '$0.01');
  check('极小额不显示成 $0', formatUSD(1).startsWith('$0.0000'), formatUSD(1));
  equal('token 千分位', formatTokens(1500), '1.5K');
  equal('token 百万', formatTokens(1234567), '1.23M');
  equal('token 十亿', formatTokens(12345678901), '12.35B');

  const cell = tokenUsageCell({ total_tokens: 1360, prompt_tokens: 900, completion_tokens: 100, cache_tokens: 600 });
  check('有缓存时拆出「入 + 缓存」', cell.includes('缓存'), '');
  check('缓存按 60% 重复计入总量', cell.includes('1,360'), '');
  const noCache = tokenUsageCell({ total_tokens: 1000, prompt_tokens: 900, completion_tokens: 100, cache_tokens: 0 });
  check('无缓存时不显示缓存段', !noCache.includes('缓存'), '');
  check('客户端列表渲染为标签', clientTags(['Claude', 'OpenCode']).includes('Claude') && clientTags(['Claude', 'OpenCode']).includes('OpenCode'));
  check('客户端名称按 HTML 文本安全展示', clientTags(['<script>']).includes('&lt;script&gt;'));
}

// ---------- 配置安全性 ----------
function testConfigSafety() {
  section('配置与密钥安全');
  const src = serverSource();
  const pub = extract('function publicConfig', "app.put('/api/config'");
  check('publicConfig 不回传 SMTP 密码', !/smtpPass\s*:/.test(pub) || /smtpPassSet/.test(pub));
  check('publicConfig 不回传飞书密钥明文', !/feishuSecret\s*:/.test(pub));
  check('飞书 Webhook 只回传掩码', /feishuWebhookMasked/.test(pub) && !/feishuWebhook\s*:\s*CONFIG\.feishuWebhook/.test(pub));
  check('留空不覆盖已有密码', /if \(body\.smtpPass\) await apply\('smtpPass'/.test(src));
  check('显式 null 才清空密码', /body\.smtpPass === null/.test(src));
  check('掩码回传不会覆盖 Webhook', /startsWith\('\*{6}'\)/.test(src));
  check('登录失败有退避锁定', /loginGate|LOGIN_MAX_FAILURES/.test(src));
  check('提供健康检查端点', /app\.get\('\/healthz'/.test(src));
  check('注册了优雅退出', /process\.on\('SIGTERM'/.test(src));
  check('自动禁用受策略开关控制', /disablePolicy === 'auto'/.test(src));
  check('禁用前检查白名单', /whitelistSet\.has\(token\.token_id\)/.test(src));
}

// ---------- 前后端接线 ----------
function testWiring() {
  section('前后端接线');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const src = serverSource();

  const missingIds = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))]
    .filter(id => !html.includes(`id="${id}"`) && id !== 'liveToast');
  check('前端引用的 DOM id 都存在', missingIds.length === 0, missingIds.join('、'));

  const unwired = [...new Set([...html.matchAll(/id="(cfg[A-Za-z]+)"/g)].map(m => m[1]))]
    .filter(id => !js.includes(`'${id}'`));
  check('设置项都有读写逻辑', unwired.length === 0, unwired.join('、'));

  const kv = extract('KV_CONFIG_KEYS', 'async function loadSavedConfig');
  const pub = extract('function publicConfig', "app.put('/api/config'");
  const put = extract("app.put('/api/config'", "app.post('/api/notify/test'");
  const keys = ['dailyLimit', 'notifyEmail', 'smtpHost', 'smtpPort', 'smtpUser', 'notifyScript',
    'alertDailyLimit', 'alertUsageAnomaly', 'alertIpUsers', 'alertSubscription', 'scriptClaudeAlertCalls', 'scriptGptAlertCalls', 'disablePolicy', 'disableOnScript', 'ruleEnabled', 'surgeWindowMin', 'surgeCalls', 'surgeRatio',
    'surgeCostUsd', 'shareIpPerToken', 'shareUsersPerIp', 'alertCooldownMin', 'subscriptionAlertPct'];
  const broken = keys.filter(k => !kv.includes(k) || !pub.includes(k) || !put.includes(k));
  check('配置项在持久化/读取/写入三处齐全', broken.length === 0, broken.join('、'));

  const kinds = [...new Set([...src.matchAll(/kind: '([a-z_]+)'/g)].map(m => m[1]))];
  const noLabel = kinds.filter(k => !js.includes(k));
  check('告警类型都有前端标签', noLabel.length === 0, noLabel.join('、'));
}

// ---------- 统计口径 ----------
function testUsageSemantics() {
  section('统计口径');
  const src = serverSource();
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('调用次数只统计真实请求（type 2/5）', /const REQUEST_LOGS = 'type IN \(2, 5\)'/.test(src));
  check('费用只对消费日志求和', /SUM\(quota\) FILTER \(WHERE type = 2\)/.test(src));
  check('token 用量只对消费日志求和且缓存按 60% 计入', /SUM\(COALESCE\(prompt_tokens, 0\) \+ COALESCE\(completion_tokens, 0\) \+ \(\$\{CACHE_TOKENS_EXPR\} \* 0\.6\)\) FILTER \(WHERE type = 2\)/.test(src));
  check('缓存 token 用正则提取而非 jsonb 强转', /SUBSTRING\(other FROM '"cache_tokens":\(\[0-9\]\+\)'\)/.test(src));
  check('报错分析不再把 other 整列传回 Node', !/SELECT id, created_at, type, content[\s\S]{0,200}channel_id, channel_name, other\s*\n\s*FROM logs/.test(src));
  check('报错明细有行数上限兜底', /LIMIT \$2/.test(src) && /ERROR_ROWS_LIMIT/.test(src));
  check('聚合缓存带版本号', /CACHE_SCHEMA_VERSION/.test(src));
  check('脚本告警同时按模型名统计 Claude/GPT', /model_name[\s\S]{0,180}claude_calls[\s\S]{0,180}gpt_calls/.test(src));
  check('非聚焦告警可分别关闭', /CONFIG\.alertUsageAnomaly && triggers\.length/.test(src) && /CONFIG\.alertDailyLimit && t\.count/.test(src));
  check('缓存命中率以新输入加缓存为分母', /total_cache \/ \(b\.total_prompt \+ b\.total_cache\)/.test(js));
  check('用户分析返回并展示 IP 分布', /ip_count/.test(src) && /d\.ips/.test(js));
  check('用户分析明确标注 Trace 占比', /Trace 占比/.test(js));
  check('Token 聚合返回 IP 数量和客户端', /ip_count/.test(src) && /clients/.test(src));
  check('客户端识别覆盖常见四类', ['Claude', 'Codex', 'OpenCode', 'Trae'].every(client => src.includes(`'${client}'`)));
  check('客户端优先读取真实 User-Agent，Trace 仅作兜底', /CLIENT_USER_AGENT_EXPR/.test(src) && /'user_agent'/.test(src) && /CLIENT_SIGNAL_EXPR/.test(src));
  check('Token 排行展示 IP 数量和使用客户端', /label: 'IP 数量'/.test(js) && /label: '使用客户端'/.test(js) && /t\.ip_count/.test(js) && /clientTags\(t\.clients\)/.test(js));
}

(async () => {
  await testFeishu();
  testNotifyOverrides();
  testFormatters();
  testConfigSafety();
  testWiring();
  testUsageSemantics();
  process.exit(summary() ? 0 : 1);
})();
