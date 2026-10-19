/* ============================================================
 *  文章列表 / 详情
 *  文件：frontend/articles.js
 *
 *  同一个页面处理两种情况：
 *    articles             → 列表（支持 ?tag= 筛选、分页）
 *    articles?slug=xxx    → 详情
 *
 *  正文的 HTML 是**服务端渲染好的**（worker 里先转义再套 Markdown 规则），
 *  所以这里可以直接 innerHTML —— 不会执行用户输入的脚本。
 * ============================================================ */

let currentTag = null;
let currentPage = 1;
let totalPages = 1;

function tagChip(t) {
  const active = currentTag === t.name;
  return `
    <a href="articles?tag=${encodeURIComponent(t.name)}"
       class="rounded-full border px-3 py-1 text-xs font-medium transition
              ${active
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600 dark:border-slate-700 dark:text-slate-400'}">
      ${escapeHtml(t.name)} <span class="opacity-60">${t.count}</span>
    </a>`;
}

function renderList(data) {
  const listEl = $('#article-list');
  $('#list-loading').classList.add('hidden');

  const items = data.items || [];
  $('#list-empty').classList.toggle('hidden', items.length > 0);

  // 标签栏
  const tagsEl = $('#list-tags');
  const tags = data.tags || [];
  tagsEl.innerHTML = items.length || currentTag
    ? [
        currentTag ? `<a href="articles" class="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-500 transition hover:border-blue-400 dark:border-slate-700 dark:text-slate-400">← 全部</a>` : '',
        ...tags.map(tagChip),
      ].join('')
    : '';

  listEl.innerHTML = items.map((a) => `
    <li>
      <a href="articles?slug=${encodeURIComponent(a.slug)}"
         class="group flex min-w-0 gap-4 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-md transition hover:border-blue-400 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-500">
        ${a.cover_url ? `
          <span class="hidden h-24 w-36 shrink-0 overflow-hidden rounded-xl sm:block">
            <img src="${escapeHtml(a.cover_url)}" alt="" loading="lazy"
                 class="h-full w-full object-cover transition duration-300 group-hover:scale-105">
          </span>` : ''}
        <span class="min-w-0 flex-1">
          <span class="block text-lg font-semibold leading-snug">
            ${a.pinned ? '<span class="mr-1 text-amber-500" title="置顶">📌</span>' : ''}${escapeHtml(a.title)}
          </span>
          ${a.summary ? `<span class="mt-2 block text-sm leading-relaxed text-slate-600 dark:text-slate-300">${escapeHtml(a.summary)}</span>` : ''}
          <span class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
            <time>${escapeHtml(formatTime(a.created_at).slice(0, 10))}</time>
            <span>·</span>
            <span>${a.views} 次阅读</span>
            ${(a.tags || []).length ? `<span>·</span><span>${a.tags.map((t) => escapeHtml(t)).join(' / ')}</span>` : ''}
          </span>
        </span>
      </a>
    </li>`).join('');

  renderPager(data);
}

function renderPager(meta) {
  const el = $('#list-pagination');
  if (!meta || meta.totalPages <= 1) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const { page, totalPages: tp } = meta;
  const btn = (label, target, disabled) => `
    <button type="button" data-page="${target}" ${disabled ? 'disabled' : ''}
            class="rounded-xl border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium transition
                   hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40
                   dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">${label}</button>`;
  el.innerHTML = `${btn('← 上一页', page - 1, page <= 1)}
    <span class="px-2 text-sm text-slate-500">第 ${page} / ${tp} 页</span>
    ${btn('下一页 →', page + 1, page >= tp)}`;
}

async function loadList(page = 1) {
  currentPage = page;
  const q = new URLSearchParams();
  q.set('page', String(page));
  q.set('size', '10');
  if (currentTag) q.set('tag', currentTag);

  try {
    const d = await api('/api/articles?' + q.toString());
    totalPages = d.totalPages;
    renderList(d);
  } catch (err) {
    $('#list-loading').classList.add('hidden');
    const el = $('#list-empty');
    el.textContent = '加载失败：' + err.message;
    el.classList.remove('hidden');
    el.className = 'mt-5 text-sm text-red-500';
  }
}

function initPager() {
  $('#list-pagination').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b || b.disabled) return;
    const t = Number(b.dataset.page);
    if (t >= 1 && t <= totalPages) {
      loadList(t);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
}

/* ============================================================
 * 详情
 * ============================================================ */
