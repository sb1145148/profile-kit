/* ============================================================
 *  后台：说说 / 文章 / 友链
 *  文件：frontend/admin-content.js
 *
 *  依赖 admin.js 里已经定义的全局：api / escapeHtml / setStatus / getToken ...
 *  （用普通 <script> 加载，共享全局作用域）
 * ============================================================ */

/* ============================================================
 * 说说
 * ============================================================ */
async function loadPostsAdmin() {
  const ul = document.querySelector('#admin-posts');
  if (!ul) return;
  try {
    const d = await api('/api/admin/posts?size=50');
    document.querySelector('#posts-loading').classList.add('hidden');
    const items = d.items || [];
    if (!items.length) {
      ul.innerHTML = '<li class="text-sm text-slate-500 dark:text-slate-400">还没有说说。</li>';
      return;
    }
    ul.innerHTML = items.map((p) => `
      <li class="rounded-xl border border-slate-200 p-3 dark:border-slate-800" data-post-row="${p.id}">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span class="font-mono">#${p.id}</span>
              <time>${escapeHtml(p.created_at)}</time>
              ${p.status === 'pending'
                ? '<span class="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-950 dark:text-amber-300">待审核</span>'
                : '<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">已通过</span>'}
              <span>❤️ ${p.likes || 0}</span>
            </div>
            <p class="message-content mt-1 text-sm text-slate-600 dark:text-slate-300">${escapeHtml(p.content)}</p>
            ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" class="mt-2 max-h-24 rounded-lg border border-slate-200 dark:border-slate-700">` : ''}
          </div>
          <div class="flex shrink-0 gap-1.5">
            ${p.status === 'pending'
              ? `<button type="button" data-post-approve="${p.id}" class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700">通过</button>`
              : `<button type="button" data-post-unapprove="${p.id}" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">撤下</button>`}
            <button type="button" data-post-del="${p.id}" class="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">删除</button>
          </div>
        </div>
      </li>`).join('');
  } catch (err) {
    document.querySelector('#posts-loading').textContent = '加载失败：' + err.message;
  }
}

function initPostsAdmin() {
  const form = document.querySelector('#post-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.querySelector('#post-save');
    const status = document.querySelector('#post-status');
    const text = document.querySelector('#post-content').value.trim();
    if (!text) return;

    btn.disabled = true;
    status.textContent = '发布中…';
    status.className = 'text-sm text-slate-500 dark:text-slate-400';

    try {
      let file = document.querySelector('#post-image').files[0];
      const fd = new FormData();
      fd.append('content', text);
      if (document.querySelector('#post-pending').checked) fd.append('status', 'pending');
      if (file) {
        file = await compressImage(file);
        if (file.size > 1024 * 1024) throw new Error('图片压缩后仍超过 1 MB');
        const thumb = await makeThumb(file);
        fd.append('image', file);
        if (thumb) fd.append('thumb', thumb);
      }
      await apiUpload('/api/admin/posts', fd);
      form.reset();
      status.textContent = '已发布 ✅';
      status.className = 'text-sm text-emerald-600';
      await Promise.all([loadPostsAdmin(), loadOverview()]);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'text-sm text-red-500';
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelector('#admin-posts').addEventListener('click', async (e) => {
    const t = e.target;

    const ap = t.closest('[data-post-approve]');
    if (ap) {
      try {
        await api(`/api/admin/posts/${ap.dataset.postApprove}/approve`, { method: 'POST', body: { approve: true } });
        setStatus('说说已通过', 'ok');
        await Promise.all([loadPostsAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
      return;
    }

    const un = t.closest('[data-post-unapprove]');
    if (un) {
      try {
        await api(`/api/admin/posts/${un.dataset.postUnapprove}/approve`, { method: 'POST', body: { approve: false } });
        setStatus('说说已撤下', 'ok');
        await Promise.all([loadPostsAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
      return;
    }

    const del = t.closest('[data-post-del]');
    if (del) {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = '确认删除？';
        setTimeout(() => { if (del.isConnected) { del.dataset.confirm = ''; del.textContent = '删除'; } }, 4000);
        return;
      }
      try {
        await api('/api/admin/posts/' + del.dataset.postDel, { method: 'DELETE' });
        setStatus('说说已删除', 'ok');
        await Promise.all([loadPostsAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
    }
  });
}

/* ============================================================
 * 文章
 * ============================================================ */
async function loadArticlesAdmin() {
  const ul = document.querySelector('#admin-articles');
  if (!ul) return;

  try {
    const d = await api('/api/admin/articles');
    const items = d.items || [];
    if (!items.length) {
      ul.innerHTML = '<li class="text-sm text-slate-500 dark:text-slate-400">还没有文章，点右上角「写新文章」。</li>';
      return;
    }
    ul.innerHTML = items.map((a) => `
      <li class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <div class="min-w-0 flex-1">
          <p class="flex min-w-0 items-center gap-2 truncate font-medium">
            ${a.pinned ? '<span class="text-amber-500">📌</span>' : ''}
            <span class="min-w-0 truncate">${escapeHtml(a.title)}</span>
            ${a.status === 'draft'
              ? '<span class="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300">草稿</span>'
              : ''}
          </p>
          <p class="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
            /articles?slug=${escapeHtml(a.slug)} · ${a.views} 次阅读
            ${(a.tags || []).length ? ' · ' + a.tags.map((t) => escapeHtml(t)).join(' / ') : ''}
          </p>
        </div>
        <div class="flex shrink-0 gap-1.5">
          <a href="${a.status === 'published' ? `articles?slug=${encodeURIComponent(a.slug)}` : '#'}"
             ${a.status === 'published' ? 'target="_blank"' : 'data-disabled="1"'}
             class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">查看</a>
          <button type="button" data-art-edit="${a.id}" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">编辑</button>
          <button type="button" data-art-del="${a.id}" class="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">删除</button>
        </div>
      </li>`).join('');
  } catch (err) {
    ul.innerHTML = `<li class="text-sm text-red-500">加载失败：${escapeHtml(err.message)}</li>`;
  }
}

/** 更新封面预览区 */
function renderCover(url) {
  const img = document.querySelector('#cover-preview');
  const empty = document.querySelector('#cover-empty');
  const rm = document.querySelector('#cover-remove');
  const file = document.querySelector('#article-cover-file');
  if (!img) return;

  if (url) {
    img.src = url;
    img.classList.remove('hidden');
    empty.classList.add('hidden');
    rm.hidden = false;
  } else {
    img.removeAttribute('src');
    img.classList.add('hidden');
    empty.classList.remove('hidden');
    rm.hidden = true;
  }
  // 没保存过的文章挂不上封面，先禁用
  const hasId = !!document.querySelector('#article-id').value;
  if (file) file.disabled = !hasId;
  if (rm) rm.disabled = !hasId;
}

function setCoverStatus(text, type) {
  const el = document.querySelector('#cover-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'mt-2 min-h-4 text-xs ' +
    (type === 'error' ? 'text-red-500' : type === 'ok' ? 'text-emerald-600' : 'text-slate-500 dark:text-slate-400');
}

async function uploadCover(file) {
  const id = Number(document.querySelector('#article-id').value) || 0;
  if (!id) return setCoverStatus('请先保存文章，再上传封面', 'error');
  if (!file) return;

  setCoverStatus('压缩并上传中…');
  try {
    let f = await compressImage(file);
    if (f.size > 1024 * 1024) throw new Error(`压缩后仍有 ${(f.size / 1024 / 1024).toFixed(1)} MB，请换一张`);

    const fd = new FormData();
    const thumb = await makeThumb(f);
    fd.append('image', f);
    if (thumb) fd.append('thumb', thumb);
    const d = await apiUpload(`/api/admin/articles/${id}/cover`, fd);

    renderCover(d.cover_url);
    setCoverStatus('封面已更新 ✅', 'ok');
    await loadArticlesAdmin();
  } catch (err) {
    setCoverStatus(err.message, 'error');
  } finally {
    const input = document.querySelector('#article-cover-file');
    if (input) input.value = '';
  }
}

function initCover() {
  const input = document.querySelector('#article-cover-file');
  if (!input) return;
  input.addEventListener('change', () => uploadCover(input.files && input.files[0]));

  document.querySelector('#cover-remove').addEventListener('click', async () => {
    const id = Number(document.querySelector('#article-id').value) || 0;
    if (!id) return;
    if (!confirm('移除封面吗？（图片会被一起删除）')) return;
    try {
      await api(`/api/admin/articles/${id}/cover`, { method: 'DELETE' });
      renderCover(null);
      setCoverStatus('封面已移除', 'ok');
      await loadArticlesAdmin();
    } catch (err) {
      setCoverStatus(err.message, 'error');
    }
  });
}

function resetArticleForm() {
  document.querySelector('#article-form').reset();
  document.querySelector('#article-id').value = '';
  document.querySelector('#article-status').checked = true;
  document.querySelector('#article-pinned').checked = false;
  document.querySelector('#article-msg').textContent = '';
  document.querySelector('#article-preview-box').classList.add('hidden');
  renderCover(null);
  setCoverStatus('保存后才能上传封面');
}

function openArticleEditor() {
  resetArticleForm();
  const form = document.querySelector('#article-form');
  form.classList.remove('hidden');
  document.querySelector('#article-title').focus();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function editArticle(id) {
  try {
    const a = await api('/api/admin/articles/' + id);
    document.querySelector('#article-id').value = a.id;
    document.querySelector('#article-title').value = a.title;
    document.querySelector('#article-slug').value = a.slug;
    document.querySelector('#article-summary').value = a.summary || '';
    document.querySelector('#article-tags').value = a.tags || '';
    document.querySelector('#article-content').value = a.content;
    document.querySelector('#article-status').checked = a.status === 'published';
    document.querySelector('#article-pinned').checked = !!a.pinned;
    document.querySelector('#article-msg').textContent = '';
    renderCover(a.cover_url);
    setCoverStatus(a.cover_url ? '' : '还没有封面');
    const form = document.querySelector('#article-form');
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/** 本地预览：调接口让服务端渲染，保证和最终效果一致 */
async function previewArticle() {
  const content = document.querySelector('#article-content').value;
  const box = document.querySelector('#article-preview-box');
  if (!content.trim()) { box.textContent = '正文是空的'; box.classList.remove('hidden'); return; }

  box.classList.remove('hidden');
  box.innerHTML = '<p class="text-sm text-slate-500 dark:text-slate-400">渲染中…</p>';
  try {
    // 借用搜索接口的渲染不方便，直接临时存成草稿再取回太啰嗦 ——
    // 这里用 /api/admin/articles 的预览能力：先看有没有专门的接口
    const r = await fetch(API_BASE + '/api/admin/article-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ content }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || '预览失败');
    box.innerHTML = j.data.html || '<p>（空）</p>';
  } catch (err) {
    box.innerHTML = `<p class="text-sm text-red-500">${escapeHtml(err.message)}</p>`;
  }
}

function initArticlesAdmin() {
  const form = document.querySelector('#article-form');
  if (!form) return;

  document.querySelector('#article-new').addEventListener('click', openArticleEditor);
  document.querySelector('#article-cancel').addEventListener('click', () => {
    form.classList.add('hidden');
    resetArticleForm();
  });
  document.querySelector('#article-preview').addEventListener('click', previewArticle);
  initCover();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.querySelector('#article-save');
    const msg = document.querySelector('#article-msg');
    btn.disabled = true;
    msg.textContent = '保存中…';
    msg.className = 'text-sm text-slate-500 dark:text-slate-400';

    try {
      const body = {
        id: Number(document.querySelector('#article-id').value) || 0,
        title: document.querySelector('#article-title').value.trim(),
        slug: document.querySelector('#article-slug').value.trim(),
        summary: document.querySelector('#article-summary').value.trim(),
        tags: document.querySelector('#article-tags').value.trim(),
        content: document.querySelector('#article-content').value,
        status: document.querySelector('#article-status').checked ? 'published' : 'draft',
        pinned: document.querySelector('#article-pinned').checked,
      };
      const d = await api('/api/admin/articles', { method: 'POST', body });
      document.querySelector('#article-id').value = d.id;
      document.querySelector('#article-slug').value = d.slug;
      renderCover(document.querySelector('#cover-preview').getAttribute('src') || null);
      setCoverStatus('已保存，现在可以上传封面了');
      msg.textContent = '已保存 ✅';
      msg.className = 'text-sm text-emerald-600';
      await Promise.all([loadArticlesAdmin(), loadOverview()]);
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'text-sm text-red-500';
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelector('#admin-articles').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-art-edit]');
    if (ed) return editArticle(Number(ed.dataset.artEdit));

    const del = e.target.closest('[data-art-del]');
    if (del) {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = '确认删除？';
        setTimeout(() => { if (del.isConnected) { del.dataset.confirm = ''; del.textContent = '删除'; } }, 4000);
        return;
      }
      try {
        await api('/api/admin/articles/' + del.dataset.artDel, { method: 'DELETE' });
        setStatus('文章已删除', 'ok');
        await Promise.all([loadArticlesAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
    }
  });
}

/* ============================================================
 * 友链
 * ============================================================ */
let friendFilter = 'all';

async function loadFriendsAdmin() {
  const ul = document.querySelector('#admin-friends');
  if (!ul) return;

  try {
    const d = await api('/api/admin/friends?status=' + friendFilter);
    document.querySelector('#friends-loading').classList.add('hidden');
    const items = d.items || [];
    if (!items.length) {
      ul.innerHTML = '<li class="text-sm text-slate-500 dark:text-slate-400">没有符合条件的友链。</li>';
      return;
    }
    ul.innerHTML = items.map((f) => `
      <li class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <div class="flex min-w-0 flex-1 items-center gap-3">
          ${f.avatar ? `<img src="${escapeHtml(f.avatar)}" alt="" class="h-9 w-9 shrink-0 rounded-full object-cover">` : '<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">🔗</span>'}
          <div class="min-w-0">
            <p class="flex min-w-0 items-center gap-2 truncate font-medium">
              ${escapeHtml(f.name)}
              ${f.status === 'pending'
                ? '<span class="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">待审核</span>'
                : f.status === 'rejected'
                  ? '<span class="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">已拒绝</span>'
                  : '<span class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">已通过</span>'}
            </p>
            <p class="truncate text-xs text-slate-500 dark:text-slate-400">
              <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" class="hover:text-blue-500">${escapeHtml(f.url)}</a>
              ${f.desc ? ' · ' + escapeHtml(f.desc) : ''} · 权重 ${f.sort}
            </p>
          </div>
        </div>
        <div class="flex shrink-0 gap-1.5">
          ${f.status !== 'approved' ? `<button type="button" data-f-approve="${f.id}" class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700">通过</button>` : ''}
          ${f.status !== 'rejected' ? `<button type="button" data-f-reject="${f.id}" class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">拒绝</button>` : ''}
          <button type="button" data-f-del="${f.id}" class="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">删除</button>
        </div>
      </li>`).join('');
  } catch (err) {
    document.querySelector('#friends-loading').textContent = '加载失败：' + err.message;
  }
}

function initFriendsAdmin() {
  const ul = document.querySelector('#admin-friends');
  if (!ul) return;

  document.querySelectorAll('.ffilter-btn').forEach((b) => {
    b.addEventListener('click', () => {
      friendFilter = b.dataset.ffilter;
      document.querySelectorAll('.ffilter-btn').forEach((x) => {
        const on = x.dataset.ffilter === friendFilter;
        x.className = 'ffilter-btn rounded-xl px-4 py-1.5 text-sm font-medium transition ' +
          (on ? 'bg-blue-600 text-white border border-blue-600'
              : 'border border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800');
      });
      loadFriendsAdmin();
    });
  });

  ul.addEventListener('click', async (e) => {
    const t = e.target;

    const ap = t.closest('[data-f-approve]');
    if (ap) {
      try {
        await api(`/api/admin/friends/${ap.dataset.fApprove}/approve`, { method: 'POST', body: { approve: true } });
        setStatus('友链已通过', 'ok');
        await Promise.all([loadFriendsAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
      return;
    }

    const rj = t.closest('[data-f-reject]');
    if (rj) {
      try {
        await api(`/api/admin/friends/${rj.dataset.fReject}/reject`, { method: 'POST' });
        setStatus('友链已拒绝', 'ok');
        await Promise.all([loadFriendsAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
      return;
    }

    const del = t.closest('[data-f-del]');
    if (del) {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = '确认删除？';
        setTimeout(() => { if (del.isConnected) { del.dataset.confirm = ''; del.textContent = '删除'; } }, 4000);
        return;
      }
      try {
        await api('/api/admin/friends/' + del.dataset.fDel, { method: 'DELETE' });
        setStatus('友链已删除', 'ok');
        await Promise.all([loadFriendsAdmin(), loadOverview()]);
      } catch (err) { setStatus(err.message, 'error'); }
    }
  });
}

/* ============================================================
 * 更新日志（后台）
 * ============================================================ */

async function loadChangelogAdmin() {
  const list = document.querySelector('#admin-changelog');
  if (!list) return;

  try {
    const rows = await api('/api/admin/changelog');
    if (!rows || !rows.length) {
      list.innerHTML = '<li class="text-sm text-slate-500 dark:text-slate-400">还没有更新记录，点右上角「写一条」。</li>';
      return;
    }

    list.innerHTML = rows.map((r) => `
      <li class="flex min-w-0 flex-wrap items-start gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <time class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(r.entry_date)}</time>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">${escapeHtml(r.title)}</span>
        <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">${(r.content || '').length} 字</span>
        <button type="button" data-cl-edit="${r.id}"
                class="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">编辑</button>
        <button type="button" data-cl-del="${r.id}"
                class="shrink-0 rounded-lg border border-red-300 px-2.5 py-1 text-xs text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40">删除</button>
      </li>`).join('');

    // 缓存一份，编辑时直接用，免得再请求
    changelogCache = rows;
  } catch (err) {
    list.innerHTML = `<li class="text-sm text-red-500">加载失败：${escapeHtml(err.message)}</li>`;
  }
}

let changelogCache = [];

function resetChangelogForm() {
  document.querySelector('#changelog-id').value = '';
  document.querySelector('#changelog-date').value = new Date().toISOString().slice(0, 10);
  document.querySelector('#changelog-title').value = '';
  document.querySelector('#changelog-content').value = '';
  document.querySelector('#changelog-status').textContent = '';
}

function openChangelogEditor(row) {
  const form = document.querySelector('#changelog-form');
  form.classList.remove('hidden');

  if (row) {
    document.querySelector('#changelog-id').value = row.id;
    document.querySelector('#changelog-date').value = row.entry_date;
    document.querySelector('#changelog-title').value = row.title;
    document.querySelector('#changelog-content').value = row.content || '';
  } else {
    resetChangelogForm();
  }

  document.querySelector('#changelog-status').textContent = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function initChangelogAdmin() {
  const form = document.querySelector('#changelog-form');
  if (!form) return;

  document.querySelector('#changelog-new').addEventListener('click', () => openChangelogEditor(null));

  document.querySelector('#changelog-cancel').addEventListener('click', () => {
    form.classList.add('hidden');
    resetChangelogForm();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const msg = document.querySelector('#changelog-status');
    btn.disabled = true;
    msg.textContent = '保存中…';
    msg.className = 'text-sm text-slate-500 dark:text-slate-400';

    try {
      await api('/api/admin/changelog', {
        method: 'POST',
        body: {
          id: Number(document.querySelector('#changelog-id').value) || 0,
          date: document.querySelector('#changelog-date').value,
          title: document.querySelector('#changelog-title').value.trim(),
          content: document.querySelector('#changelog-content').value,
        },
      });
      msg.textContent = '已保存 ✅';
      msg.className = 'text-sm text-emerald-600';
      form.classList.add('hidden');
      resetChangelogForm();
      await loadChangelogAdmin();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'text-sm text-red-500';
    } finally {
      btn.disabled = false;
    }
  });

  // 列表上的编辑 / 删除（事件委托）
  document.querySelector('#admin-changelog').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-cl-edit]');
    const delBtn = e.target.closest('[data-cl-del]');

    if (editBtn) {
      const id = Number(editBtn.dataset.clEdit);
      const row = changelogCache.find((r) => r.id === id);
      if (row) openChangelogEditor(row);
      return;
    }

    if (delBtn) {
      const id = Number(delBtn.dataset.clDel);
      const row = changelogCache.find((r) => r.id === id);
      const label = row ? `${row.entry_date} ${row.title}` : `#${id}`;
      if (!confirm(`确定删除这条更新记录吗？\n\n${label}\n\n删了之后就找不回来了。`)) return;

      try {
        await api('/api/admin/changelog/' + id, { method: 'DELETE' });
        await loadChangelogAdmin();
      } catch (err) {
        alert('删除失败：' + err.message);
      }
    }
  });

  resetChangelogForm();
  // ⚠️ 这里**不能**调 loadChangelogAdmin()。
  //    initChangelogAdmin 是在 DOMContentLoaded 跑的，那时用户还没登录，
  //    请求会因为没令牌直接 401，页面上就显示「登录已过期」——
  //    而用户其实刚打开页面，看着莫名其妙。
  //    真正的加载挂在 admin.js 的 refreshAll() 里（登录成功后统一拉）。
}
