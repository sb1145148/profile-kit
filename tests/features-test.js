/* 六个新功能专项测试：分页 / 灯箱 / 审核 / 通知 / 回复 / 访问趋势 */
const { chromium } = require('playwright');
const http = require('http');
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
async function post(name, content, imageBytes) {
  if (imageBytes) {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('content', content);
    fd.append('image', new Blob([imageBytes], { type: 'image/png' }), 'a.png');
    const r = await fetch(API + '/api/messages', { method: 'POST', body: fd });
    return { status: r.status, body: await r.json() };
  }
  return call('/api/messages', { method: 'POST', json: { name, content } });
}

/* ---------- 本地 webhook 接收器，用来验证"新留言通知" ---------- */
const received = [];
const hookPort = 8899;
let hookServer;

(async () => {
  hookServer = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => data += c);
    req.on('end', () => {
      received.push({ url: req.url, contentType: req.headers['content-type'] || '', body: data });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"errcode":0,"errmsg":"ok"}');
    });
  }).listen(hookPort, '127.0.0.1');

  const login = await call('/api/admin/login', { method: 'POST', json: { password: PW } });
  const token = login.body.data.token;

  /* ================================================================ */
  section('0. CORS 预检（新增接口用到的动词都要放行）');
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
    const r = await fetch(API + '/api/admin/settings', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': m, 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    const allow = r.headers.get('access-control-allow-methods') || '';
    ok(`预检放行 ${m}`, r.status === 204 && allow.includes(m), `status=${r.status} methods=${allow}`);
  }

  section('1. 留言分页');
  // 造 23 条留言（其中 1 条带图）
  for (let i = 1; i <= 23; i++) {
    await post('分页测试' + i, '第 ' + i + ' 条', i === 23 ? PNG_1PX : null);
  }
  const p1 = await call('/api/messages?page=1&size=10');
  const p3 = await call('/api/messages?page=3&size=10');
  ok('第 1 页返回 10 条', p1.body.data.items.length === 10, String(p1.body.data.items.length));
  ok('总数正确（23）', p1.body.data.total === 23, String(p1.body.data.total));
  ok('总页数正确（3）', p1.body.data.totalPages === 3, String(p1.body.data.totalPages));
  ok('第 3 页返回 3 条', p3.body.data.items.length === 3, String(p3.body.data.items.length));

  const ids1 = p1.body.data.items.map((m) => m.id);
  const ids2 = (await call('/api/messages?page=2&size=10')).body.data.items.map((m) => m.id);
  ok('分页之间不重复', !ids1.some((id) => ids2.includes(id)));
  ok('按时间倒序（第 1 页 id 都比第 2 页大）', Math.min(...ids1) > Math.max(...ids2));
  ok('带图那条在第 1 页（最新）', p1.body.data.items[0].image_url !== null);

  const clamped = await call('/api/messages?page=999&size=10');
  ok('越界页码返回空列表而不是报错', clamped.body.data.items.length === 0 && clamped.status === 200);

  const tooBig = await call('/api/messages?page=1&size=99999');
  ok('size 被限制在 50 以内', tooBig.body.data.size <= 50, String(tooBig.body.data.size));

  /* ================================================================ */
  section('2. 留言审核');
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: true }, token });
  ok('审核开关已打开', (await call('/api/admin/settings', { token })).body.data.require_approval === true);

  const mark = '待审核留言' + Date.now();
  const submitted = await post('想留言的人', mark);
  ok('提交返回 pending 标记', submitted.body.data.pending === true, JSON.stringify(submitted.body.data).slice(0, 90));

  const publicList = await call('/api/messages?page=1&size=50');
  ok('前台看不到待审核留言', !publicList.body.data.items.some((m) => m.content === mark));
  ok('前台总数不含待审核', publicList.body.data.total === 23, String(publicList.body.data.total));

  const pendingList = await call('/api/admin/messages?status=pending', { token });
  const pendingItem = pendingList.body.data.items.find((m) => m.content === mark);
  ok('后台「待审核」筛选能看到', !!pendingItem, JSON.stringify(pendingList.body.data.items.map((m) => m.status)));

  const approved = await call(`/api/admin/messages/${pendingItem.id}/approve`, { method: 'POST', json: { approve: true }, token });
  ok('通过审核成功', approved.status === 200 && approved.body.data.status === 'approved', JSON.stringify(approved.body).slice(0, 80));

  const afterApprove = await call('/api/messages?page=1&size=50');
  ok('通过后前台可见了', afterApprove.body.data.items.some((m) => m.content === mark));
  ok('总数 +1', afterApprove.body.data.total === 24, String(afterApprove.body.data.total));

  await call(`/api/admin/messages/${pendingItem.id}/approve`, { method: 'POST', json: { approve: false }, token });
  const afterRevoke = await call('/api/messages?page=1&size=50');
  ok('撤销后前台又看不到了', !afterRevoke.body.data.items.some((m) => m.content === mark));
  await call(`/api/admin/messages/${pendingItem.id}/approve`, { method: 'POST', json: { approve: true }, token });

  const closed = await call('/api/admin/settings', { method: 'PUT', json: { require_approval: false }, token });
  ok('审核开关可关闭', closed.body.data.require_approval === false);

  /* ================================================================ */
  section('3. 回复留言');
  const replyTarget = afterApprove.body.data.items.find((m) => m.content === mark);
  const reply = await call(`/api/admin/messages/${replyTarget.id}/reply`, {
    method: 'POST', json: { reply: '谢谢你的留言！' }, token,
  });
  ok('保存回复成功', reply.status === 200 && reply.body.data.reply === '谢谢你的留言！', JSON.stringify(reply.body).slice(0, 80));

  const withReply = await call('/api/messages?page=1&size=50');
  const replied = withReply.body.data.items.find((m) => m.id === replyTarget.id);
  ok('前台能看到回复内容', replied.reply === '谢谢你的留言！', String(replied.reply));
  ok('回复带上了时间', !!replied.replied_at, String(replied.replied_at));
  ok('其它留言没有回复字段', withReply.body.data.items.filter((m) => m.id !== replyTarget.id).every((m) => m.reply === null));

  const clearReply = await call(`/api/admin/messages/${replyTarget.id}/reply`, { method: 'POST', json: { reply: '   ' }, token });
  ok('回复留空等于删除', clearReply.body.data.reply === null, JSON.stringify(clearReply.body.data));
  await call(`/api/admin/messages/${replyTarget.id}/reply`, { method: 'POST', json: { reply: '再回复一次' }, token });

  /* ================================================================ */
  section('4. 站点设置与校验');
  const badType = await call('/api/admin/settings', { method: 'PUT', json: { notify_type: 'telegram' }, token });
  ok('拒绝不支持的推送类型', badType.status === 400, String(badType.status));
  const badHook = await call('/api/admin/settings', { method: 'PUT', json: { notify_webhook: 'http://insecure.example' }, token });
  ok('拒绝非 https 的推送地址（非本机）', badHook.status === 400, String(badHook.status));
  const localHook = await call('/api/admin/settings', { method: 'PUT', json: { notify_webhook: `http://127.0.0.1:${hookPort}/hook` }, token });
  ok('放行本机 http 地址（便于本地调试）', localHook.status === 200, JSON.stringify(localHook.body).slice(0, 80));
  const badHook2 = await call('/api/admin/settings', { method: 'PUT', json: { notify_webhook: 'x'.repeat(600) }, token });
  ok('拒绝过长的推送地址', badHook2.status === 400, String(badHook2.status));


  /* ================================================================ */
  section('5. 新留言通知（真实端到端投递）');
  const hookUrl = `http://127.0.0.1:${hookPort}/hook`;

  // 未配置时不该发
  received.length = 0;
  await call('/api/admin/settings', { method: 'PUT', json: { notify_type: 'off', notify_webhook: hookUrl }, token });
  await post('通知测试', '关闭状态不该发通知');
  await new Promise(r => setTimeout(r, 500));
  ok('通知关闭时不发送', received.length === 0, '收到 ' + received.length + ' 条');

  // 逐个格式验证真实投递
  for (const type of ['wecom', 'dingtalk', 'serverchan', 'json']) {
    received.length = 0;
    const set = await call('/api/admin/settings', {
      method: 'PUT', json: { notify_type: type, notify_webhook: hookUrl }, token,
    });
    ok(`${type} 配置保存成功`, set.status === 200 && set.body.data.notify_type === type,
      JSON.stringify(set.body).slice(0, 80));

    const guestName = `通知客人-${type}-${Date.now()}`;
    await post(guestName, `这是发给 ${type} 的测试留言`);
    // 通知是异步发的（waitUntil），稍等一下
    for (let i = 0; i < 30 && received.length === 0; i++) await new Promise(r => setTimeout(r, 100));

    if (!received.length) { ok(`${type} 实际发出并收到`, false, '接收器没收到请求'); continue; }
    const hit = received[0];
    ok(`${type} 实际发出并收到`, true);

    if (type === 'wecom' || type === 'dingtalk') {
      const b = JSON.parse(hit.body);
      ok(`${type} 载荷是 msgtype/text 格式`,
        b.msgtype === 'text' && typeof b.text.content === 'string',
        JSON.stringify(b).slice(0, 90));
      ok(`${type} 内容里带上了留言正文`, b.text.content.includes('测试留言'));
      ok(`${type} 内容里带上了昵称`, b.text.content.includes('通知客人'));
    } else if (type === 'serverchan') {
      ok('serverchan 用表单编码', hit.contentType.includes('x-www-form-urlencoded'), hit.contentType);
      const params = new URLSearchParams(hit.body);
      ok('serverchan 含 title 和 desp', params.has('title') && params.has('desp'));
      ok('serverchan 正文带上了留言', (params.get('desp') || '').includes('测试留言'));
    } else {
      const b = JSON.parse(hit.body);
      ok('json 载荷含 event=new_message', b.event === 'new_message', JSON.stringify(b).slice(0, 80));
      ok('json 载荷含 name/content', String(b.name).startsWith('通知客人') && b.content.includes('测试留言'),
        JSON.stringify({ name: b.name, content: b.content }).slice(0, 90));
      ok('json 载荷含 text 摘要', typeof b.text === 'string' && b.text.includes('新留言'));
    }
  }

  // 待审核的留言，通知里应提示需要审核
  received.length = 0;
  await call('/api/admin/settings', { method: 'PUT', json: { notify_type: 'json', notify_webhook: hookUrl, require_approval: true }, token });
  await post('待审通知' + Date.now(), '需要审核的留言');
  for (let i = 0; i < 30 && received.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  if (received.length) {
    const b = JSON.parse(received[0].body);
    ok('待审核留言的通知里标注了 pending', b.pending === true, JSON.stringify(b).slice(0, 80));
  } else {
    ok('待审核留言的通知里标注了 pending', false, '没收到通知');
  }
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: false }, token });

  // 测试通知按钮
  received.length = 0;
  const testNotify = await call('/api/admin/notify-test', { method: 'POST', token });
  for (let i = 0; i < 30 && received.length === 0; i++) await new Promise(r => setTimeout(r, 100));
  ok('后台「测试通知」返回已发送', testNotify.body.data.sent === true, JSON.stringify(testNotify.body.data).slice(0, 80));
  ok('测试通知确实到达接收器', received.length >= 1, '收到 ' + received.length + ' 条');

  // 通知失败不能影响留言本身
  received.length = 0;
  await call('/api/admin/settings', { method: 'PUT', json: { notify_type: 'json', notify_webhook: 'http://127.0.0.1:1/dead' }, token });
  const stillOk = await post('通知失败测试' + Date.now(), '接收地址是坏的，留言仍应成功');
  ok('通知地址不可达时留言依然成功', stillOk.status === 201 && stillOk.body.ok === true, String(stillOk.status));

  // 恢复成关闭，避免影响后续断言
  await call('/api/admin/settings', { method: 'PUT', json: { notify_type: 'off' }, token });

  /* ================================================================ */
  section('6. 访问量趋势');
  for (let i = 0; i < 5; i++) await call('/api/visits', { method: 'POST' });
  const trend = await call('/api/admin/visits/trend?days=7', { token });
  ok('返回 7 天数据', trend.body.data.days.length === 7, String(trend.body.data.days.length));
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = trend.body.data.days.find((d) => d.day === today);
  ok('今天的计数已累加', todayRow && todayRow.count >= 5, JSON.stringify(todayRow));
  ok('总访问量与趋势一致', trend.body.data.total === 5, String(trend.body.data.total));
  ok('日期连续且升序', trend.body.data.days.every((d, i, a) => i === 0 || d.day > a[i - 1].day));

  const trend7 = await call('/api/admin/visits/trend?days=7', { token });
  const trend90 = await call('/api/admin/visits/trend?days=90', { token });
  ok('days 参数生效', trend7.body.data.days.length === 7 && trend90.body.data.days.length === 90);
  const clampLow = await call('/api/admin/visits/trend?days=1', { token });
  ok('days 下限保护（至少 7）', clampLow.body.data.days.length === 7, String(clampLow.body.data.days.length));

  /* ================================================================ */
  section('7. 页面：分页控件 + 图片灯箱（真实浏览器）');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  ok('分页控件出现', await page.locator('#pagination').isVisible());
  ok('每页 10 条', (await page.locator('#messages-list li').count()) === 10, String(await page.locator('#messages-list li').count()));
  // 等分页真的渲染出来再断言；条数会随测试推进变化，所以不写死具体数字
  await page.waitForFunction(
    () => /共 \d+ 条/.test(document.querySelector('#pagination')?.textContent || ''),
    null, { timeout: 15000 }
  ).catch(() => {});
  const pageInfo = await page.evaluate(() => document.querySelector('#pagination').textContent || '');
  ok('显示共 N 条', /共 \d+ 条/.test(pageInfo), JSON.stringify(pageInfo.replace(/\s+/g, ' ').trim()));

  const firstPageFirst = await page.locator('#messages-list li').first().getAttribute('data-nothing') || null;
  const page1Text = await page.locator('#messages-list').innerText();
  await page.locator('#pagination button').filter({ hasText: /^2$/ }).click();
  await page.waitForTimeout(1500);
  const page2Text = await page.locator('#messages-list').innerText();
  ok('点下一页后内容变了', page1Text !== page2Text);
  ok('第 2 页仍显示 10 条', (await page.locator('#messages-list li').count()) === 10);
  await page.locator('#pagination button').filter({ hasText: /^1$/ }).click();
  await page.waitForTimeout(1500);
  ok('能翻回第 1 页', (await page.locator('#messages-list').innerText()) === page1Text);

  // 灯箱
  const thumb = page.locator('#messages-list .lightbox-trigger').first();
  ok('缩略图是灯箱触发器', await thumb.count() > 0);
  ok('灯箱初始隐藏', await page.locator('#lightbox').isHidden());
  await thumb.click();
  await page.waitForTimeout(600);
  ok('点缩略图后灯箱打开', await page.locator('#lightbox').isVisible());
  const lbSrc = await page.locator('#lightbox-img').getAttribute('src');
  ok('灯箱里是同一张图', !!lbSrc && lbSrc.includes('/api/media/'), String(lbSrc));
  ok('灯箱开启时锁住了背景滚动',
    await page.evaluate(() => document.body.style.overflow === 'hidden'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('按 Esc 关闭灯箱', await page.locator('#lightbox').isHidden());
  ok('关闭后恢复滚动', await page.evaluate(() => document.body.style.overflow === ''));

  await thumb.click();
  await page.waitForTimeout(500);
  await page.locator('#lightbox-close').click();
  await page.waitForTimeout(400);
  ok('点关闭按钮也能关', await page.locator('#lightbox').isHidden());

  /* ================================================================ */
  section('8. 页面：回复显示 + 待审核提示');
  const replyText = '页面上应该看到这条回复';
  await call(`/api/admin/messages/${replyTarget.id}/reply`, { method: 'POST', json: { reply: replyText }, token });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  ok('留言下方显示站长回复', (await page.locator('#messages-list').innerText()).includes(replyText));
  ok('回复有独立的样式块', await page.locator('#messages-list .border-l-4').count() >= 1);

  // 打开审核，提交一条，验证页面提示
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: true }, token });
  await page.fill('#msg-name', '页面审核测试');
  await page.fill('#msg-content', '这条应该提示等待审核');
  await page.click('#submit-btn');
  await page.waitForFunction(
    () => /审核|成功|失败|频繁/.test(document.querySelector('#form-status').textContent || ''),
    null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  const st = await page.locator('#form-status').innerText();
  ok('页面明确提示"等待站长审核"', /等待站长审核/.test(st), st);
  ok('待审核留言不出现在前台',
    !(await page.locator('#messages-list').innerText()).includes('这条应该提示等待审核'));
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: false }, token });

  /* ================================================================ */
  section('9. 后台页面（趋势图 / 筛选 / 回复 / 审核）');
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errs2 = [];
  p2.on('pageerror', e => errs2.push(String(e)));
  p2.on('console', m => { if (m.type() === 'error' && !/40[13]/.test(m.text())) errs2.push(m.text()); });
  await p2.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await p2.fill('#password', PW);
  await p2.click('#login-btn');
  await p2.waitForTimeout(3500);

  ok('后台登录成功', await p2.locator('#admin-view').isVisible());
  ok('趋势图渲染出 SVG', (await p2.locator('#trend-chart svg').count()) === 1);
  ok('趋势图有柱子', (await p2.locator('#trend-chart svg rect').count()) >= 7,
    String(await p2.locator('#trend-chart svg rect').count()));
  ok('趋势说明有文字', /共 \d+ 次访问/.test(await p2.locator('#trend-note').innerText()),
    await p2.locator('#trend-note').innerText());
  await p2.click('.trend-btn[data-days="7"]');
  await p2.waitForTimeout(1500);
  ok('切换 7 天后柱子变少', (await p2.locator('#trend-chart svg rect').count()) === 7,
    String(await p2.locator('#trend-chart svg rect').count()));

  ok('概览显示待审核数', /^\d+$/.test((await p2.locator('#stat-pending').innerText()).trim()));
  ok('概览显示配图占用', /MB|还没有配图/.test(await p2.locator('#stat-images-size').innerText()));

  ok('后台分页控件存在', await p2.locator('#admin-pagination').isVisible());
  await p2.click('.filter-btn[data-filter="pending"]');
  await p2.waitForTimeout(1500);
  const pendingRows = await p2.locator('#admin-messages li').count();
  ok('筛选「待审核」有结果（前面提交的那条）', pendingRows >= 1, String(pendingRows));

  // 通过审核
  await p2.locator('#admin-messages [data-approve]').first().click();
  await p2.waitForTimeout(2000);
  ok('通过后提示成功', /通过审核/.test(await p2.locator('#admin-status').innerText()),
    await p2.locator('#admin-status').innerText());

  // 回复
  await p2.click('.filter-btn[data-filter="all"]');
  await p2.waitForTimeout(1500);
  await p2.locator('#admin-messages [data-reply]').first().click();
  await p2.waitForTimeout(300);
  ok('回复框展开', await p2.locator('#admin-messages .reply-box').first().isVisible());
  await p2.locator('#admin-messages .reply-box textarea').first().fill('后台写入的回复');
  await p2.locator('#admin-messages [data-save-reply]').first().click();
  await p2.waitForTimeout(2000);
  ok('保存回复有提示', /回复已保存/.test(await p2.locator('#admin-status').innerText()),
    await p2.locator('#admin-status').innerText());

  ok('设置表单载入', await p2.locator('#settings-form').isVisible());
  ok('无 JS 报错（两个页面）', errors.length === 0 && errs2.length === 0,
    [...errors, ...errs2].join(' | '));

  await p2.screenshot({ path: `${TESTS}/admin-new-features.png`, fullPage: true });
  await browser.close();

  hookServer.close();
  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  if (hookServer) hookServer.close();
  console.log(log.join('\n'));
  console.error('\n测试崩溃:', e.message);
  process.exit(2);
});
