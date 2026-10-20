/* ============================================================
 *  公共模块 —— 所有页面共用
 *  文件：frontend/core.js
 *
 *  必须在页面自己的脚本之前加载（index.html / articles.html / about.html / search.html 都用到）。
 *  包含：API 地址、请求封装、HTML 转义、时间格式化、主题切换、图片灯箱、图片压缩。
 * ============================================================ */

/* ------------------------------------------------------------
 * 1. 后端 API 地址
 *    本地开发（127.0.0.1 / file://）时会自动切到 127.0.0.1:8787，不用改代码。
 * ------------------------------------------------------------ */
const CFG_API_BASE = 'https://api.example.com';

const API_BASE = (() => {
  // 测试服务器（tests/profile-server.mjs）会注入这个全局，
  // 让它能跑在任意端口。生产环境没有它，走下面的正常逻辑。
  if (typeof window !== 'undefined' && window.__API_BASE__) return window.__API_BASE__;

  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' || location.protocol === 'file:';
  return isLocal ? 'http://127.0.0.1:8787' : CFG_API_BASE;
})();

const THEME_KEY = 'your-site:theme';      // 手动选择的主题
const LIKED_KEY = 'your-site:liked';      // 点过赞的留言 id
const LIKED_POST_KEY = 'your-site:liked-posts';   // 点过赞的说说 id

const VISIT_DEDUP_MODE = 'day';
const VISIT_STORAGE_KEY = 'your-site:last-visit';

/* ------------------------------------------------------------
 * 2. 工具函数
 * ------------------------------------------------------------ */

/**
 * HTML 转义 —— 防止 XSS 的关键。
 * 任何来自接口/用户的文本，只要要用 innerHTML 拼接，就必须先过这个函数。
 */
function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** 统一的请求封装：自动拼地址、解析 JSON、把错误抛出来 */
async function api(path, { method = 'GET', body } = {}) {
  const init = { method };
  // 只有带 body 时才设置 Content-Type，避免 GET 请求也触发 CORS 预检
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(API_BASE + path, init);
  } catch (e) {
    throw new Error('网络请求失败，请检查网络或后端地址是否正确');
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || payload.ok === false) {
    throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data;
}

/**
 * 带文件的提交。
 * 注意：用 FormData 时**不能手动设置 Content-Type**，
 * 浏览器要自己加上 multipart 的 boundary，写死会导致后端解析失败。
 */
