// ==================== 全局状态 ====================
let config = {};
let whitelistIds = new Set();
let currentRange = 'today';
let currentDim = 'token';
let currentSort = { key: 'total_tokens', dir: 'desc' };
let currentData = [];
let currentPage = 1;
const pageSize = 20;
let tokenStatuses = {};
let errorCharts = [];
let errorGroupData = [];
let errorGroupSearch = '';
let errorGroupSort = { key: 'count', dir: 'desc' };

// ==================== API 调用 ====================
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location.replace('/login.html'); throw new Error('未登录或登录已过期'); }
  return res.json();
}

// ==================== 工具函数 ====================
function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: config.timezone || 'Asia/Shanghai' });
}
// logs.quota 是 NewAPI 内部计费单位（默认 500000 = $1），面板一律换算成美元展示
function formatUSD(q) {
  const unit = (config && config.quotaPerUnit) || 500000;
  return formatUSDValue((q || 0) / unit);
}
function formatUSDValue(usd) {
  if (!usd) return '$0';
  if (usd >= 100) return '$' + usd.toFixed(0);
  if (usd >= 1) return '$' + usd.toFixed(2);
  if (usd < 0.000001) return '<$0.000001';
  const digits = usd >= 0.01 ? 3 : 6;
  return '$' + usd.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}
// 实际使用的 token（输入 + 输出）
function formatTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}
const GPT_CACHE_WEIGHTS = { 'gpt-5.6-sol': 0.1, 'gpt-5.6-terra': 0.1, 'gpt-5.6-luna': 0.1 };
function weightedInputTokens(r) {
  if (r.input_tokens != null) return Number(r.input_tokens) || 0;
  const prompt = Math.max(0, Number(r.prompt_tokens) || 0);
  const cache = Math.max(0, Number(r.cache_tokens) || 0);
  const weight = GPT_CACHE_WEIGHTS[String(r.model_name || '').toLowerCase()] ?? 0.2;
  return Math.max(prompt - cache, 0) + cache * weight;
}
function tokenUsageCell(r) {
  const cache = r.cache_tokens || 0;
  const total = r.total_tokens != null ? r.total_tokens : (r.prompt_tokens || 0) + (r.completion_tokens || 0);
  const prompt = r.prompt_tokens || 0;
  const fresh = r.fresh_input_tokens != null ? Math.max(Number(r.fresh_input_tokens) || 0, 0) : Math.max(prompt - cache, 0);
  const input = fresh + cache;
  const cacheHitPct = input > 0 ? cache / input * 100 : 0;
  const detail = `缓存命中率 ${cacheHitPct.toFixed(1)}%`;
  const title = `总 Token ${(total || 0).toLocaleString()} tokens`
    + `\n缓存命中率 ${cacheHitPct.toFixed(1)}%`
    + `\n输入 ${prompt.toLocaleString()}`
    + (cache > 0 ? `（其中缓存读取 ${cache.toLocaleString()}）` : '')
    + `\n输出 ${(r.completion_tokens || 0).toLocaleString()}`;
  return `<td title="${title}">
    <strong>${formatTokens(total)}</strong>
    <br><span class="dim">${detail}</span>
  </td>`;
}
function tokenFamilyCell(label, r, prefix, cacheWeight) {
  const input = Number(r[`${prefix}_input_tokens`]) || 0;
  const cache = Number(r[`${prefix}_cache_tokens`]) || 0;
  const fresh = Math.max(0, input - cache * cacheWeight);
  const detail = cache > 0
    ? `新 ${formatTokens(fresh)} + 缓存 ${formatTokens(cache)}`
    : '无缓存读取';
  return `<td title="${label} ${input.toLocaleString()} tokens\n${detail}"><strong>${formatTokens(input)}</strong><br><span class="dim">${detail}</span></td>`;
}
function tokenFamilyCells(r) {
  return tokenFamilyCell('GPT', r, 'gpt', 0.1) + tokenFamilyCell('Claude', r, 'claude', 0.2);
}
function userAgentTags(userAgents) {
  const values = Array.isArray(userAgents) ? userAgents : [];
  return values.length
    ? values.map(item => `<span class="model-tag">${escapeHtml(item.name)} ×${item.count}</span>`).join('')
    : '<span class="dim">未知</span>';
}
function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

// ==================== 表头配置 ====================
const COLUMNS = {
  token: [
    { key: '#', label: '#', sortable: false },
    { key: 'token_name', label: 'Token', sortable: true },
    { key: 'total_tokens', label: '总 Token', sortable: true },
    { key: 'gpt_input_tokens', label: 'GPT', sortable: true },
    { key: 'claude_input_tokens', label: 'Claude', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'ip_count', label: 'IP 数量', sortable: true },
    { key: 'username', label: '用户', sortable: true },
    { key: 'quota', label: '费用', sortable: true },
    { key: 'cost_usd', label: '成本', sortable: true },
    { key: 'models', label: '模型分布', sortable: false },
    { key: 'user_agents', label: '完整 User-Agent 请求头', sortable: false },
    { key: 'action', label: '操作', sortable: false },
  ],
  user: [
    { key: '#', label: '#' },
    { key: 'username', label: '用户', sortable: true },
    { key: 'token_count', label: 'Token数', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'total_tokens', label: '总 Token', sortable: true },
    { key: 'quota', label: '费用', sortable: true },
    { key: 'action', label: '操作', sortable: false },
  ],
  model: [
    { key: '#', label: '#' },
    { key: 'model_name', label: '模型', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'total_tokens', label: '总 Token', sortable: true },
    { key: 'quota', label: '费用', sortable: true },
  ],
  group: [
    { key: '#', label: '#' },
    { key: 'grp', label: '分组', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'total_tokens', label: '总 Token', sortable: true },
    { key: 'quota', label: '费用', sortable: true },
  ],
  channel: [
    { key: '#', label: '#' },
    { key: 'channel_name', label: '渠道', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'total_tokens', label: '总 Token', sortable: true },
    { key: 'quota', label: '费用', sortable: true },
  ],
  ip: [
    { key: '#', label: '#' },
    { key: 'ip', label: '客户端 IP', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'user_count', label: '活跃用户', sortable: true },
    { key: 'token_count', label: '活跃 Token', sortable: true },
    { key: 'first_at', label: '首次调用', sortable: true },
    { key: 'last_at', label: '最近调用', sortable: true },
  ],
};

// ==================== 渲染逻辑 ====================
function renderStats(data) {
  if (!data) return;
  document.getElementById('statTotalLogs').textContent = formatNumber(data.totalLogs || data.total);
  document.getElementById('statRpm').textContent = data.stat ? data.stat.rpm : '-';
  document.getElementById('statTpm').textContent = data.stat ? formatNumber(data.stat.tpm) : '-';
  document.getElementById('statTokens').textContent = data.tokens ? data.tokens.length : (data.rows ? data.rows.length : '-');
  // token 用量 / 费用：按当前区间的聚合行求和（usageRows 优先，快照只覆盖今天）
  const usageRows = data.usageRows || data.tokens || data.rows || [];
  const totals = usageRows.reduce((acc, r) => {
    acc.tokens += r.total_tokens != null ? r.total_tokens : (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    acc.quota += r.quota || 0;
    return acc;
  }, { tokens: 0, quota: 0 });
  document.getElementById('statTokenUsage').textContent = usageRows.length ? formatTokens(totals.tokens) : '-';
  document.getElementById('statTokenUsage').title = totals.tokens.toLocaleString() + ' tokens';
  document.getElementById('statQuota').textContent = usageRows.length ? formatUSD(totals.quota) : '-';
  const overLimit = data.tokens ? data.tokens.filter(t => t.count > config.dailyLimit).length : 0;
  document.getElementById('statOverLimit').textContent = overLimit;
  document.getElementById('updateTime').textContent =
    '更新于 ' + new Date(data.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false, timeZone: config.timezone || 'Asia/Shanghai' });
}

