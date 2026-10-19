/* ============================================================
 *  小页面脚本：关于我 + 搜索
 *  文件：frontend/pages.js
 *
 *  两个页面共用这一个文件，靠容器元素是否存在来判断当前是哪个页面。
 * ============================================================ */

/* ============================================================
 * 关于我
 * ============================================================ */
async function initAboutPage() {
  if (!$('#about-body')) return;

  try {
    const [profile, about] = await Promise.all([
      api('/api/profile'),
      api('/api/about'),
    ]);

    const avatar = $('#about-avatar');
    if (avatar && profile.avatar) avatar.src = profile.avatar;
    $('#about-name').textContent = profile.name || '';
    $('#about-tagline').textContent = profile.tagline || '';
    document.title = '关于我 · ' + (profile.name || 'Demo');

    renderContacts($('#contacts'), profile.contacts);

    $('#about-loading').classList.add('hidden');

    if (about.html) {
      // 服务端已转义并渲染，直接插入
      $('#about-body').innerHTML = about.html;
      $('#about-body').querySelectorAll('img').forEach((img) => {
        img.classList.add('cursor-zoom-in', 'rounded-xl', 'my-4');
        img.addEventListener('click', () => openLightbox(img.src));
      });
    } else {
      $('#about-body').innerHTML = `
        <p class="text-slate-500 dark:text-slate-400">
          站长还没写自我介绍。你可以在后台的「站点设置 → 关于我」里用 Markdown 补充内容。
        </p>`;
    }
  } catch (err) {
    $('#about-loading').textContent = '加载失败：' + err.message;
    $('#about-loading').className = 'mt-8 text-sm text-red-500';
  }
}

/* ============================================================
 * 搜索
 * ============================================================ */