async function loadDetail(slug) {
  $('#list-view').classList.add('hidden');
  $('#detail-view').classList.remove('hidden');

  try {
    const a = await api('/api/articles/' + encodeURIComponent(slug));

    document.title = a.title + ' · Demo';
    $('#article-title').textContent = a.title;
    $('#article-date').textContent = '发布于 ' + formatTime(a.created_at).slice(0, 10);
    $('#article-views').textContent = a.views + ' 次阅读';
    $('#article-tags').innerHTML = (a.tags || []).map((t) => `
      <a href="articles?tag=${encodeURIComponent(t)}"
         class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">${escapeHtml(t)}</a>`).join('');

    // 服务端已经渲染并转义过了，直接插入
    $('#article-body').innerHTML = a.html || '<p>（空）</p>';

    /* 正文开头的第一个一级标题不渲染。
       写 Markdown 的人习惯以 "# 标题" 开头，而页面上
       <h1 id="article-title"> 已经在显示标题了 ——
       渲染出来就是同一个页面两个一级标题，读屏会说两遍。

       规则是「正文第一个元素如果是 h1，就删掉」，不看文字是否一样。
       一开始我只删「文字完全一致」的，结果有篇文章正文写的是短标题、
       frontmatter 写的是完整标题，两个 h1 就都留下了 —— 太保守。

       为什么可以无条件删：
         · 文章标题已经单独显示了，正文的 # 本来就是重复的
         · 只动第一个元素，正文中间的 h1 不受影响
         · 内容没丢，原文在数据库和 content/articles/ 里都在 */
    (function dropLeadingTitle() {
      const box = document.querySelector('#article-body');
      const first = box.firstElementChild;
      if (first && first.tagName === 'H1' && String(a.title || '').trim()) first.remove();
    })();

    // 正文里的图片也支持点击放大
    document.querySelectorAll('#article-body img').forEach((img) => {
      img.classList.add('cursor-zoom-in', 'rounded-xl', 'my-4');
      img.addEventListener('click', () => openLightbox(img.src));
    });

    if (a.prev) {
      const el = $('#article-prev');
      el.href = 'articles?slug=' + encodeURIComponent(a.prev.slug);
      el.innerHTML = `<span class="block text-xs text-slate-500 dark:text-slate-400">← 上一篇</span><span class="mt-1 block font-medium">${escapeHtml(a.prev.title)}</span>`;
      el.classList.remove('hidden');
    }
    if (a.next) {
      const el = $('#article-next');
      el.href = 'articles?slug=' + encodeURIComponent(a.next.slug);
      el.innerHTML = `<span class="block text-xs text-slate-500 dark:text-slate-400">下一篇 →</span><span class="mt-1 block font-medium">${escapeHtml(a.next.title)}</span>`;
      el.classList.remove('hidden');
    }

    // 封面（有才显示）
    const coverEl = $('#article-cover');
    if (coverEl) {
      if (a.cover_url) {
        coverEl.src = a.cover_url;
        coverEl.alt = a.title;
        coverEl.classList.remove('hidden');
      } else {
        coverEl.classList.add('hidden');
        coverEl.removeAttribute('src');
      }
    }

    // 正文渲染完再构建目录 / 进度条 / 分享
    buildTOC();
    initReadingProgress();
    initShare(a);

    if ((a.related || []).length) {
      $('#article-related').innerHTML = `
        <h2 class="mb-3 text-sm font-semibold text-slate-500 dark:text-slate-400">相关文章</h2>
        <ul class="grid gap-2">
          ${a.related.map((r) => `
            <li class="min-w-0"><a href="articles?slug=${encodeURIComponent(r.slug)}"
                   class="block min-w-0 truncate rounded-xl border border-slate-200 px-4 py-2.5 text-sm transition hover:border-blue-400 dark:border-slate-800 dark:hover:border-blue-500">
              ${escapeHtml(r.title)}</a></li>`).join('')}
        </ul>`;
    }
  } catch (err) {
    $('#detail-view').classList.add('hidden');
    const el = $('#detail-error');
    el.textContent = '文章加载失败：' + err.message;
    el.classList.remove('hidden');
  }
}

/* ============================================================
 * 文章详情页的三个增强：目录 / 阅读进度 / 分享
 * ============================================================ */

