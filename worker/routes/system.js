/* ============================================================
 *  routes/system.js —— 后台的系统类接口
 *
 *    GET    /api/admin/audit?page=&size=&action=     操作日志
 *    GET    /api/admin/blocked-words                 垃圾词列表
 *    POST   /api/admin/blocked-words                 添加垃圾词
 *    DELETE /api/admin/blocked-words/:id             删除垃圾词
 *    GET    /api/admin/refs?days=                    访问来源统计
 *    GET    /api/admin/backup                        备份状态
 *    POST   /api/admin/backup                        立即备份一次
 *    GET    /api/admin/images-status                  图片备份状态（库里 vs 仓库）
 *    POST   /api/admin/images-restore                 从仓库补回缺失的图片
 *    POST   /api/admin/test-article                  （开发自测用，渲染一段 Markdown）
 * ============================================================ */

function jsonError(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 和全局 json() 保持一致。这几个路由各自复制了一份 jsonError
      // （历史原因），所以这里也要带上，否则报错响应会缺这个头。
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* ---------------- 操作日志 ---------------- */

async function audit(request, env, H) {
  const url = new URL(request.url);
  const { page, size } = H.parsePaging(url, 30, 100);
  const action = String(url.searchParams.get('action') || '').slice(0, 40);
  const data = await H.listAuditLog(env, { page, size, action });
  return H.json({ ok: true, data });
}

/* ---------------- 垃圾词 ---------------- */

async function listWords(env, H) {
  const { results } = await env.DB
    .prepare('SELECT id, word, created_at FROM blocked_words ORDER BY id DESC LIMIT 500')
    .all();
  const items = (results || []).map((r) => ({ id: r.id, word: r.word, created_at: r.created_at }));
  return H.json({ ok: true, data: { items, total: items.length } });
}

async function addWord(request, env, H) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const word = String(body.word || '').trim().slice(0, 40);
  if (!word) return jsonError('请填写要屏蔽的词');

  const exist = await env.DB.prepare('SELECT id FROM blocked_words WHERE word = ?1').bind(word).first();
  if (exist) return jsonError('这个词已经在名单里了');

  const r = await env.DB.prepare('INSERT INTO blocked_words (word) VALUES (?1)').bind(word).run();
  await H.auditLog(env, 'blocked_word_add', { target: word, ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id: r.meta && r.meta.last_row_id, word } }, 201);
}