function renderSearch(data) {
  const box = $('#search-results');
  const status = $('#search-status');

  if (!data.q) {
    status.textContent = '';
    box.innerHTML = '';
    return;
  }
  if (!data.total) {
    status.textContent = `没有找到和「${data.q}」相关的内容`;
    status.className = 'mt-4 min-h-5 text-sm text-slate-500 dark:text-slate-400';
    box.innerHTML = '';
    return;
  }

  status.textContent = `找到 ${data.total} 条和「${data.q}」相关的内容`;
  status.className = 'mt-4 min-h-5 text-sm text-emerald-600';

  // 把命中的关键词标出来（先转义再替换，避免 XSS）
  const highlight = (text) => {
    const safe = escapeHtml(text || '');
    const needle = escapeHtml(data.q);
    if (!needle) return safe;
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark class="rounded bg-amber-200/70 px-0.5 dark:bg-amber-500/30">${m}</mark>`);
  };

  box.innerHTML = (data.groups || []).map((g) => `
    <section>
      <h2 class="mb-3 flex items-baseline gap-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
        ${escapeHtml(g.label)}
        <span class="font-normal text-slate-500 dark:text-slate-400">${g.items.length} 条</span>
      </h2>
      <ul class="grid gap-2">
        ${g.items.map((it) => `
          <li class="min-w-0">
            <a href="${escapeHtml(it.url)}"
               class="block min-w-0 break-words rounded-2xl border border-slate-200 bg-white p-4 shadow-md transition hover:border-blue-400 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900 dark:hover:border-blue-500">
              ${it.title ? `<p class="text-sm font-medium">${highlight(it.title)}</p>` : ''}
              <p class="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">${highlight(it.snippet)}</p>
              <time class="mt-2 block text-xs text-slate-500 dark:text-slate-400">${escapeHtml(formatTime(it.created_at).slice(0, 10))}</time>
            </a>
          </li>`).join('')}
      </ul>
    </section>`).join('');
}

async function doSearch(q) {
  const btn = $('#search-btn');
  const status = $('#search-status');
  if (!q) {
    status.textContent = '请输入关键词';
    status.className = 'mt-4 min-h-5 text-sm text-red-500';
    return;
  }

  btn.disabled = true;
  status.textContent = '搜索中…';
  status.className = 'mt-4 min-h-5 text-sm text-slate-500 dark:text-slate-400';

  try {
    renderSearch(await api('/api/search?q=' + encodeURIComponent(q)));
    // 把关键词写进地址栏，方便分享/收藏
    history.replaceState(null, '', 'search?q=' + encodeURIComponent(q));
  } catch (err) {
    status.textContent = '搜索失败：' + err.message;
    status.className = 'mt-4 min-h-5 text-sm text-red-500';
  } finally {
    btn.disabled = false;
  }
}

function initSearchPage() {
  const form = $('#search-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    doSearch($('#search-input').value.trim().slice(0, 40));
  });

  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    $('#search-input').value = q;
    doSearch(q.slice(0, 40));
  }
}


/* ============================================================
 * 归档页
 * ============================================================ */
async function initArchivePage() {
  const box = document.querySelector('#archive-list');
  if (!box) return;

  try {
    const d = await api('/api/archive');
    const status = document.querySelector('#archive-status');

    if (!d.years.length) {
      box.innerHTML = '';
      if (status) status.textContent = '还没有文章。';
      return;
    }
    if (status) status.textContent = `共 ${d.total} 篇文章，跨 ${d.years.length} 个年份`;

    box.innerHTML = d.years.map((y) => `
      <section class="mt-10 first:mt-0">
        <h2 class="flex items-baseline gap-3 text-xl font-bold">
          ${escapeHtml(y.year)}
          <span class="text-sm font-normal text-slate-500 dark:text-slate-400">${y.count} 篇</span>
        </h2>
        ${y.months.map((m) => `
          <div class="mt-5">
            <h3 class="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
              ${escapeHtml(y.year)}-${escapeHtml(m.month)}
              <span class="ml-1 font-normal text-slate-500 dark:text-slate-400">${m.count} 篇</span>
            </h3>
            <ul class="grid gap-1.5 border-l-2 border-slate-100 pl-4 dark:border-slate-800">
              ${m.items.map((it) => `
                <!-- ⚠️ li 上必须有 min-w-0：它是 grid 子项，默认 min-width:auto，
                     不会收缩到内容宽度以下。里面那个 truncate 的链接设了
                     white-space:nowrap，会把整行撑破 → 手机上出现横向滚动。 -->
                <li class="flex min-w-0 items-baseline gap-3">
                  <time class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(String(it.created_at).slice(5, 10))}</time>
                  <a href="articles?slug=${encodeURIComponent(it.slug)}"
                     class="min-w-0 truncate text-sm transition hover:text-blue-600 dark:hover:text-blue-400">${escapeHtml(it.title)}</a>
                  <span class="ml-auto shrink-0 text-xs text-slate-300 dark:text-slate-600">${it.views}</span>
                </li>`).join('')}
            </ul>
          </div>`).join('')}
      </section>`).join('');
  } catch (err) {
    box.innerHTML = `<p class="text-sm text-red-500">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 标签页
 * ============================================================ */
async function initTagsPage() {
  const box = document.querySelector('#tags-cloud');
  if (!box) return;

  try {
    const d = await api('/api/tags');
    const status = document.querySelector('#tags-status');

    if (!d.items.length) {
      box.innerHTML = '';
      if (status) status.textContent = '还没有任何标签。';
      return;
    }
    if (status) status.textContent = `共 ${d.total} 个标签`;

    const max = Math.max(...d.items.map((t) => t.count));
    box.innerHTML = d.items.map((t) => {
      // 按出现次数分三档字号，一眼看出哪些是主要话题
      const size = t.count === max && max > 1 ? 'text-lg' : t.count > 1 ? 'text-base' : 'text-sm';
      return `<a href="articles?tag=${encodeURIComponent(t.name)}"
        class="${size} inline-flex items-baseline gap-1.5 rounded-full border border-slate-300 bg-white px-3.5 py-1.5 font-medium transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-blue-500 dark:hover:text-blue-400">
        ${escapeHtml(t.name)}
        <span class="text-xs font-normal text-slate-500 dark:text-slate-400">${t.count}</span>
      </a>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<p class="text-sm text-red-500">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 网站地图（给人看的）
 * ============================================================ */
async function initSiteMapPage() {
  const box = document.querySelector('#sitemap-content');
  if (!box) return;

  try {
    const d = await api('/api/site-map');
    const link = (href, text, extra = '') =>
      `<a href="${escapeHtml(href)}" class="transition hover:text-blue-600 dark:hover:text-blue-400">${escapeHtml(text)}</a>${extra}`;

    box.innerHTML = `
      <section>
        <h2 class="mb-3 text-lg font-semibold">页面</h2>
        <ul class="grid gap-2 sm:grid-cols-2">
          ${d.pages.map((p) => `
            <li class="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              ${link(p.path, p.title)}
              <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">${escapeHtml(p.desc)}</span>
            </li>`).join('')}
        </ul>
      </section>

      ${d.articles.length ? `
      <section class="mt-10">
        <h2 class="mb-3 text-lg font-semibold">文章 <span class="text-sm font-normal text-slate-500 dark:text-slate-400">${d.articles.length} 篇</span></h2>
        <ul class="grid gap-1.5">
          ${d.articles.map((a) => `
            <li class="flex min-w-0 items-baseline gap-3 text-sm">
              <time class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(String(a.created_at).slice(0, 10))}</time>
              ${link('articles?slug=' + encodeURIComponent(a.slug), a.title)}
            </li>`).join('')}
        </ul>
      </section>` : ''}

      ${d.tags.length ? `
      <section class="mt-10">
        <h2 class="mb-3 text-lg font-semibold">标签</h2>
        <div class="flex flex-wrap gap-2">
          ${d.tags.map((t) => `<a href="articles?tag=${encodeURIComponent(t.name)}"
            class="rounded-full border border-slate-300 px-3 py-1 text-sm transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-700 dark:hover:border-blue-500 dark:hover:text-blue-400">
            ${escapeHtml(t.name)} <span class="text-xs text-slate-500 dark:text-slate-400">${t.count}</span></a>`).join('')}
        </div>
      </section>` : ''}

      ${d.posts.length ? `
      <section class="mt-10">
        <h2 class="mb-3 text-lg font-semibold">说说 <span class="text-sm font-normal text-slate-500 dark:text-slate-400">最近 ${d.posts.length} 条</span></h2>
        <ul class="grid gap-1.5">
          ${d.posts.map((p) => `
            <li class="flex min-w-0 items-baseline gap-3 text-sm">
              <time class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(String(p.created_at).slice(0, 10))}</time>
              ${link('/#moments', p.excerpt)}
            </li>`).join('')}
        </ul>
      </section>` : ''}

      ${d.friends.length ? `
      <section class="mt-10">
        <h2 class="mb-3 text-lg font-semibold">友链</h2>
        <ul class="grid gap-1.5 sm:grid-cols-2">
          ${d.friends.map((f) => `
            <li class="text-sm">
              ${link(f.url, f.name)}
              ${f.desc ? `<span class="ml-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(f.desc)}</span>` : ''}
            </li>`).join('')}
        </ul>
      </section>` : ''}

      <section class="mt-10">
        <h2 class="mb-3 text-lg font-semibold">订阅</h2>
        <ul class="grid gap-1.5 sm:grid-cols-2">
          ${d.feeds.map((f) => `<li class="text-sm">${link(f.url, f.title)}</li>`).join('')}
        </ul>
        <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">
          这是给人看的版本。给搜索引擎的 XML 版本在
          ${link('/sitemap.xml', '/sitemap.xml')}。
        </p>
      </section>`;
  } catch (err) {
    box.innerHTML = `<p class="text-sm text-red-500">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * Now 页面
 * ============================================================ */
async function initNowPage() {
  const body = document.querySelector('#now-body');
  if (!body) return;

  try {
    const d = await api('/api/now');
    const loading = document.querySelector('#now-loading');
    if (loading) loading.classList.add('hidden');

    const stamp = document.querySelector('#now-updated');
    if (stamp && d.updated_at) stamp.textContent = '更新于 ' + d.updated_at;

    if (d.html) {
      body.innerHTML = d.html;
      body.querySelectorAll('img').forEach((img) => {
        img.classList.add('cursor-zoom-in', 'rounded-xl', 'my-4');
        img.addEventListener('click', () => openLightbox(img.src));
      });
    } else {
      body.innerHTML = `
        <p class="text-slate-500 dark:text-slate-400">
          站长还没写这一页。你可以在后台的「站点设置 → Now 页面」里用 Markdown 补充。
        </p>`;
    }
  } catch (err) {
    body.innerHTML = `<p class="text-sm text-red-500">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 启动
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initHeader();
  initAboutPage();
  initSearchPage();
  initArchivePage();
  initTagsPage();
  initSiteMapPage();
  initNowPage();
  console.log('[pages] API_BASE =', API_BASE);
});