/** 给正文里的标题加锚点 id（中文标题不能直接当 id，所以用序号） */
function buildTOC() {
  const body = document.querySelector('#article-body');
  const desk = document.querySelector('#toc-desktop');
  const mob = document.querySelector('#toc-mobile');
  const mobNav = document.querySelector('#toc-mobile-nav');
  if (!body || !desk) return;

  // 只收 h2 / h3（h1 是文章标题本身，不放进目录）
  const heads = Array.from(body.querySelectorAll('h2, h3'));
  if (heads.length < 2) {
    // 太短的文章不需要目录
    desk.innerHTML = '';
    if (mob) mob.classList.add('hidden');
    return;
  }

  const items = heads.map((h, i) => {
    const id = 'sec-' + (i + 1);
    h.id = id;
    // 点标题也能复制到锚点链接
    h.classList.add('scroll-mt-24');
    return { id, text: h.textContent.trim(), level: h.tagName === 'H2' ? 2 : 3 };
  });

  const linkCls = (level) =>
    'block truncate rounded-md py-1 transition hover:text-blue-600 dark:hover:text-blue-400 ' +
    (level === 3 ? 'pl-4 text-xs' : 'text-sm');

  const html = items.map((it) =>
    `<a href="#${it.id}" data-toc="${it.id}" class="${linkCls(it.level)} text-slate-500 dark:text-slate-400">${escapeHtml(it.text)}</a>`
  ).join('');

  desk.innerHTML = `<p class="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">目录</p>${html}`;
  if (mobNav) mobNav.innerHTML = html;
  if (mob) mob.classList.remove('hidden');

  // 滚动时高亮当前所在的小节
  const allLinks = Array.from(document.querySelectorAll('[data-toc]'));
  const highlight = () => {
    let current = items[0].id;
    for (const it of items) {
      const el = document.getElementById(it.id);
      if (el && el.getBoundingClientRect().top <= 120) current = it.id;
    }
    allLinks.forEach((a) => {
      const on = a.dataset.toc === current;
      a.className = linkCls(a.classList.contains('pl-4') ? 3 : 2) +
        (on ? ' font-medium text-blue-600 dark:text-blue-400'
            : ' text-slate-500 dark:text-slate-400');
    });
  };
  window.addEventListener('scroll', highlight, { passive: true });
  highlight();
}

/** 顶部阅读进度条 */
function initReadingProgress() {
  const bar = document.querySelector('#reading-progress');
  const body = document.querySelector('#article-body');
  if (!bar || !body) return;

  bar.classList.remove('hidden');

  const update = () => {
    const rect = body.getBoundingClientRect();
    const total = rect.height - window.innerHeight * 0.6;
    const passed = -rect.top + window.innerHeight * 0.3;
    const pct = total <= 0 ? 100 : Math.max(0, Math.min(100, (passed / total) * 100));
    bar.style.width = pct.toFixed(1) + '%';
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/** 分享：复制链接 / 微博 / 原生分享 */
function initShare(article) {
  // 分享出去用 /a/<slug> 而不是当前地址 ——
  // 那条路由有服务端注入的 og 标签，微信/QQ 里才会出卡片。
  const shareSlug = article.slug || params.get('slug') || window.__ARTICLE_SLUG__ || '';
  const url = shareSlug
    ? `${location.origin}/a/${encodeURIComponent(shareSlug)}`
    : location.href;
  const title = article.title || document.title;
  const status = document.querySelector('#share-status');

  const flash = (t) => {
    if (!status) return;
    status.textContent = t;
    setTimeout(() => { if (status.textContent === t) status.textContent = ''; }, 2200);
  };

  const copyBtn = document.querySelector('#share-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        flash('已复制 ✅');
      } catch (e) {
        // 有些浏览器在不安全上下文里不给 clipboard 权限，退回老办法
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flash('已复制 ✅'); }
        catch (e2) { flash('复制失败，手动复制地址栏吧'); }
        ta.remove();
      }
    });
  }

  const weibo = document.querySelector('#share-weibo');
  if (weibo) {
    weibo.href = `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
  }

  const native = document.querySelector('#share-native');
  if (native && navigator.share) {
    native.hidden = false;
    native.addEventListener('click', async () => {
      try { await navigator.share({ title, url }); }
      catch (e) { /* 用户取消，忽略 */ }
    });
  }
}

/* ============================================================
 * 启动
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initHeader();

  const params = new URLSearchParams(location.search);
  // /a/<slug> 这条路由由 Pages Function 处理，它会把 slug 注入到
  // window.__ARTICLE_SLUG__（因为爬虫不执行 JS，meta 只能服务端渲染）。
  // 这里做一次兜底，让同一个页面两种地址都能用。
  const slug = params.get('slug') || window.__ARTICLE_SLUG__ || '';

  if (slug) {
    loadDetail(slug);
  } else {
    currentTag = params.get('tag') || null;
    initPager();
    loadList(1);
  }

  console.log('[articles] API_BASE =', API_BASE);
});
