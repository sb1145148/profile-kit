/* ============================================================
 *  更新日志
 *  文件：frontend/changelog.js
 *
 *  数据来自 GET /api/changelog（按日期倒序）。
 *  正文是后端渲染好的 HTML —— 渲染器在 worker/lib/markdown.js，
 *  前端不再单独实现一遍（复制一份就要同步两处，早晚会漏）。
 * ============================================================ */

/** 把 'YYYY-MM-DD' 转成「2026年10月17日 星期六」这种好读的形式 */
function formatChangelogDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  // 用 UTC 构造，避免本地时区把日期推前一天
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getUTCDay()];
  return `${y}年${Number(mo)}月${Number(d)}日 星期${week}`;
}

function renderChangelogEntry(item) {
  return `
    <li class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time datetime="${escapeHtml(item.date)}"
              class="font-mono text-xs text-slate-500 dark:text-slate-400"
              title="${escapeHtml(item.date)}">${escapeHtml(item.date)}</time>
        <span class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(formatChangelogDate(item.date))}</span>
      </div>
      <h2 class="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(item.title)}</h2>
      ${item.html ? `<div class="prose-custom mt-3 text-sm">${item.html}</div>` : ''}
    </li>`;
}

async function initChangelogPage() {
  const list = $('#changelog-list');
  if (!list) return;

  try {
    const items = await api('/api/changelog');

    $('#changelog-loading').classList.add('hidden');

    if (!items || !items.length) {
      $('#changelog-empty').classList.remove('hidden');
      return;
    }

    list.innerHTML = items.map(renderChangelogEntry).join('');
  } catch (err) {
    $('#changelog-loading').classList.add('hidden');
    const el = $('#changelog-error');
    if (el) {
      el.textContent = '更新日志加载失败：' + err.message;
      el.classList.remove('hidden');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initChangelogPage();
});