function renderTableHead() {
  const cols = COLUMNS[currentDim] || COLUMNS.token;
  const head = document.getElementById('rankingHead');
  head.innerHTML = cols.map(col => {
    if (!col.sortable) return `<th>${col.label}</th>`;
    const arrow = currentSort.key === col.key ? (currentSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="sortable" data-sort="${col.key}">${col.label}${arrow}</th>`;
  }).join('');

  // 绑定排序事件
  head.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        currentSort = { key, dir: 'desc' };
      }
      renderTableBody();
      renderTableHead();
    });
  });
}

function renderTableBody() {
  const tbody = document.querySelector('#rankingTable tbody');
  const filter = document.getElementById('searchInput').value.toLowerCase();
  let rows = [...currentData];

  // 搜索过滤
  if (filter) {
    rows = rows.filter(r =>
      (r.token_name || '').toLowerCase().includes(filter) ||
      (r.username || '').toLowerCase().includes(filter) ||
      (r.model_name || '').toLowerCase().includes(filter) ||
      (r.grp || '').toLowerCase().includes(filter) ||
      (r.channel_name || '').toLowerCase().includes(filter) ||
      (r.ip || '').toLowerCase().includes(filter)
    );
  }

  // 排序
  rows.sort((a, b) => {
    let va = a[currentSort.key], vb = b[currentSort.key];
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
    if (va < vb) return currentSort.dir === 'asc' ? -1 : 1;
    if (va > vb) return currentSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading">暂无数据</td></tr>`;
    renderPagination(0);
    return;
  }

  // 分页
  const totalPages = Math.ceil(rows.length / pageSize);
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  const limit = config.dailyLimit || 2000;
  tbody.innerHTML = pageRows.map((r, i) => {
    const idx = start + i;
    if (currentDim === 'token') return renderTokenRow(r, idx, limit);
    if (currentDim === 'user') return renderUserRow(r, idx);
    if (currentDim === 'model') return renderModelRow(r, idx);
    if (currentDim === 'group') return renderGroupRow(r, idx);
    if (currentDim === 'channel') return renderChannelRow(r, idx);
    if (currentDim === 'ip') return renderIpRow(r, idx);
  }).join('');

  renderPagination(rows.length);
}

function renderPagination(totalItems) {
  const el = document.getElementById('pagination');
  const totalPages = Math.ceil(totalItems / pageSize);
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  html += `<button class="page-btn" ${currentPage<=1?'disabled':''} onclick="gotoPage(${currentPage-1})">‹</button>`;

  const maxShow = 5;
  let s = Math.max(1, currentPage - Math.floor(maxShow/2));
  let e = Math.min(totalPages, s + maxShow - 1);
  s = Math.max(1, e - maxShow + 1);

  if (s > 1) html += `<button class="page-btn" onclick="gotoPage(1)">1</button><span class="page-dots">…</span>`;
  for (let i = s; i <= e; i++) {
    html += `<button class="page-btn ${i===currentPage?'active':''}" onclick="gotoPage(${i})">${i}</button>`;
  }
  if (e < totalPages) html += `<span class="page-dots">…</span><button class="page-btn" onclick="gotoPage(${totalPages})">${totalPages}</button>`;

  html += `<button class="page-btn" ${currentPage>=totalPages?'disabled':''} onclick="gotoPage(${currentPage+1})">›</button>`;
  html += `<span class="page-info">${totalItems} 条</span>`;
  el.innerHTML = html;
}

function gotoPage(p) {
  currentPage = p;
  renderTableBody();
}

function renderTokenRow(t, i, limit) {
  const overLimit = t.count > limit;
  const pct = Math.min(t.count / limit * 100, 100);
  const isWl = whitelistIds.has(t.token_id);
  const models = t.models ? Object.entries(t.models).sort((a,b) => b[1]-a[1]).slice(0,3)
    .map(([m,c]) => `<span class="model-tag">${m}×${c}</span>`).join('') : '';
  const status = tokenStatuses[t.token_id];
  const isEnabled = status !== 2;
  const cost = t.cost_priced_calls > 0
    ? `<span title="仅按 Terra 成本计入 ${t.cost_priced_calls.toLocaleString()} 次 Sol/Terra 调用">${formatUSDValue(t.cost_usd)}</span>`
    : '--';
  return `
    <tr class="${overLimit && !isWl ? 'over-limit' : ''}">
      <td>${i+1}</td>
      <td><strong>${t.token_name || '-'}</strong><br><span class="dim">ID: ${t.token_id}</span></td>
      ${tokenUsageCell(t)}
      ${tokenFamilyCells(t)}
      <td><div class="count-bar"><span>${t.count}</span><div class="count-bar-bg"><div class="count-bar-fill ${overLimit?'danger':''}" style="width:${pct}%"></div></div></div></td>
      <td>${t.ip_count || 0}</td>
      <td>${t.username}${isWl ? ' <span class="wl-badge"><svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>' : ''}</td>
      <td>${formatUSD(t.quota)}</td>
      <td>${cost}</td>
      <td><div class="model-tags">${models}</div></td>
      <td class="user-agent-cell"><div class="model-tags">${userAgentTags(t.user_agents)}</div></td>
      <td>
        <button class="btn-analyze" onclick="analyzeItem('token', ${t.token_id}, '${(t.token_name || t.token_id).toString().replace(/'/g, "\\'")}')">分析</button>
      </td>
    </tr>`;
}
function renderUserRow(r, i) {
  return `<tr><td>${i+1}</td><td><strong>${r.username || '-'}</strong></td><td>${r.token_count || '-'}</td><td>${r.count}</td>${tokenUsageCell(r)}<td>${formatUSD(r.quota)}</td><td><button class="btn-analyze" onclick="analyzeItem('user', '${r.username}', '${r.username}')">分析</button></td></tr>`;
}
function renderModelRow(r, i) {
  return `<tr><td>${i+1}</td><td><span class="model-tag">${r.model_name || '-'}</span></td><td>${r.count}</td>${tokenUsageCell(r)}<td>${formatUSD(r.quota)}</td></tr>`;
}
function renderGroupRow(r, i) {
  return `<tr><td>${i+1}</td><td>${r.grp || '-'}</td><td>${r.count}</td>${tokenUsageCell(r)}<td>${formatUSD(r.quota)}</td></tr>`;
}
function renderChannelRow(r, i) {
  return `<tr><td>${i+1}</td><td>${r.channel_name || r.channel || '-'}</td><td>${r.count}</td>${tokenUsageCell(r)}<td>${formatUSD(r.quota)}</td></tr>`;
}
function renderIpRow(r, i) {
  const isMissing = r.ip === '(未记录)';
  const action = isMissing ? '-' : `<button class="btn-analyze" onclick="showIpLogs('${r.ip.replace(/'/g, "\\'")}')">查看调用</button>`;
  return `<tr><td>${i + 1}</td><td><strong>${r.ip}</strong></td><td>${formatNumber(r.count)}</td><td>${r.user_count}</td><td>${r.token_count}</td><td>${formatTime(r.first_at)}</td><td>${formatTime(r.last_at)} ${action}</td></tr>`;
}

// 实时规则产生的告警类型
const ACTION_LABELS = {
  notify_script: '🤖 脚本行为',
  alert_usage: '⚡ 用量异常',
  alert_token_ips: '👥 疑似共享',
  alert_ip_users: '🌐 同 IP 多账号',
  alert_subscription: '📉 订阅余量告急',
  auto_disable: '🔒 自动禁用',
  auto_disable_script: '🔒 脚本禁用',
};

function renderActions(actions) {
  const tbody = document.querySelector('#actionsTable tbody');
  if (!actions || actions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading">暂无记录</td></tr>';
    return;
  }
  tbody.innerHTML = actions.map(a => `
    <tr>
      <td>${formatTime(a.created_at)}</td>
      <td>${a.token_name || a.token_id}</td>
      <td>${a.username || '-'}</td>
      <td><span class="action-badge ${a.action}">${
        a.action === 'notify' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg> 邮件通知' :
        a.action === 'auto_disable' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M8 16h.01"/><path d="M16 16h.01"/></svg> 自动禁用' :
        a.action === 'auto_disable_script' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6l1 5-4 2v2.5l3.5 2v3L12 21l-3.5-3.5v-3L12 12.5V10L8 8l1-5z"/></svg> 脚本禁用' :
        a.action === 'manual_disable' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> 手动禁用' :
        a.action === 'manual_enable' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 手动启用' :
        ACTION_LABELS[a.action] || a.action
      }</span></td>
      <td>${a.reason || '-'}</td>
      <td>${a.daily_count || '-'}</td>
    </tr>
  `).join('');
}

function renderWhitelist(list) {
  const tbody = document.querySelector('#whitelistTable tbody');
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading">白名单为空</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(w => `
    <tr>
      <td>${w.token_id}</td><td>${w.token_name || '-'}</td><td>${w.note || '-'}</td>
      <td>${formatTime(w.created_at)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="handleRemoveWhitelist(${w.token_id})">移除</button></td>
    </tr>
  `).join('');
}

// ==================== 趋势图 ====================
const COLORS = [
  '#4a9eff', '#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3',
  '#54a0ff', '#5f27cd', '#01a3a4', '#f368e0', '#ff9f43',
];
const darkTheme = {
  x: { ticks: { color: '#888', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
  y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
};
const barOpts = (indexAxis = 'x') => ({
  responsive: true, indexAxis,
  plugins: { legend: { labels: { color: '#e0e0e0', font: { size: 11 } } } },
  scales: indexAxis === 'y'
    ? { x: { ...darkTheme.x, beginAtZero: true }, y: { ...darkTheme.y, ticks: { ...darkTheme.y.ticks, font: { size: 11 } } } }
    : darkTheme,
});
const pieOpts = () => ({
  responsive: true,
  plugins: {
    legend: { position: 'right', labels: { color: '#e0e0e0', font: { size: 11 }, padding: 8, usePointStyle: true } },
    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString()}` } },
  },
});

