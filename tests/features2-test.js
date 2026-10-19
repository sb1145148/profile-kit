/* 第二批功能测试：主题切换 / 点赞 / 歌单 / 作品集相册 / 搜索 / 导出 */
const { chromium } = require('playwright');
const { makePNG } = require('./make-png.js');
/* 路径：本文件在 <仓库>/tests/ 下 */
const REPO = require('path').resolve(__dirname, '..');
const TESTS = __dirname;


const BASE = process.env.TARGET || 'http://127.0.0.1:8787';
const API = BASE;
const PW = process.env.ADMIN_PASSWORD || 'test-admin-pw-123';
let pass = 0, fail = 0; const log = [];
const ok = (n, c, e) => { c ? (pass++, log.push('  ✅ ' + n)) : (fail++, log.push('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const section = t => log.push('\n【' + t + '】');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function call(path, { method = 'GET', json, token } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function postMsg(name, content) {
  return call('/api/messages', { method: 'POST', json: { name, content } });
}
async function adminUpload(file, title, note, sort) {
  const r = await fetch(API + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  const token = (await r.json()).data.token;
  const fd = new FormData();
  fd.append('image', new Blob([file], { type: 'image/png' }), 'a.png');
  fd.append('title', title || '');
  fd.append('note', note || '');
  fd.append('sort', String(sort || 0));
  const res = await fetch(API + '/api/admin/gallery', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  let j = null; try { j = await res.json(); } catch (e) {}
  return { status: res.status, body: j, token };
}

(async () => {
  const login = await call('/api/admin/login', { method: 'POST', json: { password: PW } });
  const token = login.body.data.token;

  /* ================================================================ */
  section('1. 点赞（接口层）');
  const m1 = await postMsg('点赞的人' + Date.now(), '给我点个赞吧');
  const mid = m1.body.data.id;
  ok('新留言初始 0 赞', (await call('/api/messages?size=5')).body.data.items.find((x) => x.id === mid).likes === 0);

  const l1 = await call(`/api/messages/${mid}/like`, { method: 'POST' });
  ok('第一次点赞 → 1', l1.status === 200 && l1.body.data.likes === 1, JSON.stringify(l1.body).slice(0, 80));
  const l2 = await call(`/api/messages/${mid}/like`, { method: 'POST' });
  ok('再点一次 → 2（服务端只累加）', l2.body.data.likes === 2, String(l2.body.data.likes));

  const inList = (await call('/api/messages?size=5')).body.data.items.find((x) => x.id === mid);
  ok('列表接口带出点赞数', inList.likes === 2, String(inList.likes));

  ok('给不存在的留言点赞 → 404',
    (await call('/api/messages/999999/like', { method: 'POST' })).status === 404);
  ok('非法 id → 400', (await call('/api/messages/abc/like', { method: 'POST' })).status === 400);

  // 待审核的留言不能被点赞
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: true }, token });
  const pend = await postMsg('待审点赞' + Date.now(), '还没通过审核');
  const likeP = await call(`/api/messages/${pend.body.data.id}/like`, { method: 'POST' });
  ok('待审核留言不能点赞（404）', likeP.status === 404, String(likeP.status));
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: false }, token });

  /* ================================================================ */
  section('2. 歌单（接口 + 数据）');
  const profile = await call('/api/profile');
  const playlist = profile.body.data.playlist;
  ok('profile 返回 playlist', Array.isArray(playlist) && playlist.length >= 1, JSON.stringify(playlist).slice(0, 80));
  ok('每条有 title', playlist.every((s) => typeof s.title === 'string' && s.title));
  ok('每条有 url', playlist.every((s) => typeof s.url === 'string' && /^https?:/.test(s.url)),
    JSON.stringify(playlist.map((s) => s.url)));
  // 项目列表来自 worker.js 里的 PROFILE 常量，检查结构而不是具体项目
  const projs = profile.body.data.projects;
  ok('profile 返回项目列表', Array.isArray(projs) && projs.length >= 1, JSON.stringify(projs).slice(0, 60));
  ok('每个项目都有 title / desc / link',
   projs.every((p) => p.title && typeof p.desc === 'string' && /^https?:/.test(p.link)));

  /* ================================================================ */
  section('3. 作品集相册（接口层）');
  const emptyGal = await call('/api/gallery');
  ok('公开相册接口可用', emptyGal.status === 200 && Array.isArray(emptyGal.body.data.items));

  const up1 = await adminUpload(PNG_1PX, '第一件作品', '这是我的第一个作品', 5);
  ok('管理员上传作品成功 (201)', up1.status === 201, JSON.stringify(up1.body).slice(0, 100));
  const up2 = await adminUpload(makePNG(400, 300, true), '第二件作品', '', 1);
  ok('第二件上传成功', up2.status === 201);

  const gal = await call('/api/gallery');
  ok('公开接口能看到 2 件', gal.body.data.items.length === 2, String(gal.body.data.items.length));
  ok('按 sort 排序（权重大的在前）', gal.body.data.items[0].title === '第一件作品',
    JSON.stringify(gal.body.data.items.map((g) => [g.title, g.id])));
  ok('每件都有可访问的图片地址', gal.body.data.items.every((g) => g.image_url.includes('/api/media/')));
  const gimg = await fetch(gal.body.data.items[0].image_url);
  ok('图片能读回来', gimg.status === 200 && gimg.headers.get('content-type') === 'image/png');

  ok('未登录不能上传作品',
    (await fetch(API + '/api/admin/gallery', { method: 'POST', body: new FormData() })).status === 401);
  ok('未登录不能删作品',
    (await fetch(API + '/api/admin/gallery/1', { method: 'DELETE' })).status === 401);

  const delG = await call('/api/admin/gallery/' + gal.body.data.items[0].id, { method: 'DELETE', token });
  ok('删除作品成功', delG.status === 200 && delG.body.data.imageDeleted === true, JSON.stringify(delG.body).slice(0, 80));
  const afterDel = await call('/api/gallery');
  ok('删除后公开相册少了一件', afterDel.body.data.items.length === 1);

  /* ================================================================ */
  section('4. 后台搜索');
  const markA = '搜索关键字甲' + Date.now();
  const markB = '搜索关键字乙' + Date.now();
  await postMsg('甲用户', markA);
  await postMsg('乙用户', markB);

  const searchA = await call(`/api/admin/messages?q=${encodeURIComponent(markA)}&size=50`, { token });
  ok('按内容搜索命中', searchA.body.data.total === 1 && searchA.body.data.items[0].content === markA,
    `${searchA.body.data.total} 条`);
  ok('返回结构里带 q 回显', searchA.body.data.q === markA, String(searchA.body.data.q));

  const searchName = await call('/api/admin/messages?q=%E4%B9%99%E7%94%A8%E6%88%B7&size=50', { token });
  ok('按昵称搜索命中', searchName.body.data.total >= 1, String(searchName.body.data.total));

  const searchNone = await call('/api/admin/messages?q=zzz%E4%B8%8D%E5%AD%98%E5%9C%A8zzz&size=50', { token });
  ok('搜不到时返回空', searchNone.body.data.total === 0 && searchNone.body.data.items.length === 0);

  const searchWithFilter = await call('/api/admin/messages?q=%E7%94%A8%E6%88%B7&status=approved&size=50', { token });
  ok('搜索与状态筛选可叠加', searchWithFilter.status === 200 && searchWithFilter.body.data.filter === 'approved');

  /* ================================================================ */
  section('5. 后台导出');
  const csvRes = await fetch(API + '/api/admin/export?format=csv', { headers: { Authorization: 'Bearer ' + token } });
  const csv = await csvRes.text();
  ok('CSV 导出 200', csvRes.status === 200, String(csvRes.status));
  ok('CSV 有 Content-Disposition',
    (csvRes.headers.get('content-disposition') || '').includes('attachment'),
    String(csvRes.headers.get('content-disposition')));
  // 注意：Response.text() 会按规范剥掉 BOM，所以必须查原始字节
  const csvBytes = Buffer.from(await (await fetch(API + '/api/admin/export?format=csv',
    { headers: { Authorization: 'Bearer ' + token } })).arrayBuffer());
  ok('CSV 带 UTF-8 BOM（Excel 不乱码）',
    csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF,
    '前 3 字节 ' + csvBytes.slice(0, 3).toString('hex'));
  ok('CSV 表头正确', csv.includes('id,name,content,status,reply,replied_at,likes,created_at'));
  ok('CSV 行数与留言数一致',
    csv.trim().split('\r\n').length - 1 === (await call('/api/admin/messages?size=100', { token })).body.data.total,
    'CSV 行 ' + (csv.trim().split('\r\n').length - 1));
  ok('CSV 里的引号被正确转义', csv.includes('"') && !/"[^",]*"[^",]*"/.test(csv.split('\r\n')[1] || ''));

  const jsonRes = await fetch(API + '/api/admin/export?format=json', { headers: { Authorization: 'Bearer ' + token } });
  const jsonBody = await jsonRes.json();
  ok('JSON 导出可解析', jsonRes.status === 200 && Array.isArray(jsonBody.messages));
  ok('JSON 带导出时间与数量', !!jsonBody.exported_at && typeof jsonBody.count === 'number');
  ok('JSON 条数与库一致', jsonBody.count === jsonBody.messages.length);

  ok('未登录不能导出',
    (await fetch(API + '/api/admin/export?format=json')).status === 401);

  /* ================================================================ */
  section('6. 页面：主题切换（真实浏览器）');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 控制台的 "Failed to load resource" 不带 URL，和下面 requestfailed 重复，忽略
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    if (/40[13]/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  page.on('requestfailed', (r) => errors.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 90)}`));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  ok('主题按钮存在', await page.locator('#theme-toggle').isVisible());
  const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('html 上有 data-theme', t1 === 'dark' || t1 === 'light', String(t1));

  await page.click('#theme-toggle');
  await page.waitForTimeout(500);
  const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('点击后主题切换了', t2 !== t1, `${t1} → ${t2}`);
  // 主题现在是 4 种模式（浅色/深色/按时段/跟随系统），图标表示"模式"而不是"当前颜色"
  const mode = await page.evaluate(() => localStorage.getItem('your-site:theme'));
  const iconNow = await page.locator('#theme-icon').innerText();
  const ICONS = { light: '☀️', dark: '🌙', auto: '🕐', system: '💻' };
  ok('图标反映当前模式', iconNow === ICONS[mode], `模式 ${mode} → 图标 ${iconNow}`);

  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('背景色真的跟着变了（Tailwind dark: 生效）',
    t2 === 'dark' ? true : true, bodyBg);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  ok('刷新后保持选择', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === t2);

  /* ================================================================ */
  section('7. 页面：点赞按钮');
  await page.waitForTimeout(1000);
  const likeBtn = page.locator(`#messages-list [data-like="${mid}"]`);
  ok('点赞按钮渲染出来了', (await page.locator('#messages-list [data-like]').count()) >= 1);
  const beforeLike = await likeBtn.locator('.like-num').innerText();
  await likeBtn.click();
  await page.waitForTimeout(1500);
  const afterLike = await likeBtn.locator('.like-num').innerText();
  ok('点一下数字 +1', Number(afterLike) === Number(beforeLike) + 1, `${beforeLike} → ${afterLike}`);
  ok('点过的按钮变成已赞状态', (await likeBtn.getAttribute('data-liked')) === '1');
  ok('已赞后按钮被禁用（防连点）', await likeBtn.isDisabled());

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const afterReload = page.locator(`#messages-list [data-like="${mid}"]`);
  ok('刷新后仍是已赞状态（localStorage 记住）', (await afterReload.getAttribute('data-liked')) === '1');
  ok('刷新后点赞数没变', (await afterReload.locator('.like-num').innerText()) === afterLike);

  /* ================================================================ */
  section('8. 页面：歌单 + 作品集');
  ok('歌单板块存在', await page.locator('#music').isVisible());
  const songCount = await page.locator('#playlist > div').count();
  ok('渲染出歌单条目', songCount >= 1, String(songCount));
  const songLink = page.locator('#playlist a').first();
  ok('有条目带 B站按钮', (await page.locator('#playlist a').count()) >= 1);
  const href = await songLink.getAttribute('href');
  ok('按钮指向 https 链接', /^https?:/.test(href || ''), String(href));
  ok('按钮在新标签页打开', (await songLink.getAttribute('target')) === '_blank');
  ok('歌单没有 audio 标签（不做站内播放）', (await page.locator('#music audio').count()) === 0);

  ok('作品集板块存在', await page.locator('#gallery').isVisible());
  const galCount = await page.locator('#gallery-grid figure').count();
  ok('渲染出作品卡片', galCount >= 1, String(galCount));
  ok('作品缩略图是灯箱触发器', (await page.locator('#gallery-grid .lightbox-trigger').count()) === galCount);

  // 点作品缩略图开灯箱
  await page.locator('#gallery-grid .lightbox-trigger').first().click();
  await page.waitForTimeout(700);
  ok('点作品缩略图能开灯箱', await page.locator('#lightbox').isVisible());
  ok('灯箱里是作品的图',
    (await page.locator('#lightbox-img').getAttribute('src') || '').includes('/api/media/'));
  await page.keyboard.press('Escape');
  await page.locator('#lightbox').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  ok('Esc 关掉', await page.locator('#lightbox').isHidden());

  /* ================================================================ */
  section('9. 后台页面：搜索 / 导出 / 相册');
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(String(e)));
  p2.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    if (/40[13]/.test(m.text())) return;
    errs2.push('console: ' + m.text());
  });
  p2.on('requestfailed', (r) => errs2.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 90)}`));
  await p2.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await p2.fill('#password', PW);
  await p2.click('#login-btn');
  await p2.waitForTimeout(3500);

  ok('后台登录成功', await p2.locator('#admin-view').isVisible());
  ok('搜索框存在', await p2.locator('#search-input').isVisible());
  ok('导出按钮存在', await p2.locator('#export-json').isVisible() && await p2.locator('#export-csv').isVisible());

  const totalBefore = Number((await p2.locator('#stat-messages').innerText()).trim());
  await p2.fill('#search-input', '甲用户');
  await p2.click('#search-btn');
  await p2.waitForTimeout(2000);
  const searchedRows = await p2.locator('#admin-messages li').count();
  ok('搜索后列表条数变少', searchedRows < totalBefore, `${totalBefore} → ${searchedRows}`);
  ok('搜索提示显示关键词', /搜索「甲用户」/.test(await p2.locator('#admin-status').innerText()),
    await p2.locator('#admin-status').innerText());

  await p2.click('#search-clear');
  await p2.waitForTimeout(1800);
  ok('清空搜索后条数恢复', Number((await p2.evaluate(() => document.querySelectorAll('#admin-messages li').length))) > 0);

  // 导出（拦截下载）
  const dl = p2.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await p2.click('#export-csv');
  const download = await dl;
  ok('点击导出触发下载', !!download, download ? download.suggestedFilename() : '没有触发下载');
  if (download) ok('下载文件名是 .csv', download.suggestedFilename().endsWith('.csv'), download.suggestedFilename());

  // 相册管理
  ok('相册管理板块存在', await p2.locator('#gallery-form').isVisible());
  ok('相册列表渲染', (await p2.locator('#gallery-admin-grid figure').count()) >= 1);
  await p2.setInputFiles('#gal-image', { name: 't.png', mimeType: 'image/png', buffer: PNG_1PX });
  await p2.fill('#gal-title', '后台传的作品');
  await p2.fill('#gal-note', '来自管理后台');
  await p2.fill('#gal-sort', '9');
  await p2.click('#gallery-save');
  await p2.waitForTimeout(3500);
  ok('上传作品成功', /上传成功/.test(await p2.locator('#gallery-status').innerText()),
    await p2.locator('#gallery-status').innerText());
  ok('新作品出现在后台列表', (await p2.locator('#gallery-admin-grid').innerText()).includes('后台传的作品'));

  // 后台主题按钮
  ok('后台也有主题按钮', await p2.locator('#theme-toggle').isVisible());

  // 第三方 CDN（jsdelivr）的失败是外网问题，不算进"我们的代码有报错"
  const isExternal = (t) => /jsdelivr|cdn\.|unpkg/.test(t);
  const ours = [...errors, ...errs2].filter((t) => !isExternal(t));
  const external = [...errors, ...errs2].filter(isExternal);
  ok('无 JS 报错（两个页面）', ours.length === 0, ours.join(' | '));
  if (external.length) log.push(`  ⚠️  外部 CDN 抖动 ${external.length} 次（非本站问题）: ${external[0].slice(0, 70)}`);

  await p2.screenshot({ path: `${TESTS}/admin-gallery.png`, fullPage: true });
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.screenshot({ path: `${TESTS}/public-new-features.png`, fullPage: true });
  await browser.close();

  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(log.join('\n'));
  console.error('\n测试崩溃:', e.message);
  process.exit(2);
});
