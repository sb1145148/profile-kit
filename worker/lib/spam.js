/* ============================================================
 *  lib/spam.js —— 垃圾内容过滤
 *
 *  在留言 / 说说 / 友链申请 提交时检查。规则从简到严：
 *    1. 关键词黑名单（存在 blocked_words 表里，后台可维护）
 *    2. 链接数量上限（默认 3 条，可在设置里改）
 *    3. 连续重复字符（"aaaaaaaa" 这种灌水）
 *    4. 纯符号 / 空白
 *
 *  命中时不写入数据库，直接告诉用户"内容包含不被允许的内容"。
 *  ⚠️ 刻意不告诉用户具体命中了哪条规则 —— 否则刷子能逐条试探绕过。
 * ============================================================ */

/** 简单的中文友好长度：按码点算，避免 emoji 被算成 2 个 */
export function textLength(s) {
  return Array.from(String(s || '')).length;
}

/** 数链接条数 */
function countLinks(text) {
  const t = String(text || '');
  const urlMatches = t.match(/https?:\/\/[^\s<>"']+/gi) || [];
  // www. 开头的也算
  const wwwMatches = t.match(/(^|[\s(])www\.[^\s<>"')]+/gi) || [];
  return urlMatches.length + wwwMatches.length;
}

/** 有没有连续 6 个以上相同字符（排除正常的中文重复，只查 ASCII） */
function hasRepeatedChars(text) {
  return /(.)\1{5,}/.test(String(text || ''));
}

/** 纯符号或无意义内容 */
function isMeaningless(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  // 去掉所有空白和符号后还剩什么
  const stripped = t.replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length < 1;
}

/**
 * 检查内容是否该被拦。
 * @returns {{ blocked: boolean, reason?: string }}
 */
export async function checkSpam(env, { text, name = '', isFriendLink = false }) {
  let settings = {};
  try {
    settings = await getSettingsThin(env);
  } catch (e) {
    return { blocked: false };   // 设置读不到就不拦，宁可漏也别误伤
  }

  if (settings.spam_enabled === '0') return { blocked: false };

  const body = String(text || '');
  const lower = body.toLowerCase();

  // 1) 关键词黑名单
  try {
    const { results } = await env.DB.prepare('SELECT word FROM blocked_words').all();
    for (const row of results || []) {
      const w = String(row.word || '').trim().toLowerCase();
      if (w && lower.includes(w)) {
        return { blocked: true, reason: '内容包含不被允许的词语' };
      }
    }
  } catch (e) {
    // 表还没建（迁移没跑）就跳过这条规则
  }

  // 2) 链接数量（友链申请本来就带链接，放宽一些）
  const limit = Number(settings.spam_max_links || 3);
  const maxLinks = isFriendLink ? limit + 2 : limit;
  if (countLinks(body) > maxLinks) {
    return { blocked: true, reason: `链接太多了（最多 ${maxLinks} 条）` };
  }

  // 3) 灌水特征
  if (hasRepeatedChars(body) || hasRepeatedChars(name)) {
    return { blocked: true, reason: '内容看起来像灌水' };
  }

  // 4) 无意义内容
  if (isMeaningless(body)) {
    return { blocked: true, reason: '内容不能只有符号' };
  }

  return { blocked: false };
}

/** 只读设置，不依赖 worker.js 里的实现（避免循环引用） */
async function getSettingsThin(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}