let charts = [];
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }
function destroyErrorCharts() { errorCharts.forEach(c => c.destroy()); errorCharts = []; }

function renderTrend(trendData, distData) {
  destroyCharts();
  const labels = trendData.map(d => d.label);

  // 1. 每小时调用量（tooltip 附带该小时的 token 用量与费用）
  charts.push(new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{
      label: '调用次数', data: trendData.map(d => d.count),
      backgroundColor: 'rgba(74, 158, 255, 0.6)', borderColor: 'rgba(74, 158, 255, 1)',
      borderWidth: 1, borderRadius: 4,
    }] },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#e0e0e0' } },
        tooltip: { callbacks: {
          label: ctx => `调用 ${ctx.parsed.y} 次`,
          afterLabel: ctx => {
            const d = trendData[ctx.dataIndex] || {};
            return `Token 用量: ${(d.total_tokens || 0).toLocaleString()}\n费用: ${formatUSD(d.quota)}`;
          },
        } },
      },
      scales: darkTheme,
    },
  }));

  // 2. 每小时活跃 Token / 用户 (双折线)
  charts.push(new Chart(document.getElementById('activeChart').getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [
      { label: '活跃 Token', data: trendData.map(d => d.active_tokens), borderColor: '#48dbfb', backgroundColor: 'rgba(72,219,251,0.1)', fill: true, tension: 0.3, pointRadius: 3 },
      { label: '活跃用户', data: trendData.map(d => d.active_users), borderColor: '#ff9ff3', backgroundColor: 'rgba(255,159,243,0.1)', fill: true, tension: 0.3, pointRadius: 3 },
    ] },
    options: { responsive: true, plugins: { legend: { labels: { color: '#e0e0e0' } } }, scales: darkTheme },
  }));

  if (!distData) return;

  // 3. 用户调用量排名 (水平柱状)
  if (distData.users) {
    const u = distData.users;
    charts.push(new Chart(document.getElementById('userRankChart').getContext('2d'), {
      type: 'bar',
      data: { labels: u.map(x => x.username), datasets: [{
        label: '调用次数', data: u.map(x => x.count),
        backgroundColor: COLORS, borderRadius: 4,
      }] },
      options: barOpts('y'),
    }));
  }

  // 4. Token 调用量排名 (水平柱状)
  if (distData.tokens) {
    const t = distData.tokens;
    charts.push(new Chart(document.getElementById('tokenRankChart').getContext('2d'), {
      type: 'bar',
      data: { labels: t.map(x => `${x.token_name || x.token_id} (${x.username})`), datasets: [{
        label: '调用次数', data: t.map(x => x.count),
        backgroundColor: COLORS, borderRadius: 4,
      }] },
      options: barOpts('y'),
    }));
  }

  // 5. 用户 Token 用量排名 (水平柱状)
  if (distData.users_by_tokens || distData.users) {
    const u = [...(distData.users_by_tokens || distData.users)].sort((a, b) => weightedInputTokens(b) - weightedInputTokens(a));
    const opts = barOpts('y');
    opts.plugins = {
      ...(opts.plugins || {}),
      tooltip: { callbacks: {
        label: ctx => `输入折算 Token: ${weightedInputTokens(u[ctx.dataIndex]).toLocaleString()} · 费用: ${formatUSD(u[ctx.dataIndex].quota)}`,
      } },
    };
    charts.push(new Chart(document.getElementById('userQuotaRankChart').getContext('2d'), {
      type: 'bar',
      data: { labels: u.map(x => x.username), datasets: [{
        label: '输入 Token（折算）', data: u.map(weightedInputTokens),
        backgroundColor: COLORS.map(c => c + 'cc'), borderRadius: 4,
      }] },
      options: opts,
    }));
  }

  // 6. 模型调用分布 (环形)
  if (distData.models) {
    const m = distData.models;
    charts.push(new Chart(document.getElementById('modelPieChart').getContext('2d'), {
      type: 'doughnut',
      data: { labels: m.map(x => x.model_name), datasets: [{ data: m.map(x => x.count), backgroundColor: COLORS }] },
      options: pieOpts(),
    }));
  }
}

// ==================== 数据加载 ====================
async function loadConfig() {
  const res = await api('/api/config');
  if (res.success) config = res.data;
}

function applyDashboardData(payload) {
  if (!payload) return;
  config = payload.config || config;
  whitelistIds = new Set((payload.whitelist || []).map(w => w.token_id));
  tokenStatuses = payload.tokenStatuses || {};
  renderWhitelist(payload.whitelist || []);
  renderActions(payload.actions || []);

  currentData = (payload.stats && payload.stats.rows) ? payload.stats.rows : [];
  if (currentDim === 'token' && payload.snapshot && payload.snapshot.tokens) {
    const modelMap = {};
    for (const t of payload.snapshot.tokens) modelMap[t.token_id] = t.models;
    for (const row of currentData) {
      if (modelMap[row.token_id]) row.models = modelMap[row.token_id];
    }
  }

  renderTableHead();
  renderTableBody();
  const statPayload = payload.snapshot
    ? { ...payload.snapshot, totalLogs: payload.stats ? payload.stats.total : payload.snapshot.totalLogs, usageRows: currentData }
    : { total: payload.stats ? payload.stats.total : 0, rows: currentData, usageRows: currentData, time: Date.now() };
  renderStats(statPayload);
}

async function loadDashboard() {
  const res = await api(`/api/dashboard?range=${currentRange}&dim=${currentDim}`);
  if (!res.success) return;
  applyDashboardData(res.data);
}

async function loadWhitelist() {
  const res = await api('/api/whitelist');
  if (res.success) {
    whitelistIds = new Set(res.data.map(w => w.token_id));
    renderWhitelist(res.data);
  }
}

async function loadStats() {
  // 先获取 token 状态
  try {
    const statusRes = await api('/api/token-status');
    if (statusRes.success) tokenStatuses = statusRes.data;
  } catch {}

  const res = await api(`/api/stats?range=${currentRange}&dim=${currentDim}`);
  if (res.success) {
    currentData = res.data.rows;
    // 如果是 today + token 维度，也获取模型分布
    if (currentDim === 'token') {
      const snap = await api('/api/snapshot');
      if (snap.success && snap.data && snap.data.tokens) {
        const modelMap = {};
        for (const t of snap.data.tokens) modelMap[t.token_id] = t.models;
        for (const r of currentData) {
          if (modelMap[r.token_id]) r.models = modelMap[r.token_id];
        }
      }
    }
    renderTableHead();
    renderTableBody();
    // 更新 stats 卡片
    const snap = await api('/api/snapshot');
    if (snap.success && snap.data) {
      snap.data.totalLogs = res.data.total;
      snap.data.usageRows = currentData; // 用量按当前区间统计，快照只覆盖今天
      renderStats(snap.data);
    }
  }
}

async function loadTrend() {
  const [trendRes, distRes] = await Promise.all([
    api(`/api/trend?range=${currentRange}`),
    api(`/api/distribution?range=${currentRange}`),
  ]);
  if (trendRes.success) renderTrend(trendRes.data, distRes.success ? distRes.data : null);
}

async function loadActions() {
  const actRes = await api('/api/actions');
  if (actRes.success) renderActions(actRes.data);
}

function renderErrorSummary(summary) {
  document.getElementById('errTotalRequests').textContent = formatNumber(summary.total_requests || 0);
  document.getElementById('errMainFailures').textContent = formatNumber(summary.main_failures || 0);
  document.getElementById('errStreamInterrupts').textContent = formatNumber(summary.stream_interrupts || 0);
  document.getElementById('errTotalRate').textContent = (summary.total_failure_rate || 0).toFixed(2) + '%';
  document.getElementById('errAffectedChannels').textContent = formatNumber(summary.affected_channels || 0);
}

