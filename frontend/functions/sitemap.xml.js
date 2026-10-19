/* ============================================================
 *  functions/sitemap.xml.js —— 动态 sitemap
 *
 *  静态 sitemap 列不了文章详情页（slug 是动态的），
 *  所以这里实时生成：固定页面 + 所有已发布文章。
 *
 *  搜索爬虫会来抓 /sitemap.xml，拿到的是带全部文章的版本。
 * ============================================================ */

/**
 * 安全响应头。
 *
 * ⚠️ 为什么 Function 里要再写一遍：frontend/_headers 只对**静态资源**生效，
 *    Pages 不会把它套到 Function 返回的响应上。所以这些头现在有两个来源：
 *      · 静态资源 → _headers 文件
 *      · /a/<slug>、/sitemap.xml → 这里
 *    改的时候两处都要改。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=(), payment=(), usb=()',
};

const DEFAULT_API = 'https://api.example.com';
const DEFAULT_SITE = 'https://example.com';

const PAGES = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/articles', changefreq: 'weekly', priority: '0.9' },
  { path: '/archive', changefreq: 'weekly', priority: '0.7' },
  { path: '/tags', changefreq: 'weekly', priority: '0.6' },
  { path: '/about', changefreq: 'monthly', priority: '0.7' },
  { path: '/now', changefreq: 'weekly', priority: '0.6' },
  { path: '/site-map', changefreq: 'monthly', priority: '0.4' },
  { path: '/search', changefreq: 'monthly', priority: '0.3' },
  // 更新日志会经常变，优先级放在 about 和 search 之间
  { path: '/changelog', changefreq: 'weekly', priority: '0.5' },
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 'YYYY-MM-DD HH:MM:SS'（UTC） → W3C 格式 */
function w3c(ts) {
  if (!ts) return null;
  const d = new Date(String(ts).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export async function onRequestGet(context) {
  const { env } = context;
  const apiBase = (env && env.API_BASE) || DEFAULT_API;
  const siteBase = (env && env.SITE_BASE) || DEFAULT_SITE;

  let articles = [];
  try {
    const res = await fetch(`${apiBase}/api/articles?size=30`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.ok && j.data && Array.isArray(j.data.items)) articles = j.data.items;
    }
  } catch (e) {
    // 拿不到文章也照样输出静态页面部分，不整个 500
  }

  const rows = [];

  for (const p of PAGES) {
    rows.push(`  <url>
    <loc>${esc(siteBase + p.path)}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`);
  }

  for (const a of articles) {
    const lastmod = w3c(a.updated_at || a.created_at);
    rows.push(`  <url>
    <loc>${esc(siteBase + '/a/' + encodeURIComponent(a.slug))}</loc>${lastmod ? `
    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join('\n')}
</urlset>
`;

  return new Response(xml, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
      'x-sitemap-articles': String(articles.length),
    },
  });
}