async function delWord(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('id 不合法');
  const r = await env.DB.prepare('DELETE FROM blocked_words WHERE id = ?1').bind(id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('这个词不存在', 404);
  await H.auditLog(env, 'blocked_word_del', { target: id, ip: H.clientIp(request) });
  return H.json({ ok: true, data: { deleted: id } });
}

/* ---------------- 访问来源 ---------------- */

async function refs(request, env, H) {
  const url = new URL(request.url);
  const raw = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Math.min(90, Math.max(1, Number.isFinite(raw) ? raw : 30));

  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  const byRef = await env.DB
    .prepare(`SELECT ref, SUM(count) AS n FROM visit_refs WHERE day >= ?1 GROUP BY ref ORDER BY n DESC LIMIT 30`)
    .bind(since)
    .all();

  const byDay = await env.DB
    .prepare(`SELECT day, SUM(count) AS n FROM visit_refs WHERE day >= ?1 GROUP BY day ORDER BY day`)
    .bind(since)
    .all();

  const totalRow = await env.DB
    .prepare(`SELECT SUM(count) AS n FROM visit_refs WHERE day >= ?1`)
    .bind(since)
    .first();

  const items = (byRef.results || []).map((r) => ({
    ref: r.ref === 'direct' ? '直接访问' : r.ref,
    raw: r.ref,
    count: r.n || 0,
  }));

  return H.json({
    ok: true,
    data: {
      days,
      since,
      total: totalRow ? (totalRow.n || 0) : 0,
      byRef: items,
      byDay: (byDay.results || []).map((r) => ({ day: r.day, count: r.n || 0 })),
    },
  });
}

/* ---------------- 备份 ---------------- */

async function backupStatus(env, H) {
  const s = await H.getSettings(env);
  let preview = null;
  try {
    preview = await H.previewBackup(env);
  } catch (e) {}

  return H.json({
    ok: true,
    data: {
      enabled: s.backup_enabled === '1',
      repo: s.backup_repo || '',
      path: s.backup_path || 'backup',
      lastAt: s.backup_last_at || null,
      lastResult: s.backup_last_result || null,
      hasToken: !!env.GH_TOKEN,
      preview,
    },
  });
}

async function backupRun(request, env, H) {
  // 手动触发时忽略"未启用"开关，但仓库和令牌还是必须的
  const s = await H.getSettings(env);
  if (!env.GH_TOKEN) return jsonError('还没有配置 GH_TOKEN 密钥，无法备份', 400);
  if (!String(s.backup_repo || '').trim()) return jsonError('还没有配置备份仓库', 400);

  const result = await H.performBackup(env);
  await H.auditLog(env, 'backup_run', {
    detail: result.ok ? `成功 ${result.file}` : (result.reason || '失败'),
    ip: H.clientIp(request),
  });
  if (!result.ok) return jsonError('备份失败：' + (result.reason || '未知原因'), 500);
  return H.json({ ok: true, data: result });
}

/* ---------------- 图片备份 ---------------- */

/**
 * GET /api/admin/images-status
 * 比对「库里有几张图」和「仓库备份里有多少个文件」。
 */
async function imagesStatus(env, H) {
  const s = await H.getSettings(env);
  const repo = String(s.backup_repo || '').trim();
  const dir = String(s.backup_path || 'backup').replace(/^\/+|\/+$/g, '');

  const dbCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM images').first();
  const dbBytes = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM images').first();

  const out = {
    inDb: dbCount ? dbCount.n : 0,
    dbBytes: dbBytes ? dbBytes.n : 0,
    repo,
    path: dir + '/images',
    hasToken: !!env.GH_TOKEN,
    inRepo: null,
    missing: null,
    restorable: null,
    error: null,
  };

  if (!repo || !env.GH_TOKEN) return H.json({ ok: true, data: out });

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURI(dir + '/images')}?ref=main`,
      {
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'your-site-backup',
        },
      }
    );
    if (res.status === 404) {
      out.inRepo = 0;
      out.missing = out.inDb;
      out.restorable = 0;
    } else if (res.ok) {
      const files = await res.json();
      const list = Array.isArray(files) ? files.filter((f) => f.type === 'file') : [];
      out.inRepo = list.length;

      const { results } = await env.DB.prepare('SELECT token FROM images').all();
      const have = new Set((results || []).map((x) => x.token));
      const repoSet = new Set(
        list.map((f) => (String(f.name).match(/^([0-9a-f]+)\./) || [])[1]).filter(Boolean)
      );
      out.missing = [...have].filter((t) => !repoSet.has(t)).length;
      out.restorable = [...repoSet].filter((t) => !have.has(t)).length;
    } else {
      out.error = `GitHub 返回 ${res.status}`;
    }
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }

  return H.json({ ok: true, data: out });
}

/** POST /api/admin/images-restore —— 从仓库补回库里没有的图片 */
async function imagesRestore(request, env, H) {
  if (!env.GH_TOKEN) return jsonError('还没有配置 GH_TOKEN 密钥', 400);
  const s = await H.getSettings(env);
  if (!String(s.backup_repo || '').trim()) return jsonError('还没有配置备份仓库', 400);

  try {
    const r = await H.restoreImages(env);
    await H.auditLog(env, 'backup_run', {
      detail: `图片恢复：新增 ${r.added}，跳过 ${r.skipped}，失败 ${r.failed}`,
      ip: H.clientIp(request),
    });
    return H.json({ ok: true, data: r });
  } catch (e) {
    return jsonError('恢复失败：' + (e && e.message ? e.message : String(e)), 500);
  }
}

export async function route({ path, method, request, env, H }) {
  if (path === '/api/admin/audit' && method === 'GET') return audit(request, env, H);

  if (path === '/api/admin/blocked-words' && method === 'GET') return listWords(env, H);
  if (path === '/api/admin/blocked-words' && method === 'POST') return addWord(request, env, H);

  let m = path.match(/^\/api\/admin\/blocked-words\/([^/]+)$/);
  if (m && method === 'DELETE') return delWord(Number(m[1]), request, env, H);

  if (path === '/api/admin/refs' && method === 'GET') return refs(request, env, H);

  if (path === '/api/admin/backup' && method === 'GET') return backupStatus(env, H);
  if (path === '/api/admin/backup' && method === 'POST') return backupRun(request, env, H);
  if (path === '/api/admin/images-status' && method === 'GET') return imagesStatus(env, H);
  if (path === '/api/admin/images-restore' && method === 'POST') return imagesRestore(request, env, H);

  // 本轮新增
  if (path === '/api/admin/messages-batch' && method === 'POST') return batchMessages(request, env, H);
  if (path === '/api/admin/restore' && method === 'POST') return restore(request, env, H);
  if (path === '/api/admin/selfcheck' && method === 'GET') return selfCheckStatus(env, H);
  if (path === '/api/admin/selfcheck' && method === 'POST') return selfCheckRun(request, env, H);

  return null;
}

/* ============================================================
 *  以下为本轮新增：批量操作 / 从备份恢复 / 站点自检
 * ============================================================ */

/* ---------------- 批量操作留言 ---------------- */

/**
 * POST /api/admin/messages-batch
 * body: { ids: number[], action: 'approve' | 'unapprove' | 'delete' }
 *
 * 一次最多 200 条，避免一条请求跑太久把 Worker 拖超时。
 */
async function batchMessages(request, env, H) {
  let body = {};
  try { body = await request.json(); } catch (e) {
    return jsonError('请求体不是合法的 JSON');
  }

  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0)
    .slice(0, 200);

  if (!ids.length) return jsonError('没有选中的留言');
  if (ids.length > 200) return jsonError('一次最多处理 200 条');

  const action = String(body.action || '');
  if (!['approve', 'unapprove', 'delete'].includes(action)) {
    return jsonError('不支持的操作');
  }

  const holes = ids.map(() => '?').join(',');
  const ip = H.clientIp(request);
  let affected = 0;

  if (action === 'delete') {
    // 先把要删的留言引用的图片找出来，删完一起清理，不留孤儿
    const { results } = await env.DB
      .prepare(`SELECT image_id FROM messages WHERE id IN (${holes}) AND image_id IS NOT NULL`)
      .bind(...ids).all();
    const r = await env.DB.prepare(`DELETE FROM messages WHERE id IN (${holes})`).bind(...ids).run();
    affected = (r.meta && r.meta.changes) || 0;

    const imgIds = (results || []).map((x) => x.image_id).filter(Boolean);
    if (imgIds.length) {
      const ih = imgIds.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM images WHERE id IN (${ih})`).bind(...imgIds).run();
    }
  } else {
    const status = action === 'approve' ? 'approved' : 'pending';
    const r = await env.DB
      .prepare(`UPDATE messages SET status = ?1 WHERE id IN (${holes})`)
      .bind(status, ...ids).run();
    affected = (r.meta && r.meta.changes) || 0;
  }

  await H.auditLog(env, action === 'delete' ? 'delete_message' : (action === 'approve' ? 'approve_message' : 'unapprove_message'), {
    target: `${affected} 条`, detail: `批量：${ids.length} 个 id`, ip,
  });

  return H.json({ ok: true, data: { action, requested: ids.length, affected } });
}