function renderErrorCharts(statusCodes, streamReasons) {
  destroyErrorCharts();

  const statusCtx = document.getElementById('errorStatusChart');
  const streamCtx = document.getElementById('streamReasonChart');

  if (statusCtx && statusCodes.length > 0) {
    errorCharts.push(new Chart(statusCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: statusCodes.slice(0, 10).map(x => x.status_code),
        datasets: [{
          label: '主失败次数',
          data: statusCodes.slice(0, 10).map(x => x.count),
          backgroundColor: 'rgba(255, 107, 107, 0.65)',
          borderColor: '#ff6b6b',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: { responsive: true, plugins: { legend: { labels: { color: '#e0e0e0' } } }, scales: darkTheme },
    }));
  }

  if (streamCtx && streamReasons.length > 0) {
    errorCharts.push(new Chart(streamCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: streamReasons.slice(0, 8).map(x => x.reason),
        datasets: [{
          label: '流式中断次数',
          data: streamReasons.slice(0, 8).map(x => x.count),
          backgroundColor: 'rgba(250, 173, 20, 0.65)',
          borderColor: '#faad14',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: barOpts('y'),
    }));
  }
}

function renderErrorChannels(channels) {
  const tbody = document.querySelector('#errorChannelsTable tbody');
  if (!channels || channels.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading">暂无异常渠道</td></tr>';
    return;
  }

  tbody.innerHTML = channels.map((r, i) => {
    const badges = (r.top_status_codes || []).map(s => `<span class="error-code-badge">${s.status_code} x ${formatNumber(s.count)}</span>`).join('');
    return `<tr>
      <td>${i + 1}</td>
      <td><strong>${r.channel_name || '-'}</strong></td>
      <td>${formatNumber(r.total_requests)}</td>
      <td><span class="error-num danger">${formatNumber(r.main_failures)}</span></td>
      <td><span class="error-num warn">${formatNumber(r.stream_interrupts)}</span></td>
      <td>
        <div class="count-bar">
          <span>${r.total_failure_rate.toFixed(2)}%</span>
          <div class="count-bar-bg"><div class="count-bar-fill danger" style="width:${Math.min(r.total_failure_rate, 100)}%"></div></div>
        </div>
        <div class="dim">主失败 ${r.main_failure_rate.toFixed(2)}% · 中断 ${r.stream_interrupt_rate.toFixed(2)}%</div>
      </td>
      <td><div class="error-code-list">${badges || '<span class="dim">-</span>'}</div></td>
    </tr>`;
  }).join('');
}

function renderRecentErrors(items) {
  const tbody = document.querySelector('#recentErrorsTable tbody');
  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading">暂无错误明细</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(r => {
    const typeLabel = r.type === 5
      ? `<span class="error-type main">${r.status_code || 'unknown'}</span>`
      : `<span class="error-type stream">${r.stream_end_reason || 'stream'}</span>`;
    const summary = (r.content || '').trim() || (r.type === 5 ? (r.error_type || '主失败') : '流式中断');
    return `<tr>
      <td>${formatTime(r.created_at)}</td>
      <td>${typeLabel}</td>
      <td>${r.channel_name || '-'}</td>
      <td><span class="model-tag">${r.model_name || '-'}</span></td>
      <td>${r.username || '-'}</td>
      <td><span class="dim">#${r.token_id || '-'}</span> ${r.token_name || ''}</td>
      <td class="error-summary-cell" title="${summary.replace(/"/g, '&quot;')}">${summary}</td>
    </tr>`;
  }).join('');
}

function renderErrorGroups() {
  const tbody = document.querySelector('#errorGroupsTable tbody');
  let rows = errorGroupData;

  if (errorGroupSearch) {
    const f = errorGroupSearch.toLowerCase();
    rows = rows.filter(g =>
      (g.category_label || '').toLowerCase().includes(f) ||
      (g.category_code || '').toLowerCase().includes(f) ||
      (g.top_channels || []).some(ch =>
        (ch.channel_name || '').toLowerCase().includes(f) ||
        (ch.channel_key || '').toLowerCase().includes(f)
      ) ||
      (g.examples || []).some(example =>
        (example.content || '').toLowerCase().includes(f) ||
        (example.normalized_content || '').toLowerCase().includes(f) ||
        (example.channel_name || '').toLowerCase().includes(f)
      ) ||
      (g.normalized_content || '').toLowerCase().includes(f) ||
      (g.content || '').toLowerCase().includes(f) ||
      (g.status_code || '').toLowerCase().includes(f) ||
      (g.stream_end_reason || '').toLowerCase().includes(f)
    );
  }

  rows = [...rows].sort((a, b) => {
    let va = a[errorGroupSort.key];
    let vb = b[errorGroupSort.key];
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
    if (va < vb) return errorGroupSort.dir === 'asc' ? -1 : 1;
    if (va > vb) return errorGroupSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading">${errorGroupSearch ? '无匹配结果' : '暂无报错分类数据'}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((g, i) => {
    const typeLabel = g.type === 5 ? '<span class="error-type main">主失败</span>' : '<span class="error-type stream">流式中断</span>';
    const codeLabel = g.category_label || (g.type === 5 ? (g.status_code || 'unknown') : (g.stream_end_reason || 'stream'));
    const mergedCount = g.example_count || g.variant_count || 0;
    const sampleNote = mergedCount > 1 ? `<div class="dim">已合并 ${mergedCount} 种相似文案</div>` : '';
    const channelHtml = renderErrorGroupChannels(g.top_channels || [], g.channel_count || 0);
    const examplesHtml = renderErrorGroupExamples(g.examples || [], g.normalized_content || g.content);
    return `<tr>
      <td>${i + 1}</td>
      <td><strong>${g.count.toLocaleString()}</strong></td>
      <td>${typeLabel}</td>
      <td>${codeLabel}</td>
      <td>${channelHtml}</td>
      <td>${formatTime(g.first_at)}</td>
      <td>${formatTime(g.last_at)}</td>
      <td>${sampleNote}${examplesHtml}</td>
    </tr>`;
  }).join('');
}

function renderErrorGroupChannels(items, totalCount) {
  if (!items || items.length === 0) {
    return `<div class="dim">共 ${totalCount || 0} 个渠道</div><div class="dim">-</div>`;
  }

  const list = items.map(ch => `
    <div class="error-group-channel-item">
      <span class="error-group-channel-name">${escapeHtml(ch.channel_name || ch.channel_key || 'unknown')}</span>
      <span class="error-group-channel-count">x ${formatNumber(ch.count || 0)}</span>
    </div>
  `).join('');

  return `<div class="error-group-channel-list">${list}</div><div class="dim">共 ${totalCount || items.length} 个渠道</div>`;
}

function renderErrorGroupExamples(items, fallbackText) {
  if (!items || items.length === 0) {
    return `<pre class="error-content-pre">${escapeHtml(fallbackText || '(空)')}</pre>`;
  }

  return `<div class="error-group-example-list">${items.map(example => `
    <div class="error-group-example-item">
      <div class="error-group-example-meta">
        <span>${escapeHtml(example.channel_name || 'unknown')}</span>
        <span>x ${formatNumber(example.count || 0)}</span>
        <span>${formatTime(example.last_at)}</span>
      </div>
      <pre class="error-content-pre">${escapeHtml(example.content || example.normalized_content || '(空)')}</pre>
    </div>
  `).join('')}</div>`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadErrorAnalysis() {
  const res = await api(`/api/error-analysis?range=${currentRange}`);
  if (!res.success) return;
  const d = res.data || {};
  errorGroupData = d.error_groups || [];
  renderErrorSummary(d.summary || {});
  renderErrorCharts(d.status_codes || [], d.stream_reasons || []);
  renderErrorChannels(d.channels || []);
  renderErrorGroups();
  renderRecentErrors(d.recent_errors || []);
}

let logsPage = 1;
let seenLogIds = null;
async function loadLogs(page) {
  if (page !== undefined) logsPage = page;
  const ip = document.getElementById('logIpFilter').value.trim();
  const query = new URLSearchParams({ range: currentRange, p: logsPage });
  if (ip) query.set('ip', ip);
  const res = await api(`/api/recent-logs?${query}`);
  if (!res.success) return;
  const { items, total, pageSize } = res.data;
  const tbody = document.querySelector('#logsTable tbody');
  // Live tail：与上一次渲染对比，新出现的记录高亮一下（首次加载不闪）
  const isFirstRender = seenLogIds === null;
  const previous = seenLogIds || new Set();
  const current = new Set(items.map(r => String(r.id)));
  tbody.innerHTML = items.map(r => {
    const failed = r.type === 5;
    const total = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    const isNew = !isFirstRender && logsPage === 1 && !previous.has(String(r.id));
    return `<tr class="${isNew ? 'row-new' : ''}">
      <td>${formatTime(r.created_at)}</td><td>${r.ip || '-'}</td><td>${r.username}</td><td><span class="dim">#${r.token_id}</span> ${r.token_name || ''}</td>
      <td><span class="model-tag">${r.model_name}</span>${failed ? ' <span class="dim">失败</span>' : ''}</td>
      <td>${failed ? '-' : formatUSD(r.quota)}</td>
      <td>${(r.prompt_tokens||0).toLocaleString()}${r.cache_tokens > 0 ? `<br><span class="dim">缓存 ${(r.cache_tokens).toLocaleString()}</span>` : ''}</td>
      <td>${(r.completion_tokens||0).toLocaleString()}</td>
      <td>${total.toLocaleString()}</td>
      <td>${r.channel_name || '-'}</td>
    </tr>`;
  }).join('');
  seenLogIds = current;
  // 分页
  const totalPages = Math.ceil(total / pageSize);
  const pag = document.getElementById('logsPagination');
  let html = `<button class="page-btn" onclick="loadLogs(1)" ${logsPage<=1?'disabled':''}>&laquo;</button>`;
  html += `<button class="page-btn" onclick="loadLogs(${logsPage-1})" ${logsPage<=1?'disabled':''}>&lsaquo;</button>`;
  const start = Math.max(1, logsPage - 2), end = Math.min(totalPages, logsPage + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i===logsPage?'active':''}" onclick="loadLogs(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="loadLogs(${logsPage+1})" ${logsPage>=totalPages?'disabled':''}>&rsaquo;</button>`;
  html += `<button class="page-btn" onclick="loadLogs(${totalPages})" ${logsPage>=totalPages?'disabled':''}>&raquo;</button>`;
  html += `<span class="page-info">共 ${total} 条</span>`;
  pag.innerHTML = html;
}

// ==================== 订阅余量 ====================
async function loadSubscriptions() {
  const tbody = document.querySelector('#subsTable tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="loading">加载中...</td></tr>';
  const res = await api('/api/subscriptions');
  if (!res.success) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading">${res.message || '加载失败'}</td></tr>`;
    return;
  }
  const list = res.data || [];
  const alertPct = res.alertPct || 0;
  document.getElementById('subsHint').textContent =
    `共 ${list.length} 个活跃订阅（近 7 天有调用），按剩余比例升序；低于 ${alertPct}% 会推送续费提醒`;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading">暂无订阅数据</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((s, i) => {
    const danger = s.remain_pct <= 5;
    const warn = !danger && s.remain_pct <= alertPct;
    const color = danger ? 'var(--danger)' : warn ? '#feca57' : '#2ecc71';
    return `<tr class="${danger ? 'over-limit' : ''}">
      <td>${i + 1}</td>
      <td><strong>${s.username}</strong></td>
      <td>${s.plan}</td>
      <td>$${s.remain_usd}</td>
      <td>$${s.total_usd}</td>
      <td>
        <div class="count-bar"><span>${s.remain_pct}%</span>
          <div class="count-bar-bg"><div class="count-bar-fill" style="width:${Math.min(100, s.remain_pct)}%;background:${color}"></div></div>
        </div>
      </td>
      <td>${formatTime(s.last_at)}</td>
    </tr>`;
  }).join('');
}

