/* ============================================================
 *  routes/friends.js —— 友链
 *
 *  公开：
 *    GET  /api/friends        已通过的友链
 *    POST /api/friends        提交申请（进 pending，等站长审核）
 *  后台：
 *    GET    /api/admin/friends?status=
 *    POST   /api/admin/friends/:id/approve     通过 / 撤下
 *    POST   /api/admin/friends/:id/reject      标记拒绝
 *    POST   /api/admin/friends/:id             改资料 / 排序
 *    DELETE /api/admin/friends/:id
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

const mapFriend = (r) => ({
  id: r.id,
  name: r.name,
  url: r.url,
  avatar: r.avatar || null,
  desc: r.desc || null,
  status: r.status,
  sort: r.sort || 0,
  created_at: r.created_at,
});

/** 只接受 http/https 的绝对地址，挡掉 javascript: 之类 */
function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u)) return null;
  if (u.length > 300) return null;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
}

async function listPublic(env, H) {
  const { results } = await env.DB
    .prepare(`SELECT id, name, url, avatar, desc, status, sort, created_at
                FROM friends WHERE status = 'approved'
               ORDER BY sort DESC, id ASC`)
    .all();
  return H.json({ ok: true, data: { items: (results || []).map(mapFriend), total: (results || []).length } });
}

async function apply(request, env, H) {
  let body = {};
  try { body = await request.json(); } catch (e) {
    return jsonError('请求体不是合法的 JSON');
  }

  const name = H.sanitizeText(body.name, 30);
  const url = normalizeUrl(body.url);
  const desc = H.sanitizeText(body.desc, 80);
  const avatarRaw = String(body.avatar || '').trim();
  const avatar = avatarRaw ? normalizeUrl(avatarRaw) : null;

  if (!name) return jsonError('请填写站点名称');
  if (!url) return jsonError('请填写正确的网址（要以 http:// 或 https:// 开头）');
  if (avatarRaw && !avatar) return jsonError('头像地址不是合法的网址');
  // 人机校验：和留言板同一套。没配 TURNSTILE_SECRET 时直接放行。
  // 位置放在字段校验之后、查库之前 —— 理由和留言那边一样：
  // 让机器人卡在数据库之前，别白消耗 D1 的读配额。
  const ts = await H.verifyTurnstile(env, body.turnstile_token, H.clientIp(request));
  if (!ts.ok) return jsonError(H.turnstileErrorMessage(ts), 403);
  if (ts.skipped) {
    console.log('[turnstile] 未配置 TURNSTILE_SECRET，本次友链申请未做人机校验');
  }


  const blocked = await H.checkSpam(env, { text: `${name} ${desc} ${url}`, isFriendLink: true });
  if (blocked.blocked) return jsonError(blocked.reason || '内容不被允许');

  // 同一个网址只允许提交一次
  const dup = await env.DB.prepare('SELECT id FROM friends WHERE url = ?1').bind(url).first();
  if (dup) return jsonError('这个网址已经提交过了');

  const r = await env.DB
    .prepare(`INSERT INTO friends (name, url, avatar, desc, status) VALUES (?1, ?2, ?3, ?4, 'pending')`)
    .bind(name, url, avatar, desc)
    .run();

  // 借用留言那套通知，站长手机上能直接收到友链申请
  H.notifyNewMessage(env, H.waitCtx, {
    name: `友链申请 · ${name}`,
    content: `${url}\n${desc || '（没有简介）'}`,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    pending: true,
  });

  return H.json({ ok: true, data: { id: r.meta && r.meta.last_row_id, status: 'pending' } }, 201);
}

async function listAdmin(request, env, H) {
  const url = new URL(request.url);
  const filter = url.searchParams.get('status') || 'all';
  const ok = ['pending', 'approved', 'rejected'].includes(filter);
  const where = ok ? 'WHERE status = ?1' : '';
  const args = ok ? [filter] : [];

  const { results } = await env.DB
    .prepare(`SELECT id, name, url, avatar, desc, status, sort, created_at
                FROM friends ${where} ORDER BY
                CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                sort DESC, id DESC
               LIMIT 300`)
    .bind(...args)
    .all();

  return H.json({ ok: true, data: { items: (results || []).map(mapFriend), total: (results || []).length, filter } });
}

async function setStatus(id, status, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('友链 id 不合法');
  const r = await env.DB.prepare('UPDATE friends SET status = ?1 WHERE id = ?2').bind(status, id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条友链不存在', 404);
  await H.auditLog(env, status === 'approved' ? 'friend_approve' : 'friend_reject',
    { target: id, detail: status, ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id, status } });
}

async function update(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('友链 id 不合法');
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const name = H.sanitizeText(body.name, 30);
  const url = normalizeUrl(body.url);
  const desc = H.sanitizeText(body.desc, 80);
  const avatarRaw = String(body.avatar || '').trim();
  const avatar = avatarRaw ? normalizeUrl(avatarRaw) : null;
  const sort = parseInt(body.sort, 10) || 0;

  if (!name) return jsonError('名称不能为空');
  if (!url) return jsonError('网址不合法');

  const r = await env.DB
    .prepare('UPDATE friends SET name = ?1, url = ?2, avatar = ?3, desc = ?4, sort = ?5 WHERE id = ?6')
    .bind(name, url, avatar, desc, sort, id)
    .run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条友链不存在', 404);
  await H.auditLog(env, 'friend_approve', { target: id, detail: '修改资料', ip: H.clientIp(request) });
  return H.json({ ok: true, data: { id } });
}

async function remove(id, request, env, H) {
  if (!Number.isInteger(id) || id <= 0) return jsonError('友链 id 不合法');
  const r = await env.DB.prepare('DELETE FROM friends WHERE id = ?1').bind(id).run();
  if (!(r.meta && r.meta.changes)) return jsonError('这条友链不存在', 404);
  await H.auditLog(env, 'friend_delete', { target: id, ip: H.clientIp(request) });
  return H.json({ ok: true, data: { deleted: id } });
}

export async function route({ path, method, request, env, H }) {
  if (path === '/api/friends' && method === 'GET') return listPublic(env, H);
  if (path === '/api/friends' && method === 'POST') return apply(request, env, H);

  if (path === '/api/admin/friends' && method === 'GET') return listAdmin(request, env, H);

  let m = path.match(/^\/api\/admin\/friends\/([^/]+)\/approve$/);
  if (m && method === 'POST') {
    let on = true;
    try { const b = await request.json(); if (b && b.approve === false) on = false; } catch (e) {}
    return setStatus(Number(m[1]), on ? 'approved' : 'pending', request, env, H);
  }

  m = path.match(/^\/api\/admin\/friends\/([^/]+)\/reject$/);
  if (m && method === 'POST') return setStatus(Number(m[1]), 'rejected', request, env, H);

  m = path.match(/^\/api\/admin\/friends\/([^/]+)$/);
  if (m && method === 'DELETE') return remove(Number(m[1]), request, env, H);
  if (m && method === 'POST') return update(Number(m[1]), request, env, H);

  return null;
}