/* ---------------- 从备份恢复 ---------------- */

/** 备份文件里可能出现哪些表 */
const RESTORE_TABLES = ['messages', 'posts', 'articles', 'friends', 'gallery'];

function validateBackup(data) {
  if (!data || typeof data !== 'object') return '文件内容不是 JSON 对象';
  if (!Array.isArray(data.messages) && !Array.isArray(data.posts) && !Array.isArray(data.articles)) {
    return '这个文件看起来不像本站的备份（缺少 messages / posts / articles 字段）';
  }
  return null;
}

/** 只统计，不写库 */
async function previewRestore(env, data) {
  const counts = {};
  for (const t of RESTORE_TABLES) {
    const rows = Array.isArray(data[t]) ? data[t] : [];
    const cur = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first();
    counts[t] = { inBackup: rows.length, nowInDb: cur ? cur.n : 0 };
  }
  const warnings = [];
  if (!data.images || !Array.isArray(data.images) || !data.images.length) {
    warnings.push('备份里没有图片数据（备份只存元信息），恢复后相册条目可能引用不到图片');
  }
  warnings.push('恢复是覆盖式的：备份里没有的行会被删除');
  return { exportedAt: data.exported_at || null, counts, warnings };
}

/** 真正写库 */
async function applyRestore(env, data, mode) {
  const summary = {};
  const tables = mode === 'merge' ? RESTORE_TABLES : RESTORE_TABLES;

  // replace 模式：先清空（顺序无所谓，表之间没有外键约束）
  if (mode === 'replace') {
    for (const t of tables) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  }

  // 允许写入的列白名单 —— 只写备份里有的字段，防止脏数据塞进奇怪的列
  const COLUMNS = {
    messages: ['id', 'name', 'content', 'status', 'reply', 'replied_at', 'likes', 'parent_id', 'created_at'],
    posts: ['id', 'content', 'status', 'likes', 'created_at'],
    articles: ['id', 'slug', 'title', 'summary', 'content', 'tags', 'status', 'pinned', 'views', 'created_at', 'updated_at'],
    friends: ['id', 'name', 'url', 'avatar', 'desc', 'status', 'sort', 'created_at'],
    gallery: ['id', 'image_id', 'title', 'note', 'sort', 'created_at'],
  };

  for (const t of tables) {
    const rows = Array.isArray(data[t]) ? data[t] : [];
    let written = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row || typeof row !== 'object') { skipped++; continue; }

      // 相册条目要检查图片是否还在，否则恢复了也显示不出来
      if (t === 'gallery' && row.image_id) {
        const img = await env.DB.prepare('SELECT id FROM images WHERE id = ?1').bind(row.image_id).first();
        if (!img) { skipped++; continue; }
      }

      const cols = COLUMNS[t].filter((c) => row[c] !== undefined);
      if (!cols.length) { skipped++; continue; }
      const vals = cols.map((c) => row[c]);
      const ph = cols.map((_, i) => '?' + (i + 1)).join(', ');

      try {
        if (mode === 'replace') {
          await env.DB.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${ph})`).bind(...vals).run();
        } else {
          // merge：按 id 覆盖
          const sets = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
          await env.DB
            .prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${ph})
                      ON CONFLICT(id) DO UPDATE SET ${sets}`)
            .bind(...vals).run();
        }
        written++;
      } catch (e) {
        skipped++;
      }
    }
    summary[t] = { written, skipped };
  }

  return summary;
}