async function refreshAll() {
  const btn = document.getElementById('btnRefresh');
  const refreshSvg = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.92-5.27l3.08-3.08"/></svg>';
  btn.disabled = true; btn.innerHTML = refreshSvg + ' 加载中...';
  try {
    await api('/api/poll', 'POST');
    await Promise.all([loadDashboard(), loadTrend()]);
    if (document.getElementById('panel-logs').classList.contains('active')) loadLogs(1);
    if (document.getElementById('panel-errors').classList.contains('active')) loadErrorAnalysis();
  } catch (e) { console.error('刷新失败:', e); }
  finally { btn.disabled = false; btn.innerHTML = refreshSvg + ' 刷新'; }
}

function showIpLogs(ip) {
  document.getElementById('logIpFilter').value = ip;
  document.querySelector('.tab[data-tab="logs"]').click();
}

// ==================== 交互 ====================
async function handleToggle(tokenId, userId, currentlyEnabled) {
  const action = currentlyEnabled ? 'disable' : 'enable';
  const label = currentlyEnabled ? '禁用' : '启用';
  if (!confirm(`确认${label} Token #${tokenId}？`)) return;
  try {
    const res = await api(`/api/token/${tokenId}/${action}`, 'POST', { user_id: userId });
    if (res.success) {
      tokenStatuses[tokenId] = currentlyEnabled ? 2 : 1;
      renderTableBody();
    } else {
      alert(`${label}失败: \n\n` + (res.message || '未知错误'));
    }
  } catch (e) {
    alert(`${label}异常: \n\n` + e.message);
  }
}
async function handleRemoveWhitelist(tokenId) {
  if (!confirm(`确认移除白名单 #${tokenId}？`)) return;
  await api(`/api/whitelist/${tokenId}`, 'DELETE');
  loadDashboard();
}

// ==================== 事件绑定 ====================
// 主 Tab
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById('panel-' + tab.dataset.tab);
    panel.classList.add('active');
    if (tab.dataset.tab === 'trend') loadTrend();
    if (tab.dataset.tab === 'errors') loadErrorAnalysis();
    if (tab.dataset.tab === 'logs') loadLogs(1);
    if (tab.dataset.tab === 'subs') loadSubscriptions();
  });
});

// 时间范围
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    currentPage = 1;
    loadDashboard();
    // 如果趋势面板可见就刷新趋势
    if (document.getElementById('panel-trend').classList.contains('active')) loadTrend();
    if (document.getElementById('panel-errors').classList.contains('active')) loadErrorAnalysis();
    if (document.getElementById('panel-logs').classList.contains('active')) loadLogs(1);
  });
});

// 维度子 Tab
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDim = tab.dataset.dim;
    currentSort = currentDim === 'ip' ? { key: 'count', dir: 'desc' } : { key: 'input_tokens', dir: 'desc' };
    currentPage = 1;
    loadDashboard();
  });
});

// 搜索
document.getElementById('searchInput').addEventListener('input', () => { currentPage = 1; renderTableBody(); });
document.getElementById('btnFilterLogs').addEventListener('click', () => loadLogs(1));
document.getElementById('logIpFilter').addEventListener('keydown', event => { if (event.key === 'Enter') loadLogs(1); });

// 刷新
document.getElementById('btnRefresh').addEventListener('click', refreshAll);

// 报错分类搜索
document.getElementById('errorGroupSearch').addEventListener('input', (e) => {
  errorGroupSearch = e.target.value;
  renderErrorGroups();
});

// 报错分类排序
document.querySelectorAll('#errorGroupsTable thead .sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (errorGroupSort.key === key) {
      errorGroupSort.dir = errorGroupSort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      errorGroupSort = { key, dir: 'desc' };
    }
    document.querySelectorAll('#errorGroupsTable thead .sortable').forEach(t => {
      t.classList.remove('asc', 'desc');
    });
    th.classList.add(errorGroupSort.dir);
    renderErrorGroups();
  });
});

// 白名单添加
document.getElementById('btnAddWhitelist').addEventListener('click', async () => {
  const tokenId = parseInt(document.getElementById('wlTokenId').value);
  if (!tokenId) return alert('请输入 Token ID');
  await api('/api/whitelist', 'POST', {
    token_id: tokenId,
    token_name: document.getElementById('wlTokenName').value,
    note: document.getElementById('wlNote').value,
  });
  document.getElementById('wlTokenId').value = '';
  document.getElementById('wlTokenName').value = '';
  document.getElementById('wlNote').value = '';
  loadDashboard();
});

// 设置面板
function loadSettingsUI() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  const check = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
  set('cfgPollInterval', Math.round((config.pollInterval || 300000) / 1000));
  set('cfgDailyLimit', config.dailyLimit || 2000);
  set('cfgNotifyEmail', config.notifyEmail || '');
  set('cfgTimezone', config.timezone || 'Asia/Shanghai');
  check('cfgNotifyScript', config.notifyScript !== false);
  check('cfgAlertDailyLimit', config.alertDailyLimit);
  check('cfgAlertUsageAnomaly', config.alertUsageAnomaly);
  check('cfgAlertIpUsers', config.alertIpUsers);
  check('cfgAlertSubscription', config.alertSubscription);
  set('cfgScriptClaudeAlertCalls', config.scriptClaudeAlertCalls ?? 1500);
  set('cfgScriptGptAlertCalls', config.scriptGptAlertCalls ?? 800);
  set('cfgDisablePolicy', config.disablePolicy || 'notify_only');
  check('cfgDisableOnScript', config.disableOnScript);
  check('cfgRuleEnabled', config.ruleEnabled !== false);
  set('cfgSurgeWindowMin', config.surgeWindowMin ?? 5);
  set('cfgAlertCooldownMin', config.alertCooldownMin ?? 30);
  set('cfgSurgeCalls', config.surgeCalls ?? 300);
  set('cfgSurgeRatio', config.surgeRatio ?? 5);
  set('cfgSurgeMinCalls', config.surgeMinCalls ?? 30);
  set('cfgSurgeCostUsd', config.surgeCostUsd ?? 5);
  set('cfgShareIpPerToken', config.shareIpPerToken ?? 2);
  set('cfgShareUsersPerIp', config.shareUsersPerIp ?? 2);
  set('cfgSubscriptionAlertPct', config.subscriptionAlertPct ?? 20);
  set('cfgSmtpHost', config.smtpHost || '');
  set('cfgSmtpPort', config.smtpPort || 587);
  check('cfgSmtpSecure', config.smtpSecure);
  set('cfgSmtpUser', config.smtpUser || '');
  set('cfgSmtpFrom', config.smtpFrom || '');
  set('cfgSmtpPass', '');
  set('cfgFeishuWebhook', config.feishuWebhookMasked || '');
  set('cfgFeishuSecret', '');
  const passHint = document.getElementById('smtpPassHint');
  if (passHint) passHint.textContent = config.smtpPassSet ? '已设置，留空表示不修改' : '未设置';
  const secretHint = document.getElementById('feishuSecretHint');
  if (secretHint) secretHint.textContent = config.feishuSecretSet
    ? '已设置，留空表示不修改'
    : '机器人安全设置勾选「签名校验」时才需要填写';
}