async function apiUpload(path, formData) {
  let res;
  try {
    res = await fetch(API_BASE + path, { method: 'POST', body: formData });
  } catch (e) {
    throw new Error('网络请求失败，请检查网络');
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || payload.ok === false) {
    throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data;
}

/** 把数据库里的 UTC 时间转成本地可读格式 */
function formatTime(raw) {
  if (!raw) return '';
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z'; // SQLite 存的是 UTC
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间："3 分钟前"，超过 30 天就退回具体日期 */
function timeAgo(raw) {
  if (!raw) return '';
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return raw;
  const diff = Date.now() - t;
  if (diff < 0) return formatTime(raw);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatTime(raw).slice(0, 10);
}

/** 从 localStorage 读一个 id 数组（点赞用） */
function readIdList(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function writeIdList(key, ids) {
  try { localStorage.setItem(key, JSON.stringify(ids.slice(-800))); } catch (e) {}
}

/* ------------------------------------------------------------
 * 3. 深色模式
 *
 *  四种模式：
 *    light   强制浅色
 *    dark    强制深色
 *    auto    按时段自动（18:00–06:00 深色）—— 用户手动选的那次会记住
 *    system  跟随系统设置（默认）
 *
 *  首屏主题在 index.html 的内联脚本里先定好（避免闪烁），这里只做交互。
 * ------------------------------------------------------------ */
const THEME_MODES = ['light', 'dark', 'auto', 'system'];
const THEME_ICONS = { light: '☀️', dark: '🌙', auto: '🕐', system: '💻' };
const THEME_NAMES = { light: '浅色', dark: '深色', auto: '按时间自动', system: '跟随系统' };

/** 按时间判断现在该不该深色：18:00 – 06:00 */
function isNightNow() {
  const h = new Date().getHours();
  return h >= 18 || h < 6;
}

/* ------------------------------------------------------------
 * 背景的时段配色
 *   早上 06–11  暖橙 / 粉
 *   白天 11–17  天蓝 / 青
 *   傍晚 17–20  紫 / 落日橙
 *   夜里 20–06  靛蓝 / 淡紫
 *
 * 只改 <html> 上的 data-daypart，具体颜色由 CSS 变量决定，
 * 所以这里不碰样式，纯数据。
 * ------------------------------------------------------------ */
function currentDaypart() {
  const h = new Date().getHours();
  if (h >= 6 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'evening';
  return 'night';
}

function applyDaypart() {
  const part = currentDaypart();
  if (document.documentElement.getAttribute('data-daypart') !== part) {
    document.documentElement.setAttribute('data-daypart', part);
  }
  return part;
}

/** 把「模式」解析成「实际主题」 */
function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  if (mode === 'auto') return isNightNow() ? 'dark' : 'light';
  // system（含没设置过的情况）
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function currentThemeMode() {
  let m = null;
  try { m = localStorage.getItem(THEME_KEY); } catch (e) {}
  return THEME_MODES.includes(m) ? m : 'system';
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(mode) {
  const actual = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', actual);

  const icon = $('#theme-icon');
  if (icon) icon.textContent = THEME_ICONS[mode] || '🌙';

  const btn = $('#theme-toggle');
  if (btn) {
    btn.setAttribute('aria-label', `当前：${THEME_NAMES[mode] || mode}（点击切换）`);
    btn.setAttribute('title', `主题：${THEME_NAMES[mode] || mode}　点击切换`);
  }
}

/**
 * 算出「下一次该切到哪个模式」。
 *
 * 循环顺序固定：浅色 → 深色 → 按时段 → 跟随系统 → 浅色 …
 *
 * 唯一的特殊处理是「从来没选过主题」的时候（大多数人第一次点就是这个状态）：
 * 这时按固定顺序会切到「浅色」，而系统本来就是浅色 —— 用户会觉得点了没反应。
 * 所以这种情况直接切到「和当前看起来相反」的那个，保证第一下就有反馈。
 */
function nextThemeMode() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}

  if (!THEME_MODES.includes(stored)) {
    // 没选过：切到跟现在相反的那个
    return currentTheme() === 'dark' ? 'light' : 'dark';
  }

  const i = THEME_MODES.indexOf(stored);
  return THEME_MODES[(i + 1) % THEME_MODES.length];
}

function initTheme() {
  applyTheme(currentThemeMode());
  applyDaypart();

  const btn = $('#theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = nextThemeMode();
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      applyTheme(next);
    });
  }

  // 跟随系统时，系统变了要跟着变
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const m = currentThemeMode();
      if (m === 'system') applyTheme(m);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // 每分钟复查一次：
  //   · auto 主题模式要跨过 18:00 / 06:00 时换色
  //   · 背景的时段配色也要跟着走（跨过 6/11/17/20 点）
  setInterval(() => {
    if (currentThemeMode() === 'auto') applyTheme('auto');
    applyDaypart();
  }, 60 * 1000);
}

/* ------------------------------------------------------------
 * 4. 图片灯箱
 *    任何带 class="lightbox-trigger" 且 data-src 有值的元素都能触发。
 * ------------------------------------------------------------ */
function openLightbox(src) {
  const box = $('#lightbox');
  const img = $('#lightbox-img');
  if (!box || !img) return;
  img.src = src;
  box.classList.remove('hidden');
  box.classList.add('flex');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const box = $('#lightbox');
  const img = $('#lightbox-img');
  if (!box || !img) return;
  box.classList.add('hidden');
  box.classList.remove('flex');
  img.removeAttribute('src');
  document.body.style.overflow = '';
}

function initLightbox() {
  const box = $('#lightbox');
  if (!box) return;

  // 缩略图是动态渲染的，所以用事件委托
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.lightbox-trigger');
    if (trigger) {
      e.preventDefault();
      openLightbox(trigger.dataset.src);
      return;
    }
    if (e.target === box) closeLightbox();
  });

  const close = $('#lightbox-close');
  if (close) close.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
}