/**
 * POST /api/admin/restore
 * body: { data: <备份对象>, mode: 'preview' | 'merge' | 'replace', confirm?: string }
 *
 * 安全设计：
 *   - 默认只预览，绝不写库
 *   - 真要写必须显式传 mode + confirm（replace 要求 confirm === 'REPLACE'）
 */
async function restore(request, env, H) {
  let body = {};
  try { body = await request.json(); } catch (e) {
    return jsonError('请求体不是合法的 JSON');
  }

  const data = body.data;
  const err = validateBackup(data);
  if (err) return jsonError(err);

  const mode = String(body.mode || 'preview');

  if (mode === 'preview') {
    return H.json({ ok: true, data: { mode: 'preview', ...(await previewRestore(env, data)) } });
  }

  if (!['merge', 'replace'].includes(mode)) return jsonError('mode 只能是 preview / merge / replace');

  if (mode === 'replace' && body.confirm !== 'REPLACE') {
    return jsonError('覆盖恢复需要确认，请在 confirm 字段填入 REPLACE');
  }
  if (mode === 'merge' && body.confirm !== 'MERGE') {
    return jsonError('合并恢复需要确认，请在 confirm 字段填入 MERGE');
  }

  const summary = await applyRestore(env, data, mode);
  await H.auditLog(env, 'restore', {
    target: mode, detail: JSON.stringify(summary).slice(0, 180), ip: H.clientIp(request),
  });

  return H.json({ ok: true, data: { mode, summary } });
}

