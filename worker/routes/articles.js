/* ============================================================
 *  routes/articles.js —— 文章（Markdown 博客）
 *
 *  公开：
 *    GET /api/articles?page=&size=&tag=     列表（只含已发布，不返回正文）
 *    GET /api/articles/:slug                详情（返回渲染好的 HTML，累加阅读数）
 *  后台：
 *    GET    /api/admin/articles             列表（含草稿）
 *    GET    /api/admin/articles/:id         读取单篇（含 Markdown 原文，供编辑器回填）
 *    POST   /api/admin/articles             新建 / 保存
 *    DELETE /api/admin/articles/:id
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

/** 逗号分隔 → 数组（去空、去重、限长） */
function parseTags(raw) {
  return Array.from(new Set(
    String(raw || '')
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, 20))
  )).slice(0, 8);
}

/**
 * 生成 URL 标识。
 * 中文标题也能直接当 slug（浏览器会做百分号编码），比硬凑拼音好读。
 */
function makeSlug(title, provided) {
  const src = String(provided || title || '').trim();
  const s = src
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return s || 'post-' + Date.now().toString(36);
}

async function uniqueSlug(env, slug, exceptId = null) {
  let candidate = slug;
  for (let i = 2; i < 50; i++) {
    const row = await env.DB
      .prepare(`SELECT id FROM articles WHERE slug = ?1`)
      .bind(candidate)
      .first();
    if (!row || (exceptId && row.id === exceptId)) return candidate;
    candidate = `${slug}-${i}`;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

const listItem = (origin) => (r) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  summary: r.summary || '',
  tags: parseTags(r.tags),
  status: r.status,
  pinned: !!r.pinned,
  views: r.views || 0,
  created_at: r.created_at,
  updated_at: r.updated_at,
  cover_url: r.cover_token ? `${origin}/api/media/${r.cover_token}` : null,
});

