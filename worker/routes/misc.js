/* ============================================================
 *  routes/misc.js —— 关于我 / 全文搜索 / RSS / GitHub 卡片
 *
 *    GET /api/about                关于我（Markdown 渲染后的 HTML）
 *    GET /api/search?q=&type=      全文搜索（留言 / 说说 / 文章）
 *    GET /api/feed.xml?type=       RSS 订阅（all / articles / posts / messages）
 *    GET /api/github               GitHub 实时卡片（边缘缓存 + 快照兜底）
 * ============================================================ */

const RSS_TTL = 600;

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

const siteUrl = (env) => String(env.SITE_URL || 'https://example.com').replace(/\/+$/, '');

/* ---------------- 关于我 ---------------- */

async function about(env, H) {
  const s = await H.getSettings(env);
  const md = String(s.about_md || '');
  return H.json({
    ok: true,
    data: {
      md,
      html: md.trim() ? H.renderMarkdown(md) : '',
    },
  });
}

/* ---------------- 全文搜索 ---------------- */

/**
 * 跨三张表搜。用 LIKE 就够了 —— 个人站的数据量根本用不上 FTS5，
 * 而且 LIKE 不需要额外维护索引表。
 * 命中片段会在服务端截好，前端直接高亮。
 */
async function search(request, env, H) {
  const url = new URL(request.url);
  const q = H.sanitizeText(url.searchParams.get('q') || '', 40);
  const type = url.searchParams.get('type') || 'all';

  if (!q) return H.json({ ok: true, data: { q: '', total: 0, groups: [] } });

  // ⚠️ 必须用 likeSafe 而不是 '%' + q + '%'：
  //    D1 对 LIKE 模式有 ~50 字节上限，中文按字节算容易超，
  //    超了整个请求会 500（线上真实报过）。
  const like = H.likeSafe(q);
  const want = (t) => type === 'all' || type === t;
  const groups = [];

  const snip = (text, len = 120) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const idx = t.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return t.slice(0, len);
    const start = Math.max(0, idx - 30);
    const out = t.slice(start, start + len);
    return (start > 0 ? '…' : '') + out + (start + len < t.length ? '…' : '');
  };

  if (want('article')) {
    const { results } = await env.DB
      .prepare(`SELECT id, slug, title, summary, content, created_at FROM articles
                 WHERE status = 'published'
                   AND (title LIKE ?1 OR summary LIKE ?1 OR content LIKE ?1 OR tags LIKE ?1)
                 ORDER BY id DESC LIMIT 20`)
      .bind(like).all();
    if (results && results.length) {
      groups.push({
        type: 'article', label: '文章',
        items: results.map((r) => ({
          // ⚠️ 原来是 /article.html?slug=xxx —— 那个路径早就没了，是 404。
          //    站内文章的正式地址是 /a/<slug>（有完整的 og 标签）。
          id: r.id, title: r.title, url: `/a/${encodeURIComponent(r.slug)}`,
          snippet: snip(r.summary || r.content), created_at: r.created_at,
        })),
      });
    }
  }

  if (want('post')) {
    const { results } = await env.DB
      .prepare(`SELECT id, content, created_at FROM posts
                 WHERE status = 'approved' AND content LIKE ?1 ORDER BY id DESC LIMIT 20`)
      .bind(like).all();
    if (results && results.length) {
      groups.push({
        type: 'post', label: '说说',
        items: results.map((r) => ({
          id: r.id, title: '', url: '/#moments',
          snippet: snip(r.content), created_at: r.created_at,
        })),
      });
    }
  }

  if (want('message')) {
    const { results } = await env.DB
      .prepare(`SELECT id, name, content, reply, created_at FROM messages
                 WHERE status = 'approved' AND (name LIKE ?1 OR content LIKE ?1 OR reply LIKE ?1)
                 ORDER BY id DESC LIMIT 20`)
      .bind(like).all();
    if (results && results.length) {
      groups.push({
        type: 'message', label: '留言',
        items: results.map((r) => ({
          id: r.id, title: r.name, url: '/#board',
          snippet: snip(r.content), created_at: r.created_at,
        })),
      });
    }
  }

  const total = groups.reduce((a, g) => a + g.items.length, 0);
  return H.json({ ok: true, data: { q, total, groups } });
}

/* ---------------- RSS ---------------- */

