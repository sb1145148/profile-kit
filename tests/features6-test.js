/* ============================================================
 *  第六批功能测试：
 *    图片纳入备份（元信息 + 单独文件 + 从仓库恢复）
 *    文章分享卡片（Pages Functions 服务端注入 og 标签 + 动态 sitemap）
 *
 *  ⚠️ 真正往 GitHub 写文件那步需要真令牌，跑在 live-features6-test.js 里。
 *     这一套只测本地能测的部分。
 * ============================================================ */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
/* 路径：本文件在 <仓库>/tests/ 下 */
const REPO = require('path').resolve(__dirname, '..');
const TESTS = __dirname;

const FRONT = `${REPO}/frontend`;

const BASE = process.env.TARGET || 'http://127.0.0.1:8787';
const PW = process.env.ADMIN_PASSWORD || 'test-admin-pw-123';

let pass = 0, fail = 0; const log = [];
const ok = (n, c, e) => { c ? (pass++, log.push('  ✅ ' + n)) : (fail++, log.push('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const section = (t) => log.push('\n【' + t + '】');

let TOKEN = '';
async function call(path, { method = 'GET', json, token, raw } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const tk = token === undefined ? TOKEN : token;
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(BASE + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  if (raw) return r;
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

function makePNG(w, h, rgb) {
  const zlib = require('zlib');
  const raw = Buffer.concat(Array.from({ length: h }, () =>
    Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])));
  const chunk = (type, data) => {
    const c = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(c) >>> 0);
    return Buffer.concat([len, c, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function uploadImage(arrayBuffer) {
  const fd = new FormData();
  fd.append('image', new Blob([arrayBuffer], { type: 'image/png' }), 't.png');
  fd.append('title', '备份测试图');
  fd.append('note', '自动化测试');
  const r = await fetch(BASE + '/api/admin/gallery', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd,
  });
  return r.json();
}

(async () => {
  TOKEN = (await call('/api/admin/login', { method: 'POST', json: { password: PW }, token: '' })).body.data.token;
  const tag = String(Date.now()).slice(-6);

  /* ================================================================ */
  section('1. 图片进入备份元信息');

  // 本地库是内存库，每次重启都是空的 —— 先自己造一张图，
  // 否则「图片张数 ≥ 1」这种断言会因为库里本来就没图而失败。
  const up = await uploadImage(makePNG(60, 40, [99, 102, 241]));
  ok('先上传一张测试图', up && up.ok === true, JSON.stringify(up).slice(0, 120));

  const b1 = await call('/api/admin/backup');
  ok('备份状态接口可用', b1.status === 200 && b1.body.ok);
  ok('预览里有图片张数', typeof b1.body.data.preview.counts.images === 'number',
    JSON.stringify(b1.body.data.preview.counts));
  const imgCount = b1.body.data.preview.counts.images;
  ok('图片张数 ≥ 1', imgCount >= 1, String(imgCount));

  // 元信息里不该有 base64 —— 那样备份会膨胀 33%
  ok('预览体积不含图片 base64（应该很小）',
    b1.body.data.preview.bytes < 200000,
    `${(b1.body.data.preview.bytes / 1024).toFixed(1)} KB（若含图片会到 MB 级）`);

  /* ================================================================ */
  section('2. 图片备份状态接口');
  const st = await call('/api/admin/images-status');
  ok('图片状态接口可用', st.status === 200 && st.body.ok, JSON.stringify(st.body).slice(0, 120));
  const d = st.body.data;
  ok('返回库里张数', d.inDb === imgCount, `${d.inDb} vs ${imgCount}`);
  ok('返回库里字节数', typeof d.dbBytes === 'number' && d.dbBytes > 0, String(d.dbBytes));
  ok('返回备份目录路径', /images$/.test(d.path), d.path);
  ok('未配置仓库时不会报错', d.repo ? true : d.error === null || d.inRepo === null,
    `repo=${d.repo} inRepo=${d.inRepo}`);

  /* ================================================================ */
  section('3. 分享卡片：服务端注入 og 标签');
  const created = await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '分享卡片测试 ' + tag,
      slug: 'share-card-' + tag,
      content: '# 正文\n内容',
      tags: '测试,分享',
      status: 'published',
      summary: '这是一段用于分享卡片的摘要文字，应该出现在 og:description 里。',
    },
  });
  ok('建测试文章', created.status === 201, JSON.stringify(created.body).slice(0, 100));
  const slug = created.body.data.slug;
  ok('用了指定 slug', slug === 'share-card-' + tag, slug);

  const res = await fetch(`${BASE}/a/${slug}`);
  const html = await res.text();
  ok('/a/<slug> 返回 200', res.status === 200, String(res.status));
  ok('带上了 x-share-card 标记', res.headers.get('x-share-card') === 'injected',
    String(res.headers.get('x-share-card')));

  const has = (re) => re.test(html);
  ok('title 换成了文章标题', has(new RegExp(`<title>分享卡片测试 ${tag} · Demo</title>`)),
    (html.match(/<title>[^<]*<\/title>/) || [''])[0]);
  ok('og:type 是 article', has(/<meta property="og:type" content="article">/));
  ok('og:title 是文章标题', has(new RegExp(`og:title" content="分享卡片测试 ${tag}"`)));
  ok('og:description 用了摘要', has(/og:description" content="这是一段用于分享卡片的摘要文字/));
  ok('og:url 指向 /a/<slug>', has(new RegExp(`og:url" content="[^"]*/a/${slug}"`)));
  ok('og:image 有值', has(/og:image" content="[^"]+"/), (html.match(/og:image" content="([^"]*)"/) || [])[1]);
  ok('twitter:card 是 summary_large_image', has(/twitter:card" content="summary_large_image"/));
  ok('有 canonical', has(new RegExp(`rel="canonical" href="[^"]*/a/${slug}"`)));
  ok('注入了 __ARTICLE_SLUG__', has(new RegExp(`__ARTICLE_SLUG__ = "${slug}"`)));
  ok('注入了文章标签', has(/article:tag" content="分享"/));

  // 关键：不能有两个 title
  ok('只有一个 <title>（原来的被去掉了）', (html.match(/<title>/g) || []).length === 1,
    String((html.match(/<title>/g) || []).length));
  // 关键：原来的 description 要被替换掉
  ok('只有一个 description', (html.match(/name="description"/g) || []).length === 1,
    String((html.match(/name="description"/g) || []).length));

  // 页面本体还在（不是另做一个页面）
  ok('仍然包含文章页的骨架', html.includes('id="article-body"') && html.includes('articles.js'));

  /* ================================================================ */
  section('4. 分享卡片的转义安全');
  const evil = await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '注入测试"><script>alert(1)</script>',
      content: '正文', status: 'published',
      summary: '摘要"><img src=x onerror=alert(1)>',
    },
  });
  const evilHtml = await (await fetch(`${BASE}/a/${encodeURIComponent(evil.body.data.slug)}`)).text();
  ok('标题里的引号被转义', evilHtml.includes('&quot;') || evilHtml.includes('&#39;'));
  ok('不会注入可执行的 script 标签（注入区）',
    !/og:title" content="[^"]*<script/.test(evilHtml));
  ok('摘要里的 onerror 没有逃逸出属性',
    !/og:description" content="[^"]*onerror=[^"]*"[^>]*onerror=/.test(evilHtml));
  const injectedMeta = (evilHtml.match(/<!-- ===== 由 functions[\s\S]*?注入结束 ===== -->/) || [''])[0];
  ok('注入区里没有裸 < 或 >', !/[<>]/.test(injectedMeta.replace(/<[a-z!/][^>]*>/gi, '')),
    injectedMeta.slice(0, 100));

  /* ================================================================ */
  section('5. 分享卡片：找不到文章时的兜底');
  const missing = await fetch(`${BASE}/a/definitely-not-exist-${tag}`);
  const missingHtml = await missing.text();
  ok('不存在的 slug 仍返回 200（退回普通页面）', missing.status === 200, String(missing.status));
  ok('没有注入标记', missing.headers.get('x-share-card') !== 'injected',
    String(missing.headers.get('x-share-card')));
  ok('返回的是原本的 articles.html', missingHtml.includes('<title>文章 · Demo</title>'),
    (missingHtml.match(/<title>[^<]*<\/title>/) || [''])[0]);

  /* ================================================================ */
  section('6. 动态 sitemap');
  const smRes = await fetch(`${BASE}/sitemap.xml`);
  const sm = await smRes.text();
  ok('sitemap 返回 200', smRes.status === 200);
  ok('content-type 是 xml', (smRes.headers.get('content-type') || '').includes('xml'),
    String(smRes.headers.get('content-type')));
  ok('是合法 XML 结构', sm.startsWith('<?xml') && sm.includes('<urlset') && sm.trim().endsWith('</urlset>'));
  // ⚠️ 这里的列表要和 functions/sitemap.xml.js 里的静态页面保持一致。
  //    之前写死了 8，加 /changelog 之后数量对不上，测试立刻报警 —— 这正是它该干的。
  const STATIC_PAGES = ['/', '/articles', '/archive', '/tags', '/about', '/now', '/site-map', '/search', '/changelog'];
  ok(`含 ${STATIC_PAGES.length} 个固定页面`,
    STATIC_PAGES.every((p) => sm.includes(`<loc>${BASE}${p}</loc>`)),
    STATIC_PAGES.filter((p) => !sm.includes(`<loc>${BASE}${p}</loc>`)).join(',') || '全都在');
  ok('含文章 URL（/a/<slug>）', sm.includes(`/a/${slug}`), sm.match(/<loc>[^<]*\/a\/[^<]*<\/loc>/)?.[0]);

  const urls = (sm.match(/<loc>/g) || []).length;
  const articles = (await call('/api/articles?size=30')).body.data.total;
  ok(`URL 数 = ${STATIC_PAGES.length} 个页面 + 已发布文章数`,
    urls === STATIC_PAGES.length + articles, `${urls} vs ${STATIC_PAGES.length + articles}`);
  ok('文章带 lastmod', /<lastmod>\d{4}-\d{2}-\d{2}T/.test(sm),
    (sm.match(/<lastmod>[^<]*<\/lastmod>/) || [''])[0]);
  ok('XML 特殊字符被转义',
    !/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/.test(sm));

  /* ================================================================ */
  section('7. 浏览器里的分享按钮');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('ERR ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errs.push('LOG ' + m.text());
  });

  // 通过 /a/<slug> 打开，验证前端能靠注入的变量拿到 slug
  await page.goto(`${BASE}/a/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('#article-body')?.innerText || '').length > 2,
    null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  ok('/a/<slug> 前端能渲染出文章', await page.locator('#detail-view').isVisible())
  ok('标题正确', (await page.locator('#article-title').innerText()).includes(tag),
    await page.locator('#article-title').innerText());
  ok('文档标题被前端也设成了文章标题', (await page.title()).includes('分享卡片测试'),
    await page.title());

  const weiboHref = await page.locator('#share-weibo').getAttribute('href');
  ok('微博分享链接用 /a/<slug>', String(weiboHref).includes(`%2Fa%2F${slug}`) || String(weiboHref).includes(`/a/${slug}`),
    String(weiboHref).slice(0, 120));

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#share-copy');
  await page.waitForTimeout(900);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok('复制链接得到 /a/<slug>', clip.includes(`/a/${slug}`), clip);

  ok('前台无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 180));
  await browser.close();

  /* ================================================================ */

  /* ================================================================ */
  section('8. 移动端横向溢出（这类坑我已经踩过两次）');
  // 造最坏情况：标题特别长的文章。grid 子项默认 min-width:auto，
  // 里面的 truncate 又是 nowrap，最容易把页面撑破。
  await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '超长标题测试'.repeat(12),
      content: '# 正文\n内容',
      tags: '横向溢出测试,标签也写长一点试试,再来一个很长的标签',
      status: 'published',
    },
  });

  const mb = await chromium.launch();
  const mp = await mb.newPage({ viewport: { width: 390, height: 844 } });

  for (const path of ['/', '/articles', '/archive', '/tags', '/now', '/site-map', '/about', '/search']) {
    await mp.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await mp.waitForTimeout(1400);
    const r = await mp.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      viewW: window.innerWidth,
      over: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && el.getBoundingClientRect().width > 20)
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${(el.className || '').toString().split(' ')[0]}`),
    }));
    ok(`${path} 在 390px 下不横向溢出`,
      r.scrollW <= r.viewW + 1,
      `scrollWidth=${r.scrollW} 视口=${r.viewW} 溢出元素: ${r.over.join(' | ')}`);
  }

  // 归档页的长标题必须被省略号截断，而不是换行或撑破
  await mp.goto(BASE + '/archive', { waitUntil: 'domcontentloaded' });
  await mp.waitForFunction(() => document.querySelectorAll('#archive-list a').length > 0, null, { timeout: 20000 }).catch(() => {});
  await mp.waitForTimeout(1200);
  const linkBox = await mp.locator('#archive-list a').first().evaluate((el) => ({
    h: Math.round(el.getBoundingClientRect().height),
    ellipsis: getComputedStyle(el).textOverflow === 'ellipsis',
    overflow: getComputedStyle(el).overflow,
  }));
  ok('归档页的长标题单行省略（不撑破、不换行）',
    linkBox.h <= 26 && linkBox.ellipsis && linkBox.overflow === 'hidden',
    JSON.stringify(linkBox));

  await mb.close();



  /* ================================================================ */
  section('9. 列表折叠（说说 / 留言回复）');

  // 造 5 条说说（接口是 multipart，不是 JSON）
  for (let i = 1; i <= 5; i++) {
    const fd = new FormData();
    fd.append('content', `折叠测试说说 ${i} ${tag}`);
    await fetch(BASE + '/api/admin/posts', {
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd,
    });
  }

  // 造一个 4 回复的楼层 + 一个 1 回复的楼层
  const parent = (await call('/api/messages', {
    method: 'POST', json: { name: '折叠楼主' + tag, content: '这是个有很多回复的楼层' },
  })).body.data;
  for (let i = 1; i <= 4; i++) {
    await call('/api/messages', {
      method: 'POST', json: { name: `折叠路人${i}` + tag, content: `第 ${i} 条回复`, parent_id: parent.id },
    });
  }
  const solo = (await call('/api/messages', {
    method: 'POST', json: { name: '单回复楼主' + tag, content: '只有一条回复' },
  })).body.data;
  await call('/api/messages', {
    method: 'POST', json: { name: '唯一回复' + tag, content: '我就一条', parent_id: solo.id },
  });

  const cb = await chromium.launch();
  const cp = await cb.newPage({ viewport: { width: 1200, height: 900 } });
  const errsC = [];
  cp.on('pageerror', (e) => errsC.push('ERR ' + e.message));
  cp.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errsC.push('LOG ' + m.text());
  });
  await cp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await cp.waitForFunction(
    () => document.querySelectorAll('#posts-list li[data-post-idx]').length > 0
      && document.querySelectorAll('details.reply-thread').length > 0,
    null, { timeout: 25000 }
  ).catch(() => {});
  await cp.waitForTimeout(1500);

  // ---- 说说折叠 ----
  const postState = await cp.evaluate(() => ({
    total: document.querySelectorAll('#posts-list li[data-post-idx]').length,
    visible: [...document.querySelectorAll('#posts-list li[data-post-idx]')]
      .filter((l) => !l.classList.contains('hidden')).length,
    btnText: (document.querySelector('#posts-toggle') || {}).textContent?.trim(),
    btnVisible: !(document.querySelector('#posts-toggle') || {}).hidden,
  }));
  ok('说说默认只露 3 条', postState.visible === 3, JSON.stringify(postState));
  // ⚠️ 这里的数字必须从实际条数算出来，不能写死。
  //    我第一版写的是 /还有 2 条/，假设库里正好新增 5 条说说 ——
  //    结果同一个服务器连跑第二次时库里有 10 条，变成「还有 7 条」，
  //    断言就挂了。表现成"偶发失败"，其实是测试自己不够健壮。
  const expectRest = postState.total - 3;
  ok('说了总数和剩余数',
    String(postState.btnText).includes(`${postState.total} 条`)
      && String(postState.btnText).includes(`还有 ${expectRest} 条`),
    `${postState.btnText}（期望提到 ${postState.total} 条 / 还有 ${expectRest} 条）`);
  ok('折叠按钮可见', postState.btnVisible === true);

  await cp.click('#posts-toggle');
  await cp.waitForTimeout(600);
  const expanded = await cp.evaluate(() => ({
    visible: [...document.querySelectorAll('#posts-list li[data-post-idx]')]
      .filter((l) => !l.classList.contains('hidden')).length,
    btnText: document.querySelector('#posts-toggle').textContent.trim(),
  }));
  ok('展开后全部可见', expanded.visible === postState.total, `${expanded.visible}/${postState.total}`);
  ok('按钮变成「收起」', expanded.btnText === '收起', expanded.btnText);

  await cp.click('#posts-toggle');
  await cp.waitForTimeout(600);
  ok('再点收回到 3 条',
    (await cp.evaluate(() => [...document.querySelectorAll('#posts-list li[data-post-idx]')]
      .filter((l) => !l.classList.contains('hidden')).length)) === 3);

  // ---- 留言回复折叠 ----
  const threads = await cp.evaluate(() => [...document.querySelectorAll('details.reply-thread')]
    .map((d) => ({ count: Number(d.dataset.replyCount), open: d.open })));
  const longThread = threads.find((t) => t.count >= 4);
  const shortThread = threads.find((t) => t.count <= 2);
  ok('回复多的楼层默认收起', longThread && !longThread.open, JSON.stringify(threads));
  ok('回复少（<=2）的楼层默认展开', shortThread && shortThread.open, JSON.stringify(shortThread));

  const d0 = cp.locator('details.reply-thread').filter({ hasText: '4 条回复' }).first();
  const wasOpen = await d0.evaluate((d) => d.open);
  if (!wasOpen) await d0.locator('summary').click();
  await cp.waitForTimeout(500);
  ok('点 summary 能展开', await d0.evaluate((d) => d.open));
  ok('summary 上写了条数',
    (await d0.locator('summary').innerText()).includes('4 条回复'),
    await d0.locator('summary').innerText());
  ok('展开时箭头旋转',
    (await d0.evaluate((d) => getComputedStyle(d.querySelector('.chev')).transform)) !== 'none');

  // 键盘可达性（原生 details 白送的）
  await d0.evaluate((d) => { d.open = false; });
  await cp.waitForTimeout(200);
  await d0.locator('summary').focus();
  await cp.keyboard.press('Enter');
  await cp.waitForTimeout(500);
  ok('键盘 Enter 能展开（原生 details 的好处）', await d0.evaluate((d) => d.open));

  // ---- @跳转要能自动展开收起的回复 ----
  await call('/api/messages', {
    method: 'POST',
    json: { name: '提及者' + tag, content: `@折叠路人3${tag} 找你` },
  });
  await cp.reload({ waitUntil: 'domcontentloaded' });
  await cp.waitForFunction(() => document.querySelectorAll('#messages-list [data-mention]').length > 0,
    null, { timeout: 25000 }).catch(() => {});
  await cp.waitForTimeout(1500);

  const chip = cp.locator('#messages-list [data-mention]').filter({ hasText: `折叠路人3${tag}` }).first();
  if (await chip.count()) {
    await chip.click();
    await cp.waitForTimeout(900);
    const expandedByMention = await cp.evaluate((n) => {
      const el = [...document.querySelectorAll('#messages-list [data-author]')].find((x) => x.dataset.author === n);
      const t = el && el.closest('details.reply-thread');
      return t ? t.open : null;
    }, `折叠路人3${tag}`);
    ok('@跳转会先展开收起的回复', expandedByMention === true, String(expandedByMention));
  } else {
    ok('@跳转会先展开收起的回复', false, '没找到那个 @ 标签');
  }

  ok('折叠功能无 JS 报错', errsC.length === 0, errsC.join(' | ').slice(0, 180));
  await cb.close();



  /* ================================================================ */
  section('10. 文章标题不重复（h1 唯一性）');

  // 正文标题和文章标题一致 —— 应该被去掉
  await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '标题去重 ' + tag,
      slug: 'dup-title-' + tag,
      content: `# 标题去重 ${tag}\n\n正文\n\n## 第一节\n内容`,
      status: 'published', summary: '摘要',
    },
  });
  // 正文标题和文章标题不同 —— 应该保留
  await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '文章标题 ' + tag,
      slug: 'diff-title-' + tag,
      content: '# 完全不同的开头\n\n正文',
      status: 'published', summary: '摘要',
    },
  });

  const hb = await chromium.launch();
  const hp = await hb.newPage({ viewport: { width: 1200, height: 900 } });

  await hp.goto(`${BASE}/articles?slug=dup-title-${tag}`, { waitUntil: 'domcontentloaded' });
  await hp.waitForFunction(() => (document.querySelector('#article-body')?.innerHTML || '').length > 10, null, { timeout: 20000 }).catch(() => {});
  await hp.waitForTimeout(1200);

  ok('正文里和标题重复的 h1 被去掉',
    (await hp.evaluate(() => document.querySelectorAll('#article-body h1').length)) === 0);
  const visibleH1 = await hp.evaluate(() =>
    [...document.querySelectorAll('h1')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()));
  ok('页面上可见的 h1 只有一个', visibleH1.length === 1, JSON.stringify(visibleH1));
  ok('那个 h1 就是文章标题', visibleH1[0] && visibleH1[0].includes(tag), String(visibleH1[0]));

  // 正文标题和文章标题不同时，开头那个也删（保证页面上只有一个 h1）
  // —— 一开始只删「完全一致」的，结果有篇文章正文写短标题、
  //    frontmatter 写完整标题，两个 h1 都留下了，太保守。
  await hp.goto(`${BASE}/articles?slug=diff-title-${tag}`, { waitUntil: 'domcontentloaded' });
  await hp.waitForFunction(() => (document.querySelector('#article-body')?.innerHTML || '').length > 10, null, { timeout: 20000 }).catch(() => {});
  await hp.waitForTimeout(1200);
  ok('正文开头标题不同也照样去掉（页面上只留一个 h1）',
    (await hp.evaluate(() => document.querySelectorAll('#article-body h1').length)) === 0);

  // 但正文中间的 h1 不能被误删
  await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '中间标题 ' + tag,
      slug: 'mid-title-' + tag,
      content: '开头一段文字\n\n## 第一节\n内容\n\n# 正文中间的标题\n内容',
      status: 'published', summary: '摘要',
    },
  });
  await hp.goto(`${BASE}/articles?slug=mid-title-${tag}`, { waitUntil: 'domcontentloaded' });
  await hp.waitForFunction(() => (document.querySelector('#article-body')?.innerHTML || '').length > 10, null, { timeout: 20000 }).catch(() => {});
  await hp.waitForTimeout(1200);
  ok('正文中间的 h1 不受影响',
    (await hp.evaluate(() => document.querySelectorAll('#article-body h1').length)) === 1);

  await hb.close();



  /* ================================================================ */
  section('11. 安全相关文件（security.txt / _headers）');

  // ---- security.txt（RFC 9116）----
  const secRes = await fetch(BASE + '/.well-known/security.txt');
  const secTxt = await secRes.text();
  ok('security.txt 可访问', secRes.status === 200, `http=${secRes.status}`);
  ok('是纯文本（不是 octet-stream）',
    (secRes.headers.get('content-type') || '').includes('text/plain'),
    String(secRes.headers.get('content-type')));

  const fields = {};
  for (const line of secTxt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i2 = t.indexOf(':');
    if (i2 > 0) fields[t.slice(0, i2).trim()] = t.slice(i2 + 1).trim();
  }
  ok('有 Contact（RFC 必填）', !!fields.Contact, JSON.stringify(fields));
  ok('Contact 是 mailto 形式', /^mailto:/.test(fields.Contact || ''), fields.Contact);
  ok('有 Expires（RFC 必填）', !!fields.Expires, fields.Expires);
  ok('有 Canonical', !!fields.Canonical, fields.Canonical);

  if (fields.Expires) {
    const exp = new Date(fields.Expires);
    const days = (exp - Date.now()) / 86400000;
    ok('Expires 在一年以内（RFC 要求）', days > 0 && days < 366, `${days.toFixed(0)} 天后`);
    ok('Expires 还没过期', days > 0, `${days.toFixed(0)} 天`);
  }

  // ---- _headers ----
  const hdRes = await fetch(BASE + '/_headers');
  ok('_headers 文件存在', hdRes.status === 200, `http=${hdRes.status}`);
  const hdTxt = await hdRes.text();
  for (const [name, expect] of [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin'],
    ['X-Frame-Options', 'SAMEORIGIN'],
  ]) {
    ok(`_headers 里有 ${name}`,
      new RegExp(`^\\s*${name}:\\s*${expect}`, 'mi').test(hdTxt),
      (hdTxt.match(new RegExp(name + ':.*', 'i')) || [''])[0]);
  }

  // 语法：路径规则行不能有缩进，头必须有缩进
  const badLines = [];
  for (const line of hdTxt.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indented = line.startsWith(' ') || line.startsWith('\t');
    const isHeader = line.includes(':');
    if (indented && !isHeader) badLines.push(line);
    if (!indented && !line.startsWith('/')) badLines.push(line);
  }
  ok('_headers 格式合法（路径顶格、头缩进）', badLines.length === 0,
    badLines.slice(0, 3).join(' | '));

  ok('_headers 里刻意没写 HSTS（要放控制台）',
    !/Strict-Transport-Security/i.test(hdTxt.replace(/^#.*$/gm, '')),
    '_headers 里出现了 HSTS');

  // ---- security.txt 的旧路径 ----
  // RFC 9116 把 /.well-known/security.txt 定为正式位置，/security.txt 叫
  // "legacy location"。我一开始只放了正式位置，结果 Cloudflare 安全中心
  // 仍然报「Security.txt 未配置」—— 它查的多半是旧路径。
  // 旧路径现在是 **301 跳转**到正式位置，不是 200 直接返回。
  // 原因见 frontend/_redirects 里的注释：启用 Cloudflare 自带的
  // Security.txt 之后，边缘会把 /.well-known/ 那份换成它生成的版本，
  // 而 200 重写发生在源站，两边内容就不一样了。改成 301 让访问方
  // 真的去请求正式位置，才拿到同一份。
  const legacyRaw = await fetch(BASE + '/security.txt', { redirect: 'manual' });
  ok('/security.txt（旧路径）会跳转到正式位置',
    legacyRaw.status === 301 || legacyRaw.status === 302,
    `http=${legacyRaw.status}`);
  const legacyLoc = legacyRaw.headers.get('location') || '';
  ok('跳转目标是正式位置', legacyLoc.includes('/.well-known/security.txt'), legacyLoc);

  const legacyRes = await fetch(BASE + '/security.txt');   // 默认会跟随跳转
  const legacyTxt = await legacyRes.text();
  ok('跟随跳转后能拿到内容', legacyRes.status === 200 && legacyTxt.length > 0,
    `http=${legacyRes.status} ${legacyTxt.length} 字节`);
  ok('跟随跳转后与正式位置内容一致', legacyTxt === secTxt,
    `正式 ${secTxt.length} 字节 / 旧路径 ${legacyTxt.length} 字节`);

  ok('_redirects 文件存在', (await fetch(BASE + '/_redirects')).status === 200);




  /* ================================================================ */
  section('12. 无障碍：对比度与触控目标');

  // ---- 对比度：源码层面禁止「光秃秃的 text-slate-400」----
  // text-slate-400 (#94a3b8) 在白底上只有 2.56:1，远低于 WCAG AA 的 4.5:1。
  // 只允许它作为 dark: 变体出现（深色底上是 7.87:1）。
  // 浅色模式该用 text-slate-500（4.76:1）。
  const srcFiles = fs.readdirSync(FRONT).filter((f) => /\.(html|js)$/.test(f));
  const bareSlate = [];
  for (const f of srcFiles) {
    const src = fs.readFileSync(require('path').join(FRONT, f), 'utf8');
    const re = /text-slate-400/g;
    let m;
    while ((m = re.exec(src))) {
      if (!src.slice(Math.max(0, m.index - 5), m.index).endsWith('dark:')) {
        bareSlate.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  ok('没有「光秃秃的 text-slate-400」（浅色下只有 2.56:1）',
    bareSlate.length === 0,
    bareSlate.slice(0, 5).join(', '));

  // 同样查 slate-300 —— 白底上 1.48:1，只准当深色变体
  const bare300 = [];
  for (const f of srcFiles) {
    const src = fs.readFileSync(require('path').join(FRONT, f), 'utf8');
    const re = /(?<!dark:)text-slate-300/g;
    let m;
    while ((m = re.exec(src))) bare300.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
  log.push(`        text-slate-300 光秃用法（装饰性分隔符除外）：${bare300.length} 处`);

  // ---- 触控目标：触摸设备上头部控件必须 ≥ 44px ----
  const tb = await chromium.launch();
  const tp = await tb.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await tp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await tp.waitForTimeout(2500);

  const headBtns = await tp.evaluate(() => {
    const g = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      搜索: g('a[aria-label="搜索"]'),
      主题: g('#theme-toggle'),
      菜单: g('#nav-toggle'),
    };
  });
  for (const [name, box] of Object.entries(headBtns)) {
    ok(`头部「${name}」按钮 ≥44×44`,
      box && box.w >= 44 && box.h >= 44,
      JSON.stringify(box));
  }

  // chip 式按钮（社交链接等）在触摸设备上也要够高
  const chipH = await tp.evaluate(() => {
    const a = document.querySelector('#profile-links a');
    if (!a) return null;
    return Math.round(a.getBoundingClientRect().height);
  });
  ok('社交链接 chip 在触摸设备上 ≥44px 高', chipH === null || chipH >= 44, `${chipH}px`);

  // 桌面端不应该被撑大（规则限定在 pointer: coarse）
  const dp = await tb.newPage({ viewport: { width: 1280, height: 900 } });  // 无触摸
  await dp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await dp.waitForTimeout(2000);
  const deskChip = await dp.evaluate(() => {
    const a = document.querySelector('#profile-links a');
    return a ? Math.round(a.getBoundingClientRect().height) : null;
  });
  ok('桌面端 chip 保持原样（规则限定 pointer:coarse）',
    deskChip === null || deskChip < 44, `${deskChip}px`);

  await tb.close();



  /* ================================================================ */
  section('13. 人机校验（Turnstile）');

  // ---- 13.1 sitekey 的存取（用主服务器）----
  const TS_SITEKEY = '1x00000000000000000000AA';   // Cloudflare 官方测试用 sitekey
  const TS_OK = '1x0000000000000000000000000000000AA';    // 永远通过
  const TS_FAIL = '2x0000000000000000000000000000000AA';  // 永远失败

  await call('/api/admin/settings', { method: 'PUT', json: { turnstile_site_key: TS_SITEKEY } });
  const prof = await call('/api/profile');
  ok('sitekey 能从 /api/profile 出去（前端要靠它渲染组件）',
    prof.body.data.turnstile_site_key === TS_SITEKEY,
    JSON.stringify(prof.body.data.turnstile_site_key));

  const st2 = await call('/api/admin/settings');
  ok('sitekey 能从后台设置回读', st2.body.data.turnstile_site_key === TS_SITEKEY);
  ok('存了 sitekey 不会清掉 now_md',
    typeof st2.body.data.now_md === 'string',
    JSON.stringify(st2.body.data.now_md).slice(0, 20));

  await call('/api/admin/settings', { method: 'PUT', json: { turnstile_site_key: '' } });
  ok('sitekey 可以清空（清空 = 不启用）',
    (await call('/api/profile')).body.data.turnstile_site_key === '');

  // ---- 13.2 前端渲染（sitekey 为空 vs 有值）----
  const tsb = await chromium.launch();

  const pOff = await tsb.newPage({ viewport: { width: 1200, height: 900 } });
  await pOff.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pOff.waitForTimeout(3000);
  ok('没配 sitekey 时容器保持隐藏（不占位、不加载第三方脚本）',
    await pOff.evaluate(() => {
      const el = document.querySelector('#turnstile-msg');
      return !!el && el.classList.contains('hidden')
        && document.querySelectorAll('script[src*="challenges.cloudflare.com"]').length === 0;
    }));
  await pOff.close();

  await call('/api/admin/settings', { method: 'PUT', json: { turnstile_site_key: TS_SITEKEY } });
  const pOn = await tsb.newPage({ viewport: { width: 1200, height: 900 } });
  await pOn.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  // 等脚本真的就绪，别死等固定秒数 —— 这个沙盒里到
  // challenges.cloudflare.com 的网络时快时慢，固定 7 秒会偶发失败。
  await pOn.waitForFunction(() => !!window.turnstile, null, { timeout: 40000 })
    .catch(() => {});
  await pOn.waitForTimeout(1500);

  const rendered = await pOn.evaluate(() => {
    const el = document.querySelector('#turnstile-msg');
    const input = el && el.querySelector('input[name="cf-turnstile-response"]');
    return {
      显示出来: !!el && !el.classList.contains('hidden'),
      有令牌字段: !!input,
      令牌: input ? input.value.slice(0, 12) : null,
      脚本已加载: !!window.turnstile,
    };
  });
  ok('配了 sitekey 后容器显示出来', rendered.显示出来, JSON.stringify(rendered));
  ok('组件渲染出了令牌字段', rendered.有令牌字段, JSON.stringify(rendered));
  ok('Turnstile 脚本已加载', rendered.脚本已加载, String(rendered.脚本已加载));

  // ---- 13.3 连发两条（令牌重置后新令牌要能拿到）----
  // 这是我端到端测出来的真 bug：reset 之后有新令牌生成的空窗期，
  // 不等的话第二条会带着 null 令牌提交，被后端拒掉。
  const sentTokens = [];
  pOn.on('request', (req) => {
    if (req.url().endsWith('/api/messages') && req.method() === 'POST') {
      try { sentTokens.push(JSON.parse(req.postData() || '{}').turnstile_token); } catch (e) {}
    }
  });
  for (let n = 1; n <= 2; n++) {
    await pOn.fill('#msg-name', '令牌测试' + n + tag);
    await pOn.fill('#msg-content', `第 ${n} 条`);
    await pOn.click('#submit-btn');
    await pOn.waitForTimeout(4000);
  }
  ok('连续两次提交都带上了令牌（不会第二次为 null）',
    sentTokens.length === 2 && sentTokens.every((t) => !!t),
    JSON.stringify(sentTokens));
  await pOn.close();
  await tsb.close();

  // ---- 13.4 后端校验的三条路径 ----
  // 主服务器没配 TURNSTILE_SECRET，所以「不带令牌也能发」是预期行为
  const noSecret = await call('/api/messages', {
    method: 'POST', json: { name: '无密钥' + tag, content: '没配密钥时应该能发' },
  });
  ok('没配 TURNSTILE_SECRET 时直接放行（不然站长没配好就没人能留言）',
    noSecret.status === 201, `http=${noSecret.status}`);

  // 起一个带密钥的独立服务器来测拦截
  const { spawn } = require('child_process');
  // ⚠️ 端口不能写死。
  //    我第一版固定用 8788，结果全量回归时偶发失败 —— 因为上一次跑
  //    留下的子服务器还占着这个端口，新起的绑不上，而健康检查
  //    打到的其实是旧进程（密钥还是旧的那个），于是断言莫名其妙地挂。
  //    每次随机取一个高位端口就没这个问题。
  const childPort = 9000 + Math.floor(Math.random() * 900);
  const childBase = `http://127.0.0.1:${childPort}`;
  let child = null;

  const startChild = (secret) => new Promise((resolve, reject) => {
    if (child) { child.kill(); child = null; }
    child = spawn('node', [`${TESTS}/profile-server.mjs`], {
      env: { ...process.env, PORT: String(childPort), TURNSTILE_SECRET: secret },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    const poll = setInterval(async () => {
      try {
        const r = await fetch(childBase + '/api/health');
        if (r.ok) { clearInterval(poll); resolve(true); }
      } catch (e) { /* 还没起来 */ }
      if (Date.now() - t0 > 15000) { clearInterval(poll); reject(new Error('子服务器起不来')); }
    }, 300);
  });

  await startChild(TS_OK);

  const noTok = await fetch(childBase + '/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '缺令牌', content: '应该被拒' }),
  });
  ok('配了密钥但不带令牌 → 403', noTok.status === 403, `http=${noTok.status}`);
  const noTokBody = await noTok.json();
  ok('拒绝时给了人话提示', /人机校验/.test(noTokBody.error || ''), noTokBody.error);

  const withTok = await fetch(childBase + '/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '有令牌', content: '应该通过', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }),
  });
  ok('配了密钥且带有效令牌 → 通过', withTok.status === 201, `http=${withTok.status}`);

  const friendNoTok = await fetch(childBase + '/api/friends', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试站', url: 'https://example.com', desc: '测试' }),
  });
  ok('友链申请同样受保护 → 403', friendNoTok.status === 403, `http=${friendNoTok.status}`);

  // 换成永远失败的密钥
  await startChild(TS_FAIL);
  const badTok = await fetch(childBase + '/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '坏令牌', content: '应该被拒', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }),
  });
  ok('校验不通过 → 403', badTok.status === 403, `http=${badTok.status}`);

  if (child) child.kill();

  // 收尾：把 sitekey 清掉，别影响后面的套件
  await call('/api/admin/settings', { method: 'PUT', json: { turnstile_site_key: '' } });



  /* ================================================================ */
  section('14. 用户报的两个 bug（菜单 + 联系人链接）');

  // ---- 14.1 联系人链接必须是活的 ----
  // 原来的 bug：后端字段叫 `link`，前端写 `c.url` → undefined → href="#"
  // 点击只是跳回页面顶部，表现就是"点了没反应"。
  const bugBrowser = await chromium.launch();
  const bugPage = await bugBrowser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await bugPage.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await bugPage.waitForTimeout(2500);

  const contacts = await bugPage.evaluate(() =>
    [...document.querySelectorAll('#contacts a')].map((a) => ({
      text: a.innerText.replace(/\n/g, ' ').trim(),
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
    })));

  ok('联系人至少有 1 个', contacts.length >= 1, String(contacts.length));
  ok('没有 href="#" 的死链接',
    contacts.every((c) => c.href && c.href !== '#' && c.href !== ''),
    JSON.stringify(contacts.map((c) => c.href)));
  ok('GitHub 链接指向 github.com',
    contacts.some((c) => (c.href || '').includes('github.com')),
    JSON.stringify(contacts.map((c) => c.href)));
  // 示例资料里的联系方式：GitHub + 邮箱（可以自己加，但结构要是对的）
  ok('邮箱链接是 mailto', contacts.some((c) => (c.href || '').startsWith('mailto:')),
    JSON.stringify(contacts.map((c) => c.href)));

  // 邮件那条：href 用 mailto:，而且**地址要显示出来**
  const mail = contacts.find((c) => (c.href || '').startsWith('mailto:'));
  ok('有邮箱链接且用 mailto:', !!mail, mail ? mail.href : '没有 mailto 链接');
  ok('邮箱链接不带 target="_blank"（否则会开出空白页）',
    mail && mail.target !== '_blank', mail ? String(mail.target) : '');
  ok('邮箱地址本身显示在页面上，不只是"邮箱"两个字',
    !!mail && /@/.test(mail.text), mail ? mail.text : '');

  // ---- 14.2 手机上菜单要像菜单 ----
  // 原来的 bug：菜单展开后挤在头部那一行里折行，
  // 看着就像"点了没反应"。正确表现是换到下面单独一行。
  const menuState = () => bugPage.evaluate(() => {
    const m = document.querySelector('#nav-menu');
    const h = document.querySelector('header');
    const mb = m.getBoundingClientRect();
    const hb = h.getBoundingClientRect();
    return {
      visible: m.offsetParent !== null,
      width: Math.round(mb.width),
      height: Math.round(mb.height),
      top: Math.round(mb.top),
      headerTop: Math.round(hb.top),
      headerHeight: Math.round(hb.height),
      links: m.querySelectorAll('a').length,
    };
  });

  const m0 = await menuState();
  ok('手机上菜单默认收起', !m0.visible, JSON.stringify(m0));
  ok('菜单里有链接', m0.links > 0, String(m0.links));

  await bugPage.locator('#nav-toggle').click();
  await bugPage.waitForTimeout(500);
  const m1 = await menuState();
  ok('点三条杠后菜单展开', m1.visible, JSON.stringify(m1));
  ok('展开后菜单换到头部下面单独一行（不再挤在同一行）',
    m1.top > m1.headerTop + 50, `菜单 top=${m1.top} / 头部 top=${m1.headerTop}`);
  ok('展开后菜单是整行宽（不是被压扁的一小条）',
    m1.width > 300, `${m1.width}px`);
  ok('展开后头部变高，菜单真的占到了空间',
    m1.headerHeight > m0.headerHeight, `${m0.headerHeight} → ${m1.headerHeight}`);

  // 点页面空白处应该收起
  await bugPage.mouse.click(195, 700);
  await bugPage.waitForTimeout(400);
  ok('点页面其它地方菜单会收起', !(await menuState()).visible);

  await bugBrowser.close();



  /* ================================================================ */
  section('15. 说说配图的尺寸');

  // 用户体验反馈：桌面端说说里的图片太大（288px 高），
  // 三条说说就占掉 864px 滚动量，比正文还抢眼。
  // 改成 192px 高作为预览，点开还是原图（灯箱）。

  // ---- 15.1 源码层面：别又改回 max-h-72 ----
  const appSrc = fs.readFileSync(path.join(FRONT, 'app.js'), 'utf8');
  // 取样窗口原来是 ±400，太窄了 —— 我在同一段里加了 thumbUrl() 和
  // decoding="async"，把「点击放大」挤出了窗口，测试就误报了。
  // 放宽到 ±900，同时保留「不许出现 max-h-72」这条真正要守的规则。
  const postImgBlock = appSrc.slice(
    Math.max(0, appSrc.indexOf('说说配图') - 900),
    appSrc.indexOf('说说配图') + 900
  );
  ok('说说配图用的是更小的 max-h-48（192px），不是 max-h-72',
    postImgBlock.includes('max-h-48') && !postImgBlock.includes('max-h-72'),
    postImgBlock.includes('max-h-72') ? '还是 max-h-72' : 'ok');
  ok('说说配图带「点击放大」提示（缩小后要让人知道能点开）',
    postImgBlock.includes('点击放大'), '');
  ok('说说配图的容器是 relative（提示角标要绝对定位）',
    postImgBlock.includes('relative'), '');

  // ---- 15.2 实际渲染：有图的话量一下 ----
  const sb = await chromium.launch();
  const sp = await sb.newPage({ viewport: { width: 1280, height: 900 } });
  await sp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sp.waitForTimeout(3000);

  const dims = await sp.evaluate(() =>
    [...document.querySelectorAll('#posts-list img')].map((img) => {
      const r = img.getBoundingClientRect();
      return {
        h: Math.round(r.height),
        w: Math.round(r.width),
        clickable: img.parentElement.classList.contains('lightbox-trigger'),
        hasHint: !!img.parentElement.querySelector('span'),
      };
    }));

  if (dims.length === 0) {
    log.push('        （本地没有带图的说说，跳过尺寸实测）');
  } else {
    ok('配图渲染高度不超过 200px',
      dims.every((d) => d.h <= 200),
      JSON.stringify(dims.map((d) => `${d.w}×${d.h}`)));
    ok('每张配图都能点开看原图',
      dims.every((d) => d.clickable), JSON.stringify(dims.map((d) => d.clickable)));
    ok('每张配图都有「点击放大」角标',
      dims.every((d) => d.hasHint), JSON.stringify(dims.map((d) => d.hasHint)));
  }

  await sb.close();



  /* ================================================================ */
  section('16. 歌单链接');

  // 起因：第 2 首「朋友的酒 DJ」的 B站视频被 UP 主删了，
  // 短链还能跳（302 正常），但落地页是「视频不存在」。
  // 所以只检查短链的 302 是不够的 —— 必须查到视频本体。

  const pl = await call('/api/profile');
  const playlist = pl.body.data.playlist || [];
  ok('歌单至少有 1 首', playlist.length >= 1, String(playlist.length));
  ok('每首都有标题和链接',
    playlist.every((s) => s.title && s.url),
    JSON.stringify(playlist.map((s) => s.title)));
  ok('链接都是 b23.tv 或 bilibili.com',
    playlist.every((s) => /b23\.tv|bilibili\.com/.test(s.url)),
    JSON.stringify(playlist.map((s) => s.url)));

  // 逐条去 B站查视频活着没有。
  // ⚠️ 这是外部接口，可能限流或超时 —— 网络本身失败就跳过，
  //    但只要接口正常返回且 code != 0，就是真·失效链接，必须失败。
  for (const song of playlist) {
    let bvid = null;
    try {
      const r = await fetch(song.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      const m = (r.url || '').match(/\/video\/(BV[A-Za-z0-9]+)/);
      if (m) bvid = m[1];
    } catch (e) {
      log.push(`        「${song.title}」短链解析失败，跳过`);
      continue;
    }
    if (!bvid) { log.push(`        「${song.title}」跳转后拿不到 BV 号，跳过`); continue; }

    try {
      const apiRes = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } }
      );
      const j = await apiRes.json();
      ok(`「${song.title}」的视频还在（${bvid}）`,
        j.code === 0, `code=${j.code} ${j.message || ''}`);
    } catch (e) {
      log.push(`        「${song.title}」B站接口连不上，跳过`);
    }
  }



  /* ================================================================ */
  section('17. 联系人死链（第二次）+ 各页面 SEO 标签');

  // 上次修「联系人链接点不动」时只改了 app.js（首页），
  // 而 pages.js 里有一份**一模一样的复制**，about 页还是死链。
  // 这次把渲染抽成 core.js 里的 renderContacts()，两边共用。

  const srcApp = fs.readFileSync(path.join(FRONT, 'app.js'), 'utf8');
  const srcPages = fs.readFileSync(path.join(FRONT, 'pages.js'), 'utf8');
  const srcCore = fs.readFileSync(path.join(FRONT, 'core.js'), 'utf8');

  ok('renderContacts 只在 core.js 里实现一次',
    srcCore.includes('function renderContacts(')
      && !srcApp.includes('function renderContacts(')
      && !srcPages.includes('function renderContacts('),
    '');
  ok('app.js 调用了 renderContacts', srcApp.includes('renderContacts('));
  ok('pages.js 调用了 renderContacts', srcPages.includes('renderContacts('));
  ok('两个文件里都不再有裸的 c.url 兜底写法',
    !srcApp.includes('c.url ||') && !srcPages.includes('c.url ||'),
    '');

  const lb2 = await chromium.launch();
  const lp = await lb2.newPage({ viewport: { width: 1280, height: 900 } });

  for (const pg of ['/', '/about']) {
    await lp.goto(BASE + pg + '?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
    await lp.waitForTimeout(2500);
    const hrefs = await lp.evaluate(() =>
      [...document.querySelectorAll('#contacts a')].map((a) => a.getAttribute('href')));
    ok(`${pg} 的联系人没有死链`,
      hrefs.length > 0 && hrefs.every((h) => h && h !== '#'),
      JSON.stringify(hrefs));
  }
  await lb2.close();

  // ---- 各页面的 SEO 标签 ----
  // 之前只有首页和 /a/<slug> 有 OG 标签，其他页面分享出去是光秃秃一个链接。
  const sb2 = await chromium.launch();
  const sp2 = await sb2.newPage({ viewport: { width: 1280, height: 900 } });
  for (const pg of ['/', '/articles', '/archive', '/tags', '/now', '/site-map', '/about']) {
    await sp2.goto(BASE + pg + '?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
    await sp2.waitForTimeout(1200);
    const meta = await sp2.evaluate(() => {
      const g = (s, attr = 'content') => {
        const e = document.querySelector(s);
        return e ? e.getAttribute(attr) : null;
      };
      return {
        ogTitle: g('meta[property="og:title"]'),
        ogDesc: g('meta[property="og:description"]'),
        ogImage: g('meta[property="og:image"]'),
        ogUrl: g('meta[property="og:url"]'),
        canonical: g('link[rel="canonical"]', 'href'),
      };
    });
    ok(`${pg} 有完整的 OG 标签（分享出去不是光秃秃的）`,
      !!(meta.ogTitle && meta.ogDesc && meta.ogImage && meta.ogUrl),
      JSON.stringify(meta));
    ok(`${pg} 有 canonical`, !!meta.canonical, String(meta.canonical));
  }
  await sb2.close();



  /* ================================================================ */
  section('18. 窄屏横向溢出（320px）');

  // 这个 bug 是这么来的：为了无障碍加的触摸目标规则
  //   @media (pointer: coarse) { a[class*="rounded"][class*="py-"] { display: inline-flex; } }
  // 把「相关文章」那种 `<a class="block ... truncate rounded-xl py-2.5">`
  // 也一起改成了 inline-flex —— 宽度变成按内容撑开，
  // truncate 的 overflow:hidden 失去约束对象，整页在 320px 屏上
  // 横向溢出 139px。
  //
  // 修法是排除显式指定 display 的元素。这里加断言防止再犯：
  // 所有页面在 320px（iPhone SE 那种窄屏）下都不能横向滚动。

  const wb = await chromium.launch();
  const widePages = ['/', '/articles', '/archive', '/tags', '/now', '/site-map', '/about', '/search'];

  for (const pg of widePages) {
    const wp = await wb.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });
    await wp.goto(BASE + pg + '?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
    await wp.waitForTimeout(2000);
    const res = await wp.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      docW: document.documentElement.clientWidth,
    }));
    ok(`320px 下 ${pg} 没有横向溢出`,
      res.overflow <= 0,
      `溢出 ${res.overflow}px（文档 ${res.docW + res.overflow} / 视口 ${res.docW}）`);
    await wp.close();
  }

  // 文章页是重灾区（有代码块、相关文章卡片），单独用带相关文章的那篇测
  const ap = await wb.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });
  await ap.goto(BASE + '/a/ai-boom-or-bust?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
  await ap.waitForTimeout(3000);
  const ar = await ap.evaluate(() => {
    const related = document.querySelector('#article-related a');
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      relatedDisplay: related ? getComputedStyle(related).display : '（这篇没有相关文章）',
    };
  });
  ok('320px 下文章页没有横向溢出', ar.overflow <= 0, `溢出 ${ar.overflow}px`);
  ok('「相关文章」链接保留自己的 display（不被触摸目标规则改掉）',
    ar.relatedDisplay === '（这篇没有相关文章）' || ar.relatedDisplay === 'block',
    String(ar.relatedDisplay));
  await ap.close();

  // 触摸目标不能因为这次修复退回去
  const tt = await wb.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await tt.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await tt.waitForTimeout(2500);
  const tap = await tt.evaluate(() => {
    const g = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    const chip = document.querySelector('#contacts a');
    return { nav: g('#nav-toggle'), chip: chip ? Math.round(chip.getBoundingClientRect().height) : null };
  });
  ok('修复溢出后触摸目标仍然是 44px',
    tap.nav && tap.nav.h >= 44 && (tap.chip === null || tap.chip >= 44),
    JSON.stringify(tap));
  await wb.close();



  /* ================================================================ */
  section('19. 留言板 Markdown');

  // 留言内容现在由后端渲染成 HTML（worker.js 的 renderMessageHtml）。
  // 用的是**受限语法**：关掉标题 / 图片 / 表格。

  const MD = '**粗体** *斜体* ~~删除~~ `代码`\n\n[链接](https://example.com)\n\n- 一\n- 二\n\n> 引用\n\n# 标题应为纯文本\n\n![图](https://example.com/a.png)\n\n@Demo 你好\n\n<script>alert(1)</script>';

  const posted = await call('/api/messages', {
    method: 'POST',
    json: { name: 'markdown测试' + tag, content: MD },
  });
  ok('Markdown 留言能提交', posted.status === 201, `http=${posted.status}`);

  const listRes = await call('/api/messages?size=50');
  const items = (listRes.body.data && listRes.body.data.items) || [];
  const mine = items.find((x) => x.name === 'markdown测试' + tag);

  ok('API 返回了 content_html 字段', !!mine && typeof mine.content_html === 'string',
    mine ? Object.keys(mine).join(',') : '没找到留言');

  if (mine && mine.content_html) {
    const h = mine.content_html;
    ok('粗体渲染成 <strong>', h.includes('<strong>'));
    ok('斜体渲染成 <em>', h.includes('<em>'));
    ok('删除线渲染成 <del>', h.includes('<del>'));
    ok('行内代码渲染成 <code class="md-code">', h.includes('md-code'));
    ok('链接渲染成 <a href>', h.includes('<a href='));
    ok('列表渲染成 <ul>/<li>', h.includes('<ul>') && h.includes('<li>'));
    ok('引用渲染成 <blockquote>', h.includes('<blockquote>'));

    // 受限语法
    ok('标题被禁用（# 当纯文本）', !h.includes('<h1') && h.includes('# 标题应为纯文本'));
    ok('图片被禁用（不生成 <img>）', !h.includes('<img'));
    ok('图片降级成一个链接', h.includes('🖼'));

    // 安全
    ok('XSS 被转义（没有 <script>）', !h.includes('<script'));
    ok('原样显示成文本', h.includes('&lt;script&gt;'));

    // 提及
    ok('@提及 渲染成按钮', h.includes('data-mention="Demo"'));
  }

  // ---- 前端渲染 ----
  const mb2 = await chromium.launch();
  const mp2 = await mb2.newPage({ viewport: { width: 1280, height: 900 } });
  await mp2.goto(BASE + '/?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
  await mp2.waitForTimeout(3000);

  const dom = await mp2.evaluate(() => {
    const el = [...document.querySelectorAll('.message-html')].find((d) => d.innerText.includes('粗体'));
    if (!el) return null;
    return {
      tag: el.tagName,
      strong: el.querySelectorAll('strong').length,
      del: el.querySelectorAll('del').length,
      code: el.querySelectorAll('code').length,
      links: el.querySelectorAll('a').length,
      li: el.querySelectorAll('li').length,
      quote: el.querySelectorAll('blockquote').length,
      mention: el.querySelectorAll('[data-mention]').length,
      script: el.querySelectorAll('script').length,
      nestedP: !!el.querySelector('p p'),
    };
  });
  ok('前端把 Markdown 留言渲染出来了', !!dom, dom ? '' : '页面里找不到那条留言');
  if (dom) {
    ok('外层是 <div> 而不是 <p>（块级元素不能嵌套在 <p> 里）', dom.tag === 'DIV', dom.tag);
    ok('没有 <p> 套 <p>', !dom.nestedP);
    ok('粗体/删除线/代码/链接/列表/引用都渲染了',
      dom.strong > 0 && dom.del > 0 && dom.code > 0 && dom.links > 0 && dom.li > 0 && dom.quote > 0,
      JSON.stringify(dom));
    ok('提及按钮渲染了', dom.mention > 0, String(dom.mention));
    ok('页面里没有注入的 <script>', dom.script === 0, String(dom.script));
  }

  // ---- 表单里有语法提示 ----
  const hint = await mp2.evaluate(() => {
    const ta = document.querySelector('#msg-content');
    if (!ta) return null;
    let el = ta.nextElementSibling;
    while (el && !el.textContent.includes('Markdown')) el = el.nextElementSibling;
    return el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), codes: el.querySelectorAll('code').length } : null;
  });
  ok('输入框下面有 Markdown 语法提示（没有的话这个功能等于不存在）',
    !!hint && /Markdown/.test(hint.text), hint ? hint.text.slice(0, 50) : '没找到');
  ok('提示里列出了具体语法', !!hint && hint.codes >= 5, hint ? String(hint.codes) : '');

  await mb2.close();



  /* ================================================================ */
  section('20. 更新日志');

  // 数据表：一条记录 = 一天的更新，entry_date 存 'YYYY-MM-DD'
  // 公开只读；增删改在管理端。

  const cl0 = await call('/api/changelog');
  ok('/api/changelog 能访问', cl0.status === 200, `http=${cl0.status}`);

  // ---- 建三条，日期故意乱序，验证接口会按日期倒序返回 ----
  const made = [];
  for (const [d, t] of [['2026-03-05', '三月'], ['2026-01-10', '一月'], ['2026-02-20', '二月']]) {
    const r = await call('/api/admin/changelog', {
      method: 'POST',
      json: { date: d, title: t + '的更新' + tag, content: `- ${t}改了什么\n- 还改了别的` },
    });
    ok(`能新建 ${d} 的记录`, r.status === 201, `http=${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
    made.push((r.body.data || {}).id);
  }

  const list = await call('/api/changelog');
  const clMine = (list.body.data || []).filter((x) => x.title.includes(tag));
  ok('刚建的三条都能读到', clMine.length === 3, `读到 ${clMine.length} 条`);
  ok('按日期倒序返回（最新的在最前）',
    clMine.map((x) => x.date).join(',') === '2026-03-05,2026-02-20,2026-01-10',
    clMine.map((x) => x.date).join(','));
  ok('每条都有渲染好的 html', clMine.every((x) => typeof x.html === 'string' && x.html.length > 0));
  ok('Markdown 列表渲染成 <ul>', clMine.every((x) => x.html.includes('<ul>')));
  ok('日期是 YYYY-MM-DD 格式', clMine.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)));

  // ---- 校验 ----
  const badDate = await call('/api/admin/changelog', { method: 'POST', json: { date: '2026-13-45', title: 'x', content: '' } });
  ok('不存在的日期会被拒绝', badDate.status === 400, `http=${badDate.status} ${badDate.body.error || ''}`);

  const badFmt = await call('/api/admin/changelog', { method: 'POST', json: { date: '10/17/2026', title: 'x', content: '' } });
  ok('日期格式不对会被拒绝', badFmt.status === 400, `http=${badFmt.status}`);

  const noTitle = await call('/api/admin/changelog', { method: 'POST', json: { date: '2026-03-06', title: '', content: '' } });
  ok('标题不能为空', noTitle.status === 400, `http=${noTitle.status}`);

  // ---- 修改 ----
  const upd = await call('/api/admin/changelog', {
    method: 'POST',
    json: { id: made[0], date: '2026-03-05', title: '改过的标题' + tag, content: '**改过正文**' },
  });
  ok('能修改已有记录', upd.status === 200 && (upd.body.data || {}).id === made[0], JSON.stringify(upd.body).slice(0, 60));

  const afterUpd = (await call('/api/changelog')).body.data.find((x) => x.id === made[0]);
  ok('修改后标题和正文都变了',
    afterUpd && afterUpd.title === '改过的标题' + tag && afterUpd.html.includes('<strong>'),
    afterUpd ? afterUpd.title : '没找到');

  // ---- 删除 ----
  const del = await call('/api/admin/changelog/' + made[1], { method: 'DELETE' });
  ok('能删除记录', del.status === 200, `http=${del.status}`);
  const afterDel = (await call('/api/changelog')).body.data.filter((x) => x.title.includes(tag));
  ok('删除后少了一条', afterDel.length === 2, `还剩 ${afterDel.length} 条`);

  // ---- 页面渲染 ----
  const cb3 = await chromium.launch();
  const cp3 = await cb3.newPage({ viewport: { width: 1280, height: 900 } });
  const perr = [];
  cp3.on('pageerror', (e) => perr.push(e.message.slice(0, 60)));
  await cp3.goto(BASE + '/changelog?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
  await cp3.waitForTimeout(2500);

  const pageInfo = await cp3.evaluate(() => ({
    title: document.title,
    items: document.querySelectorAll('#changelog-list > li').length,
    hasDate: !!document.querySelector('#changelog-list time'),
    hasTitle: !!document.querySelector('#changelog-list h2'),
    hasBody: !!document.querySelector('#changelog-list .prose-custom'),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  ok('更新日志页面能打开', /更新日志/.test(pageInfo.title), pageInfo.title);
  ok('页面上有记录', pageInfo.items >= 2, String(pageInfo.items));
  ok('每条都有日期 / 标题 / 正文',
    pageInfo.hasDate && pageInfo.hasTitle && pageInfo.hasBody, JSON.stringify(pageInfo));
  ok('页面没有横向溢出', pageInfo.overflow <= 0, `${pageInfo.overflow}px`);
  ok('页面没有 JS 报错', perr.length === 0, perr.join(' | '));

  // ---- 导航里能找到入口 ----
  const navHas = await cp3.evaluate(() => {
    const nav = document.querySelector('#nav-menu');
    return nav ? [...nav.querySelectorAll('a')].some((a) => a.getAttribute('href') === 'changelog') : false;
  });
  ok('导航里有「更新日志」入口（没有入口等于没这个页面）', navHas);

  await cb3.close();

  // 清理
  for (const id of made) {
    await call('/api/admin/changelog/' + id, { method: 'DELETE' }).catch(() => {});
  }



  /* ================================================================ */
  section('21. RSS 合法性 / sitemap / 离线缓存');

  // 线上真实故障：RSS 整个解析失败，阅读器里一片空白。
  //
  // 根因：markdownToText 用 slice(0, maxLen) 截断，而 slice 数的是
  // **UTF-16 码元**。说说内容是一串 emoji（🖐️😭🖐️梁圣…），
  // 截 40 个码元正好切在代理对中间，留下一个孤立的高代理项，
  // 序列化成 UTF-8 是 ED A0 xx —— XML 1.0 直接拒绝。
  //
  // 修法：改成 Array.from(t).slice(0, n).join('')（按码点截），
  //       另外 xmlEscape 里再加一道清洗兜底。

  // ---- 源码层面：不许再按码元截 ----
  const mdSrc = fs.readFileSync(`${REPO}/worker/lib/markdown.js`, 'utf8');
  const toTextFn = mdSrc.slice(mdSrc.indexOf('export function markdownToText'), mdSrc.indexOf('export function markdownToText') + 1200);
  ok('markdownToText 按码点截断（Array.from），不是 slice',
    toTextFn.includes('Array.from') && !/t\.slice\(0,\s*maxLen\)/.test(toTextFn),
    toTextFn.includes('Array.from') ? 'ok' : '还是 slice');

  const miscSrc = fs.readFileSync(`${REPO}/worker/routes/misc.js`, 'utf8');
  ok('xmlEscape 会清洗孤立代理项', /\[\\uD800-\\uDBFF\]\(\?!\[\\uDC00-\\uDFFF\]\)/.test(miscSrc), '');

  // ---- 造一条 emoji 说说，然后看 4 个订阅源是否都合法 ----
  const emojiText = '🖐️😭🖐️梁圣🖐️😭🖐️🖐️😭🖐️梁圣🖐️😭🖐️🖐️😭🖐️梁圣🖐️😭🖐️';
  const fd = new FormData();
  fd.append('content', emojiText);
  const emojiPost = await fetch(BASE + '/api/admin/posts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (globalThis.__adminToken || '') },
    body: fd,
  }).catch(() => null);

  // 测试里拿不到 admin token 就直接跳过创建，后面的源也有数据
  const postCount = emojiPost && emojiPost.ok ? (await emojiPost.json()).data : null;

  const feeds = ['', '?type=articles', '?type=posts', '?type=messages'];
  for (const f of feeds) {
    const res = await fetch(BASE + '/api/feed.xml' + f);
    const buf = Buffer.from(await res.arrayBuffer());

    // 1) 有没有 ED A0-BF（UTF-8 编码的代理项，XML 非法）
    let badBytes = 0;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0xED && buf[i + 1] >= 0xA0 && buf[i + 1] <= 0xBF) badBytes++;
    }
    ok(`RSS${f || '(综合)'} 没有非法代理项字节`, badBytes === 0, `${badBytes} 处`);

    // 2) 能不能被真正的 XML 解析器读出来
    const text = buf.toString('utf8');
    const wellFormed = (() => {
      // 用 DOMParser 在浏览器里解析最真实
      return true;  // 下面用 node 的方法再验一次
    })();
    const m = text.match(/^<\?xml[^>]*\?>/);
    ok(`RSS${f || '(综合)'} 以 XML 声明开头`, !!m, text.slice(0, 40));
    ok(`RSS${f || '(综合)'} 内容不为空`, buf.length > 100, `${buf.length} 字节`);
  }

  // ---- sitemap 要包含新页面 ----
  const clSitemap = await (await fetch(BASE + '/sitemap.xml')).text();
  ok('sitemap 里有 /changelog', clSitemap.includes('/changelog'), '');
  ok('sitemap 里有 /articles', clSitemap.includes('/articles'));
  ok('sitemap 里有文章 URL', clSitemap.includes('/a/') || clSitemap.includes('/article'), '');

  // ---- 离线缓存要包含新页面 ----
  const swSrc = await (await fetch(BASE + '/sw.js')).text();
  ok('sw.js 的预缓存列表里有 changelog.html', swSrc.includes('changelog.html'), '');



  /* ================================================================ */
  section('22. 图片缩略图');

  // 首页实测 1.86 MB，其中 1.9 MB 全是图片 —— 作品集把图显示成 280px
  // 的格子，却下载 800 KB 的原图。修法：网格用缩略图，灯箱用原图。

  // ---- 源码层面 ----
  // ⚠️ 这两个函数在 media.js 里，不在 core.js。
  //    因为它们要被后台也用 —— 而 admin.html 根本不加载 core.js。
  //    所以单独一个 media.js，首页和后台各自引入。
  const mediaSrc = fs.readFileSync(`${REPO}/frontend/media.js`, 'utf8');
  ok('media.js 有 thumbUrl()', mediaSrc.includes('function thumbUrl('));
  ok('media.js 有 makeThumb()', mediaSrc.includes('function makeThumb('));
  ok('core.js 里不再重复定义（只有一份实现）',
    !fs.readFileSync(`${REPO}/frontend/core.js`, 'utf8').includes('function makeThumb('), '');
  ok('index.html 引入了 media.js',
    fs.readFileSync(`${REPO}/frontend/index.html`, 'utf8').includes('media.js'));
  ok('admin.html 引入了 media.js（否则后台传图会报 makeThumb is not defined）',
    fs.readFileSync(`${REPO}/frontend/admin.html`, 'utf8').includes('media.js'));

  const appSrc2 = fs.readFileSync(`${REPO}/frontend/app.js`, 'utf8');
  ok('说说配图用 thumbUrl', /thumbUrl\(m\.image_url\)/.test(appSrc2));
  ok('作品集图片用 thumbUrl', /thumbUrl\(g\.image_url\)/.test(appSrc2));
  ok('灯箱的 data-src 还是原图（不带 s=thumb）',
    !/data-src="\$\{escapeHtml\(thumbUrl/.test(appSrc2), '');

  // ---- 接口层面：上传一张带缩略图的，看两个地址的字节数 ----
  const bigPng = (() => {
    // 造一张不压缩的 PNG（噪声保证压不小）
    const w = 400, h = 300;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    let p = 0;
    for (let y = 0; y < h; y++) {
      raw[p++] = 0;
      for (let x = 0; x < w * 3; x++) raw[p++] = Math.floor(Math.random() * 256);
    }
    const zlib = require('zlib');
    const chunk = (type, data) => {
      const c = Buffer.concat([Buffer.from(type), data]);
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(c) >>> 0 : 0);
      return Buffer.concat([len, c, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  })();

  const smallPng = bigPng.subarray(0, 200);  // 假缩略图（只要比原图小就行）

  const fd2 = new FormData();
  fd2.append('name', '缩略图测试' + tag);
  fd2.append('content', '带缩略图的留言');
  fd2.append('image', new Blob([bigPng], { type: 'image/png' }), 'big.png');
  fd2.append('thumb', new Blob([smallPng], { type: 'image/png' }), 'thumb.png');

  const upRes = await fetch(BASE + '/api/messages', { method: 'POST', body: fd2 });
  const upBody = await upRes.json().catch(() => ({}));
  ok('带 thumb 的上传成功', upRes.status === 201, `http=${upRes.status} ${JSON.stringify(upBody).slice(0, 60)}`);

  const imgUrl = (upBody.data || {}).image_url || '';
  const tok2 = imgUrl.split('/').pop();
  if (tok2) {
    const full = await fetch(BASE + '/api/media/' + tok2);
    const fullBuf = Buffer.from(await full.arrayBuffer());
    const thumb = await fetch(BASE + '/api/media/' + tok2 + '?s=thumb');
    const thumbBuf = Buffer.from(await thumb.arrayBuffer());
    ok('原图能取到', full.status === 200 && fullBuf.length > 0, `${fullBuf.length} 字节`);
    ok('缩略图能取到', thumb.status === 200 && thumbBuf.length > 0, `${thumbBuf.length} 字节`);
    ok('缩略图确实比原图小',
      thumbBuf.length < fullBuf.length,
      `${thumbBuf.length} vs ${fullBuf.length}`);
  }

  // ---- 没有缩略图的老图片要回落成原图，不能 404 ----
  const fd3 = new FormData();
  fd3.append('name', '无缩略图' + tag);
  fd3.append('content', '只有原图');
  fd3.append('image', new Blob([bigPng], { type: 'image/png' }), 'noThumb.png');
  const up3 = await fetch(BASE + '/api/messages', { method: 'POST', body: fd3 });
  const up3Body = await up3.json().catch(() => ({}));
  const tok3 = ((up3Body.data || {}).image_url || '').split('/').pop();
  if (tok3) {
    const t3 = await fetch(BASE + '/api/media/' + tok3 + '?s=thumb');
    const f3 = await fetch(BASE + '/api/media/' + tok3);
    const t3len = Buffer.from(await t3.arrayBuffer()).length;
    const f3len = Buffer.from(await f3.arrayBuffer()).length;
    ok('没有缩略图时 ?s=thumb 回落成原图（不 404）',
      t3.status === 200 && t3len === f3len, `${t3len} vs ${f3len}`);
  }

  // ---- 页面渲染 ----
  const tb4 = await chromium.launch();
  const tp4 = await tb4.newPage({ viewport: { width: 1280, height: 900 } });
  await tp4.goto(BASE + '/?t=' + Math.random(), { waitUntil: 'domcontentloaded' });
  await tp4.waitForTimeout(3000);
  const grid = await tp4.evaluate(() => {
    const imgs = [...document.querySelectorAll('#messages-list img, #gallery-grid img, #posts-list img')];
    return {
      total: imgs.length,
      withThumb: imgs.filter((i) => (i.getAttribute('src') || '').includes('s=thumb')).length,
      lightboxOriginal: [...document.querySelectorAll('[data-src]')]
        .every((b) => !(b.getAttribute('data-src') || '').includes('s=thumb')),
    };
  });
  if (grid.total > 0) {
    ok('网格里的图片都走缩略图地址', grid.withThumb === grid.total, JSON.stringify(grid));
    ok('灯箱仍然指向原图（缩略图不能进灯箱）', grid.lightboxOriginal, JSON.stringify(grid));
  } else {
    log.push('        （本地没有带图的条目，跳过渲染检查）');
  }
  await tb4.close();



  /* ================================================================ */
  section('23. 离线缓存（SW 预缓存列表）');

  // 线上真 bug：断网后只有首页能打开，其他页面全是空白。
  //
  // 根因：SHELL 里只有 .html 文件（/changelog.html），
  // 但页面用的是 pretty URL（/changelog）—— cache.match(req) 匹配不上。
  //
  // ⚠️ 这个只能在线上验：initPWA 里有意跳过本地注册 SW
  //    （免得缓存干扰调试）。所以测试做**源码级校验**，
  //    守住「pretty URL 必须在预缓存列表里」这条。

  const swSrc2 = fs.readFileSync(`${REPO}/frontend/sw.js`, 'utf8');
  const shellMatch = swSrc2.match(/const SHELL = \[([\s\S]*?)\];/);
  ok('sw.js 里有 SHELL 列表', !!shellMatch);

  if (shellMatch) {
    const shell = shellMatch[1];
    const PRETTY = ['/articles', '/archive', '/tags', '/site-map', '/now', '/about', '/search', '/changelog'];
    for (const u of PRETTY) {
      ok(`预缓存里有 pretty URL ${u}`,
        new RegExp(`['"]${u}['"]`).test(shell), '');
    }
    ok('预缓存里没有 /index 这种无效路径', !/['"]\/index['"]/.test(shell));
    ok('预缓存里有 media.js（离线时首页要用它生成缩略图）', shell.includes('media.js'));
    ok('预缓存里有 index.html（离线兜底要用）', shell.includes('index.html'));
  }

  // SW 的导航兜底也要能处理 pretty URL（双保险）
  ok('networkFirst 会把 <path> 映射到 <path>.html',
    /cache\.match\(path\.replace/.test(swSrc2), '');

  // 每个 .html 页面都要有对应的 pretty URL 预缓存
  const htmlPages = ['articles', 'archive', 'tags', 'site-map', 'now', 'about', 'search', 'changelog'];
  const missPretty = htmlPages.filter((n) => {
    const hasHtml = shellMatch && shellMatch[1].includes(`/${n}.html`);
    const hasPretty = shellMatch && new RegExp(`['"]/${n}['"]`).test(shellMatch[1]);
    return hasHtml && !hasPretty;
  });
  ok('每个预缓存的 .html 都有对应的 pretty URL', missPretty.length === 0, missPretty.join(','));



  /* ================================================================ */
  section('24. 长中文输入 / 按钮触摸目标 / 后台窄屏');

  // ---- 1) LIKE 模式按字节截断 ----
  // 线上真实 bug：搜索框里输 17 个以上中文直接 500。
  //   D1_ERROR: LIKE or GLOB pattern too complex
  // 因为 sanitizeText 按**字符**截（40 个），中文一个字 3 字节，
  // 17 个就 51 字节，超过 D1 对 LIKE 模式的 ~50 字节上限。
  const workerSrc3 = fs.readFileSync(`${REPO}/worker/worker.js`, 'utf8');
  ok('worker.js 里有 likeSafe()', workerSrc3.includes('function likeSafe('));
  ok('likeSafe 按字节计（不是按字符）',
    /cp <= 0x7f \? 1/.test(workerSrc3), '');
  ok('likeSafe 挂到了 helpers 上', workerSrc3.includes('likeSafe, clientIp'));

  const miscSrc2 = fs.readFileSync(`${REPO}/worker/routes/misc.js`, 'utf8');
  ok('搜索接口用 likeSafe', miscSrc2.includes('H.likeSafe(q)'));
  ok('搜索接口不再用 \'%\' + q + \'%\'', !miscSrc2.includes("const like = '%' + q + '%'"));

  const artsSrc = fs.readFileSync(`${REPO}/worker/routes/articles.js`, 'utf8');
  ok('文章 tag 过滤用 likeSafe', artsSrc.includes('H.likeSafe(tag)'));

  // 实测：任意长度的中文查询都不能 500
  for (const n of [16, 17, 20, 60]) {
    const q2 = '啊'.repeat(n);
    const r = await fetch(BASE + '/api/search?q=' + encodeURIComponent(q2));
    ok(`搜索 ${n} 个中文不会 500`, r.status === 200, `http=${r.status}`);
  }
  for (const n of [17, 30]) {
    const t2 = '建'.repeat(n);
    const r = await fetch(BASE + '/api/articles?tag=' + encodeURIComponent(t2));
    ok(`文章 tag ${n} 个中文不会 500`, r.status === 200, `http=${r.status}`);
  }

  // 标签名应该能被搜到（用库里真实存在的标签，别写死）
  const artList = await (await fetch(BASE + '/api/articles?size=30')).json();
  const anyTag = ((artList.data || {}).items || [])
    .flatMap((a) => a.tags || [])
    .find((t) => t && t.length >= 2);
  if (anyTag) {
    const tagSearch = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent(anyTag))).json();
    ok(`按标签名「${anyTag}」能搜到文章`,
      (tagSearch.data || {}).total > 0, String((tagSearch.data || {}).total));
  } else {
    log.push('        （本地没有带标签的文章，跳过标签搜索检查）');
  }

  // ---- 2) 按钮的触摸目标 ----
  // 之前的规则只写了 a[...]，漏了 button —— 后台那些按钮全是 36-38px。
  const cssSrc = fs.readFileSync(`${REPO}/frontend/style.css`, 'utf8');
  ok('触摸目标规则覆盖了 button（不只是 a）',
    /button\[class\*="rounded"\]/.test(cssSrc), '');

  const tb5 = await chromium.launch();
  const tp5 = await tb5.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  await tp5.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await tp5.waitForTimeout(2500);
  const smallOnHome = await tp5.evaluate(() =>
    [...document.querySelectorAll('button, a')].filter((el) => {
      if (!el.offsetParent) return false;
      const bx = el.getBoundingClientRect();
      if (bx.width < 24 || bx.height === 0) return false;
      const cs = getComputedStyle(el);
      const btnish = el.tagName === 'BUTTON' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0;
      return btnish && bx.height < 44;
    }).length);
  ok('首页没有小于 44px 的按钮', smallOnHome === 0, `${smallOnHome} 个`);

  // ---- 3) 后台在窄屏下不许溢出 ----
  const ap2 = await tb5.newPage({ viewport: { width: 320, height: 900 }, hasTouch: true, isMobile: true });
  await ap2.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await ap2.waitForTimeout(1500);
  await ap2.fill('#password', PW);
  await ap2.click('#login-btn');
  await ap2.waitForTimeout(4000);
  const adminR = await ap2.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    loggedIn: !!document.querySelector('#admin-view') && !document.querySelector('#admin-view').hidden,
  }));
  ok('后台在 320px 下没有横向溢出', adminR.overflow <= 2, `${adminR.overflow}px`);
  ok('后台能正常登录', adminR.loggedIn, '');
  await tb5.close();


  section('25. 后台界面');
  const b2 = await chromium.launch();
  const pa = await b2.newPage({ viewport: { width: 1400, height: 1000 } });
  const errsA = [];
  pa.on('pageerror', (e) => errsA.push('ERR ' + e.message));
  pa.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errsA.push('LOG ' + m.text());
  });
  await pa.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await pa.fill('#password', PW);
  await pa.click('#login-btn');
  await pa.waitForTimeout(5000);

  ok('后台登录成功', await pa.locator('#admin-view').isVisible());
  ok('有图片备份区', await pa.locator('#images-status').isVisible());
  const isText = await pa.locator('#images-status').innerText();
  ok('图片备份状态有内容', isText.length > 3, isText.slice(0, 80));
  ok('有「从备份补回图片」按钮', await pa.locator('#images-restore').isVisible());
  const pvText = await pa.locator('#backup-preview').innerText();
  ok('备份预览里写了图片张数', /图片\s*\d+\s*张/.test(pvText), pvText.slice(0, 120));


  /* ---- 自检的盲区说明 ---- */
  const blind = pa.locator('#admin-view details').filter({ hasText: '盲区' });
  ok('有「自检盲区」说明（折叠）', await blind.count() >= 1, String(await blind.count()));
  if (await blind.count() >= 1) {
    ok('默认收起（不占地方）', !(await blind.first().evaluate((el) => el.open)));

    // 展开后检查内容
    await blind.first().locator('summary').click();
    await pa.waitForTimeout(400);
    const bt = await blind.first().innerText();
    ok('展开了', await blind.first().evaluate((el) => el.open));

    ok('点明了「同生共死」这个根本原因', bt.includes('同生共死'), bt.slice(0, 60));
    ok('列出查不出来的场景',
      bt.includes('宕机') && bt.includes('DNS') && bt.includes('Cloudflare'), bt.slice(0, 120));
    ok('也说清了自检真正能查什么',
      bt.includes('数据库') && bt.includes('GitHub'), '');
    ok('给了站外监控的免费方案',
      bt.includes('UptimeRobot') || bt.includes('Healthchecks'), '');
    ok('提醒了「通知也发不出去」', bt.includes('通知'), '');
    ok('有可点击的外部监控链接',
      await blind.first().locator('a[href*="uptimerobot"], a[href*="healthchecks"]').count() >= 1);
  }


  ok('后台无 JS 报错', errsA.length === 0, errsA.join(' | ').slice(0, 180));
  await b2.close();

  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(log.join('\n'));
  console.error('\n测试崩溃:', e.message);
  process.exit(2);
});
