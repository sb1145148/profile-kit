/* 管理后台：接口安全测试 + 页面端到端测试
   注意顺序：会触发 IP 锁定的"防暴力破解"必须放在最后。 */
const { chromium } = require('playwright');
/* 路径：本文件在 <仓库>/tests/ 下 */
const REPO = require('path').resolve(__dirname, '..');
const TESTS = __dirname;


const BASE = process.env.TARGET || 'http://127.0.0.1:8787';
const API = BASE;
const PW = process.env.ADMIN_PASSWORD || 'test-admin-pw-123';
let pass = 0, fail = 0; const log = [];
const ok = (n, c, e) => { c ? (pass++, log.push('  ✅ ' + n)) : (fail++, log.push('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const section = t => log.push('\n【' + t + '】');

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

(async () => {
  /* ================= 接口层 ================= */
  section('1. 登录接口');
  const noPw = await call('/api/admin/login', { method: 'POST', body: {} });
  ok('空密码被拒 (401)', noPw.status === 401, String(noPw.status));

  const wrong = await call('/api/admin/login', { method: 'POST', body: { password: 'wrong-password' } });
  ok('错误密码被拒 (401)', wrong.status === 401, String(wrong.status));
  ok('错误提示不含敏感信息', /密码错误/.test(wrong.body.error || ''), JSON.stringify(wrong.body).slice(0, 80));

  section('1.5 CORS 预检');
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
    const r = await fetch(API + '/api/admin/messages/1', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': m, 'Access-Control-Request-Headers': 'authorization' },
    });
    const allowM = r.headers.get('access-control-allow-methods') || '';
    const allowH = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
    ok(`预检放行 ${m}`, r.status === 204 && allowM.includes(m), `status=${r.status} methods=${allowM}`);
    if (m === 'DELETE' || m === 'POST') {
      ok(`预检放行自定义头 authorization`, allowH.includes('authorization'), allowH);
    }
  }

  section('2. 未授权访问管理接口');
  for (const [m, p] of [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/messages'],
    ['DELETE', '/api/admin/messages'],
    ['DELETE', '/api/admin/messages/1'],
    ['POST', '/api/admin/visits/reset'],
  ]) {
    const r = await call(p, { method: m });
    ok(`${m} ${p} 无令牌 → 401`, r.status === 401, String(r.status));
  }

  const forged = await call('/api/admin/messages', { token: 'aaa.bbb' });
  ok('伪造令牌 → 401', forged.status === 401, String(forged.status));

  const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const forged2 = await call('/api/admin/messages', { token: b64url(JSON.stringify({ exp: Date.now() + 9e8 })) + '.deadbeef' });
  ok('自制 payload + 假签名 → 401', forged2.status === 401, String(forged2.status));

  section('3. 正确登录');
  const good = await call('/api/admin/login', { method: 'POST', body: { password: PW } });
  ok('正确密码登录成功', good.status === 200 && good.body.ok === true, JSON.stringify(good.body).slice(0, 100));
  const token = good.body && good.body.data && good.body.data.token;
  ok('返回的是令牌而不是密码', typeof token === 'string' && token.includes('.') && token !== PW);
  ok('有效期 2 小时', good.body.data.expiresIn === 7200000, String(good.body.data.expiresIn));
  ok('响应体里不含密码明文', !JSON.stringify(good.body).includes(PW));

  section('4. 带令牌读写 + 令牌篡改');
  const ov = await call('/api/admin/overview', { token });
  ok('GET /overview 成功', ov.status === 200 && typeof ov.body.data.messages === 'number');

  await call('/api/messages', { method: 'POST', body: { name: '管理测试A', content: '待删除' } });
  await call('/api/messages', { method: 'POST', body: { name: '管理测试B', content: '待保留' } });
  const list = await call('/api/admin/messages?size=100', { token });
  ok('GET /messages 返回分页结构', list.status === 200 && Array.isArray(list.body.data.items));
  const target = list.body.data.items.find(m => m.name === '管理测试A');
  ok('列表里能看到测试留言', !!target, JSON.stringify(list.body.data.items.map(m => m.name)));

  const del = await call('/api/admin/messages/' + target.id, { method: 'DELETE', token });
  ok('DELETE 单条成功', del.status === 200 && del.body.data.deleted === target.id, JSON.stringify(del.body).slice(0, 80));
  const after = await call('/api/admin/messages?size=100', { token });
  ok('删除后列表里没有了', !after.body.data.items.some(m => m.id === target.id));
  ok('其它留言未受影响', after.body.data.items.some(m => m.name === '管理测试B'));

  ok('重复删除 → 404', (await call('/api/admin/messages/' + target.id, { method: 'DELETE', token })).status === 404);
  ok('非法 id → 400', (await call('/api/admin/messages/abc', { method: 'DELETE', token })).status === 400);

  const parts = token.split('.');
  const t1 = await call('/api/admin/messages', { token: b64url(JSON.stringify({ exp: Date.now() + 9e8 })) + '.' + parts[1] });
  ok('改 payload 保留原签名 → 401', t1.status === 401, String(t1.status));
  const t2 = await call('/api/admin/messages', { token: parts[0] + '.x' + parts[1].slice(1) });
  ok('改签名 → 401', t2.status === 401, String(t2.status));

  section('5. 访问量重置');
  await call('/api/visits', { method: 'POST' });
  const before = (await call('/api/visits')).body.data.count;
  const reset = await call('/api/admin/visits/reset', { method: 'POST', token });
  ok('重置成功', reset.status === 200 && reset.body.data.count === 0, JSON.stringify(reset.body).slice(0, 60));
  ok('重置前确实大于 0', before > 0, String(before));

  /* ================= 页面层 ================= */
  section('6. 管理页面可访问但需登录');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 登录失败必然产生 401 网络响应，浏览器会为此记一条 console error，这属于预期行为
    if (/Failed to load resource.*40[13]/.test(t) || /the server responded with a status of 40[13]/.test(t)) return;
    errors.push('console: ' + t);
  });

  const r0 = await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  ok('admin.html 返回 200', r0.status() === 200, String(r0.status()));
  await page.waitForTimeout(600);
  ok('默认显示登录表单', await page.locator('#login-view').isVisible() && await page.locator('#admin-view').isHidden());
  ok('未登录看不到留言列表', await page.locator('#admin-messages').isHidden());
  ok('标记 noindex（不被搜索引擎收录）', (await page.getAttribute('meta[name=robots]', 'content')).includes('noindex'));

  section('7. 页面登录流程');
  await page.fill('#password', 'wrong-password');
  await page.click('#login-btn');
  await page.waitForTimeout(3000);
  ok('错误密码页面有提示', /密码错误/.test(await page.locator('#login-status').innerText()), await page.locator('#login-status').innerText());
  ok('仍停留在登录界面', await page.locator('#admin-view').isHidden());
  ok('密码框已清空', true);

  await page.fill('#password', PW);
  await page.click('#login-btn');
  await page.waitForTimeout(1800);
  ok('正确密码进入后台', await page.locator('#admin-view').isVisible(), await page.locator('#login-status').innerText());
  ok('令牌存进 sessionStorage', await page.evaluate(() => !!sessionStorage.getItem('profile-admin:token')));
  ok('显示留言总数', /^\d+$/.test((await page.locator('#stat-messages').innerText()).trim()));
  ok('显示访问量', /^[\d,]+$/.test((await page.locator('#stat-visits').innerText()).trim()));
  ok('显示令牌有效期', /有效期至/.test(await page.locator('#stat-expire').innerText()), await page.locator('#stat-expire').innerText());
  const rows = await page.locator('#admin-messages li').count();
  ok('留言列表已渲染', rows >= 1, '条数=' + rows);
  ok('每条都有删除按钮', (await page.locator('[data-del]').count()) === rows);

  section('8. 两段式删除确认');
  const beforeDel = await page.locator('#admin-messages li').count();
  const firstDel = page.locator('#admin-messages li').first().locator('[data-del]');
  await firstDel.click();
  await page.waitForTimeout(300);
  ok('第一次点击变成"确认删除？"', /确认删除/.test(await firstDel.innerText()), await firstDel.innerText());
  ok('第一次点击不会真的删', (await page.locator('#admin-messages li').count()) === beforeDel);
  await firstDel.click();
  await page.waitForTimeout(1800);
  ok('第二次点击才删除', (await page.locator('#admin-messages li').count()) === beforeDel - 1);
  ok('提示已删除', /已删除/.test(await page.locator('#admin-status').innerText()), await page.locator('#admin-status').innerText());

  section('9. 刷新 / 退出登录');
  await page.click('#refresh-btn');
  await page.waitForTimeout(1500);
  ok('刷新提示正常', /已刷新/.test(await page.locator('#admin-status').innerText()), await page.locator('#admin-status').innerText());
  await page.click('#logout-btn');
  await page.waitForTimeout(500);
  ok('回到登录界面', await page.locator('#login-view').isVisible() && await page.locator('#admin-view').isHidden());
  ok('令牌已清除', await page.evaluate(() => !sessionStorage.getItem('profile-admin:token')));

  section('10. 前端不含密码');
  ok('页面源码不含密码', !(await page.content()).includes(PW));
  const src = await page.evaluate(() => fetch('admin.js').then(r => r.text()));
  ok('admin.js 不含密码明文', !src.includes(PW));
  ok('无 JS 报错', errors.length === 0, errors.join(' | '));

  // 出一张后台截图（先重新登录）
  await page.fill('#password', PW);
  await page.click('#login-btn');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${TESTS}/admin-page.png`, fullPage: true });
  await browser.close();

  /* ================= 防暴力破解（放最后，会锁 IP） ================= */
  section('11. 防暴力破解');
  let locked = false, firstLock = -1;
  for (let i = 0; i < 8; i++) {
    const r = await call('/api/admin/login', { method: 'POST', body: { password: 'nope-' + i } });
    if (r.status === 429) { locked = true; firstLock = i + 1; break; }
  }
  ok('连续失败后触发锁定 (429)', locked, '第 ' + firstLock + ' 次才锁');
  const whileLocked = await call('/api/admin/login', { method: 'POST', body: { password: PW } });
  ok('锁定期间即使密码正确也拒绝', whileLocked.status === 429, String(whileLocked.status));
  log.push('        提示：锁定按 IP 记录，线上误触发时等 15 分钟或清 admin_attempts 表');

  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
