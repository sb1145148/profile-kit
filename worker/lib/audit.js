/* ============================================================
 *  lib/audit.js —— 后台操作日志
 *
 *  后台每次「写」操作都记一条，出问题能回溯：
 *    "那条留言是什么时候被删的？"
 *    "谁把审核开关打开了？"
 *
 *  设计原则：记录日志失败绝不能影响主流程，所以内部全兜异常。
 * ============================================================ */

/** 动作名 → 人类可读描述 */
const ACTION_LABELS = {
  login: '登录后台',
  login_fail: '登录失败',
  delete_message: '删除留言',
  clear_messages: '清空留言',
  approve_message: '通过留言',
  unapprove_message: '撤下留言',
  reply_message: '回复留言',
  clear_reply: '删除回复',
  update_settings: '修改站点设置',
  reset_visits: '访问量归零',
  gallery_add: '上传作品',
  gallery_update: '修改作品',
  gallery_delete: '删除作品',
  post_add: '发布说说',
  post_delete: '删除说说',
  post_approve: '通过说说',
  article_save: '保存文章',
  article_delete: '删除文章',
  friend_approve: '通过友链',
  friend_delete: '删除友链',
  friend_reject: '拒绝友链',
  blocked_word_add: '添加垃圾词',
  blocked_word_del: '删除垃圾词',
  backup_run: '执行备份',
  restore: '从备份恢复',
  selfcheck: '站点自检',
  notify_test: '发送测试通知',
};

export function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

export function allActionLabels() {
  return ACTION_LABELS;
}

/**
 * 写一条操作日志。
 * 永远不会抛异常 —— 日志失败不该让业务操作跟着失败。
 */
export async function auditLog(env, action, { target = null, detail = null, ip = null } = {}) {
  try {
    await env.DB
      .prepare('INSERT INTO audit_log (action, target, detail, ip) VALUES (?1, ?2, ?3, ?4)')
      .bind(
        String(action || 'unknown').slice(0, 40),
        target == null ? null : String(target).slice(0, 60),
        detail == null ? null : String(detail).slice(0, 200),
        ip == null ? null : String(ip).slice(0, 60)
      )
      .run();
  } catch (e) {
    console.error('写操作日志失败:', e && e.message ? e.message : e);
  }
}

/** 读取日志列表（分页） */
export async function listAuditLog(env, { page = 1, size = 30, action = '' } = {}) {
  const offset = (page - 1) * size;
  const hasFilter = !!action;
  const where = hasFilter ? 'WHERE action = ?1' : '';
  const args = hasFilter ? [action] : [];

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`)
    .bind(...args)
    .first();
  const total = totalRow ? totalRow.n : 0;

  const { results } = await env.DB
    .prepare(`SELECT id, action, target, detail, ip, created_at
                FROM audit_log ${where}
               ORDER BY id DESC LIMIT ?${hasFilter ? 2 : 1} OFFSET ?${hasFilter ? 3 : 2}`)
    .bind(...args, size, offset)
    .all();

  return {
    items: (results || []).map((r) => ({
      id: r.id,
      action: r.action,
      label: actionLabel(r.action),
      target: r.target || null,
      detail: r.detail || null,
      ip: r.ip || null,
      created_at: r.created_at,
    })),
    total,
    page,
    size,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}
