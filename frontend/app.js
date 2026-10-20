/* ============================================================
 *  首页逻辑
 *  文件：frontend/app.js
 *
 *  依赖 core.js（必须先加载）：api / escapeHtml / formatTime / initHeader ...
 *
 *  这个文件负责：资料卡、歌单、说说、作品集、友链、GitHub 卡片、留言板。
 * ============================================================ */

/* ---------------- 状态 ---------------- */
const PAGE_SIZE = 10;
let currentPage = 1;
let totalPages = 1;
let likedSet = new Set(readIdList(LIKED_KEY));
let likedPosts = new Set(readIdList(LIKED_POST_KEY));

/* ============================================================
 * 1. 资料卡 / 技能 / 项目 / 歌单
 * ============================================================ */
async function loadProfile() {
  const data = await api('/api/profile');

  /*
   * 人机校验：只有后台配了 sitekey 才启用。
   *
   * 没配的话 initTurnstile 返回 false，这里什么都不做 ——
   * 容器保持 hidden、第三方脚本不加载、提交时也不带令牌。
   * 也就是说，在站长去 Cloudflare 建好 widget 之前，
   * 这段代码是一次空操作，不会给访客增加任何负担。
   */
  if (await initTurnstile(data.turnstile_site_key)) {
    for (const id of ['turnstile-msg', 'turnstile-friend']) {
      const box = document.getElementById(id);
      if (!box) continue;
      box.classList.remove('hidden');
      await renderTurnstile(id);
    }
  }

  $('#profile-name').textContent = data.name || '';
  $('#profile-tagline').textContent = data.tagline || '';
  $('#profile-bio').textContent = data.bio || '';

  const avatar = $('#profile-avatar');
  if (avatar && data.avatar) {
    avatar.src = data.avatar;
    avatar.alt = (data.name || '') + ' 的头像';
  }

  renderContacts($('#contacts'), data.contacts);

  const skills = $('#skills-list');
  if (skills) {
    // 两种写法都支持（可以混用）：
    //   'JavaScript'                 → 渲染成一个小标签
    //   { name: 'Rust', level: 60 }  → 渲染成带百分比进度条的卡片
    //
    // ⚠️ 之前这里只实现了字符串分支 —— 传对象会被 escapeHtml 调 toString()，
    //    页面上直接显示「[object Object]」。后端注释里承诺的进度条一直没做。
    skills.innerHTML = (data.skills || []).map((s) => {
      if (s && typeof s === 'object') {
        const name = escapeHtml(String(s.name == null ? '' : s.name));
        const level = Math.max(0, Math.min(100, Math.round(Number(s.level) || 0)));
        return `
          <span class="flex min-w-40 flex-col gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            <span class="flex items-baseline justify-between gap-3">
              <span class="truncate">${name}</span>
              <span class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${level}%</span>
            </span>
            <span class="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <span class="block h-full rounded-full bg-blue-500" style="width:${level}%"></span>
            </span>
          </span>`;
      }
      return `
      <span class="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
        ${escapeHtml(s)}
      </span>`;
    }).join('');
  }

  const projects = $('#projects-list');
  if (projects) {
    projects.innerHTML = (data.projects || []).map((p) => `
      <article class="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-md transition hover:shadow-lg dark:border-slate-800 dark:bg-slate-900">
        <h3 class="text-base font-semibold">${escapeHtml(p.title)}</h3>
        <p class="mt-1.5 flex-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">${escapeHtml(p.desc)}</p>
        ${(p.tags || []).length ? `
          <div class="mt-3 flex flex-wrap gap-1.5">
            ${p.tags.map((t) => `<span class="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">${escapeHtml(t)}</span>`).join('')}
          </div>` : ''}
        <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          ${(Array.isArray(p.demos) ? p.demos : []).map((d) => `
            <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer"
               class="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-md transition hover:bg-blue-700">
              <span aria-hidden="true">🎮</span>${escapeHtml(d.label)}
            </a>`).join('')}
          ${p.link ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer"
                         class="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">${(p.demos || []).length ? '源码' : '查看详情'} →</a>` : ''}
        </div>
      </article>`).join('');
  }

  renderPlaylist(data.playlist);

  // GitHub 卡片懒加载：滚动到可见才请求，别拖慢首屏（顺便避开外部接口抖动）
  const ghBox = $('#github-card');
  if (ghBox) {
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadGithubCard();
        }
      }, { rootMargin: '300px' });
      io.observe(ghBox);
    } else {
      loadGithubCard();
    }
  }
  return data;
}

function renderPlaylist(list) {
  const el = $('#playlist');
  if (!el) return;
  const items = Array.isArray(list) ? list.filter((x) => x && x.title) : [];
  if (!items.length) {
    el.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">还没有歌单。</p>';
    return;
  }
  el.innerHTML = items.map((s, i) => `
    <div class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-md transition hover:shadow-lg dark:border-slate-800 dark:bg-slate-900">
      <span class="w-6 shrink-0 text-center font-mono text-sm text-slate-500 dark:text-slate-400">${i + 1}</span>
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">
          ${escapeHtml(s.title)}${s.artist ? `<span class="font-normal text-slate-500 dark:text-slate-400"> — ${escapeHtml(s.artist)}</span>` : ''}
        </p>
        ${s.note ? `<p class="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">${escapeHtml(s.note)}</p>` : ''}
      </div>
      ${s.url ? `
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer"
           class="shrink-0 rounded-xl bg-pink-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-md transition hover:bg-pink-700">
          ▶ B站
        </a>` : ''}
    </div>`).join('');
}

/* ============================================================
 * 2. 说说（短动态）
 * ============================================================ */
/* 说说默认露几条，其余折叠。
   展开状态存在模块变量里，这样点了赞重新渲染之后不会又缩回去。 */
const POSTS_PREVIEW = 3;
let postsExpanded = false;

function renderPosts(list, meta) {
  const el = $('#posts-list');
  const empty = $('#posts-empty');
  const loading = $('#posts-loading');
  if (!el) return;

  if (loading) loading.classList.add('hidden');
  const items = Array.isArray(list) ? list : [];

  if (empty) empty.classList.toggle('hidden', items.length > 0);
  const count = $('#posts-count');
  if (count) count.textContent = meta && meta.total ? `（${meta.total} 条）` : '';

  const needCollapse = items.length > POSTS_PREVIEW;

  el.innerHTML = items.map((m, i) => `
    <li data-post-idx="${i}"${needCollapse && i >= POSTS_PREVIEW && !postsExpanded ? ' class="hidden"' : ''}
        class="rounded-2xl border border-slate-200 bg-white p-4 shadow-md dark:border-slate-800 dark:bg-slate-900">
      <time class="font-mono text-xs text-slate-500 dark:text-slate-400" title="${escapeHtml(formatTime(m.created_at))}">
        ${escapeHtml(timeAgo(m.created_at))}
      </time>
      <p class="message-content mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200">${escapeHtml(m.content)}</p>
      ${m.image_url ? `
        <button type="button" class="lightbox-trigger group relative mt-3 block w-fit cursor-zoom-in"
                data-src="${escapeHtml(m.image_url)}" title="点击查看原图">
          <img src="${escapeHtml(thumbUrl(m.image_url))}" alt="说说配图" loading="lazy" decoding="async"
               class="max-h-48 w-auto max-w-full rounded-xl border border-slate-200 object-contain transition group-hover:opacity-90 dark:border-slate-700">
          <span aria-hidden="true"
                class="pointer-events-none absolute bottom-2 right-2 rounded-md bg-slate-900/55 px-1.5 py-0.5 text-[11px] leading-none text-white backdrop-blur-sm">
            点击放大
          </span>
        </button>` : ''}
      <div class="mt-3 flex items-center gap-2">
        <button type="button" data-post-like="${m.id}" data-liked="${likedPosts.has(m.id) ? '1' : '0'}"
                ${likedPosts.has(m.id) ? 'disabled' : ''}
                class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition
                       ${likedPosts.has(m.id)
                         ? 'cursor-default border-pink-200 bg-pink-50 text-pink-600 dark:border-pink-900 dark:bg-pink-950/50 dark:text-pink-400'
                         : 'border-slate-300 text-slate-500 hover:border-pink-300 hover:text-pink-600 dark:border-slate-700 dark:text-slate-400'}">
          <span aria-hidden="true">${likedPosts.has(m.id) ? '❤️' : '🤍'}</span>
          <span class="like-num">${m.likes || 0}</span>
        </button>
      </div>
    </li>`).join('');

  // 折叠按钮：条数不够就不显示
  const toggle = $('#posts-toggle');
  if (toggle) {
    if (!needCollapse) {
      toggle.hidden = true;
    } else {
      toggle.hidden = false;
      const rest = items.length - POSTS_PREVIEW;
      toggle.textContent = postsExpanded ? '收起' : `展开全部 ${items.length} 条（还有 ${rest} 条）`;
    }
  }
}

function initPostsToggle() {
  const toggle = $('#posts-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    postsExpanded = !postsExpanded;
    const cards = document.querySelectorAll('#posts-list li[data-post-idx]');
    cards.forEach((li) => {
      if (Number(li.dataset.postIdx) >= POSTS_PREVIEW) li.classList.toggle('hidden', !postsExpanded);
    });
    const total = cards.length;
    toggle.textContent = postsExpanded ? '收起' : `展开全部 ${total} 条（还有 ${total - POSTS_PREVIEW} 条）`;
    // 收起时把视图带回列表顶部，否则用户会停在半空
    if (!postsExpanded) $('#posts-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function loadPosts() {
  try {
    const d = await api('/api/posts?size=20');
    renderPosts(d.items, d);
  } catch (err) {
    const loading = $('#posts-loading');
    if (loading) loading.textContent = '说说加载失败：' + err.message;
  }
}

/* ------------------------------------------------------------
 * 首页的「最近文章」
 *
 * 原来首页没有任何文章入口 —— 访客只能靠导航栏点「文章」才看得到，
 * 结果就是「站上有文章，但没人知道」。
 *
 * 这里只露最近 3 篇。多了会把首页撑得太长，剩下的交给「看全部」。
 * 链接用 articles?slug=xxx（站内约定），不要用 /a/<slug> ——
 * 后者是 Pages Function 整页渲染，会多一次完整加载。
 * ---------------------------------------------------------- */
function renderRecentArticles(data) {
  const el = $('#recent-articles-list');
  if (!el) return;

  $('#recent-articles-loading')?.classList.add('hidden');

  const items = (data && data.items) || [];
  $('#recent-articles-empty')?.classList.toggle('hidden', items.length > 0);

  const count = $('#recent-articles-count');
  if (count) count.textContent = data && data.total ? `（共 ${data.total} 篇）` : '';

  el.innerHTML = items.map((a) => `
    <li class="min-w-0">
      <a href="articles?slug=${encodeURIComponent(a.slug)}"
         class="block rounded-2xl border border-slate-200 bg-white p-4 shadow-md transition hover:border-blue-300 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-700">
        <div class="flex items-baseline gap-2">
          ${a.pinned ? '<span class="shrink-0 text-amber-500" aria-label="置顶">📌</span>' : ''}
          <h3 class="min-w-0 flex-1 truncate font-semibold">${escapeHtml(a.title)}</h3>
          <time class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
            ${escapeHtml(formatTime(a.created_at).slice(0, 10))}
          </time>
        </div>
        ${a.summary ? `<p class="mt-1.5 line-clamp-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">${escapeHtml(a.summary)}</p>` : ''}
        ${(a.tags || []).length ? `
          <div class="mt-2 flex flex-wrap gap-1.5">
            ${a.tags.slice(0, 4).map((t) => `<span class="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">${escapeHtml(t)}</span>`).join('')}
          </div>` : ''}
      </a>
    </li>`).join('');
}

async function loadRecentArticles() {
  try {
    const d = await api('/api/articles?size=3');
    renderRecentArticles(d);
  } catch (err) {
    const loading = $('#recent-articles-loading');
    if (loading) loading.textContent = '文章加载失败：' + err.message;
  }
}

/* ============================================================
 * 3. 作品集相册
 * ============================================================ */
function renderGallery(data) {
  const grid = $('#gallery-grid');
  if (!grid) return;
  const items = (data && data.items) || [];

  const count = $('#gallery-count');
  if (count) count.textContent = items.length ? `（${items.length} 件）` : '';
  const empty = $('#gallery-empty');
  if (empty) empty.classList.toggle('hidden', items.length > 0);

  grid.innerHTML = items.map((g) => `
    <figure class="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md transition hover:shadow-lg dark:border-slate-800 dark:bg-slate-900">
      <button type="button" class="lightbox-trigger block w-full cursor-zoom-in"
              data-src="${escapeHtml(g.image_url)}" aria-label="查看大图">
        <img src="${escapeHtml(thumbUrl(g.image_url))}" alt="${escapeHtml(g.title || '作品')}" loading="lazy" decoding="async"
             class="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-105">
      </button>
      ${(g.title || g.note) ? `
        <figcaption class="p-3">
          ${g.title ? `<p class="truncate text-sm font-medium">${escapeHtml(g.title)}</p>` : ''}
          ${g.note ? `<p class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">${escapeHtml(g.note)}</p>` : ''}
        </figcaption>` : ''}
    </figure>`).join('');
}

async function loadGallery() {
  try {
    renderGallery(await api('/api/gallery'));
  } catch (err) {
    const grid = $('#gallery-grid');
    if (grid) grid.innerHTML = `<p class="text-sm text-red-500">作品集加载失败：${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 4. 友链
 * ============================================================ */
function renderFriends(data) {
  const grid = $('#friends-grid');
  if (!grid) return;
  const items = (data && data.items) || [];

  const empty = $('#friends-empty');
  if (empty) empty.classList.toggle('hidden', items.length > 0);

  grid.innerHTML = items.map((f) => {
    const host = (() => {
      try { return new URL(f.url).hostname.replace(/^www\./, ''); } catch (e) { return f.url; }
    })();
    return `
      <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer"
         class="flex min-w-0 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-md transition hover:border-blue-400 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-500">
        ${f.avatar
          ? `<img src="${escapeHtml(f.avatar)}" alt="" loading="lazy" class="h-10 w-10 shrink-0 rounded-full object-cover">`
          : `<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg dark:bg-slate-800">🔗</span>`}
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">${escapeHtml(f.name)}</span>
          <span class="block truncate text-xs text-slate-500 dark:text-slate-400">${escapeHtml(f.desc || host)}</span>
        </span>
      </a>`;
  }).join('');
}

async function loadFriends() {
  try {
    renderFriends(await api('/api/friends'));
  } catch (err) {
    const grid = $('#friends-grid');
    if (grid) grid.innerHTML = `<p class="text-sm text-red-500">友链加载失败：${escapeHtml(err.message)}</p>`;
  }
}

function initFriendForm() {
  const form = $('#friend-form');
  if (!form) return;
  let busy = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const status = $('#friend-status');
    const btn = $('#friend-submit');
    busy = true;
    btn.disabled = true;
    status.textContent = '提交中…';
    status.className = 'mt-3 min-h-5 text-sm text-slate-500 dark:text-slate-400';

    try {
      await api('/api/friends', {
        method: 'POST',
        body: {
          name: $('#friend-name').value.trim(),
          url: $('#friend-url').value.trim(),
          avatar: $('#friend-avatar').value.trim(),
          desc: $('#friend-desc').value.trim(),
          turnstile_token: await getTurnstileToken('turnstile-friend'),
        },
      });
      resetTurnstile('turnstile-friend');
      form.reset();
      status.textContent = '申请已提交，等站长审核通过就会显示在这里 👍';
      status.className = 'mt-3 min-h-5 text-sm text-emerald-600';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'mt-3 min-h-5 text-sm text-red-500';
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
}

/* ============================================================
 * 5. GitHub 实时卡片
 * ============================================================ */
async function loadGithubCard() {
  const box = $('#github-card');
  if (!box) return;

  try {
    const d = await api('/api/github');
    if (d.unavailable) {
      box.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">GitHub 数据暂时拿不到，稍后再来看看～</p>';
      return;
    }
    const repos = (d.repos || []).slice(0, 4);

    box.innerHTML = `
      <div class="flex flex-wrap items-center gap-4">
        <img src="${escapeHtml(d.avatar)}" alt="" class="h-14 w-14 rounded-full object-cover">
        <div class="min-w-0 flex-1">
          <a href="${escapeHtml(d.html_url)}" target="_blank" rel="noopener noreferrer"
             class="text-base font-semibold hover:text-blue-600">${escapeHtml(d.name)}</a>
          <p class="text-xs text-slate-500 dark:text-slate-400">@${escapeHtml(d.login)}${d.location ? ' · ' + escapeHtml(d.location) : ''}</p>
          ${d.bio ? `<p class="mt-1 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(d.bio)}</p>` : ''}
        </div>
      </div>
      <div class="mt-4 grid grid-cols-3 gap-3 text-center">
        <div><p class="font-mono text-xl font-bold">${d.public_repos}</p><p class="text-xs text-slate-500 dark:text-slate-400">仓库</p></div>
        <div><p class="font-mono text-xl font-bold">${d.followers}</p><p class="text-xs text-slate-500 dark:text-slate-400">关注者</p></div>
        <div><p class="font-mono text-xl font-bold">${d.following}</p><p class="text-xs text-slate-500 dark:text-slate-400">正在关注</p></div>
      </div>
      ${repos.length ? `
        <div class="mt-4 grid gap-2">
          ${repos.map((r) => `
            <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer"
               class="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 transition hover:border-blue-400 dark:border-slate-700 dark:hover:border-blue-500">
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium">${escapeHtml(r.name)}</span>
                ${r.desc ? `<span class="block truncate text-xs text-slate-500 dark:text-slate-400">${escapeHtml(r.desc)}</span>` : ''}
              </span>
              <span class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">⭐ ${r.stars}</span>
            </a>`).join('')}
        </div>` : ''}
      ${d.stale ? '<p class="mt-3 text-xs text-amber-500">⚠️ 实时数据暂时拿不到，显示的是缓存快照</p>' : ''}`;
  } catch (err) {
    box.innerHTML = `<p class="text-sm text-slate-500 dark:text-slate-400">GitHub 数据暂时拿不到：${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 6. 留言板（含嵌套回复、点赞、分页）
 * ============================================================ */
function likeButton(id, likes, liked, attr) {
  return `
    <button type="button" ${attr}="${id}" data-liked="${liked ? '1' : '0'}" ${liked ? 'disabled' : ''}
            class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition
                   ${liked
                     ? 'cursor-default border-pink-200 bg-pink-50 text-pink-600 dark:border-pink-900 dark:bg-pink-950/50 dark:text-pink-400'
                     : 'border-slate-300 text-slate-500 hover:border-pink-300 hover:text-pink-600 dark:border-slate-700 dark:text-slate-400'}">
      <span aria-hidden="true">${liked ? '❤️' : '🤍'}</span>
      <span class="like-num">${likes || 0}</span>
    </button>`;
}

/**
 * 把 @某人 渲染成可点击的小标签。
 * 注意：传进来的已经是 escapeHtml 之后的内容，所以这里再包一层标签是安全的。
 */
function renderMentions(escapedText) {
  return String(escapedText || '').replace(
    /(^|[\s，,。.!！?？:：])@([^\s@，,。.!！?？:：]{1,20})/g,
    (full, pre, name) =>
      `${pre}<button type="button" data-mention="${name}"
        class="mention-chip inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"
        title="点击跳到 TA 的留言">@${name}</button>`
  );
}

/** 渲染一条留言的内容体（顶层留言和子回复共用） */
/*
 * 留言内容现在是**后端渲染好的 HTML**（worker.js 的 renderMessageHtml）。
 *
 * ⚠️ 外层必须是 <div> 不能是 <p>：
 *    Markdown 会生成 <p> / <ul> / <blockquote> 这些块级元素，
 *    塞进 <p> 里是非法嵌套，浏览器会自动拆掉外层 <p>，排版就散了。
 *
 * `|| renderMentions(...)` 是老数据兜底 —— content_html 是后加的字段，
 * 浏览器缓存的旧响应里可能没有。
 */

function messageBody(m, isReply) {
  return `
    <div class="mb-1.5 flex min-w-0 items-center gap-2">
      ${letterAvatar(m.name, isReply ? 'sm' : '')}
      <span class="min-w-0 flex-1 truncate ${isReply ? 'text-sm' : 'font-medium'}">${escapeHtml(m.name)}</span>
      <time class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(formatTime(m.created_at))}</time>
    </div>
    <div class="message-html text-sm leading-relaxed text-slate-600 dark:text-slate-300">${m.content_html || renderMentions(escapeHtml(m.content))}</div>
    ${m.image_url ? `
      <button type="button" class="lightbox-trigger mt-3 block w-fit cursor-zoom-in" data-src="${escapeHtml(m.image_url)}">
        <img src="${escapeHtml(thumbUrl(m.image_url))}" alt="留言配图" loading="lazy" decoding="async"
             class="${isReply ? 'max-h-40' : 'max-h-64'} w-auto max-w-full rounded-xl border border-slate-200 object-contain transition hover:opacity-90 dark:border-slate-700">
      </button>` : ''}
    ${m.reply ? `
      <div class="mt-3 rounded-xl border-l-4 border-blue-500 bg-blue-50/70 px-3.5 py-2.5 dark:bg-blue-950/40">
        <p class="mb-1 text-xs font-semibold text-blue-700 dark:text-blue-300">
          ↳ 站长回复${m.replied_at ? ` · ${escapeHtml(formatTime(m.replied_at))}` : ''}
        </p>
        <p class="message-content text-sm leading-relaxed text-slate-700 dark:text-slate-200">${escapeHtml(m.reply)}</p>
      </div>` : ''}`;
}

function renderMessages(items, meta) {
  const listEl = $('#messages-list');
  const emptyEl = $('#messages-empty');
  const errEl = $('#messages-error');
  const loadingEl = $('#messages-loading');

  loadingEl.classList.add('hidden');
  errEl.classList.add('hidden');

  const total = meta ? meta.total : items.length;
  $('#message-count').textContent = total ? `（共 ${total} 条）` : '';

  if (!items.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    renderPagination(meta);
    return;
  }
  emptyEl.classList.add('hidden');

  listEl.innerHTML = items.map((m) => {
    const replies = m.replies || [];
    return `
    <li class="animate-fade-up rounded-2xl border border-slate-200 bg-white p-4 shadow-md transition-colors dark:border-slate-800 dark:bg-slate-900"
        data-msg-id="${m.id}" data-author="${escapeHtml(m.name)}">
      ${messageBody(m, false)}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        ${likeButton(m.id, m.likes, likedSet.has(m.id), 'data-like')}
        <button type="button" data-reply-to="${m.id}"
                class="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-500 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-700 dark:text-slate-400">
          💬 回复
        </button>
      </div>

      <div class="reply-box mt-3 hidden">
        <textarea rows="2" maxlength="500" placeholder="回复 ${escapeHtml(m.name)}…"
                  class="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-hidden transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-slate-700 dark:bg-slate-950"></textarea>
        <div class="mt-2 flex gap-2">
          <button type="button" data-reply-send="${m.id}"
                  class="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700">发送回复</button>
          <button type="button" data-reply-cancel="${m.id}"
                  class="rounded-lg border border-slate-300 px-4 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">取消</button>
        </div>
        <p class="reply-status mt-1.5 min-h-4 text-xs"></p>
      </div>

      ${replies.length ? `
      <!-- 回复折叠：用原生 <details>，键盘可达性和无障碍是白送的。
           短线程（<= 2 条）默认展开，长的默认收起。 -->
      <details class="reply-thread mt-3" data-reply-count="${replies.length}" ${replies.length <= 2 ? 'open' : ''}>
        <summary class="reply-summary">
          <span class="chev" aria-hidden="true">▸</span>
          <span>${replies.length} 条回复</span>
        </summary>
        <ul class="mt-2 grid gap-2 border-l-2 border-slate-100 pl-3 dark:border-slate-800">
          ${replies.map((r) => `
            <li class="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50"
                data-msg-id="${r.id}" data-author="${escapeHtml(r.name)}">
              ${messageBody(r, true)}
              <div class="mt-2">${likeButton(r.id, r.likes, likedSet.has(r.id), 'data-like')}</div>
            </li>`).join('')}
        </ul>
      </details>` : ''}
    </li>`;
  }).join('');

  renderPagination(meta);
}

function renderPagination(meta) {
  const el = $('#pagination');
  if (!el) return;

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

  const nums = [];
  const from = Math.max(1, page - 2);
  const to = Math.min(tp, from + 4);
  for (let i = from; i <= to; i++) {
    nums.push(`
      <button type="button" data-page="${i}"
              class="min-w-9 rounded-xl px-3 py-1.5 text-sm font-medium transition
                     ${i === page
                       ? 'bg-blue-600 text-white'
                       : 'border border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'}">${i}</button>`);
  }

  el.innerHTML = `
    ${btn('← 上一页', page - 1, page <= 1)}
    <div class="flex items-center gap-1">${nums.join('')}</div>
    ${btn('下一页 →', page + 1, page >= tp)}
    <span class="ml-1 text-xs text-slate-500 dark:text-slate-400">共 ${total} 条</span>`;
}

async function loadMessages(page) {
  $('#messages-loading').classList.remove('hidden');
  try {
    const data = await api(`/api/messages?page=${page || 1}&size=${PAGE_SIZE}`);
    currentPage = data.page;
    totalPages = data.totalPages;
    renderMessages(Array.isArray(data.items) ? data.items : [], data);
  } catch (err) {
    $('#messages-loading').classList.add('hidden');
    $('#messages-list').innerHTML = '';
    $('#messages-empty').classList.add('hidden');
    const errEl = $('#messages-error');
    errEl.textContent = '留言加载失败：' + err.message;
    errEl.classList.remove('hidden');
  }
}

/* ---------------- 留言表单 ---------------- */
let submitting = false;
let previewUrl = null;

function setFormStatus(text, type) {
  const el = $('#form-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'mt-3 min-h-5 text-sm ' +
    (type === 'error' ? 'text-red-500' : type === 'ok' ? 'text-emerald-600' : 'text-slate-500 dark:text-slate-400');
}

function resetImagePreview() {
  const input = $('#msg-image');
  const box = $('#image-preview');
  if (input) input.value = '';
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
}

function initImagePreview() {
  const input = $('#msg-image');
  const box = $('#image-preview');
  if (!input || !box) return;

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    if (!file) { box.innerHTML = ''; box.classList.add('hidden'); setFormStatus(''); return; }

    // 先做类型和体积校验，不合格直接拒绝，别等到提交才报错
    if (!/^image\//.test(file.type)) {
      setFormStatus('只能上传图片文件', 'error');
      resetImagePreview();
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setFormStatus(`原始图片不能超过 20 MB（当前 ${(file.size / 1024 / 1024).toFixed(1)} MB）`, 'error');
      resetImagePreview();
      return;
    }
    // 大图会在提交时自动压缩，先告诉用户一声，免得看到"变小了"以为传错
    setFormStatus(file.size > 400 * 1024
      ? `这张图 ${(file.size / 1024 / 1024).toFixed(1)} MB，提交时会自动压缩`
      : '');

    previewUrl = URL.createObjectURL(file);
    box.classList.remove('hidden');
    box.innerHTML = `
      <img src="${previewUrl}" alt="预览" class="max-h-40 w-auto max-w-full rounded-xl border border-slate-200 object-contain dark:border-slate-700">
      <button type="button" id="clear-image"
              class="mt-1.5 rounded-lg border border-slate-300 px-3 py-1 text-xs transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">移除</button>`;
  });

  box.addEventListener('click', (e) => {
    if (e.target.id === 'clear-image') resetImagePreview();
  });
}

function initMessageForm() {
  const form = $('#message-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;

    const name = $('#msg-name').value.trim();
    const content = $('#msg-content').value.trim();
    const fileInput = $('#msg-image');
    let file = fileInput && fileInput.files ? fileInput.files[0] : null;
    let result = null;

    if (!name) return setFormStatus('请填写昵称', 'error');
    if (!content) return setFormStatus('请填写留言内容', 'error');

    const btn = $('#submit-btn');
    submitting = true;
    btn.disabled = true;

    try {
      if (file) {
        if (file.size > 20 * 1024 * 1024) throw new Error('原图太大了，请先自己压一下（超过 20 MB）');
        setFormStatus('大图会自动压缩，正在处理…');
        file = await compressImage(file);
        if (file.size > 1024 * 1024) {
          throw new Error(`图片压缩后仍超过 1 MB 上限（${(file.size / 1024 / 1024).toFixed(1)} MB），请换一张更小的`);
        }
        setFormStatus('正在上传…');
        const fd = new FormData();
        fd.append('name', name);
        fd.append('content', content);
        const thumb = await makeThumb(file);
        fd.append('image', file);
        if (thumb) fd.append('thumb', thumb);
        // 人机校验令牌（没启用时是 null，不 append）
        // await 是必须的：重置之后新令牌要等一会儿才生成好，
        // 不等的话用户连续发两条，第二条会因为空令牌被拒。
        const tsTok = await getTurnstileToken('turnstile-msg');
        if (tsTok) fd.append('turnstile_token', tsTok);
        result = await apiUpload('/api/messages', fd);
      } else {
        result = await api('/api/messages', {
          method: 'POST',
          body: { name, content, turnstile_token: await getTurnstileToken('turnstile-msg') },
        });
      }

      // ⚠️ 令牌是一次性的，提交完必须重置。否则用户第二次提交会拿到
      //    已经用过的令牌，Cloudflare 返回 timeout-or-duplicate，
      //    用户看到「校验失败」却完全不知道自己哪里做错了。
      resetTurnstile('turnstile-msg');

      form.reset();
      resetImagePreview();
      await loadMessages(1);

      if (result && result.pending) {
        setFormStatus('留言已提交，等待站长审核后显示 👍', 'ok');
      } else {
        setFormStatus('留言成功！', 'ok');
      }
    } catch (err) {
      setFormStatus(err.message, 'error');
      // 失败也要重置：令牌很可能已经被服务端消费掉了
      resetTurnstile('turnstile-msg');
    } finally {
      submitting = false;
      btn.disabled = false;
    }
  });
}

/* ---------------- 点赞 / 回复 / 分页：统一事件委托 ---------------- */
function initMessageActions() {
  const list = $('#messages-list');
  if (!list) return;

  list.addEventListener('click', async (e) => {
    const t = e.target;

    // —— 点 @某人：跳到 TA 在该页的留言并高亮 ——
    const mention = t.closest('[data-mention]');
    if (mention) {
      const name = mention.dataset.mention;
      const target = Array.from(list.querySelectorAll('[data-author]'))
        .find((el) => el.dataset.author === name);
      if (target) {
        // 目标可能躲在收起的回复里 —— 先把它所在的 details 展开，
        // 否则 scrollIntoView 会滚到一个零高度的隐藏元素上。
        const thread = target.closest('details.reply-thread');
        if (thread && !thread.open) thread.open = true;

        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('ring-2', 'ring-blue-400');
        setTimeout(() => target.classList.remove('ring-2', 'ring-blue-400'), 1600);
      } else {
        // 不提示显得像坏了；给个轻量的反馈
        mention.animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(3px)' },
           { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }],
          { duration: 220 }
        );
      }
      return;
    }

    // —— 点赞（顶层留言和回复共用同一套处理）——
    const likeBtn = t.closest('[data-like]');
    if (likeBtn && likeBtn.dataset.liked !== '1') {
      const id = Number(likeBtn.dataset.like);
      likeBtn.disabled = true;
      try {
        const d = await api(`/api/messages/${id}/like`, { method: 'POST' });
        const num = likeBtn.querySelector('.like-num');
        if (num) num.textContent = d.likes;
        likeBtn.dataset.liked = '1';
        const emoji = likeBtn.querySelector('span[aria-hidden]');
        if (emoji) emoji.textContent = '❤️';
        likedSet.add(id);
        writeIdList(LIKED_KEY, Array.from(likedSet));
      } catch (err) {
        likeBtn.disabled = false;
        console.warn('点赞失败:', err.message);
      }
      return;
    }

    // —— 展开 / 收起回复框 ——
    const replyBtn = t.closest('[data-reply-to]');
    if (replyBtn) {
      const li = replyBtn.closest('li');
      const box = li.querySelector('.reply-box');
      const ta = box.querySelector('textarea');
      const author = li.dataset.author || '';

      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) {
        // 展开时自动带上 @对方，省得手打
        const prefix = `@${author} `;
        if (!ta.value.startsWith('@')) ta.value = prefix + ta.value;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else {
        // 收起时把自动加的 @ 去掉，避免反复展开堆一堆
        if (ta.value.startsWith(`@${author} `)) ta.value = ta.value.slice(author.length + 2);
      }
      return;
    }

    const cancelBtn = t.closest('[data-reply-cancel]');
    if (cancelBtn) {
      cancelBtn.closest('.reply-box').classList.add('hidden');
      return;
    }

    // —— 发送回复（嵌套）——
    const sendBtn = t.closest('[data-reply-send]');
    if (sendBtn) {
      const box = sendBtn.closest('.reply-box');
      const status = box.querySelector('.reply-status');
      const textarea = box.querySelector('textarea');
      const parentId = Number(sendBtn.dataset.replySend);

      // 昵称复用主表单那个输入框，免得用户在两处填
      const nameInput = $('#msg-name');
      const name = nameInput ? nameInput.value.trim() : '';
      const content = textarea.value.trim();

      if (!name) {
        status.textContent = '请先在上面「昵称」里填个名字';
        status.className = 'reply-status mt-1.5 min-h-4 text-xs text-red-500';
        if (nameInput) nameInput.focus();
        return;
      }
      if (!content) {
        status.textContent = '回复内容不能为空';
        status.className = 'reply-status mt-1.5 min-h-4 text-xs text-red-500';
        return;
      }

      sendBtn.disabled = true;
      status.textContent = '发送中…';
      status.className = 'reply-status mt-1.5 min-h-4 text-xs text-slate-500 dark:text-slate-400';
      try {
        await api('/api/messages', { method: 'POST', body: { name, content, parent_id: parentId } });
        await loadMessages(currentPage);
      } catch (err) {
        status.textContent = err.message;
        status.className = 'reply-status mt-1.5 min-h-4 text-xs text-red-500';
        sendBtn.disabled = false;
      }
      return;
    }
  });

  const pager = $('#pagination');
  if (pager) {
    pager.addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      const target = Number(b.dataset.page);
      if (!Number.isInteger(target) || target < 1 || target > totalPages) return;
      loadMessages(target);
      document.getElementById('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

/* ---------------- 说说点赞 ---------------- */
function initPostLikes() {
  const list = $('#posts-list');
  if (!list) return;
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-post-like]');
    if (!btn || btn.dataset.liked === '1') return;
    const id = Number(btn.dataset.postLike);
    btn.disabled = true;
    try {
      const d = await api(`/api/posts/${id}/like`, { method: 'POST' });
      const num = btn.querySelector('.like-num');
      if (num) num.textContent = d.likes;
      btn.dataset.liked = '1';
      const emoji = btn.querySelector('span[aria-hidden]');
      if (emoji) emoji.textContent = '❤️';
      likedPosts.add(id);
      writeIdList(LIKED_POST_KEY, Array.from(likedPosts));
    } catch (err) {
      btn.disabled = false;
      console.warn('点赞失败:', err.message);
    }
  });
}

/* ============================================================
 * 7. 启动
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initHeader();
  initMessageForm();
  initImagePreview();
  initFriendForm();
  initMessageActions();
  initPostLikes();

  reportVisit().then((count) => {
    const el = $('#visit-count');
    if (el && typeof count === 'number') el.textContent = count;
  });

  loadProfile().catch((err) => {
    const el = $('#profile-bio');
    if (el) el.textContent = '资料加载失败：' + err.message;
  });
  initPostsToggle();
  loadPosts();
  loadRecentArticles();
  loadGallery();
  loadFriends();
  loadMessages(1);

  console.log('[app] API_BASE =', API_BASE);
});
