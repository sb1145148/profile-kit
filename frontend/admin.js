/* ============================================================
 *  管理后台前端逻辑
 *  文件：frontend/admin.js
 *
 *  功能：
 *    - 密码登录（HMAC 签名令牌，存 sessionStorage，2 小时过期）
 *    - 概览统计、访问量趋势图（纯 SVG，无第三方图表库）
 *    - 站点设置：留言审核开关、新留言通知（企业微信/钉钉/Server酱/通用 JSON）
 *    - 留言管理：分页、状态筛选、审核通过与撤销、回复、删除
 *
 *  安全说明：
 *    - 登录拿到的是签名令牌而不是密码；所有写操作都带 Authorization 头
 *    - 令牌过期或被拒（401）时自动退回登录界面
 * ============================================================ */

const CFG_API_BASE = 'https://api.example.com';
const API_BASE = (() => {
  // 测试服务器（tests/profile-server.mjs）会注入这个全局，
  // 让它能跑在任意端口。生产环境没有它，走下面的正常逻辑。
  if (typeof window !== 'undefined' && window.__API_BASE__) return window.__API_BASE__;

  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' || location.protocol === 'file:';
  return isLocal ? 'http://127.0.0.1:8787' : CFG_API_BASE;
})();

const TOKEN_KEY = 'profile-admin:token';
const EXPIRE_KEY = 'profile-admin:expire';
const PAGE_SIZE = 20;

const $ = (s) => document.querySelector(s);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let currentPage = 1;
let totalPages = 1;
let currentFilter = 'all';
let currentDays = 30;
let currentQuery = '';

/* ---------------- 令牌读写 ---------------- */
const getToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
function setToken(token, ttlMs) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(EXPIRE_KEY, String(Date.now() + ttlMs));
}
function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRE_KEY);
}

/* ---------------- 主题（和主页共用同一个选择） ---------------- */
const THEME_KEY = 'your-site:theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  const icon = document.querySelector('#theme-icon');
  if (icon) icon.textContent = mode === 'dark' ? '☀️' : '🌙';
}
function initTheme() {
  applyTheme(currentTheme());
  const btn = document.querySelector('#theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });
}

/* ---------------- 图片压缩 ----------------
   相册和留言配图用同一套规则：压到最长边 1400px 的 JPEG，
   因为图片要以 base64 存进 D1，不压的话单行 2MB 限制根本塞不下。 */
async function compressImage(file, maxBytes = 1024 * 1024) {
  if (file.size <= 400 * 1024) return file;
  if (file.type === 'image/gif') return file;   // 动图压了只剩一帧
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1400;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
  } catch (e) {
    return file;
  }
}

/** 带文件的提交：不能手动设 Content-Type，浏览器要自己加 boundary */
async function apiUpload(path, formData) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + getToken() },
      body: formData,
    });
  } catch (e) {
    throw new Error('网络请求失败，请检查网络');
  }
  const payload = await res.json().catch(() => null);
  if (res.status === 401) {
    clearToken();
    showLogin('登录已过期，请重新登录');
    throw new Error('登录已过期');
  }
  if (!res.ok || !payload || payload.ok === false) {
    throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data;
}

/* ---------------- 请求封装 ---------------- */
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  const init = { method };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (auth) headers.Authorization = 'Bearer ' + getToken();
  init.headers = headers;

  let res;
  try {
    res = await fetch(API_BASE + path, init);
  } catch (e) {
    throw new Error('网络请求失败，请检查网络');
  }

  const payload = await res.json().catch(() => null);

  if (res.status === 401) {
    clearToken();
    showLogin('登录已过期，请重新登录');
    throw new Error((payload && payload.error) || '登录已过期');
  }
  if (!res.ok || !payload || payload.ok === false) {
    throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data;
}

/* ---------------- 界面切换 ---------------- */
function showLogin(message) {
  $('#login-view').hidden = false;
  $('#admin-view').hidden = true;
  $('#logout-btn').hidden = true;
  if (message) setLoginStatus(message, 'error');
}

