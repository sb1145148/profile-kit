/* ============================================================
 *  lib/markdown.js —— 极简 Markdown 渲染
 *
 *  安全性：**先整体做 HTML 转义，再套 Markdown 规则**。
 *  所以输入里的 <script> 早就变成 &lt;script&gt; 了，不可能被当成标签执行。
 *  这比"先渲染再过滤"安全得多 —— 后者容易被各种畸形标签绕过。
 *
 *  支持（够个人博客用就行，不做完整实现）：
 *    # ## ### 标题
 *    **粗体**  *斜体*  ~~删除线~~  `行内代码`
 *    [文字](链接)   ![说明](图片)
 *    - 无序列表     1. 有序列表
 *    > 引用
 *    ``` 代码块 ```
 *    --- 分割线
 *    空行分段
 * ============================================================ */

/** 只放行安全的链接协议，挡掉 javascript: / data: 这类 */
function isSafeUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return false;
  if (u.startsWith('javascript:') || u.startsWith('data:') || u.startsWith('vbscript:')) return false;
  return /^(https?:\/\/|mailto:|\/|#)/.test(u);
}

/** 把连续的文本行转成 <p>，其余交给调用方 */
function wrapParagraphs(html) {
  return html
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      // 已经是块级元素（列表 / 引用 / 标题 / 代码块 / 分割线）就不要套 <p>
      if (/^<(h[1-6]|ul|ol|blockquote|pre|hr|p|figure|table|div)\b/.test(chunk)) return chunk;
      return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

/**
 * @param {string} src
 * @param {object} [opts]  语法白名单。默认全开（文章正文用）。
 *   留言板会关掉标题/图片/表格 —— 见 worker.js 的 renderMessageHtml()
 */
export function renderMarkdown(src, opts = {}) {
  const allowHeadings = opts.allowHeadings !== false;
  const allowImages = opts.allowImages !== false;
  const allowTables = opts.allowTables !== false;
  if (!src) return '';
  let text = String(src).replace(/\r\n?/g, '\n');

  // ---------- 1) 整体转义（这一步是安全性的根基） ----------
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ---------- 2) 先摘出代码块，避免里面的符号被后续规则破坏 ----------
  const blocks = [];
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push(
      `<pre class="md-pre"><code${lang ? ` data-lang="${lang}"` : ''}>${code.replace(/\n$/, '')}</code></pre>`
    );
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  // ---------- 3) 行内规则 ----------
  const inline = (s) =>
    s
      .replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
        if (!isSafeUrl(url)) return m;
        // 不许图片时降级成文字链接：直接丢掉会让人疑惑「我写的图呢」，
        // 放行又意味着任何人能让别人的浏览器去加载任意地址
        // （追踪像素、慢资源、不合适的内容）。留言板选前者。
        if (!allowImages) return `<a href="${url}" target="_blank" rel="noopener noreferrer">🖼 ${alt || '图片'}</a>`;
        return `<img src="${url}" alt="${alt}" loading="lazy" class="md-img">`;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
        isSafeUrl(url)
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : m)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // ---------- 4) 按行处理块级结构 ----------
  const lines = text.split('\n');
  const out = [];
  let list = null;        // { type: 'ul' | 'ol', items: [] }
  let quote = [];         // 引用缓存

  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${wrapParagraphs(quote.map(inline).join('\n'))}</blockquote>`);
    quote = [];
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trimEnd();

    // ---- 表格 ----
    // 形如：
    //   | 表头 | 表头 |
    //   | --- | --- |
    //   | 单元格 | 单元格 |
    // 判定条件是"当前行以 | 开头，且下一行是分隔行"
    if (allowTables && /^\s*\|.*\|\s*$/.test(line) && li + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[li + 1]) && lines[li + 1].includes('-')) {
      flushList(); flushQuote();

      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      li++; // 跳过分隔行

      const rows = [];
      while (li + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[li + 1])) {
        li++;
        rows.push(cells(lines[li]));
      }

      out.push(
        '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
        head.map((c) => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>'
      );
      continue;
    }

    // 代码块占位符：单独一行，直接放回
    if (/^\u0000B\d+\u0000$/.test(line.trim())) {
      flushList(); flushQuote();
      out.push(line.trim());
      continue;
    }

    // 引用
    if (/^&gt;\s?/.test(line)) {
      flushList();
      quote.push(line.replace(/^&gt;\s?/, ''));
      continue;
    }
    flushQuote();

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushList(); out.push('<hr>'); continue;
    }

    // 标题
      // 标题（留言板关掉：卡片里冒出个 h1 会破坏层级和排版）
      const h = allowHeadings ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (h) {
      flushList();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(ul[1]);
      continue;
    }

    // 有序列表
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(ol[1]);
      continue;
    }

    flushList();
    // 普通段落也要过一遍行内规则（粗体/斜体/链接/行内代码都在这里处理）
    out.push(line.trim() ? inline(line) : '');
  }
  flushList(); flushQuote();

  // ---------- 5) 分段 + 还原代码块 ----------
  let html = wrapParagraphs(out.join('\n'));
  html = html.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[Number(i)] || '');

  // 防止引用块里出现空的 <p></p>
  return html.replace(/<p>\s*<\/p>/g, '').trim();
}

/** 从 Markdown 里抽纯文本做摘要（去掉标记符号，截断到指定长度） */
export function markdownToText(src, maxLen = 160) {
  const t = String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // ⚠️ 必须按**码点**截，不能按 UTF-16 码元截。
  //
  //    JS 的 slice() 数的是 UTF-16 码元，一个 emoji（比如 🖐）占两个码元。
  //    如果截断位置正好落在代理对中间，就会留下一个孤立的**高代理项**
  //    （0xD800~0xDBFF）—— 这个字符在 UTF-8 里编码出来是 ED A0 xx，
  //    属于非法字节序列，XML 1.0 明确禁止。
  //
  //    实际后果：RSS 订阅源整个解析失败（浏览器和阅读器都报 XML 不合法）。
  //
  //    这个 bug 是线上真实触发的：说说 #13 的内容是「🖐️😭🖐️梁圣…」，
  //    截 40 个码元正好切在 emoji 中间。
  const chars = Array.from(t);              // 按码点拆（会自动处理代理对）
  return chars.length > maxLen ? chars.slice(0, maxLen).join('') + '…' : t;
}
