/* ============================================================
 *  functions/a/[slug].js —— 文章的「可分享」地址
 *
 *  为什么需要这个东西：
 *    /articles?slug=xxx 这个地址是靠前端 JS 去改 document.title 的。
 *    但微信、QQ、微博、Twitter 这些平台的爬虫**不执行 JS**，
 *    它们抓到的永远是 articles.html 里那句写死的 <title>文章 · Demo</title>，
 *    于是分享出去就是一张没有任何信息的通用卡片。
 *
 *  解决办法：
 *    在边缘把文章标题 / 摘要 / 封面**服务端注入**到 HTML 里，
 *    爬虫拿到的是已经带好 og 标签的页面。
 *
 *  访问 /a/<slug> 时：
 *    1. 向 API 取文章
 *    2. 取静态的 articles.html 原文
 *    3. 注入 og / twitter 标签 + canonical + window.__ARTICLE_SLUG__
 *    4. 返回
 *
 *  普通用户看到的还是同一个页面（articles.js 会从 __ARTICLE_SLUG__ 读到 slug 并渲染）。
 * ============================================================ */

/**
 * 安全响应头。
 *
 * ⚠️ 为什么 Function 里要再写一遍：frontend/_headers 只对**静态资源**生效，
 *    Pages 不会把它套到 Function 返回的响应上。所以这些头现在有两个来源：
 *      · 静态资源（/, /style.css, /articles…）→ _headers 文件
 *      · /a/<slug>、/sitemap.xml           → 这里
 *    改的时候两处都要改（还有 /api/* 是 Worker，在另一个仓库目录里）。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=(), payment=(), usb=()',
};

const DEFAULT_API = 'https://api.example.com';
const DEFAULT_SITE = 'https://example.com';
const DEFAULT_OG_IMAGE = '/og-image.png';

/** 转义 HTML 属性值 —— 标题里可能有引号，不转义会把标签撑破 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把 Markdown 摘要压成一行纯文本，用于 meta description */
function oneLine(s, max = 150) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const slug = Array.isArray(params.slug) ? params.slug.join('/') : String(params.slug || '');

  const apiBase = (env && env.API_BASE) || DEFAULT_API;
  const siteBase = (env && env.SITE_BASE) || DEFAULT_SITE;

  // 拿静态页原文（和普通访问 /articles 得到的完全一样）
  const asset = await env.ASSETS.fetch(new URL('/articles.html', request.url));

  /**
   * 取文章。
   *
   * ⚠️ slug 可能是中文（标题直接生成的那种）。Pages 传给 params 的
   * 到底是解码后的原文还是百分号编码，两种情况都见过 —— 所以这里
   * 两个都试一遍，避免因为编码差异白白退化成通用卡片。
   */
  let article = null;
  const candidates = [...new Set([slug, decodeURIComponent(slug), encodeURIComponent(slug)])];

  for (const c of candidates) {
    try {
      const res = await fetch(`${apiBase}/api/articles/${c}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const j = await res.json();
        if (j && j.ok && j.data) { article = j.data; break; }
      }
    } catch (e) {
      // 网络抖一下就试下一个候选，都失败就退回普通页面
    }
  }

  // 取不到文章也要带上安全头（asset 是原始响应，不带 _headers 的加成）
  if (!article) {
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(asset.body, { status: asset.status, headers });
  }

  const html = await asset.text();

  const url = `${siteBase}/a/${encodeURIComponent(slug)}`;
  const title = article.title || '文章';
  const desc = oneLine(article.summary || '', 150) || `Demo 的文章：${title}`;
  const image = article.cover_url || `${siteBase}${DEFAULT_OG_IMAGE}`;

  const meta = `
<!-- ===== 由 functions/a/[slug].js 注入（爬虫不执行 JS，这些必须是服务端渲染的）===== -->
<title>${esc(title)} · Demo</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Demo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="article:published_time" content="${esc(article.created_at || '')}">
${(article.tags || []).map((t) => `<meta property="article:tag" content="${esc(t)}">`).join('\n')}

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">

<script>window.__ARTICLE_SLUG__ = ${JSON.stringify(String(slug))};</script>
<!-- ===== 注入结束 ===== -->
`;

  // 0) 关键：/a/<slug> 比 /articles 多一层路径，
  //    而 articles.html 里的资源引用全是相对的（articles.js、tailwind.css…），
  //    不处理的话浏览器会去请求 /a/articles.js → 404 → 页面整个瘫掉。
  //    加一个 <base href="/"> 让所有相对地址都从根目录解析。
  let out = html.replace(/<head>/i, '<head>\n<base href="/">');
  if (!out.includes('<base href="/">')) out = '<base href="/">' + out;   // 万一没有 <head>

  // 1) 去掉原来写死的 title，避免页面上出现两个
  out = out.replace(/<title>[\s\S]*?<\/title>/i, '');
  // 2) 顺手把原来的 description 也去掉（默认那条会覆盖不掉）
  out = out.replace(/<meta\s+name="description"[^>]*>\s*/i, '');
  // 3) 注入到 </head> 之前
  out = out.replace('</head>', meta + '</head>');

  return new Response(out, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      // 边缘缓存 5 分钟，别让每次分享抓取都打回源站
      'cache-control': 'public, max-age=300',
      'x-share-card': 'injected',
    },
  });
}
