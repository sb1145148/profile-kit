/* ============================================================
 *  后台：访问来源 / 垃圾词 / 自动备份 / 操作日志 / 关于我
 *  文件：frontend/admin-system.js
 *
 *  依赖 admin.js 里已定义的全局：api / escapeHtml / setStatus / getToken ...
 * ============================================================ */

/* ============================================================
 * 访问来源
 * ============================================================ */
async function loadRefs() {
  const box = document.querySelector('#refs-chart');
  if (!box) return;

  try {
    const d = await api('/api/admin/refs?days=30');
    const empty = document.querySelector('#refs-empty');

    if (!d.byRef || !d.byRef.length) {
      if (empty) empty.classList.remove('hidden');
      box.innerHTML = '';
      document.querySelector('#refs-note').textContent = '';
      return;
    }
    if (empty) empty.classList.add('hidden');

    const max = Math.max(1, ...d.byRef.map((r) => r.count));
    box.innerHTML = `
      <ul class="grid gap-2">
        ${d.byRef.slice(0, 10).map((r) => `
          <li>
            <div class="flex items-baseline justify-between gap-2 text-sm">
              <span class="min-w-0 truncate">${escapeHtml(r.ref)}</span>
              <span class="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">${r.count}</span>
            </div>
            <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div class="h-full rounded-full bg-blue-500" style="width:${((r.count / max) * 100).toFixed(1)}%"></div>
            </div>
          </li>`).join('')}
      </ul>`;

    document.querySelector('#refs-note').textContent =
      `最近 ${d.days} 天共 ${d.total} 次访问，来自 ${d.byRef.length} 个来源。数据从开启后开始记录。`;
  } catch (err) {
    box.innerHTML = `<p class="text-sm text-red-500">${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
 * 垃圾词
 * ============================================================ */
async function loadWords() {
  const ul = document.querySelector('#word-list');
  if (!ul) return;
  try {
    const d = await api('/api/admin/blocked-words');
    const items = d.items || [];
    if (!items.length) {
      ul.innerHTML = '<li class="text-xs text-slate-500 dark:text-slate-400">还没有屏蔽词。</li>';
      return;
    }
    ul.innerHTML = items.map((w) => `
      <li class="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-3 py-1 text-xs dark:border-slate-700">
        <span>${escapeHtml(w.word)}</span>
        <button type="button" data-word-del="${w.id}" aria-label="删除"
                class="text-slate-500 dark:text-slate-400 transition hover:text-red-500">✕</button>
      </li>`).join('');
  } catch (err) {
    ul.innerHTML = `<li class="text-xs text-red-500">${escapeHtml(err.message)}</li>`;
  }
}

/* ============================================================
 * 自动备份
 * ============================================================ */
/** 图片备份状态：库里几张、仓库几个文件 */
async function loadImagesStatus() {
  const el = document.querySelector('#images-status');
  if (!el) return;
  try {
    const d = await api('/api/admin/images-status');

    if (d.error) {
      el.innerHTML = `<span class="text-amber-500">⚠️ ${escapeHtml(d.error)}</span>`;
      return;
    }
    if (!d.repo || !d.hasToken) {
      el.textContent = '配置好备份仓库和 GH_TOKEN 之后，图片会自动备份到 ' + (d.path || 'backup/images') + '/';
      return;
    }

    const bits = [
      `库里 <b>${d.inDb}</b> 张（${(d.dbBytes / 1024 / 1024).toFixed(2)} MB）`,
      `仓库 <b>${d.inRepo ?? '?'}</b> 个文件`,
    ];
    if (d.missing > 0) {
      bits.push(`<span class="text-amber-500">有 ${d.missing} 张还没备份上，下次备份会补</span>`);
    } else if (d.inRepo !== null && d.inRepo >= d.inDb) {
      bits.push('<span class="text-emerald-600 dark:text-emerald-400">已全部备份 ✅</span>');
    }
    if (d.restorable > 0) {
      bits.push(`<span class="text-blue-500">仓库里有 ${d.restorable} 张库里没有，可以补回来</span>`);
    }
    el.innerHTML = bits.join(' · ');
  } catch (err) {
    el.textContent = '加载失败：' + err.message;
  }
}


async function loadBackup() {
  const el = document.querySelector('#backup-status');
  if (!el) return;
  try {
    const d = await api('/api/admin/backup');
    document.querySelector('#backup-enabled').checked = !!d.enabled;
    document.querySelector('#backup-repo').value = d.repo || '';
    document.querySelector('#backup-path').value = d.path || 'backup';

    const bits = [];
    if (!d.hasToken) bits.push('<span class="text-amber-500">⚠️ 还没有配置 GH_TOKEN 密钥</span>');
    if (d.lastAt) bits.push(`上次：${escapeHtml(d.lastAt)}`);
    if (d.lastResult) bits.push(escapeHtml(d.lastResult));
    el.innerHTML = bits.length ? bits.join(' · ') : '还没有执行过备份。';

    const pv = document.querySelector('#backup-preview');
    if (pv && d.preview) {
      pv.textContent = `本次会备份：留言 ${d.preview.counts.messages} · 说说 ${d.preview.counts.posts} · ` +
        `文章 ${d.preview.counts.articles} · 友链 ${d.preview.counts.friends} · 作品 ${d.preview.counts.gallery} · ` +
        `图片 ${d.preview.counts.images ?? 0} 张 ` +
        `（约 ${(d.preview.bytes / 1024).toFixed(1)} KB，图片另存不占这份体积）`;
    }
  } catch (err) {
    el.textContent = '加载失败：' + err.message;
  }
}

/* ============================================================
 * 操作日志
 * ============================================================ */
let auditPage = 1;
let auditTotalPages = 1;

async function loadAudit(page = 1) {
  const ul = document.querySelector('#audit-list');
  if (!ul) return;
  auditPage = page;

  try {
    const d = await api(`/api/admin/audit?page=${page}&size=30`);
    document.querySelector('#audit-loading').classList.add('hidden');
    auditTotalPages = d.totalPages;

    const items = d.items || [];
    if (!items.length) {
      ul.innerHTML = '<li class="text-sm text-slate-500 dark:text-slate-400">还没有操作记录。</li>';
      document.querySelector('#audit-pagination').classList.add('hidden');
      return;
    }

    ul.innerHTML = items.map((a) => `
      <li class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/50">
        <time class="shrink-0 font-mono text-slate-500 dark:text-slate-400">${escapeHtml(a.created_at)}</time>
        <span class="font-medium">${escapeHtml(a.label)}</span>
        ${a.target ? `<span class="text-slate-500 dark:text-slate-400">#${escapeHtml(a.target)}</span>` : ''}
        ${a.detail ? `<span class="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">${escapeHtml(a.detail)}</span>` : ''}
        ${a.ip ? `<span class="shrink-0 font-mono text-slate-300 dark:text-slate-600">${escapeHtml(a.ip)}</span>` : ''}
      </li>`).join('');

    const pg = document.querySelector('#audit-pagination');
    if (d.totalPages <= 1) {
      pg.innerHTML = '';
      pg.classList.add('hidden');
    } else {
      pg.classList.remove('hidden');
      pg.innerHTML = `
        <button type="button" data-audit-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}
                class="rounded-xl border border-slate-300 px-3.5 py-1.5 text-sm transition disabled:opacity-40 dark:border-slate-700">← 上一页</button>
        <span class="px-2 text-sm text-slate-500">第 ${page} / ${d.totalPages} 页（共 ${d.total} 条）</span>
        <button type="button" data-audit-page="${page + 1}" ${page >= d.totalPages ? 'disabled' : ''}
                class="rounded-xl border border-slate-300 px-3.5 py-1.5 text-sm transition disabled:opacity-40 dark:border-slate-700">下一页 →</button>`;
    }
  } catch (err) {
    document.querySelector('#audit-loading').textContent = '加载失败：' + err.message;
  }
}

/* ============================================================
 * 初始化
 * ============================================================ */
function initSystemPanels() {
  /* ---- 访问来源 ----
     ⚠️ 这里不调 loadRefs()：initSystemPanels 是在 DOMContentLoaded 跑的，
        那时用户还没登录（或者只剩一个过期的 token），请求直接 401，
        面板上会显示「加载失败」——而用户刚打开页面，看着莫名其妙。
        真正的加载在 admin.js 的 refreshAll() 里（登录成功后统一拉）。 */

  /* ---- 垃圾词 ---- */
  const wordForm = document.querySelector('#word-form');
  if (wordForm) {
    wordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.querySelector('#word-input');
      const status = document.querySelector('#word-status');
      const word = input.value.trim();
      if (!word) return;
      try {
        await api('/api/admin/blocked-words', { method: 'POST', body: { word } });
        input.value = '';
        status.textContent = '已加入黑名单';
        status.className = 'mt-2 min-h-5 text-sm text-emerald-600';
        await loadWords();
      } catch (err) {
        status.textContent = err.message;
        status.className = 'mt-2 min-h-5 text-sm text-red-500';
      }
    });

    document.querySelector('#word-list').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-word-del]');
      if (!b) return;
      try {
        await api('/api/admin/blocked-words/' + b.dataset.wordDel, { method: 'DELETE' });
        await loadWords();
      } catch (err) {
        setStatus(err.message, 'error');
      }
    });
  }

  /* ---- 备份 ---- */
  const backupSave = document.querySelector('#backup-save');
  if (backupSave) {
    backupSave.addEventListener('click', async () => {
      const msg = document.querySelector('#backup-msg');
      msg.textContent = '保存中…';
      msg.className = 'text-sm text-slate-500 dark:text-slate-400';
      try {
        // 复用站点设置的 PUT 接口（它已经支持这些键）
        await api('/api/admin/settings', {
          method: 'PUT',
          body: {
            backup_enabled: document.querySelector('#backup-enabled').checked,
            backup_repo: document.querySelector('#backup-repo').value.trim(),
            backup_path: document.querySelector('#backup-path').value.trim(),
          },
        });
        msg.textContent = '已保存 ✅';
        msg.className = 'text-sm text-emerald-600';
        await Promise.all([loadBackup(), loadImagesStatus()]);
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'text-sm text-red-500';
      }
    });

    document.querySelector('#images-restore').addEventListener('click', async () => {
      const msg = document.querySelector('#images-msg');
      if (!confirm('从备份仓库把库里缺失的图片补回来吗？\n\n只会新增，不会覆盖已有图片。')) return;
      msg.textContent = '正在检查仓库…';
      try {
        const r = await api('/api/admin/images-restore', { method: 'POST' });
        const d = r.data;
        msg.innerHTML = d.added
          ? `<span class="text-emerald-600 dark:text-emerald-400">补回 ${d.added} 张 ✅`
            + (d.failed ? `，${d.failed} 张失败` : '') + '</span>'
          : `没有需要补的图片（跳过 ${d.skipped} 张）`;
        await Promise.all([loadImagesStatus(), loadAudit(1)]);
      } catch (err) {
        msg.innerHTML = `<span class="text-red-500">恢复失败：${escapeHtml(err.message)}</span>`;
      }
    });

    document.querySelector('#backup-now').addEventListener('click', async () => {
      const msg = document.querySelector('#backup-msg');
      msg.textContent = '备份中…（要读写 GitHub，可能需要几秒）';
      msg.className = 'text-sm text-slate-500 dark:text-slate-400';
      try {
        const d = await api('/api/admin/backup', { method: 'POST' });
        msg.textContent = `备份成功：${d.file} ✅`;
        msg.className = 'text-sm text-emerald-600';
        await Promise.all([loadBackup(), loadAudit(1)]);
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'text-sm text-red-500';
      }
    });
  }

  /* ---- 操作日志 ---- */
  const auditList = document.querySelector('#audit-list');
  if (auditList) {
    document.querySelector('#audit-refresh').addEventListener('click', () => loadAudit(1));
    document.querySelector('#audit-pagination').addEventListener('click', (e) => {
      const b = e.target.closest('[data-audit-page]');
      if (!b || b.disabled) return;
      const p = Number(b.dataset.auditPage);
      if (p >= 1 && p <= auditTotalPages) loadAudit(p);
    });
  }

  /* ---- 本轮新增 ---- */
  initBatch();
  initSelfCheckButton();
  initRestore();
  // ⚠️ 这里不调 loadSelfCheck() —— initSystemPanels 是在 DOMContentLoaded 跑的，
  //    那时用户还没登录，请求直接 401，面板上会显示「加载失败」。
  //    真正的加载挂在 admin.js 的 refreshAll() 里（登录成功后统一拉）。

  // 关于我 / 垃圾过滤 / GitHub 用户名 由 admin.js 的设置表单统一读取和提交，这里不重复处理。
}

/* ============================================================
 *  本轮新增：批量操作 / 站点自检 / 从备份恢复
 * ============================================================ */

/* ---------------- 批量操作 ---------------- */

/** 统计当前勾选，更新工具条 */
function updateBatchBar() {
  const picks = Array.from(document.querySelectorAll('.msg-pick:checked'));
  const count = document.querySelector('#batch-count');
  const bar = document.querySelector('#batch-bar');
  const all = document.querySelector('#select-all');
  const boxes = Array.from(document.querySelectorAll('.msg-pick'));

  if (count) count.textContent = picks.length ? `已选 ${picks.length} 条` : '未选中';
  if (all) all.checked = boxes.length > 0 && picks.length === boxes.length;
  if (all) all.indeterminate = picks.length > 0 && picks.length < boxes.length;

  document.querySelectorAll('[data-batch]').forEach((b) => {
    // 删除是危险操作，不选东西时彻底禁用；其它操作也一样
    b.disabled = picks.length === 0;
  });
  if (bar) bar.classList.toggle('opacity-60', picks.length === 0);
}

function initBatch() {
  const bar = document.querySelector('#batch-bar');
  if (!bar) return;

  // 勾选变化（事件委托，列表是动态渲染的）
  document.querySelector('#admin-messages').addEventListener('change', (e) => {
    if (e.target.classList.contains('msg-pick')) updateBatchBar();
  });

  document.querySelector('#select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.msg-pick').forEach((c) => { c.checked = e.target.checked; });
    updateBatchBar();
  });

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-batch]');
    if (!btn || btn.disabled) return;

    const action = btn.dataset.batch;
    const ids = Array.from(document.querySelectorAll('.msg-pick:checked')).map((c) => Number(c.value));
    if (!ids.length) return;

    const labels = { approve: '通过', unapprove: '撤下', delete: '删除' };
    if (action === 'delete') {
      if (!confirm(`确定删除选中的 ${ids.length} 条留言吗？\n（它们引用的配图也会一起删除，不可撤销）`)) return;
    }

    const btns = document.querySelectorAll('[data-batch]');
    btns.forEach((b) => { b.disabled = true; });
    setStatus(`正在批量${labels[action]} ${ids.length} 条…`);

    try {
      const d = await api('/api/admin/messages-batch', { method: 'POST', body: { ids, action } });
      setStatus(`批量${labels[action]}完成：影响 ${d.affected} 条`, 'ok');
      await Promise.all([loadMessages(currentPage), loadOverview()]);
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      updateBatchBar();
    }
  });

  updateBatchBar();
}

/* ---------------- 站点自检 ---------------- */

function renderSelfCheck(d) {
  const list = document.querySelector('#selfcheck-list');
  const status = document.querySelector('#selfcheck-status');
  if (!list) return;

  if (!d) {
    list.innerHTML = '';
    status.textContent = '还没有跑过自检。';
    return;
  }

  list.innerHTML = (d.checks || []).map((c) => `
    <li class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs
               ${c.ok ? 'bg-emerald-50 dark:bg-emerald-950/40' : 'bg-red-50 dark:bg-red-950/40'}">
      <span class="shrink-0">${c.ok ? '✅' : '❌'}</span>
      <span class="font-medium">${escapeHtml(c.name)}</span>
      <span class="text-slate-500 dark:text-slate-400">${c.ms}ms</span>
      <span class="min-w-0 flex-1 truncate ${c.ok ? 'text-slate-500 dark:text-slate-400' : 'text-red-600 dark:text-red-400'}">${escapeHtml(c.detail || '')}</span>
    </li>`).join('');

  status.textContent = d.ok
    ? `全部通过（${d.checks.length} 项）· ${d.at}`
    : `${d.failedCount} 项失败 · ${d.at}（已尝试推送告警）`;
  status.className = 'text-sm ' + (d.ok ? 'text-emerald-600' : 'text-red-500');
}

async function loadSelfCheck() {
  try {
    const d = await api('/api/admin/selfcheck');
    if (d.lastResult) {
      // 只有摘要，展示摘要 + 提示点「立即自检」看明细
      const status = document.querySelector('#selfcheck-status');
      status.textContent = `上次自检：${d.lastResult} · ${d.lastAt || ''}`;
      status.className = 'text-sm ' + (String(d.lastResult).startsWith('全部通过') ? 'text-emerald-600' : 'text-amber-500');
    } else {
      document.querySelector('#selfcheck-status').textContent = '还没有跑过自检。';
    }
  } catch (e) {
    document.querySelector('#selfcheck-status').textContent = '读取状态失败：' + e.message;
  }
}

/* ---------------- 从备份恢复 ---------------- */

let restoreData = null;

function setRestoreStatus(text, type) {
  const el = document.querySelector('#restore-status');
  el.textContent = text || '';
  el.className = 'mt-3 min-h-5 text-sm ' +
    (type === 'error' ? 'text-red-500' : type === 'ok' ? 'text-emerald-600' : 'text-slate-500 dark:text-slate-400');
}

function initRestore() {
  const fileInput = document.querySelector('#restore-file');
  if (!fileInput) return;

  const previewBtn = document.querySelector('#restore-preview');
  const mergeBtn = document.querySelector('#restore-merge');
  const replaceBtn = document.querySelector('#restore-replace');

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    restoreData = null;
    mergeBtn.disabled = true;
    replaceBtn.disabled = true;
    document.querySelector('#restore-result').innerHTML = '';
    if (!f) return;
    setRestoreStatus(`已选择 ${f.name}（${(f.size / 1024).toFixed(1)} KB），点「预览」看看会改什么。`);
  });

  previewBtn.addEventListener('click', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return setRestoreStatus('请先选择备份文件', 'error');

    previewBtn.disabled = true;
    setRestoreStatus('读取中…');
    try {
      const text = await f.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('文件不是合法的 JSON'); }
      restoreData = json;

      const d = await api('/api/admin/restore', { method: 'POST', body: { data: json, mode: 'preview' } });

      document.querySelector('#restore-result').innerHTML = `
        <div class="rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
          <p class="mb-2 text-slate-500 dark:text-slate-400">备份导出时间：${escapeHtml(d.exportedAt || '（未标注）')}</p>
          <table class="w-full">
            <tbody>
              ${Object.entries(d.counts).map(([t, c]) => `
                <tr><td class="py-0.5 pr-3">${escapeHtml(t)}</td>
                    <td class="pr-3 font-mono">备份 ${c.inBackup}</td>
                    <td class="font-mono text-slate-500 dark:text-slate-400">当前 ${c.nowInDb}</td></tr>`).join('')}
            </tbody>
          </table>
          ${(d.warnings || []).map((w) => `<p class="mt-2 text-amber-600 dark:text-amber-400">⚠️ ${escapeHtml(w)}</p>`).join('')}
        </div>`;

      setRestoreStatus('预览完成。确认无误再选下面的恢复方式。', 'ok');
      mergeBtn.disabled = false;
      replaceBtn.disabled = false;
    } catch (err) {
      restoreData = null;
      setRestoreStatus(err.message, 'error');
    } finally {
      previewBtn.disabled = false;
    }
  });

  const doRestore = async (mode) => {
    if (!restoreData) return setRestoreStatus('请先预览', 'error');

    const msg = mode === 'replace'
      ? '覆盖恢复会先清空相关数据表，再写入备份内容。\n当前数据库里备份中没有的记录会永久丢失。\n\n确定继续吗？'
      : '合并恢复会按 id 覆盖同名记录，备份里没有的记录保持不变。\n\n确定继续吗？';
    if (!confirm(msg)) return;
    if (mode === 'replace' && !confirm('最后确认：覆盖恢复不可撤销，确定？')) return;

    setRestoreStatus(`正在${mode === 'replace' ? '覆盖' : '合并'}恢复…`);
    mergeBtn.disabled = true;
    replaceBtn.disabled = true;

    try {
      const d = await api('/api/admin/restore', {
        method: 'POST',
        body: { data: restoreData, mode, confirm: mode === 'replace' ? 'REPLACE' : 'MERGE' },
      });
      const rows = Object.entries(d.summary)
        .map(([t, s]) => `${t} 写入 ${s.written}${s.skipped ? `（跳过 ${s.skipped}）` : ''}`)
        .join(' · ');
      setRestoreStatus('恢复完成 ✅ ' + rows, 'ok');
      await refreshAll();
    } catch (err) {
      setRestoreStatus(err.message, 'error');
    } finally {
      mergeBtn.disabled = false;
      replaceBtn.disabled = false;
    }
  };

  mergeBtn.addEventListener('click', () => doRestore('merge'));
  replaceBtn.addEventListener('click', () => doRestore('replace'));
}

/* ---------------- 自检按钮 ---------------- */

function initSelfCheckButton() {
  const btn = document.querySelector('#selfcheck-run');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    document.querySelector('#selfcheck-status').textContent = '检查中…（GitHub 那项可能要几秒）';
    try {
      const d = await api('/api/admin/selfcheck', { method: 'POST' });
      renderSelfCheck(d);
    } catch (err) {
      document.querySelector('#selfcheck-status').textContent = '自检失败：' + err.message;
      document.querySelector('#selfcheck-status').className = 'text-sm text-red-500';
    } finally {
      btn.disabled = false;
    }
  });
}