/**
 * XML 转义 + **非法字符清洗**
 *
 * 除了常规的 & < > " '，这里还会清掉 XML 1.0 不允许出现的字符：
 *
 *   1. 控制字符（\u0000-\u0008 等）—— 用户粘贴的文本里偶尔会带
 *   2. 孤立的代理项（surrogate）—— 字符串被按 UTF-16 码元截断时产生。
 *      这类字符转成 UTF-8 会变成 ED A0 xx 这种非法字节，
 *      整个 RSS 源解析失败，阅读器里直接看不到任何内容。
 *
 * 这是**兜底**：截断的问题应该在 markdownToText 那层就修好了
 * （已改成按码点截）。但订阅源是对外的，宁可多一道保险 ——
 * 一个字符坏掉，用户看到的是「这个订阅没内容」，而不会来告诉你为什么。
 */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** '2026-10-11 15:09:00' → RFC822（RSS 要求的格式） */
function rfc822(raw) {
  const s = String(raw || '').trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

async function feed(request, env, H) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'all';
  const base = siteUrl(env);

  const items = [];

  if (type === 'all' || type === 'articles') {
    const { results } = await env.DB
      .prepare(`SELECT slug, title, summary, content, created_at, updated_at
                  FROM articles WHERE status = 'published' ORDER BY id DESC LIMIT 30`)
      .all();
    for (const r of results || []) {
      items.push({
        title: r.title,
        // ⚠️ 原来指向 /article.html?slug=xxx —— 那个路径是 404。
        //    订阅者从阅读器点进来会直接看到「页面不存在」。
        link: `${base}/a/${encodeURIComponent(r.slug)}`,
        guid: `article-${r.slug}`,
        description: r.summary || H.markdownToText(r.content, 200),
        pubDate: rfc822(r.updated_at || r.created_at),
      });
    }
  }

  if (type === 'all' || type === 'posts') {
    const { results } = await env.DB
      .prepare(`SELECT id, content, created_at FROM posts WHERE status = 'approved' ORDER BY id DESC LIMIT 30`)
      .all();
    for (const r of results || []) {
      items.push({
        title: '说说 · ' + H.markdownToText(r.content, 40),
        link: `${base}/#moments`,
        guid: `post-${r.id}`,
        description: r.content,
        pubDate: rfc822(r.created_at),
      });
    }
  }

  if (type === 'messages') {
    const { results } = await env.DB
      .prepare(`SELECT id, name, content, created_at FROM messages
                 WHERE status = 'approved' ORDER BY id DESC LIMIT 50`)
      .all();
    for (const r of results || []) {
      items.push({
        title: `${r.name} 的留言`,
        link: `${base}/#board`,
        guid: `message-${r.id}`,
        description: r.content,
        pubDate: rfc822(r.created_at),
      });
    }
  }

  // 按时间倒序，最新的在最前
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const titles = { all: '站点更新', articles: '文章', posts: '说说', messages: '留言板' };
  const feedTitle = `${H.profileName || 'Demo'} · ${titles[type] || '订阅'}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(feedTitle)}</title>
    <link>${xmlEscape(base)}</link>
    <description>${xmlEscape('个人主页的更新订阅')}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${xmlEscape(`${base}/api/feed.xml?type=${type}`)}" rel="self" type="application/rss+xml"/>
${items.slice(0, 60).map((it) => `    <item>
      <title>${xmlEscape(it.title)}</title>
      <link>${xmlEscape(it.link)}</link>
      <guid isPermaLink="false">${xmlEscape(it.guid)}</guid>
      <description>${xmlEscape(it.description)}</description>
      <pubDate>${it.pubDate}</pubDate>
    </item>`).join('\n')}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${RSS_TTL}`,
    },
  });
}

/* ---------------- GitHub 实时卡片 ---------------- */

/**
 * 带超时和重试的 fetch。
 * GitHub API 偶发连接超时，一次失败就放弃的话卡片会时好时坏，
 * 所以重试 3 次、每次 8 秒超时 —— 最坏 24 秒，但至少不会因为一次抖动就空着。
 */
