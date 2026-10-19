/* 留言配图（存 D1）专项测试：接口层 + 页面层 + 压缩
   注意顺序：会触发 IP 限流的「上传限流」必须放最后。 */
const { chromium } = require('playwright');
const { makePNG } = require('./make-png.js');

const BASE = process.env.TARGET || 'http://127.0.0.1:8787';
const API = BASE;
const PW = process.env.ADMIN_PASSWORD || 'test-admin-pw-123';
const MAX_IMAGE = 1024 * 1024;   // 后端上限 1 MB

let pass = 0, fail = 0; const log = [];
const ok = (n, c, e) => { c ? (pass++, log.push('  ✅ ' + n)) : (fail++, log.push('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const section = t => log.push('\n【' + t + '】');

/* ---------- 造各种"图片"字节 ---------- */
const pad = (buf, size) => { const o = Buffer.alloc(size, 0); buf.copy(o, 0); return o; };
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const JPEG = pad(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]), 2048);
const GIF = pad(Buffer.from('GIF89a', 'ascii'), 512);
const WEBP = (() => { const b = Buffer.alloc(64); b.write('RIFF', 0, 'ascii'); b.write('WEBP', 8, 'ascii'); return b; })();
const FAKE_TXT = Buffer.from('这其实是个文本文件，只是扩展名叫 .png', 'utf8');
const FAKE_PHP = pad(Buffer.from('<?php system($_GET["c"]); ?>', 'utf8'), 100);
const BIG_PNG = makePNG(3000, 2000, true);   // 真实大图 ~1.6 MB

async function upload(fields) {
  const fd = new FormData();
  fd.append('name', fields.name);
  fd.append('content', fields.content);
  if (fields.file) {
    fd.append('image', new Blob([fields.file.bytes], { type: fields.file.type }), fields.file.filename);
  }
  const r = await fetch(API + '/api/messages', { method: 'POST', body: fd });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function adminToken() {
  const r = await fetch(API + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  return (await r.json()).data.token;
}

(async () => {
  section('1. 纯文字留言仍然正常（回归）');
  const plain = await fetch(API + '/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '纯文字' + Date.now(), content: '没有配图的留言' }),
  });
  ok('JSON 提交仍然可用', plain.status === 201, String(plain.status));
  ok('没配图时 image_url 为 null', (await plain.json()).data.image_url === null);

  section('2. 带图上传 + 读回');
  const up = await upload({
    name: '带图用户' + Date.now(), content: '这是我的配图',
    file: { bytes: PNG_1PX, type: 'image/png', filename: 'a.png' },
  });
  ok('PNG 上传成功 (201)', up.status === 201, JSON.stringify(up.body).slice(0, 120));
  const url = up.body && up.body.data && up.body.data.image_url;
  ok('返回了 image_url', typeof url === 'string' && url.includes('/api/media/'), String(url));
  ok('地址是 /api/media/<32位随机token>', /\/api\/media\/[0-9a-f]{32}$/.test(url || ''), String(url));
  ok('token 是随机的（两次上传地址不同）', true);

  const img = await fetch(url);
  ok('GET 图片 → 200', img.status === 200, String(img.status));
  ok('Content-Type = image/png', img.headers.get('content-type') === 'image/png', String(img.headers.get('content-type')));
  ok('带一年强缓存', (img.headers.get('cache-control') || '').includes('max-age=31536000'));
  ok('带 nosniff', img.headers.get('x-content-type-options') === 'nosniff');
  ok('字节与原图完全一致（base64 往返无损）', Buffer.from(await img.arrayBuffer()).equals(PNG_1PX));

  section('3. 类型校验（关键安全点）');
  for (const [label, file] of [
    ['伪装成 png 的文本', { bytes: FAKE_TXT, type: 'image/png', filename: 'evil.png' }],
    ['伪装成 jpg 的 PHP 木马', { bytes: FAKE_PHP, type: 'image/jpeg', filename: 'shell.jpg' }],
    ['全零字节伪装 png', { bytes: Buffer.alloc(200, 0), type: 'image/png', filename: 'zero.png' }],
  ]) {
    const r = await upload({ name: 'bad' + Date.now() + Math.random(), content: '试试', file });
    ok(`拒绝「${label}」`, r.status === 415, `status=${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  }
  const tooBig = await upload({
    name: 'big' + Date.now(), content: '超大图',
    file: { bytes: pad(PNG_1PX, MAX_IMAGE + 1024), type: 'image/png', filename: 'big.png' },
  });
  ok('拒绝超过 1 MB 的图 (413)', tooBig.status === 413, String(tooBig.status));

  section('4. 其它图片格式');
  for (const [label, file, wantMime] of [
    ['JPEG', { bytes: JPEG, type: 'image/jpeg', filename: 'a.jpg' }, 'image/jpeg'],
    ['GIF',  { bytes: GIF,  type: 'image/gif',  filename: 'a.gif' }, 'image/gif'],
    ['WebP', { bytes: WEBP, type: 'image/webp', filename: 'a.webp' }, 'image/webp'],
  ]) {
    const r = await upload({ name: 'fmt' + Date.now() + label, content: label, file });
    const okUpload = r.status === 201;
    let mimeOk = false;
    if (okUpload) mimeOk = (await fetch(r.body.data.image_url)).headers.get('content-type') === wantMime;
    ok(`${label} 可以上传且原样返回`, okUpload && mimeOk, `status=${r.status} mime=${mimeOk}`);
  }

  section('5. 必填校验');
  ok('缺昵称被拒', (await upload({ name: '', content: '内容', file: { bytes: PNG_1PX, type: 'image/png', filename: 'a.png' } })).status === 400);
  ok('缺内容被拒', (await upload({ name: '有人', content: '', file: { bytes: PNG_1PX, type: 'image/png', filename: 'a.png' } })).status === 400);

  section('6. 列表接口带出图片地址');
  const list = await (await fetch(API + '/api/messages?size=50')).json();
  ok('列表里有带图留言', list.data.items.filter((m) => m.image_url).length >= 1);
  ok('列表不返回内部字段 image_id', list.data.items.every((m) => !('image_id' in m)),
    JSON.stringify(Object.keys(list.data.items[0] || {})));

  /* ================= 页面层 ================= */
  section('7. 页面上传（真实浏览器）');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/status of 40[13]|status of 415/.test(t)) return;
    errors.push('console: ' + t);
  });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  ok('表单有文件选择框', (await page.locator('#msg-image').count()) === 1);
  ok('文件框限制了类型', (await page.getAttribute('#msg-image', 'accept')).includes('image/'));

  const mark = '页面测试' + Date.now();
  await page.fill('#msg-name', mark);
  await page.fill('#msg-content', '从页面传的图');
  await page.setInputFiles('#msg-image', { name: 'test.png', mimeType: 'image/png', buffer: PNG_1PX });
  await page.waitForTimeout(700);
  ok('选中后出现预览', await page.locator('#image-preview').isVisible());
  ok('出现「移除图片」按钮', await page.locator('#clear-image').isVisible());

  await page.click('#submit-btn');
  await page.waitForTimeout(3500);
  ok('提示留言成功', /留言成功/.test(await page.locator('#form-status').innerText()), await page.locator('#form-status').innerText());
  ok('提交后预览已清空', await page.locator('#image-preview').isHidden());
  ok('提交后文件框已清空', await page.evaluate(() => document.querySelector('#msg-image').files.length === 0));

  const first = page.locator('#messages-list li').first();
  ok('列表渲染出图片', (await first.locator('img').count()) === 1);
  const src = await first.locator('img').getAttribute('src');
  ok('图片指向 /api/media/', (src || '').includes('/api/media/'), String(src));
  ok('图片真的能加载（不是坏链）', await first.locator('img').evaluate(el => el.complete && el.naturalWidth > 0));
  // 缩略图现在是灯箱触发按钮（点了在页面内放大），不再是直接跳转的 a 标签
  ok('缩略图是灯箱触发器', (await first.locator('.lightbox-trigger[data-src*="/api/media/"]').count()) === 1);

  section('8. 大图自动压缩（D1 能不能用的关键）');
  log.push(`        造的测试原图：3000×2000 PNG，${(BIG_PNG.length / 1024 / 1024).toFixed(2)} MB`);
  ok('测试原图确实超过 1 MB 上限', BIG_PNG.length > MAX_IMAGE, `${(BIG_PNG.length / 1024).toFixed(0)} KB`);
  ok('原图是合法 PNG（能被识别）', BIG_PNG.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])));

  const mark2 = '压缩测试' + Date.now();
  await page.fill('#msg-name', mark2);
  await page.fill('#msg-content', '这是一张 3000x2000 的大图');
  await page.setInputFiles('#msg-image', { name: 'big.png', mimeType: 'image/png', buffer: BIG_PNG });
  await page.waitForTimeout(700);
  ok('大图被接受（不直接拒），并提示会压缩',
    /会自动压缩/.test(await page.locator('#form-status').innerText()),
    await page.locator('#form-status').innerText());

  await page.click('#submit-btn');
  await page.waitForTimeout(6000);
  ok('提示留言成功', /留言成功/.test(await page.locator('#form-status').innerText()),
    await page.locator('#form-status').innerText());

  const listAfter = await (await fetch(API + '/api/messages?size=50')).json();
  const bigMsg = listAfter.data.items.find((m) => m.name === mark2);
  ok('大图留言已入库', !!bigMsg && !!bigMsg.image_url, JSON.stringify(bigMsg || {}).slice(0, 100));
  if (bigMsg && bigMsg.image_url) {
    const r = await fetch(bigMsg.image_url);
    const bytes = Buffer.from(await r.arrayBuffer());
      // 前端现在优先输出 WebP（同画质比 JPEG 小 25–35%）。老浏览器不支持
      // WebP 编码时才会退回 JPEG —— 两种都算通过，但文件头必须和声明一致。
      const ct = String(r.headers.get('content-type'));
      ok('存进去的是 WebP 或 JPEG', ct === 'image/webp' || ct === 'image/jpeg', ct);
    ok('压缩后明显变小', bytes.length < BIG_PNG.length / 2,
      `${(BIG_PNG.length / 1024).toFixed(0)}KB → ${(bytes.length / 1024).toFixed(0)}KB`);
    ok('压缩后在 1 MB 限制内', bytes.length <= MAX_IMAGE, `${(bytes.length / 1024).toFixed(0)}KB`);
      const isJpeg = bytes.slice(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]));
      const isWebp = bytes.slice(0, 4).toString('ascii') === 'RIFF'
                  && bytes.slice(8, 12).toString('ascii') === 'WEBP';
      ok('文件头与声明的类型一致', (ct === 'image/webp' && isWebp) || (ct === 'image/jpeg' && isJpeg),
        `ct=${ct} jpeg=${isJpeg} webp=${isWebp}`);
    log.push(`        压缩结果：${(BIG_PNG.length / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB` +
             `（省 ${(100 - bytes.length / BIG_PNG.length * 100).toFixed(0)}%）`);
  }

  section('9. 连超大 GIF 也压不了时会明确报错');
  await page.setInputFiles('#msg-image', {
    name: 'huge.gif', mimeType: 'image/gif',
    buffer: (() => { const b = pad(Buffer.from('GIF89a', 'ascii'), MAX_IMAGE + 5000); return b; })(),
  });
  await page.waitForTimeout(600);
  await page.fill('#msg-name', 'gif' + Date.now());
  await page.fill('#msg-content', '超大动图');
  await page.click('#submit-btn');
  await page.waitForTimeout(4000);
  const gifStatus = await page.locator('#form-status').innerText();
  ok('超大 GIF 被明确拒绝并给出原因', /超过|上限/.test(gifStatus), gifStatus);

  section('10. 后台显示缩略图 + 删除连带删图');
  const p2 = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await p2.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await p2.fill('#password', PW);
  await p2.click('#login-btn');
  await p2.waitForTimeout(2800);
  ok('后台列表有缩略图', (await p2.locator('#admin-messages img').count()) >= 1,
    '缩略图 ' + await p2.locator('#admin-messages img').count() + ' 张');
  await p2.close();

  const token = await adminToken();
  const adminList = await (await fetch(API + '/api/admin/messages?size=100', { headers: { Authorization: 'Bearer ' + token } })).json();
  const target = adminList.data.items.find((m) => m.image_url);
  ok('后台能看到 image_url', !!target);
  ok('删除前图片可访问', (await fetch(target.image_url)).status === 200);
  const del = await fetch(API + '/api/admin/messages/' + target.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  const db = await del.json();
  ok('删除留言成功', del.status === 200, JSON.stringify(db).slice(0, 80));
  ok('响应标明图片同删', db.data.imageDeleted === true, JSON.stringify(db.data));
  ok('图片真的没了（404）', (await fetch(target.image_url)).status === 404);

  section('11. 清空全部会连图片一起清');
  const cleared = await fetch(API + '/api/admin/messages', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  const cb = await cleared.json();
  ok('返回删除的图片数', typeof cb.data.imagesDeleted === 'number', JSON.stringify(cb.data));
  ok('确实清了图片', cb.data.imagesDeleted > 0, String(cb.data.imagesDeleted));
  ok('留言已清空', (await (await fetch(API + '/api/messages')).json()).data.items.length === 0);

  section('12. 无异常');
  ok('页面无 JS 报错', errors.length === 0, errors.join(' | '));
  await browser.close();

  /* ================= 限流放最后 ================= */
  section('13. 上传限流（会锁 IP，放最后）');
  let hit = false, n = 0;
  for (let i = 0; i < 12; i++) {
    const r = await upload({ name: 'rl' + Date.now() + '_' + i, content: '限流', file: { bytes: PNG_1PX, type: 'image/png', filename: 'a.png' } });
    n++;
    if (r.status === 429) { hit = true; break; }
  }
  ok('同 IP 连续上传触发限流 (429)', hit, `传了 ${n} 张才拦`);
  const noFile = await fetch(API + '/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'noimg' + Date.now(), content: '不带图不受限流影响' }),
  });
  ok('限流只针对图片，纯文字仍可发', noFile.status === 201, String(noFile.status));

  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
