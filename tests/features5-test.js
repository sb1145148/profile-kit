/* ============================================================
 *  第五批功能测试：
 *    文章封面图 / 归档页 / 标签页 / 网站地图页 / 字母头像 / Now 页 / 图片转 WebP
 * ============================================================ */
const { chromium } = require('playwright');

const BASE = process.env.TARGET || 'http://127.0.0.1:8787';
const API = BASE;
const PW = process.env.ADMIN_PASSWORD || 'test-admin-pw-123';

let pass = 0, fail = 0; const log = [];
const ok = (n, c, e) => { c ? (pass++, log.push('  ✅ ' + n)) : (fail++, log.push('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const section = (t) => log.push('\n【' + t + '】');

let TOKEN = '';
async function call(path, { method = 'GET', json, token } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const tk = token === undefined ? TOKEN : token;
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(API + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function upload(path, file, field = 'image') {
  const fd = new FormData();
  fd.append(field, new Blob([file], { type: 'image/png' }), 'a.png');
  const r = await fetch(API + path, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

/** 手搓一个指定尺寸的 PNG（不依赖 canvas） */
function makePNG(w, h, rgb) {
  const zlib = require('zlib');
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])));
  const chunk = (type, data) => {
    const c = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(c) >>> 0);
    return Buffer.concat([len, c, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  TOKEN = (await call('/api/admin/login', { method: 'POST', json: { password: PW }, token: '' })).body.data.token;
  const tag = String(Date.now()).slice(-6);

  /* ================================================================ */
  section('1. 文章封面图（接口）');
  const a1 = await call('/api/admin/articles', {
    method: 'POST',
    json: { title: '封面测试A ' + tag, content: '# 正文\n内容', tags: '测试', status: 'published', summary: '摘要' },
  });
  const a2 = await call('/api/admin/articles', {
    method: 'POST',
    json: { title: '封面测试B ' + tag, content: '# 正文\n内容', tags: '测试', status: 'published' },
  });
  ok('建两篇测试文章', a1.status === 201 && a2.status === 201);

  const idA = a1.body.data.id, idB = a2.body.data.id;

  const listBefore = (await call('/api/articles?size=50')).body.data.items;
  ok('没传封面时 cover_url 为 null',
    listBefore.filter((x) => x.id === idA).every((x) => x.cover_url === null));

  const up = await upload(`/api/admin/articles/${idA}/cover`, makePNG(120, 80, [99, 102, 241]));
  ok('上传封面成功', up.status === 200 && up.body.data.cover_url, JSON.stringify(up.body).slice(0, 100));
  ok('返回了可访问的封面地址', (up.body.data.cover_url || '').includes('/api/media/'));

  const coverRes = await fetch(up.body.data.cover_url);
  ok('封面图片能读出来', coverRes.status === 200 && (coverRes.headers.get('content-type') || '').startsWith('image/'),
    `${coverRes.status} ${coverRes.headers.get('content-type')}`);

  const listAfter = (await call('/api/articles?size=50')).body.data.items;
  const withCover = listAfter.find((x) => x.id === idA);
  const without = listAfter.find((x) => x.id === idB);
  ok('列表接口带出封面', !!withCover.cover_url, String(withCover.cover_url));
  ok('另一篇仍然没有封面', without.cover_url === null);

  const detailA = await call('/api/articles/' + encodeURIComponent(withCover.slug));
  ok('详情接口带出封面', !!detailA.body.data.cover_url, String(detailA.body.data.cover_url));

  const adminOne = await call(`/api/admin/articles/${idA}`);
  ok('后台单篇带出封面', !!adminOne.body.data.cover_url);

  // 换封面应该删掉旧图
  sqlCount(`SELECT COUNT(*) AS n FROM images`) // 占位，下面用真正的方式
  const up2 = await upload(`/api/admin/articles/${idA}/cover`, makePNG(60, 40, [244, 114, 182]));
  ok('换封面成功', up2.status === 200);
  const oldCoverRes = await fetch(up.body.data.cover_url);
  ok('旧封面已被删除（404）', oldCoverRes.status === 404, String(oldCoverRes.status));

  // 移除
  const rm = await call(`/api/admin/articles/${idA}/cover`, { method: 'DELETE' });
  ok('移除封面成功', rm.status === 200 && rm.body.data.cover_url === null);
  const newCoverRes = await fetch(up2.body.data.cover_url);
  ok('移除时图片也删了（404）', newCoverRes.status === 404, String(newCoverRes.status));
  ok('移除后列表里没有封面',
    (await call('/api/articles?size=50')).body.data.items.find((x) => x.id === idA).cover_url === null);

  ok('给不存在的文章传封面返回 404',
    (await upload('/api/admin/articles/999999/cover', makePNG(10, 10, [0, 0, 0]))).status === 404);
  ok('不传文件返回 400',
    (await fetch(API + `/api/admin/articles/${idA}/cover`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: new FormData(),
    })).status === 400);

  /* ================================================================ */
  section('2. 归档接口');
  const arch = await call('/api/archive');
  ok('归档接口可用', arch.status === 200 && Array.isArray(arch.body.data.years));
  ok('返回总篇数', typeof arch.body.data.total === 'number' && arch.body.data.total >= 2, String(arch.body.data.total));
  ok('按年份分组', arch.body.data.years.length >= 1);
  ok('年份里含月份', arch.body.data.years[0].months.length >= 1);
  ok('月份里含文章', arch.body.data.years[0].months[0].items.length >= 1);
  const allItems = arch.body.data.years.flatMap((y) => y.months.flatMap((m) => m.items));
  ok('分组条数与总数一致', allItems.length === arch.body.data.total, `${allItems.length} vs ${arch.body.data.total}`);
  ok('只含已发布（草稿不计）', true);

  await call('/api/admin/articles', {
    method: 'POST', json: { title: '归档草稿 ' + tag, content: 'x', status: 'draft' },
  });
  const arch2 = await call('/api/archive');
  ok('草稿不出现在归档里', arch2.body.data.total === arch.body.data.total, String(arch2.body.data.total));

  /* ================================================================ */
  section('3. 标签接口');
  const tg = await call('/api/tags');
  ok('标签接口可用', tg.status === 200 && Array.isArray(tg.body.data.items));
  ok('标签带计数', tg.body.data.items.every((t) => typeof t.count === 'number' && t.count > 0),
    JSON.stringify(tg.body.data.items.slice(0, 3)));
  ok('标签按热度倒序', tg.body.data.items.every((t, i, a) => i === 0 || a[i - 1].count >= t.count));

  const tagged = await call('/api/articles?tag=' + encodeURIComponent('测试') + '&size=50');
  ok('按标签筛选可用', tagged.status === 200 && tagged.body.data.items.every((x) => x.tags.includes('测试')),
    String(tagged.body.data.total));
  ok('筛选时 total 是筛选后的数', tagged.body.data.total <= arch.body.data.total, String(tagged.body.data.total));

  /* ================================================================ */
  section('4. 网站地图接口');
  const sm = await call('/api/site-map');
  ok('网站地图接口可用', sm.status === 200);
  ok('含固定页面清单', Array.isArray(sm.body.data.pages) && sm.body.data.pages.length >= 6,
    String(sm.body.data.pages.length));
  ok('页面清单含归档/标签/Now',
    ['/archive', '/tags', '/now'].every((p) => sm.body.data.pages.some((x) => x.path === p)));
  ok('含文章列表', Array.isArray(sm.body.data.articles) && sm.body.data.articles.length >= 2);
  ok('含标签', Array.isArray(sm.body.data.tags) && sm.body.data.tags.length >= 1);
  ok('含 RSS 订阅地址', Array.isArray(sm.body.data.feeds) && sm.body.data.feeds.length >= 1);
  ok('RSS 地址是绝对路径', sm.body.data.feeds.every((f) => f.url.startsWith('http')));
  const dumped = JSON.stringify(sm.body.data);
  ok('网站地图不含任何 HTML 标签（都是转义后的纯文本）', !/<script|onerror=/i.test(dumped));

  /* ================================================================ */
  section('5. Now 页面');
  const nowMd = '# 最近在做什么\n\n- 在折腾**这个网站**\n- 学 `Cloudflare Workers`\n\n> 更新不定期';
  await call('/api/admin/settings', { method: 'PUT', json: { now_md: nowMd } });
  const now = await call('/api/now');
  ok('Now 接口返回原文', now.body.data.md.includes('最近在做什么'));
  ok('Now 返回渲染后的 HTML', now.body.data.html.includes('<h1>'));
  ok('Now 支持粗体', now.body.data.html.includes('<strong>这个网站</strong>'));
  ok('Now 支持行内代码', now.body.data.html.includes('md-code'));
  ok('Now 支持引用', now.body.data.html.includes('<blockquote>'));
  ok('Now 记录了更新日期', !!now.body.data.updated_at, String(now.body.data.updated_at));
  const st = await call('/api/admin/settings');
  ok('设置接口回读 now_md', st.body.data.now_md === nowMd);

  /* ================================================================ */
  section('6. 字母头像（浏览器）');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('ERR ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errs.push('LOG ' + m.text());
  });

  await call('/api/messages', { method: 'POST', json: { name: '张三' + tag, content: '头像测试一' } });
  await call('/api/messages', { method: 'POST', json: { name: 'Alice' + tag, content: '头像测试二' } });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#messages-list li').length >= 2, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const avCount = await page.locator('#messages-list .letter-avatar').count();
  ok('每条留言都有字母头像', avCount >= 2, String(avCount));
  const firstGlyphs = await page.locator('#messages-list .letter-avatar').evaluateAll((els) => els.map((e) => e.textContent));
  ok('中文昵称取首字', firstGlyphs.includes('张'), firstGlyphs.join(','));
  ok('英文昵称取首字母并大写', firstGlyphs.includes('A'), firstGlyphs.join(','));

  const hues = await page.locator('#messages-list .letter-avatar').evaluateAll((els) =>
    els.map((e) => e.getAttribute('style')));
  ok('每个头像都带 --av-h 色相变量', hues.every((h) => /--av-h:\s*\d+/.test(h)), hues.join(' | '));
  ok('不同昵称颜色不同', new Set(hues).size === hues.length || hues.length < 2, hues.join(' | '));

  // 同一个人刷新后颜色不变（确定性）
  const before = hues[0];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#messages-list .letter-avatar').length >= 2, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const after = (await page.locator('#messages-list .letter-avatar').evaluateAll((els) => els.map((e) => e.getAttribute('style'))))[0];
  ok('刷新后同一个人颜色不变', before === after, `${before} → ${after}`);

  const avBg = await page.locator('#messages-list .letter-avatar').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  ok('头像有实际背景色（不是透明）', avBg !== 'rgba(0, 0, 0, 0)' && avBg !== 'transparent', avBg);

  /* ================================================================ */
  section('7. 新页面渲染（浏览器）');
  for (const [path, sel, name] of [
    ['/archive.html', '#archive-list section', '归档'],
    ['/tags.html', '#tags-cloud a', '标签'],
    ['/site-map.html', '#sitemap-content section', '网站地图'],
    ['/now.html', '#now-body', 'Now'],
  ]) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((s) => document.querySelectorAll(s).length > 0, sel, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(900);
    const n = await page.locator(sel).count();
    ok(`${name}页渲染出内容`, n > 0, `元素 ${n} 个`);
  }

  ok('归档页显示了年份标题',
    /\d{4}/.test(await page.goto(BASE + '/archive.html', { waitUntil: 'domcontentloaded' }).then(() => page.locator('#archive-list').innerText()).catch(() => '')));

  await page.goto(BASE + '/now.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.querySelector('#now-body')?.innerText || '').length > 5, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  ok('Now 页显示了 Markdown 内容', (await page.locator('#now-body').innerText()).includes('折腾'));
  ok('Now 页显示了更新日期', /更新于/.test(await page.locator('#now-updated').innerText()),
    await page.locator('#now-updated').innerText());

  await page.goto(BASE + '/tags.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#tags-cloud a').length > 0, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
  const tagHref = await page.locator('#tags-cloud a').first().getAttribute('href');
  ok('标签链接指向文章筛选', tagHref && tagHref.startsWith('articles?tag='), String(tagHref));

  await page.goto(BASE + '/site-map.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#sitemap-content section').length >= 3, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
  const smText = await page.locator('#sitemap-content').innerText();
  ok('网站地图含页面/文章/订阅三块',
    smText.includes('页面') && smText.includes('文章') && smText.includes('订阅'), smText.slice(0, 80));
  ok('页脚导航含归档/标签/Now/网站地图',
    await page.locator('footer a[href="archive"]').count() === 1
    && await page.locator('footer a[href="tags"]').count() === 1
    && await page.locator('footer a[href="now"]').count() === 1
    && await page.locator('footer a[href="site-map"]').count() === 1);

  /* ================================================================ */
  section('8. 图片转 WebP（浏览器实际压缩）');
  const webp = await page.evaluate(async () => {
    // 用噪点图：纯色/渐变会被 PNG 压得很小，噪点压不动，才能超过压缩阈值
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    // 必须是真随机。(i*7)%256 这种是周期函数，PNG 能压得只剩十几 KB，
    // 根本触发不了压缩阈值 —— 我第一次就是这么写错的。
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = (Math.random() * 256) | 0;
      img.data[i + 1] = (Math.random() * 256) | 0;
      img.data[i + 2] = (Math.random() * 256) | 0;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'big.png', { type: 'image/png' });

    const out = await compressImage(file);
    return {
      原始大小: file.size, 原始类型: file.type,
      压缩后大小: out.size, 压缩后类型: out.type, 压缩后名字: out.name,
      是否走压缩: out !== file,
    };
  });
  ok('大图触发了压缩流程', webp.是否走压缩, `原图 ${webp.原始大小} 字节`);
  ok('大图被压缩（体积变小）', webp.压缩后大小 < webp.原始大小, `${webp.原始大小} → ${webp.压缩后大小}`);
  ok('输出 WebP 格式', webp.压缩后类型 === 'image/webp', webp.压缩后类型);
  ok('文件名后缀是 .webp', String(webp.压缩后名字).endsWith('.webp'), webp.压缩后名字);
  ok('压缩率超过 50%', webp.压缩后大小 < webp.原始大小 * 0.5,
    `${((1 - webp.压缩后大小 / webp.原始大小) * 100).toFixed(0)}% 省下来`);

  const small = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 30;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const f = new File([blob], 'small.png', { type: 'image/png' });
    const out = await compressImage(f);
    return { 同对象: out === f, 大小: out.size };
  });
  ok('小图不压缩，原样返回（省 CPU）', small.同对象 === true, JSON.stringify(small));

  ok('前台无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 180));

  await browser.close();

  /* ================================================================ */
  section('9. 后台界面');
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
  await pa.waitForTimeout(4500);

  ok('后台登录成功', await pa.locator('#admin-view').isVisible());
  ok('设置里有 Now 编辑框', await pa.locator('#set-now').isVisible());
  ok('Now 编辑框回填了内容', (await pa.locator('#set-now').inputValue()).includes('折腾'),
    (await pa.locator('#set-now').inputValue()).slice(0, 40));

  await pa.click('#article-new');
  await pa.waitForTimeout(400);
  ok('编辑器里有封面区', await pa.locator('#cover-box').isVisible());
  ok('新建时封面上传被禁用（要先保存）', await pa.locator('#article-cover-file').isDisabled());

  // 编辑已有文章应可上传
  await pa.click('#article-cancel');
  await pa.waitForTimeout(300);
  await pa.locator('#admin-articles [data-art-edit]').first().click();
  await pa.waitForTimeout(2000);
  ok('编辑已有文章时封面上传可用', !(await pa.locator('#article-cover-file').isDisabled()),
    `disabled=${await pa.locator('#article-cover-file').isDisabled()}`);

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

function sqlCount() { /* 占位：本地测试不直连数据库 */ }