async function fetchWithRetry(url, init, tries = 2, timeoutMs = 5000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
      if (timer) clearTimeout(timer);
      return res;
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 拉 GitHub 资料 + 仓库。
 * 未认证的 GitHub API 每小时只有 60 次配额，而 Worker 出口 IP 是共享的，
 * 所以必须缓存：
 *   1. 边缘缓存 1 小时（caches.default）
 *   2. D1 里存一份快照，API 挂了就用快照兜底
 */
async function github(request, env, H, ctx) {
  const s = await H.getSettings(env);
  const user = String(s.github_user || 'Demo').trim();
  if (!/^[\w-]{1,39}$/.test(user)) return jsonError('GitHub 用户名不合法');

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://your-site.internal/github/${user}`, { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Cache': 'HIT',
        },
      });
    }
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'your-site',
  };

  let data = null;
  try {
    const [uRes, rRes] = await Promise.all([
      fetchWithRetry(`https://api.github.com/users/${user}`, { headers }),
      fetchWithRetry(`https://api.github.com/users/${user}/repos?sort=updated&per_page=100`, { headers }),
    ]);
    if (uRes.ok) {
      const u = await uRes.json();
      let repos = [];
      if (rRes.ok) {
        const list = await rRes.json();
        repos = (Array.isArray(list) ? list : [])
          .filter((r) => !r.fork)
          .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
          .slice(0, 6)
          .map((r) => ({
            name: r.name,
            url: r.html_url,
            desc: r.description || '',
            stars: r.stargazers_count || 0,
            forks: r.forks_count || 0,
            lang: r.language || '',
            updated_at: r.updated_at,
          }));
      }
      data = {
        login: u.login,
        name: u.name || u.login,
        avatar: u.avatar_url,
        bio: u.bio || '',
        company: u.company || '',
        location: u.location || '',
        blog: u.blog || '',
        html_url: u.html_url,
        public_repos: u.public_repos || 0,
        followers: u.followers || 0,
        following: u.following || 0,
        created_at: u.created_at,
        repos,
        fetched_at: new Date().toISOString(),
        stale: false,
      };
      // 存一份快照兜底
      await H.setSetting(env, 'github_snapshot', JSON.stringify({ ...data, stale: true }));
    }
  } catch (e) {
    console.error('GitHub 拉取失败:', e && e.message ? e.message : e);
  }

  // 拉不到就用快照
  if (!data) {
    const snap = String(s.github_snapshot || '');
    if (snap) {
      try {
        data = { ...JSON.parse(snap), stale: true };
      } catch (e) {}
    }
  }
  // 拿不到数据时返回 200 + 空壳，而不是 503：
  // 这只是个装饰性卡片，不该在浏览器控制台刷一堆红色错误。
  if (!data) {
    data = {
      login: user, name: user, avatar: '', bio: '', location: '',
      html_url: `https://github.com/${user}`,
      public_repos: 0, followers: 0, following: 0,
      repos: [], unavailable: true, stale: true,
      fetched_at: new Date().toISOString(),
    };
  }

  const payload = JSON.stringify({ ok: true, data });
  const res = new Response(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Cache': 'MISS',
    },
  });

  // 只缓存成功的结果
  if (cache && !data.stale && !data.unavailable && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}


/* ---------------- 归档 ---------------- */

/**
 * GET /api/archive —— 按年月分组返回已发布文章
 * 归档页专门用这个，比拉全量列表再在浏览器里分组省事。
 */
async function archive(env, H) {
  const { results } = await env.DB
    .prepare(`SELECT slug, title, created_at, tags, views
                FROM articles WHERE status = 'published'
               ORDER BY created_at DESC, id DESC`)
    .all();

  const years = [];
  const yearMap = new Map();

  for (const r of results || []) {
    // SQLite 存的是 'YYYY-MM-DD HH:MM:SS'（UTC）
    const y = String(r.created_at || '').slice(0, 4) || '未知';
    const m = String(r.created_at || '').slice(5, 7) || '00';

    if (!yearMap.has(y)) {
      const yObj = { year: y, count: 0, months: [] };
      yearMap.set(y, yObj);
      years.push(yObj);
    }
    const yObj = yearMap.get(y);
    yObj.count++;

    let mObj = yObj.months.find((x) => x.month === m);
    if (!mObj) {
      mObj = { month: m, count: 0, items: [] };
      yObj.months.push(mObj);
    }
    mObj.count++;
    mObj.items.push({ slug: r.slug, title: r.title, created_at: r.created_at, views: r.views || 0 });
  }

  return H.json({ ok: true, data: { total: (results || []).length, years } });
}

/* ---------------- 标签 ---------------- */