async function listPublic(request, env, H) {
  const url = new URL(request.url);
  const { page, size, offset } = H.parsePaging(url, 10, 30);
  const tag = H.sanitizeText(url.searchParams.get('tag') || '', 20);

  const conds = [`status = 'published'`];
  const args = [];
  // 同 search：LIKE 模式按字节截，别让长中文把它撑爆
  if (tag) { conds.push('tags LIKE ?'); args.push(H.likeSafe(tag)); }
  const where = 'WHERE ' + conds.join(' AND ');

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM articles ${where}`).bind(...args).first();
  const whereA = where.replace(/\bstatus\b/g, 'a.status').replace(/\btags\b/g, 'a.tags');
  const { results } = await env.DB
    .prepare(`SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.pinned,
                     a.views, a.created_at, a.updated_at, ci.token AS cover_token
                FROM articles a
                LEFT JOIN images ci ON ci.id = a.cover_image_id
                ${whereA}
               ORDER BY a.pinned DESC, a.id DESC
               LIMIT ? OFFSET ?`)
    .bind(...args, size, offset)
    .all();

  const total = totalRow ? totalRow.n : 0;

  // 所有标签（给列表页做筛选用），只从已发布的文章里收集
  const tagRows = await env.DB
    .prepare(`SELECT tags FROM articles WHERE status = 'published'`)
    .all();
  const tagCount = {};
  for (const r of tagRows.results || []) {
    for (const t of parseTags(r.tags)) tagCount[t] = (tagCount[t] || 0) + 1;
  }

  return H.json({
    ok: true,
    data: {
      items: (results || []).map(listItem(url.origin)),
      total, page, size,
      totalPages: Math.max(1, Math.ceil(total / size)),
      tag: tag || null,
      tags: Object.entries(tagCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    },
  });
}

async function detail(slug, env, H, request) {
  const origin = new URL(request.url).origin;
  const row = await env.DB
    .prepare(`SELECT a.*, ci.token AS cover_token
                FROM articles a
                LEFT JOIN images ci ON ci.id = a.cover_image_id
               WHERE a.slug = ?1 AND a.status = 'published'`)
    .bind(slug)
    .first();
  if (!row) return jsonError('文章不存在或还没发布', 404);

  // 阅读数 +1（失败不影响正文返回）
  try {
    await env.DB.prepare('UPDATE articles SET views = views + 1 WHERE id = ?1').bind(row.id).run();
  } catch (e) {}

  // 上一篇 / 下一篇（按 id 顺序）
  const prev = await env.DB
    .prepare(`SELECT slug, title FROM articles WHERE status = 'published' AND id < ?1 ORDER BY id DESC LIMIT 1`)
    .bind(row.id).first();
  const next = await env.DB
    .prepare(`SELECT slug, title FROM articles WHERE status = 'published' AND id > ?1 ORDER BY id ASC LIMIT 1`)
    .bind(row.id).first();

  const related = await env.DB
    .prepare(`SELECT id, slug, title FROM articles WHERE status = 'published' AND id != ?1
               ORDER BY id DESC LIMIT 5`)
    .bind(row.id).all();

  return H.json({
    ok: true,
    data: {
      id: row.id,
      slug: row.slug,
      title: row.title,
      summary: row.summary || '',
      html: H.renderMarkdown(row.content),      // 服务端渲染，前端直接 innerHTML
      tags: parseTags(row.tags),
      cover_url: row.cover_token ? `${origin}/api/media/${row.cover_token}` : null,
      views: (row.views || 0) + 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      prev: prev ? { slug: prev.slug, title: prev.title } : null,
      next: next ? { slug: next.slug, title: next.title } : null,
      related: (related.results || []).map((r) => ({ slug: r.slug, title: r.title })),
    },
  });
}

async function listAdmin(request, env, H) {
  const origin = new URL(request.url).origin;
  const { results } = await env.DB
    .prepare(`SELECT a.id, a.slug, a.title, a.summary, a.tags, a.status, a.pinned,
                     a.views, a.created_at, a.updated_at, ci.token AS cover_token
                FROM articles a
                LEFT JOIN images ci ON ci.id = a.cover_image_id
               ORDER BY a.pinned DESC, a.id DESC LIMIT 300`)
    .all();
  return H.json({
    ok: true,
    data: { items: (results || []).map(listItem(origin)), total: (results || []).length },
  });
}

async function getOne(id, env, H, request) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('文章 id 不合法');
  const row = await env.DB
    .prepare(`SELECT a.*, ci.token AS cover_token FROM articles a
               LEFT JOIN images ci ON ci.id = a.cover_image_id WHERE a.id = ?1`)
    .bind(id).first();
  if (!row) return jsonError('文章不存在', 404);
  return H.json({
    ok: true,
    data: {
      id: row.id,
      slug: row.slug,
      title: row.title,
      summary: row.summary || '',
      content: row.content,
      tags: parseTags(row.tags).join(', '),
      status: row.status,
      pinned: !!row.pinned,
      views: row.views || 0,
      cover_url: row.cover_token ? `${new URL(request.url).origin}/api/media/${row.cover_token}` : null,
    },
  });
}

async function save(request, env, H) {
  let body = {};
  try { body = await request.json(); } catch (e) {
    return jsonError('请求体不是合法的 JSON');
  }

  const title = H.sanitizeText(body.title, 80);
  const summary = H.sanitizeText(body.summary, 200);
  const tags = parseTags(body.tags).join(',');
  const status = body.status === 'draft' ? 'draft' : 'published';
  const pinned = body.pinned ? 1 : 0;

  // 正文只做长度限制，不做 HTML 转义 —— 渲染时会先转义，存原文才能再编辑
  const content = String(body.content || '').slice(0, 20000);

  if (!title) return jsonError('标题不能为空');
  if (!content.trim()) return jsonError('正文不能为空');

  const id = Number(body.id) || 0;
  const ip = H.clientIp(request);

  if (id) {
    const exist = await env.DB.prepare('SELECT id FROM articles WHERE id = ?1').bind(id).first();
    if (!exist) return jsonError('文章不存在', 404);

    let slug = makeSlug(title, body.slug);
    slug = await uniqueSlug(env, slug, id);

    await env.DB
      .prepare(`UPDATE articles SET slug = ?1, title = ?2, summary = ?3, content = ?4,
                                   tags = ?5, status = ?6, pinned = ?7,
                                   updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?8`)
      .bind(slug, title, summary, content, tags, status, pinned, id)
      .run();
    await H.auditLog(env, 'article_save', { target: id, detail: `更新《${title}》`, ip });
    return H.json({ ok: true, data: { id, slug } });
  }

  let slug = makeSlug(title, body.slug);
  slug = await uniqueSlug(env, slug);

  const r = await env.DB
    .prepare(`INSERT INTO articles (slug, title, summary, content, tags, status, pinned)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(slug, title, summary, content, tags, status, pinned)
    .run();

  const newId = r.meta && r.meta.last_row_id;
  await H.auditLog(env, 'article_save', { target: newId, detail: `新建《${title}》`, ip });
  return H.json({ ok: true, data: { id: newId, slug } }, 201);
}