function showAdmin() {
  $('#login-view').hidden = true;
  $('#admin-view').hidden = false;
  $('#logout-btn').hidden = false;
  const exp = Number(sessionStorage.getItem(EXPIRE_KEY) || 0);
  $('#stat-expire').textContent = exp
    ? '有效期至 ' + new Date(exp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
}

function setLoginStatus(t, type) { setText('#login-status', t, type); }
function setStatus(t, type) { setText('#admin-status', t, type); }

function setText(sel, text, type) {
  const el = $(sel);
  el.textContent = text || '';
  const base = sel === '#login-status' ? 'mt-3 min-h-5 text-sm' : 'mt-4 min-h-5 text-sm';
  el.className = base + ' ' + (type === 'error' ? 'text-red-500' : type === 'ok' ? 'text-emerald-600' : 'text-slate-500 dark:text-slate-400');
}

/* ============================================================
 * 概览
 * ============================================================ */
async function loadOverview() {
  const d = await api('/api/admin/overview');

  $('#stat-messages').textContent = d.messages;
  $('#stat-replied').textContent = d.replied ? `已回复 ${d.replied} 条` : '还没有回复';

  const pending = (d.pending || 0) + (d.postsPending || 0) + (d.friendsPending || 0);
  $('#stat-pending').textContent = pending;
  $('#stat-pending').className = 'mt-1 font-mono text-3xl font-bold tabular-nums ' +
    (pending > 0 ? 'text-amber-500' : '');
  $('#stat-pending-detail').textContent =
    `留言 ${d.pending || 0} · 说说 ${d.postsPending || 0} · 友链 ${d.friendsPending || 0}`;

  $('#stat-content').textContent = (d.articles || 0) + (d.posts || 0);
  $('#stat-content-detail').textContent =
    `文章 ${d.articles || 0} 篇（草稿 ${d.articlesDraft || 0}）· 说说 ${d.posts || 0} 条`;
  $('#stat-images-size').textContent = d.imageBytes
    ? `配图 ${d.images} 张 · ${(d.imageBytes / 1024 / 1024).toFixed(2)} MB / 500 MB`
    : `配图 ${d.images || 0} 张 · 还没有占用`;

  $('#stat-visits').textContent = Number(d.visits).toLocaleString('en-US');
  const exp = Number(sessionStorage.getItem(EXPIRE_KEY) || 0);
  $('#stat-expire').textContent = exp
    ? '登录有效期至 ' + new Date(exp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
}

/* ============================================================
 * 访问量趋势（纯 SVG 柱状图，不引第三方图表库）
 * ============================================================ */
function renderTrendChart(data) {
  const days = data.days || [];
  const el = $('#trend-chart');

  if (!days.length) {
    el.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">还没有数据</p>';
    return;
  }

  const W = 900, H = 220, PAD_L = 44, PAD_R = 14, PAD_T = 18, PAD_B = 36;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...days.map((d) => d.count));
  const step = plotW / days.length;
  const barW = Math.max(2, Math.min(28, step * 0.68));

  const bars = days.map((d, i) => {
    const h = (d.count / max) * plotH;
    const x = PAD_L + i * step + (step - barW) / 2;
    const y = PAD_T + plotH - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
                  height="${Math.max(0, h).toFixed(1)}" rx="3"
                  fill="currentColor" class="text-blue-500">
              <title>${d.day}：${d.count} 次</title>
            </rect>`;
  }).join('');

  const ticks = [0, Math.round(max / 2), max].map((v) => {
    const y = PAD_T + plotH - (v / max) * plotH;
    return `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}"
                  stroke="currentColor" class="text-slate-200 dark:text-slate-700" stroke-width="1"/>
            <text x="${PAD_L - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end"
                  font-size="11" fill="currentColor" class="text-slate-500 dark:text-slate-400">${v}</text>`;
  }).join('');

  const idxs = [0, Math.floor(days.length / 2), days.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  const xLabels = idxs.map((i) => {
    const x = PAD_L + i * step + step / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 12}" text-anchor="middle"
                  font-size="11" fill="currentColor" class="text-slate-500 dark:text-slate-400">${days[i].day.slice(5)}</text>`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="h-auto w-full" role="img"
         aria-label="最近 ${days.length} 天访问量趋势">
      ${ticks}${bars}${xLabels}
    </svg>`;

  const sum = days.reduce((a, d) => a + d.count, 0);
  const peak = days.reduce((a, d) => (d.count > a.count ? d : a), days[0]);
  $('#trend-note').textContent =
    `最近 ${days.length} 天共 ${sum} 次访问，最高 ${peak.count} 次（${peak.day}）。` +
    (data.firstDay ? ` 数据从 ${data.firstDay} 开始记录。` : '');
}

async function loadTrend(days = currentDays) {
  currentDays = days;
  document.querySelectorAll('.trend-btn').forEach((b) => {
    const on = Number(b.dataset.days) === days;
    b.className = 'trend-btn rounded-lg px-3 py-1 text-xs font-medium transition ' +
      (on ? 'bg-blue-600 text-white border border-blue-600'
          : 'border border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800');
  });
  try {
    renderTrendChart(await api(`/api/admin/visits/trend?days=${days}`));
  } catch (err) {
    $('#trend-chart').innerHTML = `<p class="text-sm text-red-500">${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 站点设置
 * ============================================================ */
const NOTIFY_HINTS = {
  off: '关闭后，有新留言不会通知你（后台仍然能看到）。',
  wecom: '企业微信群 → 群设置 → 群机器人 → 添加 → 复制 Webhook 地址填到这里。',
  dingtalk: '钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址。',
  serverchan: 'Server酱官网 sct.ftqq.com 扫码登录，把 SendKey 拼成 https://sctapi.ftqq.com/<SendKey>.send 填进来。',
  json: '会 POST 一段 JSON（含 event / text / name / content / image_url 等字段），可对接 n8n、Zapier 或自建中转。',
};

async function loadSettings() {
  const d = await api('/api/admin/settings');
  $('#set-approval').checked = !!d.require_approval;
  $('#set-notify-type').value = d.notify_type || 'off';

  const input = $('#set-notify-webhook');
  input.value = '';
  input.placeholder = d.notify_webhook_set
    ? `已设置（${d.notify_webhook_masked}）· 留空则不修改`
    : 'https://...';

  // 关于我 / 垃圾过滤 / GitHub 用户名
  const about = $('#set-about');
  const gh = $('#set-github-user');
  const spam = $('#set-spam');
  if (about) about.value = d.about_md || '';
  const tsEl = $('#set-turnstile');
  if (tsEl) tsEl.value = d.turnstile_site_key || '';

  const nowEl = $('#set-now');
  if (nowEl) nowEl.value = d.now_md || '';
  if (gh) gh.value = d.github_user || '';
  if (spam) spam.checked = d.spam_enabled !== false;

  updateNotifyHint();
}

function updateNotifyHint() {
  $('#notify-hint').textContent = NOTIFY_HINTS[$('#set-notify-type').value] || '';
}

function initSettings() {
  $('#set-notify-type').addEventListener('change', updateNotifyHint);

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#settings-save');
    btn.disabled = true;
    setStatus('保存中…');
    try {
      const body = {
        require_approval: $('#set-approval').checked,
        notify_type: $('#set-notify-type').value,
        about_md: $('#set-about') ? $('#set-about').value : undefined,
        now_md: $('#set-now') ? $('#set-now').value : undefined,
        turnstile_site_key: $('#set-turnstile') ? $('#set-turnstile').value.trim() : undefined,
        github_user: $('#set-github-user') ? $('#set-github-user').value.trim() : undefined,
        spam_enabled: $('#set-spam') ? $('#set-spam').checked : undefined,
      };
      // 留空表示"不修改"，避免把打码后的地址写回去
      const hook = $('#set-notify-webhook').value.trim();
      if (hook) body.notify_webhook = hook;
      // undefined 的字段不要发给后端（后端按"未提供"处理）
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

      await api('/api/admin/settings', { method: 'PUT', body });
      setStatus('设置已保存', 'ok');
      await loadSettings();
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#notify-test').addEventListener('click', async () => {
    setStatus('正在发送测试通知…');
    try {
      const d = await api('/api/admin/notify-test', { method: 'POST' });
      setStatus(d.sent ? '测试通知已发送，去手机上看看' : '没有发送：' + (d.reason || '未配置'),
        d.sent ? 'ok' : 'error');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });
}

/* ============================================================
 * 留言管理
 * ============================================================ */
function renderAdminMessages(items, meta) {
  $('#list-loading').classList.add('hidden');
  const ul = $('#admin-messages');
  $('#list-empty').classList.toggle('hidden', items.length > 0);

  ul.innerHTML = items.map((m) => `
    <li class="rounded-2xl border border-slate-200 bg-white p-4 shadow-md dark:border-slate-800 dark:bg-slate-900"
        data-id="${m.id}">
      <label class="mb-2 flex cursor-pointer items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <input type="checkbox" class="msg-pick h-4 w-4 accent-blue-600" value="${m.id}">
        选中这条
      </label>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex flex-wrap items-baseline gap-3">
            <span class="font-medium">${escapeHtml(m.name)}</span>
            <span class="font-mono text-xs text-slate-500 dark:text-slate-400">#${m.id}</span>
            <time class="font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(m.created_at)}</time>
            ${m.status === 'pending'
              ? '<span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">待审核</span>'
              : '<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">已通过</span>'}
          </div>
          <p class="message-content text-sm leading-relaxed text-slate-600 dark:text-slate-300">${escapeHtml(m.content)}</p>
          ${m.image_url ? `
            <a href="${escapeHtml(m.image_url)}" target="_blank" rel="noopener noreferrer"
               class="mt-2 block w-fit" title="点击查看原图">
              <img src="${escapeHtml(m.image_url)}" alt="配图" loading="lazy"
                   class="max-h-32 w-auto max-w-full rounded-lg border border-slate-200 object-contain dark:border-slate-700">
            </a>` : ''}
          ${m.reply ? `
            <div class="mt-2 rounded-lg border-l-4 border-blue-500 bg-blue-50/70 px-3 py-2 dark:bg-blue-950/40">
              <p class="text-xs font-semibold text-blue-700 dark:text-blue-300">↳ 站长回复</p>
              <p class="message-content text-sm text-slate-700 dark:text-slate-200">${escapeHtml(m.reply)}</p>
            </div>` : ''}
        </div>

        <div class="flex shrink-0 flex-wrap gap-1.5">
          ${m.status === 'pending'
            ? `<button type="button" data-approve="${m.id}" class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700">通过</button>`
            : `<button type="button" data-unapprove="${m.id}" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">撤下</button>`}
          <button type="button" data-reply="${m.id}" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
            ${m.reply ? '改回复' : '回复'}
          </button>
          <button type="button" data-del="${m.id}" class="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">删除</button>
        </div>
      </div>

      <div class="reply-box mt-3 hidden">
        <textarea rows="2" maxlength="300" placeholder="写一句回复，显示在这条留言下方（留空并保存＝删除回复）"
                  class="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-hidden transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-slate-700 dark:bg-slate-950">${escapeHtml(m.reply || '')}</textarea>
        <div class="mt-2 flex gap-2">
          <button type="button" data-save-reply="${m.id}" class="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700">保存回复</button>
          <button type="button" data-cancel-reply="${m.id}" class="rounded-lg border border-slate-300 px-4 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">取消</button>
        </div>
      </div>
    </li>
  `).join('');

  renderAdminPagination(meta);

  // 每次重新渲染都复位批量选择状态
  const all = document.querySelector('#select-all');
  if (all) all.checked = false;
  if (typeof updateBatchBar === 'function') updateBatchBar();
}

function renderAdminPagination(meta) {
  const el = $('#admin-pagination');
  if (!meta || meta.totalPages <= 1) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const { page, totalPages: tp, total } = meta;
  const btn = (label, target, disabled) => `
    <button type="button" data-page="${target}" ${disabled ? 'disabled' : ''}
            class="rounded-xl border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium transition
                   hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40
                   dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">${label}</button>`;
  el.innerHTML = `${btn('← 上一页', page - 1, page <= 1)}
    <span class="px-2 text-sm text-slate-500">第 ${page} / ${tp} 页</span>
    ${btn('下一页 →', page + 1, page >= tp)}
    <span class="ml-1 text-xs text-slate-500 dark:text-slate-400">共 ${total} 条</span>`;
}

async function loadMessages(page = 1) {
  currentPage = page;
  $('#list-loading').classList.remove('hidden');
  try {
    const data = await api(
      `/api/admin/messages?page=${page}&size=${PAGE_SIZE}` +
      `&status=${currentFilter}&q=${encodeURIComponent(currentQuery)}`
    );
    totalPages = data.totalPages;
    renderAdminMessages(data.items || [], data);
  } catch (err) {
    $('#list-loading').classList.add('hidden');
    $('#admin-messages').innerHTML = '';
    $('#list-empty').classList.add('hidden');
    setStatus(err.message, 'error');
  }
}

/** 所有按钮都用事件委托，避免每次重新渲染后重复绑定 */
function initMessageActions() {
  const ul = $('#admin-messages');

  ul.addEventListener('click', async (e) => {
    const t = e.target;

    const approveBtn = t.closest('[data-approve]');
    if (approveBtn) {
      approveBtn.disabled = true;
      try {
        await api(`/api/admin/messages/${approveBtn.dataset.approve}/approve`, { method: 'POST', body: { approve: true } });
        setStatus('已通过审核，现在首页可见了', 'ok');
        await Promise.all([loadMessages(currentPage), loadOverview(), loadTrend()]);
      } catch (err) { setStatus(err.message, 'error'); approveBtn.disabled = false; }
      return;
    }

    const unapproveBtn = t.closest('[data-unapprove]');
    if (unapproveBtn) {
      unapproveBtn.disabled = true;
      try {
        await api(`/api/admin/messages/${unapproveBtn.dataset.unapprove}/approve`, { method: 'POST', body: { approve: false } });
        setStatus('已撤下，首页不再显示', 'ok');
        await Promise.all([loadMessages(currentPage), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); unapproveBtn.disabled = false; }
      return;
    }

    const replyBtn = t.closest('[data-reply]');
    if (replyBtn) {
      const box = replyBtn.closest('li').querySelector('.reply-box');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) box.querySelector('textarea').focus();
      return;
    }

    const cancelBtn = t.closest('[data-cancel-reply]');
    if (cancelBtn) {
      cancelBtn.closest('.reply-box').classList.add('hidden');
      return;
    }

    const saveBtn = t.closest('[data-save-reply]');
    if (saveBtn) {
      const li = saveBtn.closest('li');
      const text = li.querySelector('.reply-box textarea').value.trim();
      saveBtn.disabled = true;
      try {
        await api(`/api/admin/messages/${saveBtn.dataset.saveReply}/reply`, { method: 'POST', body: { reply: text } });
        setStatus(text ? '回复已保存' : '回复已删除', 'ok');
        await Promise.all([loadMessages(currentPage), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); saveBtn.disabled = false; }
      return;
    }

    // 删除（两段式确认，防误触）
    const delBtn = t.closest('[data-del]');
    if (delBtn) {
      if (delBtn.dataset.confirm !== '1') {
        delBtn.dataset.confirm = '1';
        delBtn.textContent = '确认删除？';
        setTimeout(() => {
          if (delBtn.isConnected) { delBtn.dataset.confirm = ''; delBtn.textContent = '删除'; }
        }, 4000);
        return;
      }
      const id = Number(delBtn.dataset.del);
      delBtn.disabled = true;
      delBtn.textContent = '删除中…';
      try {
        await api('/api/admin/messages/' + id, { method: 'DELETE' });
        setStatus(`已删除留言 #${id}（含配图）`, 'ok');
        await Promise.all([loadMessages(currentPage), loadOverview()]);
      } catch (err) {
        setStatus(err.message, 'error');
        delBtn.disabled = false;
        delBtn.dataset.confirm = '';
        delBtn.textContent = '删除';
      }
    }
  });

  $('#admin-pagination').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b || b.disabled) return;
    const target = Number(b.dataset.page);
    if (target >= 1 && target <= totalPages) loadMessages(target);
  });

  document.querySelectorAll('.filter-btn').forEach((b) => {
    b.addEventListener('click', () => {
      currentFilter = b.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach((x) => {
        const on = x.dataset.filter === currentFilter;
        x.className = 'filter-btn rounded-xl px-4 py-1.5 text-sm font-medium transition ' +
          (on ? 'bg-blue-600 text-white border border-blue-600'
              : 'border border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800');
      });
      loadMessages(1);
    });
  });
}

/* ============================================================
 * 工具栏
 * ============================================================ */
async function refreshAll() {
  try {
    const jobs = [loadOverview(), loadMessages(currentPage), loadTrend(), loadGallery()];
    if (typeof loadPostsAdmin === 'function') jobs.push(loadPostsAdmin());
    if (typeof loadArticlesAdmin === 'function') jobs.push(loadArticlesAdmin());
    if (typeof loadFriendsAdmin === 'function') jobs.push(loadFriendsAdmin());
    if (typeof loadRefs === 'function') jobs.push(loadRefs());
    if (typeof loadWords === 'function') jobs.push(loadWords());
    if (typeof loadBackup === 'function') jobs.push(loadBackup());
    if (typeof loadImagesStatus === 'function') jobs.push(loadImagesStatus());
    if (typeof loadChangelogAdmin === 'function') jobs.push(loadChangelogAdmin());
    if (typeof loadSelfCheck === 'function') jobs.push(loadSelfCheck());
    if (typeof loadAudit === 'function') jobs.push(loadAudit(1));
    await Promise.all(jobs);
    setStatus('已刷新 · ' + new Date().toLocaleTimeString('zh-CN'), 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function initToolbar() {
  $('#refresh-btn').addEventListener('click', refreshAll);

  document.querySelectorAll('.trend-btn').forEach((b) => {
    b.addEventListener('click', () => loadTrend(Number(b.dataset.days)));
  });

  // —— 搜索 ——
  const doSearch = () => {
    currentQuery = $('#search-input').value.trim().slice(0, 50);
    loadMessages(1);
    setStatus(currentQuery ? `搜索「${currentQuery}」` : '已清空搜索', 'ok');
  };
  $('#search-btn').addEventListener('click', doSearch);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  $('#search-clear').addEventListener('click', () => {
    $('#search-input').value = '';
    currentQuery = '';
    loadMessages(1);
    setStatus('已清空搜索', 'ok');
  });

  // —— 导出（浏览器直接下载文件）——
  const doExport = async (format) => {
    setStatus(`正在导出 ${format.toUpperCase()}…`);
    try {
      const res = await fetch(`${API_BASE}/api/admin/export?format=${format}`, {
        headers: { Authorization: 'Bearer ' + getToken() },
      });
      if (res.status === 401) { clearToken(); showLogin('登录已过期'); return; }
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `messages-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(`已导出 ${format.toUpperCase()}，检查一下浏览器的下载`, 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  };
  $('#export-json').addEventListener('click', () => doExport('json'));
  $('#export-csv').addEventListener('click', () => doExport('csv'));

  $('#reset-visits-btn').addEventListener('click', async () => {
    if (!confirm('确定把访问量归零吗？此操作不可撤销。')) return;
    try {
      await api('/api/admin/visits/reset', { method: 'POST' });
      setStatus('访问量已归零', 'ok');
      await Promise.all([loadOverview(), loadTrend()]);
    } catch (err) { setStatus(err.message, 'error'); }
  });

  $('#clear-all-btn').addEventListener('click', async () => {
    if (!confirm('确定清空【全部】留言吗？留言里的配图也会一起删除，此操作不可撤销！')) return;
    if (!confirm('再确认一次：所有留言和配图都会永久删除。')) return;
    try {
      const d = await api('/api/admin/messages', { method: 'DELETE' });
      setStatus(`已清空 ${d.deleted} 条留言、${d.imagesDeleted || 0} 张配图`, 'ok');
      await refreshAll();
    } catch (err) { setStatus(err.message, 'error'); }
  });

  $('#logout-btn').addEventListener('click', () => {
    clearToken();
    showLogin();
    setLoginStatus('已退出登录', 'ok');
  });
}

/* ============================================================
 * 作品集相册
 * ============================================================ */
const setGalleryStatus = (t, type) => {
  const el = $('#gallery-status');
  el.textContent = t || '';
  el.className = 'text-sm ' + (type === 'error' ? 'text-red-500' : type === 'ok' ? 'text-emerald-600' : 'text-slate-500 dark:text-slate-400');
};

function renderGalleryAdmin(items) {
  $('#gallery-loading').classList.add('hidden');
  $('#gallery-empty').classList.toggle('hidden', items.length > 0);

  $('#gallery-admin-grid').innerHTML = items.map((g) => `
    <figure class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md dark:border-slate-800 dark:bg-slate-900">
      <img src="${escapeHtml(g.image_url)}" alt="${escapeHtml(g.title || '作品')}" loading="lazy"
           class="aspect-[4/3] w-full object-cover">
      <figcaption class="p-3">
        <p class="truncate text-sm font-medium">${escapeHtml(g.title || '（未命名）')}</p>
        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          权重 ${g.sort} · ${(g.size / 1024).toFixed(0)} KB
        </p>
        ${g.note ? `<p class="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(g.note)}</p>` : ''}
        <button type="button" data-gal-del="${g.id}"
                class="mt-2 w-full rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
          删除
        </button>
      </figcaption>
    </figure>
  `).join('');
}

async function loadGallery() {
  try {
    const d = await api('/api/admin/gallery');
    renderGalleryAdmin(d.items || []);
  } catch (err) {
    $('#gallery-loading').classList.add('hidden');
    setGalleryStatus(err.message, 'error');
  }
}

function initGallery() {
  $('#gallery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#gal-image');
    let file = input.files && input.files[0];
    if (!file) return setGalleryStatus('请先选择一张图片', 'error');

    const btn = $('#gallery-save');
    btn.disabled = true;
    setGalleryStatus('处理中…');

    try {
      const compressed = await compressImage(file);
      if (compressed !== file) {
        setGalleryStatus(`已压缩 ${(file.size / 1024).toFixed(0)}KB → ${(compressed.size / 1024).toFixed(0)}KB，上传中…`);
        file = compressed;
      } else {
        setGalleryStatus('上传中…');
      }
      if (file.size > 1024 * 1024) {
        throw new Error(`图片压缩后仍有 ${(file.size / 1024 / 1024).toFixed(1)} MB，请先自己压一下`);
      }

      const fd = new FormData();
      const thumb = await makeThumb(file);
      fd.append('image', file);
      if (thumb) fd.append('thumb', thumb);
      fd.append('title', $('#gal-title').value.trim());
      fd.append('note', $('#gal-note').value.trim());
      fd.append('sort', $('#gal-sort').value || '0');

      await apiUpload('/api/admin/gallery', fd);
      e.target.reset();
      $('#gal-sort').value = '0';
      setGalleryStatus('上传成功，去首页看看效果', 'ok');
      await Promise.all([loadGallery(), loadOverview()]);
    } catch (err) {
      setGalleryStatus(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 删除（两段式确认）
  $('#gallery-admin-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-gal-del]');
    if (!btn) return;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = '确认删除？';
      setTimeout(() => {
        if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '删除'; }
      }, 4000);
      return;
    }
    const id = Number(btn.dataset.galDel);
    btn.disabled = true;
    btn.textContent = '删除中…';
    try {
      await api('/api/admin/gallery/' + id, { method: 'DELETE' });
      setGalleryStatus(`已删除作品 #${id}（图片一并删除）`, 'ok');
      await Promise.all([loadGallery(), loadOverview()]);
    } catch (err) {
      setGalleryStatus(err.message, 'error');
      btn.disabled = false;
      btn.dataset.confirm = '';
      btn.textContent = '删除';
    }
  });
}

/* ============================================================
 * 登录
 * ============================================================ */
function initLogin() {
  const btn = $('#login-btn');
  let busy = false;

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const password = $('#password').value;
    if (!password) return setLoginStatus('请输入密码', 'error');

    busy = true;
    btn.disabled = true;
    setLoginStatus('登录中…');

    try {
      const d = await api('/api/admin/login', { method: 'POST', body: { password }, auth: false });
      setToken(d.token, d.expiresIn);
      $('#password').value = '';
      setLoginStatus('');
      showAdmin();
      await refreshAll();
      loadSettings().catch(() => {});
    } catch (err) {
      setLoginStatus(err.message, 'error');
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
}

/* ============================================================
 * 启动
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLogin();
  initMessageActions();
  initToolbar();
  initSettings();
  initGallery();
  updateNotifyHint();

  // 新模块（分别在 admin-content.js / admin-system.js 里定义）
  if (typeof initPostsAdmin === 'function') initPostsAdmin();
  if (typeof initArticlesAdmin === 'function') initArticlesAdmin();
  if (typeof initChangelogAdmin === 'function') initChangelogAdmin();
  if (typeof initFriendsAdmin === 'function') initFriendsAdmin();
  if (typeof initSystemPanels === 'function') initSystemPanels();

  const exp = Number(sessionStorage.getItem(EXPIRE_KEY) || 0);
  if (getToken() && exp > Date.now()) {
    showAdmin();
    refreshAll();
    loadSettings().catch(() => {});
  } else {
    clearToken();
    showLogin();
  }

  console.log('[admin] API_BASE =', API_BASE);
});
