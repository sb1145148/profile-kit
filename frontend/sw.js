/* ============================================================
 *  Service Worker —— 让站点可以"添加到主屏"并离线访问
 *  文件：frontend/sw.js
 *
 *  策略：
 *    静态资源（HTML / CSS / JS / 图标）   cache-first + 后台更新
 *    接口 GET（/api/...）                 network-first，断了就用缓存兜底
 *    接口写操作（POST / PUT / DELETE）    直接放行，不缓存
 *    图片（/api/media/...）               cache-first（地址带随机 token，内容不会变）
 *
 *  ⚠️ 下面的 CACHE 版本号和 SHELL 里的 ?v= 都**由 build/release.mjs 自动维护**，
 *     不要手改 —— 它是按各资源的 sha256 前缀算出来的：
 *       · 文件内容一变，?v= 就变，URL 就变，天然不会命中旧缓存
 *       · 一个都没变，CACHE 也不变，不会白白让用户重新拉一遍全部资源
 *     发版前跑：node build/release.mjs
 * ============================================================ */

const CACHE = 'your-site-840ece3d';   // ← 发版脚本会替换成真实哈希

const SHELL = [
  '/',
  '/index.html',
  '/articles.html',
  '/archive.html',
  '/tags.html',
  '/site-map.html',
  '/now.html',
  '/about.html',
  '/search.html',
  '/changelog.html',
    // ⚠️ 页面用的是 pretty URL（/changelog、/articles），但预缓存的是 .html 文件。
    //    两者 URL 不同，cache.match(req) 匹配不上 —— 离线时就只能回落到首页。
    //    所以这里把 pretty URL 也一并预缓存，让 cache.match(req) 直接命中。
  '/articles',
  '/archive',
  '/tags',
  '/site-map',
  '/now',
  '/about',
  '/search',
  '/changelog',
  '/404.html',
  '/style.css?v=c80c92e0',
  '/tailwind.css?v=b05bda35',
  '/core.js?v=c06a10c4',
  '/app.js?v=37b5bb0c',
  '/articles.js?v=a65834bd',
  '/pages.js?v=17c9135c',
  '/media.js?v=146f46d9',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/manifest.json',
];

/* ---------------- 安装：预缓存应用外壳 ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个加，某个文件 404 不至于让整次安装失败
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
    ));
    await self.skipWaiting();
  })());
});

/* ---------------- 激活：清掉旧版本缓存 ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------------- 请求拦截 ---------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET，写操作直接走网络
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 别的域名（比如 GitHub 头像）不插手，避免出奇怪的缓存问题
  if (url.origin !== self.location.origin && !url.hostname.endsWith('example.com')) return;

  // 图片：地址里带随机 token，内容永远不变 → cache-first
  if (url.pathname.startsWith('/api/media/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 其它接口：network-first，断了用缓存兜底（这样离线也能看到上次的内容）
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 页面导航：network-first，断网就回缓存，再不行回首页
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, true));
    return;
  }

  // 静态资源：cache-first
  event.respondWith(cacheFirst(req));
});

/* ---------------- 策略实现 ---------------- */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;

  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    // 静态资源实在拿不到，也别抛错
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function networkFirst(req, isNavigate = false) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // 只缓存成功的 GET 响应
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (isNavigate) {
      // ⚠️ 站内页面用的是 pretty URL（/changelog、/articles），
      //    但 SHELL 里预缓存的是对应的 .html 文件。
      //    所以 cache.match('/changelog') 是**不命中**的 ——
      //    直接回落到 index.html 的话，用户离线打开 /changelog
      //    看到的会是首页，URL 却还是 /changelog，很迷惑。
      //
      //    这里先按 <path>.html 找一次，找到就返回正确的页面。
      const path = new URL(req.url).pathname;
      if (path !== '/' && !path.includes('.')) {
        const page = await cache.match(path.replace(/\/$/, '') + '.html');
        if (page) return page;
      }
    
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return new Response(JSON.stringify({ ok: false, error: '离线状态，暂时拿不到数据' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