/* ------------------------------------------------------------
 * 5. 图片压缩
 *    图片要以 base64 存进 D1（单行上限 2 MB），所以上传前先压到
 *    最长边 1400px 的 JPEG。GIF 不动（压了只剩一帧）。
 * ------------------------------------------------------------ */
/*
 * 跳过压缩的阈值。
 *
 * 以前是 400 KB —— 但那意味着 400 KB 以下的图**永远不会转 WebP**，
 * 白白丢掉 30% 左右的体积收益。而图片是要以 base64 存进 D1 的
 * （单行上限 2 MB），越省越好。
 *
 * 现在降到 150 KB：再小的话省下来不到 50 KB，不值得多花一次编解码的 CPU。
 */
const COMPRESS_MIN_BYTES = 150 * 1024;

async function compressImage(file, maxDim = 1400, quality = 0.82) {
  if (file.size <= COMPRESS_MIN_BYTES) return file;
  if (file.type === 'image/gif') return file;   // 动图压了只剩一帧
  return _compress(file, maxDim, quality);
}

async function _compress(file, maxDim, quality) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();

    // 优先用 WebP：同画质下比 JPEG 小 25–35%，服务器端也认这个格式
    let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));

    // 个别老浏览器不支持 WebP 编码，toBlob 会返回 null 或退化成 PNG（体积反而更大）
    if (!blob || blob.type !== 'image/webp') {
      blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    }

    if (blob.size >= file.size) return file;
    return new File([blob], 'photo.webp', { type: 'image/webp' });
  } catch (e) {
    return file;
  }
}

/**
 * 渲染资料卡上的联系方式（GitHub / Bilibili / 邮箱 …）
 *
 * ⚠️ 为什么要抽出来：
 *
 *   这段逻辑原来**在 app.js 和 pages.js 里各有一份**。
 *   之前修「所有联系人链接都点不动」那个 bug 时，我只改了 app.js，
 *   结果首页好了、about 页还是死链 —— 同一段代码两份，改一份等于没改完。
 *
 *   （那个 bug 的成因：后端字段叫 `link`，代码里写的是 `c.url`。
 *     c.url 是 undefined，`|| '#'` 兜底成 href="#"，
 *     点一下只是跳回页面顶部，表现就是"没反应"。）
 *
 * @param {HTMLElement|null} el        容器
 * @param {Array} contacts             联系人数组
 */
function renderContacts(el, contacts) {
  if (!el) return;

  el.innerHTML = (contacts || []).map((c) => {
    const href = c.link || c.url || '';
    if (!href) console.warn('[contacts] 缺少链接，跳过:', c);
    if (!href) return '';

    // 邮件链接不开新窗口；http 的才加 target
    const isMail = href.startsWith('mailto:');
    const targetAttrs = isMail ? '' : ' target="_blank" rel="noopener noreferrer"';

    // 只写「邮箱」两个字看不出往哪发，把 value 作为副标题显示出来。
    // 访客不用点开就知道地址，也方便直接抄走。
    const sub = c.value && c.value !== c.label ? c.value : '';

    return `
      <a href="${escapeHtml(href)}"${targetAttrs}
         title="${escapeHtml(sub || href)}"
         class="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-blue-400">
        <span aria-hidden="true">${escapeHtml(c.icon || (isMail ? '✉️' : '🔗'))}</span>
        <span class="flex min-w-0 flex-col items-start leading-tight">
          <span>${escapeHtml(c.label || '')}</span>
          ${sub ? `<span class="max-w-[11rem] truncate text-xs text-slate-500 dark:text-slate-400">${escapeHtml(sub)}</span>` : ''}
        </span>
      </a>`;
  }).join('');
}



/* ------------------------------------------------------------
 * Turnstile 人机校验
 *
 * 设计上有个前提：**没配置就不加载**。
 *   · 站长还没去 Cloudflare 建 widget 时，sitekey 是空串
 *   · 这时整段代码不执行，页面上不出现任何验证组件
 *   · 也就不会多加载一个第三方脚本（约 30KB）
 *
 * 另一个容易忘的点：**令牌是一次性的**。
 * 提交成功后必须 reset，否则第二次提交会拿到已经用过的令牌，
 * Cloudflare 会返回 timeout-or-duplicate，用户看到"校验失败"
 * 却不知道自己做错了什么。
 * ------------------------------------------------------------ */