async function remove(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('文章 id 不合法');
  const row = await env.DB.prepare('SELECT title FROM articles WHERE id = ?1').bind(id).first();
  const r = await env.DB.prepare('DELETE FROM articles WHERE id = ?1').bind(id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('文章不存在', 404);
  await H.auditLog(env, 'article_delete', { target: id, detail: row ? row.title : '', ip: H.clientIp(request) });
  return H.json({ ok: true, data: { deleted: id } });
}

/** POST /api/admin/article-preview —— 编辑器里预览 Markdown，用服务端渲染保证和最终效果一致 */
async function preview(request, env, H) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const content = String(body.content || '').slice(0, 20000);
  return H.json({ ok: true, data: { html: H.renderMarkdown(content) } });
}


/* ---------------- 文章封面图 ---------------- */

/** POST /api/admin/articles/:id/cover —— 上传并设置封面（multipart: image） */
async function setCover(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('文章 id 不合法');

  const row = await env.DB.prepare('SELECT id, cover_image_id FROM articles WHERE id = ?1').bind(id).first();
  if (!row) return jsonError('文章不存在', 404);

  let form;
  try { form = await request.formData(); } catch (e) {
    return jsonError('请求体解析失败');
  }
  const file = form.get('image');
  if (!file || typeof file !== 'object' || typeof file.size !== 'number' || !file.size) {
    return jsonError('请选择一张图片');
  }

  const stored = await H.storeImage(env, file, form.get('thumb'));
  if (stored.error) return stored.error;

  await env.DB.prepare('UPDATE articles SET cover_image_id = ?1 WHERE id = ?2').bind(stored.id, id).run();

  // 换封面时把旧图删掉，不留孤儿
  if (row.cover_image_id) {
    try { await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(row.cover_image_id).run(); } catch (e) {}
  }

  await H.auditLog(env, 'article_save', { target: id, detail: '更新封面', ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id, cover_url: `${new URL(request.url).origin}/api/media/${stored.token}` } });
}

/** DELETE /api/admin/articles/:id/cover —— 移除封面（连同图片） */
async function removeCover(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('文章 id 不合法');

  const row = await env.DB.prepare('SELECT id, cover_image_id FROM articles WHERE id = ?1').bind(id).first();
  if (!row) return jsonError('文章不存在', 404);

  await env.DB.prepare('UPDATE articles SET cover_image_id = NULL WHERE id = ?1').bind(id).run();
  if (row.cover_image_id) {
    try { await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(row.cover_image_id).run(); } catch (e) {}
  }

  await H.auditLog(env, 'article_save', { target: id, detail: '移除封面', ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id, cover_url: null } });
}

export async function route({ path, method, request, env, H }) {
  if (path === '/api/admin/article-preview' && method === 'POST') return preview(request, env, H);

  if (path === '/api/articles' && method === 'GET') return listPublic(request, env, H);

  let m = path.match(/^\/api\/articles\/([^/]+)$/);
  if (m && method === 'GET') return detail(decodeURIComponent(m[1]), env, H, request);

  if (path === '/api/admin/articles' && method === 'GET') return listAdmin(request, env, H);
  if (path === '/api/admin/articles' && method === 'POST') return save(request, env, H);

  m = path.match(/^\/api\/admin\/articles\/([^/]+)\/cover$/);
  if (m && method === 'POST') return setCover(Number(m[1]), request, env, H);
  if (m && method === 'DELETE') return removeCover(Number(m[1]), request, env, H);

  m = path.match(/^\/api\/admin\/articles\/([^/]+)$/);
  if (m && method === 'GET') return getOne(Number(m[1]), env, H, request);
  if (m && method === 'DELETE') return remove(Number(m[1]), request, env, H);

  return null;
}