/* ---------------- 站点自检（监控告警） ---------------- */

/**
 * 自检：逐项检查关键能力，任何一项失败就通过已配置的通知渠道告警。
 *
 * 注意：Worker 自己没法发现"Worker 挂了"。这里做的是
 * **能力自检**（数据库能不能读、图片能不能取、GitHub 能不能连），
 * 真正的"站点是否在线"需要外部监控（UptimeRobot 之类）。
 */
export async function runSelfCheck(env) {
  const checks = [];

  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: Date.now() - t0, detail: detail || '' });
    } catch (e) {
      checks.push({ name, ok: false, ms: Date.now() - t0, detail: (e && e.message) || String(e) });
    }
  };

  await timed('数据库读取', async () => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first();
    return `留言 ${r ? r.n : 0} 条`;
  });

  await timed('数据库写入', async () => {
    await env.DB
      .prepare(`INSERT INTO settings (key, value) VALUES ('selfcheck_at', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(new Date().toISOString())
      .run();
    return '可写';
  });

  await timed('图片存储', async () => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM images').first();
    return `${r ? r.n : 0} 张 / ${((r ? r.b : 0) / 1024 / 1024).toFixed(2)} MB`;
  });

  await timed('备份令牌', async () => {
    if (!env.GH_TOKEN) throw new Error('未配置 GH_TOKEN');
    return '已配置';
  });

  await timed('GitHub 连通性', async () => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 6000) : null;
    try {
      const r = await fetch('https://api.github.com/zen', {
        headers: { 'User-Agent': 'your-site-selfcheck' },
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return '可达';
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
  });

  const failed = checks.filter((c) => !c.ok);
  return { at: new Date().toISOString(), ok: failed.length === 0, failedCount: failed.length, checks };
}

/** 自检失败时告警（复用留言通知那套渠道） */
export async function alertIfBroken(env, result) {
  if (result.ok) return;
  try {
    const s = await getSettingsThin(env);
    const type = s.notify_type || 'off';
    const hook = (s.notify_webhook || '').trim();
    if (type === 'off' || !hook) return;

    const lines = [
      '🚨 站点自检未通过',
      ...result.checks.filter((c) => !c.ok).map((c) => `· ${c.name}：${c.detail}`),
      `时间：${result.at}`,
    ];
    const text = lines.join('\n');

    let init;
    if (type === 'wecom' || type === 'dingtalk') {
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
    } else if (type === 'serverchan') {
      init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
               body: new URLSearchParams({ title: '站点自检未通过', desp: text }) };
    } else {
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ event: 'selfcheck_failed', text, checks: result.checks }) };
    }
    await fetch(hook, init);
  } catch (e) {
    console.error('自检告警发送失败:', e && e.message ? e.message : e);
  }
}

async function getSettingsThin(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

/** GET /api/admin/selfcheck —— 看上次自检结果 */
async function selfCheckStatus(env, H) {
  const s = await H.getSettings(env);
  return H.json({
    ok: true,
    data: {
      lastAt: s.selfcheck_at || null,
      lastResult: s.selfcheck_result || null,
      notifyType: s.notify_type || 'off',
      notifySet: !!(s.notify_webhook || '').trim(),
    },
  });
}

/** POST /api/admin/selfcheck —— 立刻跑一次自检 */
async function selfCheckRun(request, env, H) {
  const result = await runSelfCheck(env);
  const brief = result.ok
    ? `全部通过（${result.checks.length} 项）`
    : `${result.failedCount} 项失败：` + result.checks.filter((c) => !c.ok).map((c) => c.name).join('、');

  await H.setSetting(env, 'selfcheck_result', brief);
  await H.auditLog(env, 'selfcheck', { detail: brief, ip: H.clientIp(request) });

  if (!result.ok) await alertIfBroken(env, result);

  return H.json({ ok: true, data: result });
}
