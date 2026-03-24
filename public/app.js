// ==================== 全局状态 ====================
let config = {};
let whitelistIds = new Set();
let currentRange = 'today';
let currentDim = 'token';
let currentSort = { key: 'count', dir: 'desc' };
let currentData = [];
let currentPage = 1;
const pageSize = 20;
let tokenStatuses = {};

// ==================== API 调用 ====================
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

// ==================== 工具函数 ====================
function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}
function formatQuota(q) {
  if (!q) return '0';
  if (q >= 1e8) return (q / 1e8).toFixed(2) + ' 亿';
  if (q >= 1e4) return (q / 1e4).toFixed(1) + ' 万';
  return q.toLocaleString();
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
    { key: 'username', label: '用户', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'quota', label: '额度消耗', sortable: true },
    { key: 'models', label: '模型分布', sortable: false },
    { key: 'action', label: '操作', sortable: false },
  ],
  user: [
    { key: '#', label: '#' },
    { key: 'username', label: '用户', sortable: true },
    { key: 'token_count', label: 'Token数', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'quota', label: '额度消耗', sortable: true },
    { key: 'action', label: '操作', sortable: false },
  ],
  model: [
    { key: '#', label: '#' },
    { key: 'model_name', label: '模型', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'quota', label: '额度消耗', sortable: true },
  ],
  group: [
    { key: '#', label: '#' },
    { key: 'grp', label: '分组', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'quota', label: '额度消耗', sortable: true },
  ],
  channel: [
    { key: '#', label: '#' },
    { key: 'channel_name', label: '渠道', sortable: true },
    { key: 'count', label: '调用次数', sortable: true },
    { key: 'quota', label: '额度消耗', sortable: true },
  ],
};

