/* ============================================================
 *  lib/turnstile.js —— Cloudflare Turnstile 人机校验
 *
 *  干嘛用的：留言板和友链申请是公开的写接口，之前只有「垃圾词黑名单」
 *  和「同昵称 5 秒限流」两道防线 —— 换个 IP、写正常中文的机器人挡不住。
 *
 *  ------------------------------------------------------------
 *  两个密钥，性质完全不同：
 *
 *    sitekey   公开的，会出现在网页 HTML 里，谁都能看到
 *    secret    私密的，只能待在服务端，用来向 Cloudflare 验证令牌
 *
 *  所以：
 *    · sitekey 存在 settings 表（后台可改，因为它是公开信息）
 *    · secret  存成 Worker secret（wrangler secret put TURNSTILE_SECRET）
 *
 *  ------------------------------------------------------------
 *  ⚠️ 没配 secret 时**直接放行**，不报错。
 *
 *     这是刻意的：Turnstile 需要去 Cloudflare 后台建 widget 才有密钥，
 *     在建好之前站点不能因此没法留言。所以这里的策略是
 *     「配了就校验，没配就当没这回事」。
 *
 *     代价是：如果哪天误删了 secret，保护会静默消失。
 *     所以 verifyTurnstile 会把 skipped 状态返回出去，让调用方能记日志。
 * ============================================================ */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 校验一枚 Turnstile 令牌。
 *
 * @param {object} env      Worker 环境（读 env.TURNSTILE_SECRET）
 * @param {string} token    前端拿到的那串令牌
 * @param {string} [ip]     访客 IP，可选但建议传 —— 让 Cloudflare 多做一层比对
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, codes?:string[]}>}
 */
export async function verifyTurnstile(env, token, ip) {
  const secret = env && env.TURNSTILE_SECRET;

  // 没配密钥 —— 放行，但明确告诉调用方"这次没校验"
  if (!secret) return { ok: true, skipped: true };

  // 配了密钥但前端没送令牌 —— 这就不对了
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing-token' };
  }

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip && ip !== 'unknown') form.append('remoteip', ip);

  let data = null;
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form });
    data = await res.json();
  } catch (e) {
    // 网络抖一下不能把用户挡在外面 —— 但也不能默认放行。
    // 这里选择"拒绝"，因为被刷的代价比偶尔发不出留言大。
    return { ok: false, reason: 'verify-unreachable' };
  }

  if (data && data.success) return { ok: true };

  const codes = (data && data['error-codes']) || [];
  return { ok: false, reason: 'verify-failed', codes };
}

/**
 * 把「校验失败」翻译成给用户看的话。
 *
 * 大部分情况下用户不需要知道细节 —— 只有「令牌重复使用」和
 * 「令牌过期」是用户能自己解决的（刷新页面重试），这两种说清楚。
 */
export function turnstileErrorMessage(result) {
  if (!result) return '人机校验失败，请刷新页面重试';

  if (result.reason === 'missing-token') {
    return '人机校验没有完成，请稍等片刻再试';
  }
  if (result.reason === 'verify-unreachable') {
    return '人机校验服务暂时联系不上，请稍后重试';
  }

  const codes = result.codes || [];
  // 这两种是"令牌被用过"或"等太久过期了"，用户刷新就能解决
  if (codes.includes('timeout-or-duplicate')) {
    return '这次校验已经用过了，请刷新页面重新提交';
  }
  if (codes.includes('invalid-input-response')) {
    return '人机校验没通过，请刷新页面重试';
  }
  if (codes.includes('invalid-input-secret')) {
    // 这是站长配错了，不该让访客背锅
    return '站点的人机校验配置有问题，请联系站长';
  }
  return '人机校验没通过，请刷新页面重试';
}