// 通知渠道测试
async function testChannel(channel, btnId, statusId) {
  const btn = document.getElementById(btnId);
  const status = document.getElementById(statusId);
  btn.disabled = true;
  status.textContent = '发送中...';
  status.className = 'save-status';
  // 测的是表单里的当前值（未保存也能测），dirty 时提醒用户别忘了保存
  const val = id => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
  const checked = id => Boolean(document.getElementById(id) && document.getElementById(id).checked);
  const body = { channel };
  let dirty = false;
  if (channel === 'email' || channel === 'all') {
    Object.assign(body, {
      smtpHost: val('cfgSmtpHost'),
      smtpPort: parseInt(val('cfgSmtpPort')) || 587,
      smtpSecure: checked('cfgSmtpSecure'),
      smtpUser: val('cfgSmtpUser'),
      smtpPass: val('cfgSmtpPass'),
      smtpFrom: val('cfgSmtpFrom'),
      notifyEmail: val('cfgNotifyEmail'),
    });
    dirty = dirty || Boolean(body.smtpPass)
      || body.smtpHost !== (config.smtpHost || '') || body.smtpPort !== (config.smtpPort || 587)
      || body.smtpSecure !== Boolean(config.smtpSecure) || body.smtpUser !== (config.smtpUser || '')
      || body.smtpFrom !== (config.smtpFrom || '') || body.notifyEmail !== (config.notifyEmail || '');
  }
  if (channel === 'feishu' || channel === 'all') {
    body.feishuWebhook = val('cfgFeishuWebhook');
    body.feishuSecret = val('cfgFeishuSecret');
    dirty = dirty || Boolean(body.feishuSecret)
      || Boolean(body.feishuWebhook && !body.feishuWebhook.startsWith('******'));
  }
  try {
    const res = await api('/api/notify/test', 'POST', body);
    const item = (res.data || []).find(r => r.channel === channel) || {};
    if (item.ok) {
      status.textContent = dirty ? '✅ 已发送，别忘了点「保存设置」' : '✅ 已发送，请查收';
      status.className = 'save-status success';
    } else {
      status.textContent = '❌ ' + (item.message || res.message || '发送失败');
      status.className = 'save-status error';
    }
  } catch (e) {
    status.textContent = '❌ ' + e.message;
    status.className = 'save-status error';
  }
  btn.disabled = false;
  setTimeout(() => { status.textContent = ''; status.className = 'save-status'; }, 8000);
}
document.getElementById('btnTestEmail').addEventListener('click', () => testChannel('email', 'btnTestEmail', 'testEmailStatus'));
document.getElementById('btnTestFeishu').addEventListener('click', () => testChannel('feishu', 'btnTestFeishu', 'testFeishuStatus'));

document.getElementById('btnSaveConfig').addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveConfig');
  const status = document.getElementById('cfgSaveStatus');
  btn.disabled = true;
  const val = id => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
  const body = {
    pollInterval: parseInt(document.getElementById('cfgPollInterval').value) * 1000,
    dailyLimit: parseInt(document.getElementById('cfgDailyLimit').value),
    notifyEmail: val('cfgNotifyEmail'),
    timezone: val('cfgTimezone'),
    notifyScript: document.getElementById('cfgNotifyScript').checked,
    alertDailyLimit: document.getElementById('cfgAlertDailyLimit').checked,
    alertUsageAnomaly: document.getElementById('cfgAlertUsageAnomaly').checked,
    alertIpUsers: document.getElementById('cfgAlertIpUsers').checked,
    alertSubscription: document.getElementById('cfgAlertSubscription').checked,
    scriptClaudeAlertCalls: parseInt(val('cfgScriptClaudeAlertCalls')) || 1500,
    scriptGptAlertCalls: parseInt(val('cfgScriptGptAlertCalls')) || 800,
    disablePolicy: document.getElementById('cfgDisablePolicy').value,
    disableOnScript: document.getElementById('cfgDisableOnScript').checked,
    smtpHost: val('cfgSmtpHost'),
    smtpPort: parseInt(val('cfgSmtpPort')) || 587,
    smtpSecure: document.getElementById('cfgSmtpSecure').checked,
    smtpUser: val('cfgSmtpUser'),
    smtpFrom: val('cfgSmtpFrom'),
    ruleEnabled: document.getElementById('cfgRuleEnabled').checked,
    surgeWindowMin: parseInt(val('cfgSurgeWindowMin')) || 5,
    alertCooldownMin: parseInt(val('cfgAlertCooldownMin')) || 30,
    surgeCalls: parseInt(val('cfgSurgeCalls')) || 300,
    surgeRatio: parseFloat(val('cfgSurgeRatio')) || 5,
    surgeMinCalls: parseInt(val('cfgSurgeMinCalls')) || 30,
    surgeCostUsd: parseFloat(val('cfgSurgeCostUsd')) || 0,
    shareIpPerToken: parseInt(val('cfgShareIpPerToken')) || 2,
    shareUsersPerIp: parseInt(val('cfgShareUsersPerIp')) || 2,
    subscriptionAlertPct: parseFloat(val('cfgSubscriptionAlertPct')) || 0,
  };
  // 密钥类字段：留空 = 不修改，填了才提交
  if (val('cfgSmtpPass')) body.smtpPass = val('cfgSmtpPass');
  if (val('cfgFeishuSecret')) body.feishuSecret = val('cfgFeishuSecret');
  const webhook = val('cfgFeishuWebhook');
  if (webhook && !webhook.startsWith('******')) body.feishuWebhook = webhook;
  if (!webhook && config.feishuWebhookSet) body.feishuWebhook = null; // 清空需显式置 null
  try {
    const res = await api('/api/config', 'PUT', body);
    if (res.success) {
      config = { ...config, ...res.data };
      loadSettingsUI();
      await Promise.all([loadStats(), loadTrend()]);
      if (document.getElementById('panel-logs').classList.contains('active')) loadLogs(1);
      status.innerHTML = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 已保存';
      status.className = 'save-status success';
    } else {
      status.innerHTML = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> 保存失败';
      status.className = 'save-status error';
    }
  } catch(e) {
    status.innerHTML = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> ' + e.message;
    status.className = 'save-status error';
  }
  btn.disabled = false;
  setTimeout(() => { status.textContent = ''; }, 3000);
});

// ==================== 用户分析 Modal ====================
const analysisModal = document.getElementById('analysisModal');
document.getElementById('btnCloseModal').addEventListener('click', () => analysisModal.classList.remove('active'));
analysisModal.addEventListener('click', e => { if (e.target === analysisModal) analysisModal.classList.remove('active'); });

let analysisCharts = [];
function destroyAnalysisCharts() { analysisCharts.forEach(c => c.destroy()); analysisCharts = []; }
let analysisRequestQuery = '';
let analysisRequestTotal = 0;

function renderAnalysisRequests(items, page, pageSize, total) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requests = (items || []).map((req, index) => {
    const body = req.request_body == null ? '该历史请求未记录请求体' : typeof req.request_body === 'string' ? req.request_body : JSON.stringify(req.request_body, null, 2);
    return `<details class="request-item" ${index === 0 ? 'open' : ''}>
      <summary><strong>${formatTime(req.created_at)}</strong><span class="request-ip">${escapeHtml(req.ip || 'IP 未记录')}</span><span>${escapeHtml(req.client || '客户端未知')}</span><span>${escapeHtml(req.model_name || '-')}</span></summary>
      <div class="request-meta">请求 ID：${escapeHtml(req.request_id || '-')} · 日志 ID：${escapeHtml(req.id || '-')}<br>User-Agent：${escapeHtml(req.user_agent || '-')}</div>
      <pre class="request-body">${escapeHtml(body)}</pre>
    </details>`;
  }).join('') || '<div class="dim">暂无请求</div>';
  return `<div class="request-list">${requests}</div>
    <div class="pagination">
      <button class="page-btn" onclick="loadAnalysisRequests(${page - 1})" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="page-info">第 ${total ? page : 0} / ${totalPages} 页 · 共 ${total} 条</span>
      <button class="page-btn" onclick="loadAnalysisRequests(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    </div>`;
}