/** GET /api/tags —— 所有标签及其文章数（只统计已发布的） */
async function tags(env, H) {
  const { results } = await env.DB
    .prepare(`SELECT tags FROM articles WHERE status = 'published'`)
    .all();

  const count = {};
  for (const r of results || []) {
    for (const t of String(r.tags || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)) {
      count[t] = (count[t] || 0) + 1;
    }
  }

  const items = Object.entries(count)
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));

  return H.json({ ok: true, data: { items, total: items.length } });
}

/* ---------------- 网站地图（给人看的） ---------------- */

/** GET /api/site-map —— 站内所有内容的清单，pages 是固定页面 */
async function siteMap(env, H) {
  const base = siteUrl(env);

  const pages = [
    { path: '/', title: '首页', desc: '资料卡 / 技能 / 项目 / 说说 / 歌单 / 作品集 / 友链 / 留言板' },
    { path: '/articles', title: '文章', desc: 'Markdown 博客，带目录和阅读进度' },
    { path: '/archive', title: '归档', desc: '按年月浏览所有文章' },
    { path: '/tags', title: '标签', desc: '按标签找文章' },
    { path: '/about', title: '关于我', desc: '详细的自我介绍' },
    { path: '/now', title: 'Now', desc: '最近在做什么' },
    { path: '/search', title: '搜索', desc: '跨文章、说说、留言的全文搜索' },
    { path: '/site-map', title: '网站地图', desc: '你正在看的这一页' },
  ];

  const articles = (await env.DB
    .prepare(`SELECT slug, title, created_at, tags FROM articles WHERE status = 'published'
               ORDER BY created_at DESC, id DESC`).all()).results || [];

  const posts = (await env.DB
    .prepare(`SELECT id, content, created_at FROM posts WHERE status = 'approved'
               ORDER BY id DESC LIMIT 50`).all()).results || [];

  const friends = (await env.DB
    .prepare(`SELECT name, url, desc FROM friends WHERE status = 'approved' ORDER BY sort DESC, id`).all()).results || [];

  const tagRows = (await env.DB
    .prepare(`SELECT tags FROM articles WHERE status = 'published'`).all()).results || [];
  const tagCount = {};
  for (const r of tagRows) {
    for (const t of String(r.tags || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)) {
      tagCount[t] = (tagCount[t] || 0) + 1;
    }
  }

  return H.json({
    ok: true,
    data: {
      base,
      pages,
      articles: articles.map((a) => ({
        slug: a.slug, title: a.title, created_at: a.created_at,
        tags: String(a.tags || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
      })),
      posts: posts.map((p) => ({
        id: p.id, created_at: p.created_at,
        excerpt: H.markdownToText(p.content, 40),
      })),
      friends: friends.map((f) => ({ name: f.name, url: f.url, desc: f.desc || '' })),
      tags: Object.entries(tagCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      feeds: [
        { title: '站点更新', url: `${base}/api/feed.xml` },
        { title: '文章', url: `${base}/api/feed.xml?type=articles` },
        { title: '说说', url: `${base}/api/feed.xml?type=posts` },
        { title: '留言板', url: `${base}/api/feed.xml?type=messages` },
      ],
    },
  });
}

/* ---------------- Now 页面 ---------------- */

/** GET /api/now —— 「最近在做什么」 */
async function now(env, H) {
  const s = await H.getSettings(env);
  const md = String(s.now_md || '');
  return H.json({
    ok: true,
    data: {
      md,
      html: md.trim() ? H.renderMarkdown(md) : '',
      updated_at: s.now_updated_at || null,
    },
  });
}

export async function route({ path, method, request, env, H, ctx }) {
  if (method !== 'GET') {
    if (path === '/api/search') return null;
  }
  if (path === '/api/about' && method === 'GET') return about(env, H);
  if (path === '/api/search' && method === 'GET') return search(request, env, H);
  if (path === '/api/feed.xml' && method === 'GET') return feed(request, env, H);
  if (path === '/api/github' && method === 'GET') return github(request, env, H, ctx);
  if (path === '/api/archive' && method === 'GET') return archive(env, H);
  if (path === '/api/tags' && method === 'GET') return tags(env, H);
  if (path === '/api/site-map' && method === 'GET') return siteMap(env, H);
  if (path === '/api/now' && method === 'GET') return now(env, H);
  return null;
}