// ==================== 渲染逻辑 ====================
function renderStats(data) {
  if (!data) return;
  document.getElementById('statTotalLogs').textContent = formatNumber(data.totalLogs || data.total);
  document.getElementById('statRpm').textContent = data.stat ? data.stat.rpm : '-';
  document.getElementById('statTpm').textContent = data.stat ? formatNumber(data.stat.tpm) : '-';
  document.getElementById('statTokens').textContent = data.tokens ? data.tokens.length : (data.rows ? data.rows.length : '-');
  const overLimit = data.tokens ? data.tokens.filter(t => t.count > config.dailyLimit).length : 0;
  document.getElementById('statOverLimit').textContent = overLimit;
  document.getElementById('updateTime').textContent =
    '更新于 ' + new Date(data.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
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
      (r.channel_name || '').toLowerCase().includes(filter)
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
  return `
    <tr class="${overLimit && !isWl ? 'over-limit' : ''}">
      <td>${i+1}</td>
      <td><strong>${t.token_name || '-'}</strong><br><span class="dim">ID: ${t.token_id}</span></td>
      <td>${t.username}${isWl ? ' <span class="wl-badge"><svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>' : ''}</td>
      <td><div class="count-bar"><span>${t.count}</span><div class="count-bar-bg"><div class="count-bar-fill ${overLimit?'danger':''}" style="width:${pct}%"></div></div></div></td>
      <td>${formatQuota(t.quota)}</td>
      <td><div class="model-tags">${models}</div></td>
      <td>
        <button class="btn-analyze" onclick="analyzeItem('token', ${t.token_id}, '${(t.token_name || t.token_id).toString().replace(/'/g, "\\'")}')">分析</button>
      </td>
    </tr>`;
}
function renderUserRow(r, i) {
  return `<tr><td>${i+1}</td><td><strong>${r.username || '-'}</strong></td><td>${r.token_count || '-'}</td><td>${r.count}</td><td>${formatQuota(r.quota)}</td><td><button class="btn-analyze" onclick="analyzeItem('user', '${r.username}', '${r.username}')">分析</button></td></tr>`;
}
function renderModelRow(r, i) {
  return `<tr><td>${i+1}</td><td><span class="model-tag">${r.model_name || '-'}</span></td><td>${r.count}</td><td>${formatQuota(r.quota)}</td></tr>`;
}
function renderGroupRow(r, i) {
  return `<tr><td>${i+1}</td><td>${r.grp || '-'}</td><td>${r.count}</td><td>${formatQuota(r.quota)}</td></tr>`;
}
function renderChannelRow(r, i) {
  return `<tr><td>${i+1}</td><td>${r.channel_name || r.channel || '-'}</td><td>${r.count}</td><td>${formatQuota(r.quota)}</td></tr>`;
}

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
        a.action === 'manual_disable' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> 手动禁用' :
        a.action === 'manual_enable' ? '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 手动启用' : a.action
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

function renderTrend(trendData, distData) {
  destroyCharts();
  const labels = trendData.map(d => d.label);

  // 1. 每小时调用量
  charts.push(new Chart(document.getElementById('trendChart').getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{
      label: '调用次数', data: trendData.map(d => d.count),
      backgroundColor: 'rgba(74, 158, 255, 0.6)', borderColor: 'rgba(74, 158, 255, 1)',
      borderWidth: 1, borderRadius: 4,
    }] },
    options: { responsive: true, plugins: { legend: { labels: { color: '#e0e0e0' } } }, scales: darkTheme },
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

  // 5. 用户额度消耗排名 (水平柱状)
  if (distData.users) {
    const u = distData.users;
    charts.push(new Chart(document.getElementById('userQuotaRankChart').getContext('2d'), {
      type: 'bar',
      data: { labels: u.map(x => x.username), datasets: [{
        label: '额度消耗', data: u.map(x => x.quota),
        backgroundColor: COLORS.map(c => c + 'cc'), borderRadius: 4,
      }] },
      options: barOpts('y'),
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

let logsPage = 1;
async function loadLogs(page) {
  if (page !== undefined) logsPage = page;
  const res = await api(`/api/recent-logs?range=${currentRange}&p=${logsPage}`);
  if (!res.success) return;
  const { items, total, pageSize } = res.data;
  const tbody = document.querySelector('#logsTable tbody');
  tbody.innerHTML = items.map(r => {
    const t = new Date(r.created_at * 1000);
    const ts = `${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    const q = r.quota >= 10000 ? (r.quota / 10000).toFixed(1) + '万' : (r.quota || 0);
    return `<tr>
      <td>${ts}</td><td>${r.username}</td><td><span class="dim">#${r.token_id}</span> ${r.token_name || ''}</td>
      <td><span class="model-tag">${r.model_name}</span></td><td>${q}</td>
      <td>${(r.prompt_tokens||0).toLocaleString()}</td><td>${(r.completion_tokens||0).toLocaleString()}</td>
      <td>${r.channel_name || '-'}</td>
    </tr>`;
  }).join('');
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

async function refreshAll() {
  const btn = document.getElementById('btnRefresh');
  const refreshSvg = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.92-5.27l3.08-3.08"/></svg>';
  btn.disabled = true; btn.innerHTML = refreshSvg + ' 加载中...';
  try {
    await api('/api/poll', 'POST');
    await Promise.all([loadStats(), loadTrend(), loadActions()]);
    if (document.getElementById('panel-logs').classList.contains('active')) loadLogs(1);
  } catch (e) { console.error('刷新失败:', e); }
  finally { btn.disabled = false; btn.innerHTML = refreshSvg + ' 刷新'; }
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
  loadWhitelist();
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
    if (tab.dataset.tab === 'logs') loadLogs(1);
    if (tab.dataset.tab === 'actions') loadActions();
  });
});

// 时间范围
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    currentPage = 1;
    loadStats();
    // 如果趋势面板可见就刷新趋势
    if (document.getElementById('panel-trend').classList.contains('active')) loadTrend();
    if (document.getElementById('panel-logs').classList.contains('active')) loadLogs(1);
  });
});

// 维度子 Tab
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDim = tab.dataset.dim;
    currentSort = { key: 'count', dir: 'desc' };
    currentPage = 1;
    loadStats();
  });
});

// 搜索
document.getElementById('searchInput').addEventListener('input', () => { currentPage = 1; renderTableBody(); });

// 刷新
document.getElementById('btnRefresh').addEventListener('click', refreshAll);

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
  loadWhitelist();
});

// 设置面板
function loadSettingsUI() {
  document.getElementById('cfgPollInterval').value = Math.round((config.pollInterval || 300000) / 1000);
  document.getElementById('cfgDailyLimit').value = config.dailyLimit || 2000;
  document.getElementById('cfgNotifyEmail').value = config.notifyEmail || '';
}

document.getElementById('btnSaveConfig').addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveConfig');
  const status = document.getElementById('cfgSaveStatus');
  btn.disabled = true;
  const body = {
    pollInterval: parseInt(document.getElementById('cfgPollInterval').value) * 1000,
    dailyLimit: parseInt(document.getElementById('cfgDailyLimit').value),
    notifyEmail: document.getElementById('cfgNotifyEmail').value.trim(),
  };
  try {
    const res = await api('/api/config', 'PUT', body);
    if (res.success) {
      config = { ...config, ...res.data };
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
  const b = d.basic;
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

  html += '<div class="analysis-grid">';

  // 基本信息
  html += `<div class="analysis-card">
    <h4>📊 调用统计</h4>
    <div class="big-num">${b.total_calls.toLocaleString()}</div>
    <div class="sub-num">总调用次数</div>
    <div style="margin-top:10px;font-size:13px;color:var(--text-dim);line-height:1.8">
      Token数: ${b.token_count} · 模型数: ${b.model_count}<br>
      活跃: ${d.activeHours || '-'}h（夜${d.nightActiveHours || 0}+日${d.dayActiveHours || 0}） · 密度: ${d.density || '-'}次/h<br>
      额度: ${formatQuota(b.total_quota)}<br>
      Prompt: ${formatNumber(b.total_prompt)} · Completion: ${formatNumber(b.total_completion)}
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
    const labels = tl.map(p => new Date(p.t * 1000).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}));
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
      options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#e0e0e0', font: { size: 11 }, padding: 6, usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString()}次` } } } },
    }));
  }
}

// ==================== 初始化 ====================
(async () => {
  await loadConfig();
  loadSettingsUI();
  await loadWhitelist();
  await loadStats();
  await loadActions();
})();
