/* ============================================================
 *  routes/posts.js —— 说说（短动态）
 *
 *  公开：
 *    GET  /api/posts?page=&size=      已通过的列表
 *    POST /api/posts/:id/like         点赞
 *  后台：
 *    GET    /api/admin/posts?page=&size=&status=
 *    POST   /api/admin/posts          multipart: content / image / status
 *    POST   /api/admin/posts/:id      改文字（JSON）
 *    POST   /api/admin/posts/:id/approve
 *    DELETE /api/admin/posts/:id
 * ============================================================ */

const MAX_CONTENT = 500;

function mapPost(origin) {
  return (r) => ({
    id: r.id,
    content: r.content,
    likes: r.likes || 0,
    status: r.status,
    created_at: r.created_at,
    image_url: r.image_token ? `${origin}/api/media/${r.image_token}` : null,
  });
}

async function listPublic(request, env, H) {
  const url = new URL(request.url);
  const { page, size, offset } = H.parsePaging(url, 20, 50);

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = 'approved'`)
    .first();

  const { results } = await env.DB
    .prepare(`SELECT p.id, p.content, p.likes, p.status, p.created_at, i.token AS image_token
                FROM posts p
                LEFT JOIN images i ON i.id = p.image_id
               WHERE p.status = 'approved'
               ORDER BY p.id DESC LIMIT ?1 OFFSET ?2`)
    .bind(size, offset)
    .all();

  const total = totalRow ? totalRow.n : 0;
  return H.json({
    ok: true,
    data: {
      items: (results || []).map(mapPost(url.origin)),
      total, page, size,
      totalPages: Math.max(1, Math.ceil(total / size)),
    },
  });
}

async function like(id, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('说说 id 不合法');
  const r = await env.DB
    .prepare(`UPDATE posts SET likes = likes + 1 WHERE id = ?1 AND status = 'approved'`)
    .bind(id)
    .run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条说说不存在或还没通过审核', 404);
  const row = await env.DB.prepare('SELECT likes FROM posts WHERE id = ?1').bind(id).first();
  return H.json({ ok: true, data: { id, likes: row ? row.likes : 0 } });
}

/** 模块内的小工具（不依赖 worker.js 的实现） */
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

async function listAdmin(request, env, H) {
  const url = new URL(request.url);
  const { page, size, offset } = H.parsePaging(url, 20, 100);
  const filter = url.searchParams.get('status') || 'all';
  const ok = filter === 'pending' || filter === 'approved';
  const where = ok ? 'WHERE p.status = ?1' : '';
  const args = ok ? [filter] : [];

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts p ${where}`).bind(...args).first();
  const { results } = await env.DB
    .prepare(`SELECT p.id, p.content, p.likes, p.status, p.created_at, i.token AS image_token
                FROM posts p LEFT JOIN images i ON i.id = p.image_id
                ${where} ORDER BY p.id DESC
               LIMIT ?${ok ? 2 : 1} OFFSET ?${ok ? 3 : 2}`)
    .bind(...args, size, offset)
    .all();

  const total = totalRow ? totalRow.n : 0;
  return H.json({
    ok: true,
    data: {
      items: (results || []).map(mapPost(url.origin)),
      total, page, size,
      totalPages: Math.max(1, Math.ceil(total / size)),
      filter,
    },
  });
}

async function create(request, env, H) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonError('请求体解析失败');
  }

  const content = H.sanitizeText(form.get('content'), MAX_CONTENT);
  if (!content) return jsonError('说点什么吧');

  const blocked = await H.checkSpam(env, { text: content });
  if (blocked.blocked) return jsonError(blocked.reason || '内容不被允许');

  let imageId = null;
  const file = form.get('image');
  if (file && typeof file === 'object' && typeof file.size === 'number' && file.size) {
    const stored = await H.storeImage(env, file, form.get('thumb'));
    if (stored.error) return stored.error;
    imageId = stored.id;
  }

  const wantStatus = String(form.get('status') || '');
  const status = wantStatus === 'pending' ? 'pending' : 'approved';

  let r;
  try {
    r = await env.DB
      .prepare('INSERT INTO posts (content, image_id, status) VALUES (?1, ?2, ?3)')
      .bind(content, imageId, status)
      .run();
  } catch (err) {
    if (imageId) { try { await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(imageId).run(); } catch (e) {} }
    throw err;
  }

  const id = r.meta && r.meta.last_row_id;
  await H.auditLog(env, 'post_add', { target: id, detail: content.slice(0, 60), ip: H.clientIp(request) });

  return H.json({ ok: true, data: { id, content, status } }, 201);
}

async function update(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('说说 id 不合法');
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const content = H.sanitizeText(body.content, MAX_CONTENT);
  if (!content) return jsonError('内容不能为空');

  const blocked = await H.checkSpam(env, { text: content });
  if (blocked.blocked) return jsonError(blocked.reason || '内容不被允许');

  const r = await env.DB.prepare('UPDATE posts SET content = ?1 WHERE id = ?2').bind(content, id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条说说不存在', 404);

  await H.auditLog(env, 'post_add', { target: id, detail: '修改：' + content.slice(0, 50), ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id, content } });
}

async function approve(id, approveIt, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('说说 id 不合法');
  const status = approveIt ? 'approved' : 'pending';
  const r = await env.DB.prepare('UPDATE posts SET status = ?1 WHERE id = ?2').bind(status, id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条说说不存在', 404);
  await H.auditLog(env, approveIt ? 'post_approve' : 'post_add',
    { target: id, detail: status, ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id, status } });
}

async function remove(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('说说 id 不合法');
  const row = await env.DB.prepare('SELECT image_id FROM posts WHERE id = ?1').bind(id).first();
  const r = await env.DB.prepare('DELETE FROM posts WHERE id = ?1').bind(id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条说说不存在', 404);
  if (row && row.image_id) {
    await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(row.image_id).run();
  }
  await H.auditLog(env, 'post_delete', { target: id, ip: H.clientIp(request) });
  return H.json({ ok: true, data: { deleted: id } });
}

/** 路由入口：返回 Response 表示已处理，返回 null 表示不归本模块管 */
export async function route({ path, method, request, env, H }) {
  // 公开
  if (path === '/api/posts' && method === 'GET') return listPublic(request, env, H);

  let m = path.match(/^\/api\/posts\/([^/]+)\/like$/);
  if (m && method === 'POST') {
    return like(Number(m[1]), env, H);
  }

  // 后台
  if (path === '/api/admin/posts' && method === 'GET') return listAdmin(request, env, H);
  if (path === '/api/admin/posts' && method === 'POST') return create(request, env, H);

  m = path.match(/^\/api\/admin\/posts\/([^/]+)\/approve$/);
  if (m && method === 'POST') {
    let approveIt = true;
    try { const b = await request.json(); if (b && b.approve === false) approveIt = false; } catch (e) {}
    return approve(Number(m[1]), approveIt, request, env, H);
  }

  m = path.match(/^\/api\/admin\/posts\/([^/]+)$/);
  if (m && method === 'DELETE') return remove(Number(m[1]), request, env, H);
  if (m && method === 'POST') return update(Number(m[1]), request, env, H);

  return null;
}