const TS_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let tsEnabled = false;
let tsScriptPromise = null;
const tsWidgets = new Map();   // 容器 id → widgetId

/** 按需加载 Turnstile 脚本（同一个页面只加载一次） */
function loadTurnstileScript() {
  if (tsScriptPromise) return tsScriptPromise;

  tsScriptPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = TS_SCRIPT;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(true);
    // 加载失败不能把留言功能一起拖死 —— 返回 false，调用方降级
    s.onerror = () => resolve(false);
    document.head.appendChild(s);

    // 脚本本身没问题但一直不回调（网络黑洞）也要有个上限。
    // 15 秒是权衡：太短会误判（移动网络下 Cloudflare 的脚本有时就是慢），
    // 太长用户会觉得页面卡住了。
    setTimeout(() => resolve(!!(window.turnstile)), 15000);
  });

  return tsScriptPromise;
}

/**
 * 在指定容器里渲染一个验证组件。
 * 容器不存在、脚本加载失败、或者没启用 —— 都安静地返回 null。
 */
async function renderTurnstile(containerId) {
  if (!tsEnabled) return null;
  const el = document.getElementById(containerId);
  if (!el) return null;

  const ok = await loadTurnstileScript();
  if (!ok || !window.turnstile) {
    // ⚠️ 这里必须给用户一个交代。
    //    因为配了 secret 之后后端是**要求令牌**的 —— 组件没渲染出来
    //    就等于用户发不出留言，而页面上一点提示都没有，
    //    他只会觉得"这个网站坏了"。
    el.innerHTML = '<p class="text-xs text-amber-600 dark:text-amber-400">'
      + '人机校验加载失败，请检查网络后刷新页面重试</p>';
    return null;
  }

  // 已经渲染过就别重复渲染（Cloudflare 会报错）
  if (tsWidgets.has(containerId)) return tsWidgets.get(containerId);

  const widgetId = window.turnstile.render(el, {
    sitekey: tsSiteKey,
    // 站点有手动主题开关，所以按当前实际主题给，不用 auto
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    size: 'flexible',
    // 这些回调暂时只用于排错，用户看不到
    'error-callback': () => console.warn('[turnstile] 组件报错'),
    'timeout-callback': () => console.warn('[turnstile] 令牌超时，已自动重置'),
  });

  tsWidgets.set(containerId, widgetId);
  return widgetId;
}

/** 取当前令牌；没启用或组件还没完成时返回 null */
function turnstileToken(containerId) {
  if (!tsEnabled || !window.turnstile) return null;
  const id = tsWidgets.get(containerId);
  if (id === undefined) return null;
  return window.turnstile.getResponse(id) || null;
}

/**
 * 取令牌 —— 如果现在没有，就等它生成好。
 *
 * ⚠️ 为什么必须有这个函数：
 *
 *   令牌是**一次性**的，提交完必须 reset。但 reset 之后新令牌是
 *   **异步**生成的，有一段空窗期。如果用户提交完马上又发一条，
 *   turnstileToken() 会返回 null，请求就带着空令牌出去了，
 *   后端返回「人机校验没有完成」—— 用户完全不明白自己做错了什么。
 *
 *   这个问题我是端到端测试才发现的：连发两条，第二条必失败。
 *
 * 做法：先看有没有现成的；没有就主动 execute 一次并轮询等待，
 *       超时了也不卡死（返回 null，让后端去判断）。
 */
async function getTurnstileToken(containerId, timeoutMs = 8000) {
  if (!tsEnabled || !window.turnstile) return null;

  const existing = turnstileToken(containerId);
  if (existing) return existing;

  const id = tsWidgets.get(containerId);
  if (id === undefined) return null;

  // 主动让组件去取一个新令牌（无感模式下不会打扰用户）
  try { window.turnstile.execute(id); } catch (e) { /* 有些版本不支持，靠轮询兜底 */ }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const t = turnstileToken(containerId);
    if (t) return t;
  }

  // 等不到了。返回 null，让后端决定怎么处理，并且把失败原因说清楚。
  console.warn('[turnstile] 等待令牌超时');
  return null;
}