async function loadAnalysisRequests(page) {
  const el = document.querySelector('#analysisRequests');
  if (!el || !analysisRequestQuery) return;
  el.innerHTML = '<div class="loading">正在加载请求明细...</div>';
  try {
    const res = await api(`/api/user-analysis/requests?${analysisRequestQuery}&page=${page}`);
    if (!res.success || !res.data) throw new Error(res.message || '未知错误');
    el.innerHTML = renderAnalysisRequests(res.data.items, res.data.page, res.data.pageSize, analysisRequestTotal);
  } catch (err) {
    el.innerHTML = `<div class="loading">请求明细加载失败：${escapeHtml(err.message)}</div>`;
  }
}

async function analyzeItem(type, value, displayName) {
  document.getElementById('modalTitle').textContent = `${type === 'user' ? '用户' : 'Token'}分析：${displayName}`;
  document.getElementById('modalBody').innerHTML = '<div class="loading">正在分析...</div>';
  analysisModal.classList.add('active');
  destroyAnalysisCharts();

  const query = type === 'user' ? `username=${encodeURIComponent(value)}` : `token_id=${value}&token_name=${encodeURIComponent(displayName)}`;
  const res = await api(`/api/user-analysis?${query}&range=${currentRange}`);
  if (!res.success || !res.data) {
    document.getElementById('modalBody').innerHTML = '<div class="loading">该时间段无该用户数据</div>';
    return;
  }
  const d = res.data;
  analysisRequestQuery = `${query}&range=${encodeURIComponent(currentRange)}`;
  analysisRequestTotal = d.recentRequestsPage?.total || 0;
  const b = d.basic;
  const totalInput = (b.total_fresh_input || 0) + (b.total_cache || 0);
  const cacheHitPct = totalInput > 0 ? b.total_cache / totalInput * 100 : 0;
  const sc = d.score;
  const level = sc.value >= 14 ? 'high' : sc.value >= 8 ? 'mid' : 'low';
  const verdict = sc.value >= 14 ? '⛔ 极大概率是脚本' : sc.value >= 8 ? '⚠️ 较大可能是脚本' : sc.value >= 4 ? '🟡 有部分脚本特征' : '✅ 看起来像正常用户';

  let html = '';

  // 评分区
  html += `<div class="score-section">
    <div class="score-bar-wrap">
      <div class="score-bar"><div class="score-bar-fill ${level}" style="width:${sc.value/sc.max*100}%"></div></div>
      <div class="score-label ${level}">${sc.value}/${sc.max}</div>
    </div>
    <div class="score-verdict">${verdict}</div>
    <div class="score-reasons">${sc.reasons.map(r => {
      const isGood = r.includes('人类') || r.includes('正常') || r.includes('休息') || r.includes('集中');
      return isGood ? `<span class="reason-good">${r}</span>` : `<span>${r}</span>`;
    }).join('')}</div>
  </div>`;

  if (d.scriptTraceStats && d.scriptTraceStats.flagged_calls > 0) {
    const st = d.scriptTraceStats;
    html += `<div class="analysis-card full">
      <h4>🧪 强规则脚本证据</h4>
      <div style="font-size:13px;line-height:1.9;color:var(--text)">
        <div>Trace 占比: <strong>${(st.ratio_pct || 0).toFixed ? st.ratio_pct.toFixed(1) : st.ratio_pct}%</strong>（${st.flagged_calls} / ${st.total_calls}）</div>
        <div>Trace 类型: <strong>${(st.trace_types || []).join('、') || '未知'}</strong></div>
        <div>脚本检测已关闭，仅作提醒</div>
      </div>
      <div class="score-reasons">${(d.scriptSignals || []).map(s => `<span>${s}</span>`).join('')}</div>
    </div>`;
  }

  html += `<div class="analysis-ip-panel">
    <strong>来源 IP · ${b.ip_count || 0} 个</strong>
    <div class="analysis-ip-list">${(d.ips || []).map(ip => `<span>${escapeHtml(ip)}</span>`).join('') || '<span>未记录</span>'}</div>
  </div>`;

  html += `<div class="analysis-card full ua-summary-card">
    <h4>🌐 完整 User-Agent 请求头</h4>
    <div class="model-tags">${userAgentTags(d.userAgents)}</div>
  </div>`;

  html += '<div class="analysis-grid">';

  // 基本信息
  html += `<div class="analysis-card">
    <h4>📊 调用统计</h4>
    <div class="big-num">${b.total_calls.toLocaleString()}</div>
    <div class="sub-num">总调用次数</div>
    <div style="margin-top:10px;font-size:13px;color:var(--text-dim);line-height:1.8">
      Token数: ${b.token_count} · 模型数: ${b.model_count}<br>
      活跃: ${d.activeHours || '-'}h（夜${d.nightActiveHours || 0}+日${d.dayActiveHours || 0}） · 密度: ${d.density || '-'}次/h<br>
      Token 用量: <strong>${(b.total_tokens || 0).toLocaleString()}</strong>（入 ${formatTokens(b.total_prompt)} / 出 ${formatTokens(b.total_completion)}）<br>
      ${b.total_cache ? `其中缓存读取: ${formatTokens(b.total_cache)}（缓存命中率 ${cacheHitPct.toFixed(1)}%）<br>` : ''}
      费用: ${formatUSD(b.total_quota)}
    </div>
  </div>`;

  // 会话分析
  if (d.sessions) {
    const ss = d.sessions;
    const fmtDur = s => s >= 3600 ? (s/3600).toFixed(1)+'h' : s >= 60 ? Math.round(s/60)+'m' : s+'s';
    html += `<div class="analysis-card">
      <h4>🧩 会话分析</h4>
      <div class="interval-stats">
        <div class="interval-stat"><div class="val">${ss.count}</div><div class="lbl">会话数</div></div>
        <div class="interval-stat"><div class="val">${fmtDur(ss.avgDuration)}</div><div class="lbl">平均时长</div></div>
        <div class="interval-stat"><div class="val">${ss.avgCalls}</div><div class="lbl">均次数</div></div>
        <div class="interval-stat"><div class="val">${fmtDur(ss.maxDuration)}</div><div class="lbl">最长会话</div></div>
      </div>
      <div style="font-size:12px;color:var(--text-dim);line-height:1.6">
        ${ss.count <= 2 && b.total_calls > 100 ? '⚠️ 会话极少，几乎无休息间隔' : ss.count >= 10 ? '✅ 有明显的工作-休息周期' : '会话模式正常'}
      </div>
    </div>`;
  }

  // 间隔核心指标
  if (d.intervals) {
    const iv = d.intervals;
    html += `<div class="analysis-card">
      <h4>⏱️ 间隔分析</h4>
      <div class="interval-stats">
        <div class="interval-stat"><div class="val">${iv.median}s</div><div class="lbl">中位数</div></div>
        <div class="interval-stat"><div class="val">${iv.avg}s</div><div class="lbl">平均</div></div>
        <div class="interval-stat"><div class="val">${iv.p5}s</div><div class="lbl">P5</div></div>
        <div class="interval-stat"><div class="val">${iv.p95}s</div><div class="lbl">P95</div></div>
      </div>
      <div style="font-size:12px;color:var(--text-dim);line-height:1.8">
        ≤1s: ${iv.sub1}(${(iv.sub1/iv.count*100).toFixed(1)}%)
        · ≤3s: ${iv.sub3}(${(iv.sub3/iv.count*100).toFixed(1)}%)<br>
        ≤5s: ${iv.sub5}(${(iv.sub5/iv.count*100).toFixed(1)}%)
        · ≤10s: ${iv.sub10}(${(iv.sub10/iv.count*100).toFixed(1)}%)
      </div>
    </div>`;
  }

  // 并发 & 快速调用
  html += `<div class="analysis-card">
    <h4>🔥 异常行为</h4>
    <div style="font-size:13px;line-height:2;color:var(--text)">
      <div>并发请求: <strong>${d.concurrentPoints}</strong> 个时间点</div>
      <div>连续快速调用: <strong>${d.streaks.length}</strong> 段${d.streaks.length > 0 ? ' (最长 ' + Math.max(...d.streaks) + ' 次)' : ''}</div>
      <div>深夜(0-6点): <strong>${d.nightCalls}</strong> 次 (${d.nightPct}%)</div>
    </div>
  </div>`;

  html += `<div class="analysis-card full">
    <h4>🧾 最近请求明细</h4>
    <div id="analysisRequests">${renderAnalysisRequests(d.recentRequests, d.recentRequestsPage?.page || 1, d.recentRequestsPage?.pageSize || 3, analysisRequestTotal)}</div>
  </div>`;

  // === Chart.js 图表区 ===
  // 每小时分布 (Chart.js bar)
  if (d.hourly.length > 0) {
    html += `<div class="analysis-card full">
      <h4>🕐 每小时分布</h4>
      <div class="analysis-chart-wrap"><canvas id="chartHourly"></canvas></div>
    </div>`;
  }

  // 调用节奏散点图
  if (d.intervalTimeline && d.intervalTimeline.length > 0) {
    html += `<div class="analysis-card full">
      <h4>💫 调用节奏（时间 vs 间隔）</h4>
      <div class="analysis-chart-wrap"><canvas id="chartRhythm"></canvas></div>
    </div>`;
  }

  // 间隔分布 (Chart.js bar)
  if (d.intervals) {
    html += `<div class="analysis-card full">
      <h4>📊 间隔分布</h4>
      <div class="analysis-chart-wrap"><canvas id="chartIntervals"></canvas></div>
    </div>`;
  }

  // 星期分布
  if (d.weekday) {
    html += `<div class="analysis-card">
      <h4>📅 星期分布</h4>
      <div class="analysis-chart-wrap"><canvas id="chartWeekday"></canvas></div>
    </div>`;
  }

  // 模型分布 (Chart.js doughnut)
  if (d.models.length > 0) {
    html += `<div class="analysis-card">
      <h4>🤖 模型分布</h4>
      <div class="analysis-chart-wrap"><canvas id="chartModels"></canvas></div>
    </div>`;
  }

  html += '</div>'; // close analysis-grid
  document.getElementById('modalBody').innerHTML = html;

  // === 渲染 Chart.js 图表 ===
  const chartColors = ['#4a9eff','#ff6b6b','#feca57','#48dbfb','#ff9ff3','#54a0ff','#5f27cd','#01a3a4','#f368e0','#ff9f43'];
  const chartScale = { x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } } };

  function safeChart(id, fn) { try { const el = document.getElementById(id); if (el) analysisCharts.push(fn(el.getContext('2d'))); } catch(e) { console.warn('Chart error:', id, e); } }

  // 每小时分布
  if (d.hourly.length > 0) {
    safeChart('chartHourly', ctx => new Chart(ctx, {
      type: 'bar',
      data: { labels: Array.from({length:24}, (_,i) => String(i).padStart(2,'0')+':00'), datasets: [{
        label: '调用次数',
        data: (() => { const m = {}; d.hourly.forEach(h => m[h.hour] = h.count); return Array.from({length:24}, (_,i) => m[i] || 0); })(),
        backgroundColor: Array.from({length:24}, (_,h) => (h >= 0 && h <= 6) ? 'rgba(255,107,107,0.7)' : 'rgba(74,158,255,0.6)'),
        borderRadius: 3,
      }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { ...chartScale, y: { ...chartScale.y, beginAtZero: true } } },
    }));
  }

  // 调用节奏散点图（使用线性轴，避免 date adapter 依赖）
  if (d.intervalTimeline && d.intervalTimeline.length > 0) {
    const maxGap = 300;
    const tl = d.intervalTimeline;
    const labels = tl.map(p => new Date(p.t * 1000).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:config.timezone || 'Asia/Shanghai'}));
    safeChart('chartRhythm', ctx => new Chart(ctx, {
      type: 'scatter',
      data: { datasets: [{
        label: '调用间隔(s)',
        data: tl.map((p, i) => ({ x: i, y: Math.min(p.gap, maxGap) })),
        pointBackgroundColor: tl.map(p => p.gap <= 3 ? '#ff6b6b' : p.gap <= 10 ? '#feca57' : '#4a9eff'),
        pointRadius: 3, pointHoverRadius: 5,
      }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `间隔: ${ctx.parsed.y}s\n时间: ${labels[ctx.parsed.x] || ''}` } } },
        scales: {
          x: { ticks: { color: '#888', maxTicksLimit: 8, callback: (v) => labels[v] || '' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#888', callback: v => v >= maxGap ? '≥5m' : v + 's' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true, suggestedMax: maxGap },
        },
      },
    }));
  }

  // 间隔分布
  if (d.intervals) {
    const labels = ['0-1s','1-2s','2-3s','3-5s','5-10s','10-30s','30-60s','1-5m','5-10m','10-60m','>1h'];
    const barColors = ['#e74c3c','#e74c3c','#f39c12','#f39c12','#f1c40f','#2ecc71','#27ae60','#4a9eff','#4a9eff','#4a9eff','#4a9eff'];
    safeChart('chartIntervals', ctx => new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: '次数', data: d.intervals.hist, backgroundColor: barColors.map(c => c + 'cc'), borderRadius: 3 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { ...chartScale, y: { ...chartScale.y, beginAtZero: true } } },
    }));
  }

  // 星期分布
  if (d.weekday) {
    const dayLabels = ['周日','周一','周二','周三','周四','周五','周六'];
    const weekendColors = d.weekday.map((_,i) => (i === 0 || i === 6) ? 'rgba(255,107,107,0.7)' : 'rgba(74,158,255,0.6)');
    safeChart('chartWeekday', ctx => new Chart(ctx, {
      type: 'bar',
      data: { labels: dayLabels, datasets: [{ label: '调用次数', data: d.weekday, backgroundColor: weekendColors, borderRadius: 3 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { ...chartScale, y: { ...chartScale.y, beginAtZero: true } } },
    }));
  }

  // 模型分布环形图
  if (d.models.length > 0) {
    safeChart('chartModels', ctx => new Chart(ctx, {
      type: 'doughnut',
      data: { labels: d.models.map(m => m.model_name || '(空)'), datasets: [{ data: d.models.map(m => m.count), backgroundColor: chartColors }] },
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#e0e0e0', font: { size: 11 }, padding: 6, usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: {
        label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString()}次`,
        afterLabel: ctx => { const m = d.models[ctx.dataIndex] || {}; return `Token: ${(m.total_tokens || 0).toLocaleString()}\n费用: ${formatUSD(m.quota)}`; },
      } } } },
    }));
  }
}

// ==================== 实时监控（SSE） ====================
let liveSource = null;
let liveRefreshTimer = null;
let lastLiveRefresh = 0;
const LIVE_MIN_INTERVAL = 3000; // 两次刷新之间的最小间隔，避免高频调用把面板刷爆

function showToast(text, kind = '') {
  let el = document.getElementById('liveToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'liveToast';
    el.className = 'live-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = `live-toast show ${kind}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = `live-toast ${kind}`; }, 4000);
}

// 只刷新当前打开的面板，省掉无谓的查询
async function refreshActivePanel() {
  const active = document.querySelector('.tab-panel.active');
  const id = active ? active.id : 'panel-ranking';
  if (id === 'panel-trend') return loadTrend();
  if (id === 'panel-logs') return loadLogs();
  if (id === 'panel-errors') return loadErrorAnalysis();
  if (id === 'panel-subs') return loadSubscriptions();
  return loadStats();
}

function scheduleLiveRefresh() {
  const wait = Math.max(0, LIVE_MIN_INTERVAL - (Date.now() - lastLiveRefresh));
  if (liveRefreshTimer) return;
  liveRefreshTimer = setTimeout(async () => {
    liveRefreshTimer = null;
    lastLiveRefresh = Date.now();
    try { await refreshActivePanel(); } catch {}
  }, wait);
}

function startLive() {
  if (liveSource) return;
  liveSource = new EventSource('/api/events');
  liveSource.onmessage = ev => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'logs') {
      document.getElementById('updateTime').textContent =
        `实时 · 新增 ${data.added} 条 · ${new Date(data.at).toLocaleTimeString('zh-CN', { hour12: false })}`;
      scheduleLiveRefresh();
    } else if (data.type === 'alert') {
      showToast(`🔔 ${data.title}`, data.level === 'danger' ? 'alert' : '');
    }
  };
  liveSource.onerror = () => { /* EventSource 自带重连，这里只保持状态 */ };
  document.getElementById('btnLive').classList.add('active');
  localStorage.setItem('liveMode', '1');
}

function stopLive() {
  if (liveSource) { liveSource.close(); liveSource = null; }
  if (liveRefreshTimer) { clearTimeout(liveRefreshTimer); liveRefreshTimer = null; }
  document.getElementById('btnLive').classList.remove('active');
  localStorage.setItem('liveMode', '0');
}

document.getElementById('btnLive').addEventListener('click', () => {
  if (liveSource) { stopLive(); showToast('已关闭实时刷新'); }
  else { startLive(); showToast('已开启实时刷新，有新调用会自动更新'); }
});

// ==================== 初始化 ====================
(async () => {
  await loadDashboard();
  loadSettingsUI();
  if (localStorage.getItem('liveMode') === '1') startLive();
})();