/** 提交之后必须重置 —— 令牌一次性 */
function resetTurnstile(containerId) {
  if (!tsEnabled || !window.turnstile) return;
  const id = tsWidgets.get(containerId);
  if (id !== undefined) window.turnstile.reset(id);
}

/**
 * 初始化。siteKey 为空 = 不启用，什么都不做。
 * @returns {boolean} 是否启用了人机校验
 */
async function initTurnstile(siteKey) {
  tsSiteKey = String(siteKey || '').trim();
  tsEnabled = !!tsSiteKey;
  if (!tsEnabled) return false;

  // 脚本先预加载，用户填表单的时候差不多就好了
  loadTurnstileScript();
  return true;
}

/* ------------------------------------------------------------
 * 字母头像
 *   留言的人没有头像，用昵称首字生成一个彩色圆。
 *   颜色由昵称哈希决定 —— 同一个人每次都是同一个颜色，不会跳。
 * ------------------------------------------------------------ */

/** 昵称 → 0–360 的色相（确定性） */
function nameHue(name) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 取首字（emoji 和中文都能正确取到第一个字符） */
function firstGlyph(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  return Array.from(s)[0].toUpperCase();
}

/**
 * 生成字母头像的 HTML。
 * 只输出一个 span + 内联的 --av-h，样式全在 style.css 里。
 */
function letterAvatar(name, extraClass = '') {
  const h = nameHue(name);
  return `<span class="letter-avatar ${extraClass}" style="--av-h:${h}" aria-hidden="true">${escapeHtml(firstGlyph(name))}</span>`;
}

/* ------------------------------------------------------------
 * 6. 访问量上报（带来源）
 * ------------------------------------------------------------ */
async function reportVisit() {
  let last = null;
  try { last = localStorage.getItem(VISIT_STORAGE_KEY); } catch (e) {}

  const stamp = VISIT_DEDUP_MODE === 'day' ? new Date().toISOString().slice(0, 10) : 'session';

  try {
    // 今天已经计过数就不再 +1，但仍然要把总数读出来显示
    if (last === stamp) {
      const d = await api('/api/visits');
      return typeof d.count === 'number' ? d.count : null;
    }
    const d = await api('/api/visits', { method: 'POST', body: { ref: document.referrer || '' } });
    try { localStorage.setItem(VISIT_STORAGE_KEY, stamp); } catch (e) {}
    return d.count;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------
 * 7. PWA：注册 Service Worker
 * ------------------------------------------------------------ */
function initPWA() {
  if (!('serviceWorker' in navigator)) return;
  // 本地开发时不注册，免得缓存干扰调试
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('Service Worker 注册失败:', e.message);
    });
  });
}

/* ------------------------------------------------------------
 * 8. 顶部导航（各页面共用的小逻辑）
 * ------------------------------------------------------------ */
function initHeader() {
  initTheme();
  initLightbox();

  // 移动端的导航折叠
  const toggle = $('#nav-toggle');
  const menu = $('#nav-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', (e) => {
      // 阻止冒泡：否则下面那个「点外面关闭」会立刻把它又关掉
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    // 点菜单里的链接 → 关掉（不然后面页面跳转了菜单还开着）
    menu.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') menu.classList.add('hidden');
    });

    // 点页面其它地方也关掉 —— 手机上展开菜单后点空白处，
    // 直觉上应该收起来。菜单已经收起时这段什么也不做。
    document.addEventListener('click', (e) => {
      if (menu.classList.contains('hidden')) return;
      if (menu.contains(e.target) || toggle.contains(e.target)) return;
      menu.classList.add('hidden');
    });

    // 从手机宽度拉宽到桌面时复位展开状态，
    // 不然缩回手机宽度会发现菜单莫名其妙是开着的
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 640) menu.classList.add('hidden');
    });
  }

  initPWA();
}
