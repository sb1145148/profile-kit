/* ============================================================
 *  第四批功能测试：
 *    从备份恢复 / 文章目录 / 站点自检 / 后台批量操作
 *    @回复 / 分享按钮 / 阅读进度条 / 深色模式按时段
 * ============================================================ */
const { chromium } = require('playwright');
/* 路径：本文件在 <仓库>/tests/ 下 */
const REPO = require('path').resolve(__dirname, '..');
const TESTS = __dirname;


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

/** 构造一份备份对象 */
function makeBackup(tag) {
  return {
    exported_at: '2026-10-13T00:00:00.000Z',
    counts: {},
    messages: [
      { id: 1, name: '恢复甲' + tag, content: '恢复内容 A', status: 'approved', likes: 7, parent_id: null, created_at: '2026-10-01 10:00:00' },
      { id: 2, name: '恢复乙' + tag, content: '恢复内容 B', status: 'approved', likes: 0, parent_id: null, created_at: '2026-10-02 10:00:00' },
    ],
    posts: [{ id: 1, content: '恢复的说说 ' + tag, status: 'approved', likes: 2, created_at: '2026-10-03 10:00:00' }],
    articles: [{ id: 1, slug: 'restored-' + tag, title: '恢复的文章 ' + tag, summary: '', content: '# 标题\n正文', tags: '恢复', status: 'published', pinned: 0, views: 0, created_at: '2026-10-04 10:00:00', updated_at: '2026-10-04 10:00:00' }],
    friends: [{ id: 1, name: '恢复友链 ' + tag, url: 'https://restored.example.com', avatar: null, desc: '', status: 'approved', sort: 0, created_at: '2026-10-05 10:00:00' }],
    gallery: [{ id: 1, image_id: 999999, title: '引用了不存在图片', note: '', sort: 0, created_at: '2026-10-06 10:00:00' }],
    visits: 0,
    visit_daily: [],
  };
}

(async () => {
  TOKEN = (await call('/api/admin/login', { method: 'POST', json: { password: PW }, token: '' })).body.data.token;
  const tag = String(Date.now()).slice(-6);

  /* ================================================================ */
  section('1. 从备份恢复（接口）');
  const backup = makeBackup(tag);

  ok('非法文件被拒',
    (await call('/api/admin/restore', { method: 'POST', json: { data: { foo: 1 }, mode: 'preview' } })).status === 400);
  ok('非对象被拒',
    (await call('/api/admin/restore', { method: 'POST', json: { data: 'abc', mode: 'preview' } })).status === 400);

  const prev = await call('/api/admin/restore', { method: 'POST', json: { data: backup, mode: 'preview' } });
  ok('预览成功', prev.status === 200 && prev.body.data.mode === 'preview');
  ok('预览返回各表条数', prev.body.data.counts && typeof prev.body.data.counts.messages.inBackup === 'number',
    JSON.stringify(prev.body.data.counts).slice(0, 90));
  ok('预览给出警告', (prev.body.data.warnings || []).length >= 1);

  const beforeMsgs = (await call('/api/messages?size=50')).body.data.total;
  ok('预览没有写库', (await call('/api/messages?size=50')).body.data.total === beforeMsgs, '条数变了');

  ok('覆盖恢复没 confirm 被拒',
    (await call('/api/admin/restore', { method: 'POST', json: { data: backup, mode: 'replace' } })).status === 400);
  ok('合并恢复没 confirm 被拒',
    (await call('/api/admin/restore', { method: 'POST', json: { data: backup, mode: 'merge' } })).status === 400);
  ok('confirm 值不对也被拒',
    (await call('/api/admin/restore', { method: 'POST', json: { data: backup, mode: 'replace', confirm: 'yes' } })).status === 400);

  const merged = await call('/api/admin/restore', { method: 'POST', json: { data: backup, mode: 'merge', confirm: 'MERGE' } });
  ok('合并恢复成功', merged.status === 200, JSON.stringify(merged.body).slice(0, 100));
  const s = merged.body.data.summary;
  ok('留言写入 2 条', s.messages.written === 2, JSON.stringify(s.messages));
  ok('说说写入 1 条', s.posts.written === 1);
  ok('文章写入 1 条', s.articles.written === 1);
  ok('友链写入 1 条', s.friends.written === 1);
  ok('引用不存在图片的相册条目被跳过', s.gallery.written === 0 && s.gallery.skipped === 1, JSON.stringify(s.gallery));

  const afterMsgs = (await call('/api/messages?size=50')).body.data;
  ok('恢复后能查到留言', afterMsgs.items.some((m) => m.name === '恢复甲' + tag));
  ok('恢复回了点赞数', afterMsgs.items.find((m) => m.name === '恢复甲' + tag).likes === 7);
  ok('恢复后能查到文章', (await call('/api/articles?size=50')).body.data.items.some((a) => a.title.includes(tag)));
  ok('恢复后能查到友链', (await call('/api/friends')).body.data.items.some((f) => f.name.includes(tag)));
  ok('恢复后相册里没有那条脏数据', !(await call('/api/gallery')).body.data.items.some((g) => g.title === '引用了不存在图片'));

  ok('恢复了操作日志', (await call('/api/admin/audit')).body.data.items.some((a) => a.action === 'restore'));

  /* ================================================================ */
  section('2. 后台批量操作（接口）');
  for (let i = 1; i <= 5; i++) await call('/api/messages', { method: 'POST', json: { name: '批量' + i + tag, content: '第 ' + i } });
  const list = (await call('/api/admin/messages?size=100')).body.data.items;
  const ids = list.filter((m) => String(m.name).startsWith('批量')).map((m) => m.id).slice(0, 3);
  ok('能取到 3 个 id', ids.length === 3, String(ids.length));

  const un = await call('/api/admin/messages-batch', { method: 'POST', json: { ids, action: 'unapprove' } });
  ok('批量撤下成功', un.status === 200 && un.body.data.affected === 3, JSON.stringify(un.body.data));
  const afterUn = (await call('/api/admin/messages?size=100')).body.data.items.filter((m) => ids.includes(m.id));
  ok('撤下后状态变成 pending', afterUn.every((m) => m.status === 'pending'), afterUn.map((m) => m.status).join(','));

  const ap = await call('/api/admin/messages-batch', { method: 'POST', json: { ids, action: 'approve' } });
  ok('批量通过成功', ap.body.data.affected === 3);
  ok('通过后前台可见', (await call('/api/messages?size=100')).body.data.items.some((m) => ids.includes(m.id)));

  const del = await call('/api/admin/messages-batch', { method: 'POST', json: { ids, action: 'delete' } });
  ok('批量删除成功', del.body.data.affected === 3, JSON.stringify(del.body.data));
  ok('删完前台查不到了', !(await call('/api/messages?size=100')).body.data.items.some((m) => ids.includes(m.id)));

  ok('空 ids 被拒', (await call('/api/admin/messages-batch', { method: 'POST', json: { ids: [], action: 'approve' } })).status === 400);
  ok('非法 action 被拒', (await call('/api/admin/messages-batch', { method: 'POST', json: { ids: [1], action: 'hack' } })).status === 400);
  ok('非法 id 被过滤后拒绝',
    (await call('/api/admin/messages-batch', { method: 'POST', json: { ids: ['a', -1], action: 'approve' } })).status === 400);

  /* ================================================================ */
  section('3. 站点自检');
  const sc = await call('/api/admin/selfcheck', { method: 'POST' });
  ok('自检可运行', sc.status === 200 && Array.isArray(sc.body.data.checks), JSON.stringify(sc.body).slice(0, 90));
  const names = sc.body.data.checks.map((c) => c.name);
  for (const n of ['数据库读取', '数据库写入', '图片存储', '备份令牌', 'GitHub 连通性']) {
    ok(`自检含「${n}」`, names.includes(n), names.join(','));
  }
  ok('每项带耗时', sc.body.data.checks.every((c) => typeof c.ms === 'number'));
  ok('有 ok 汇总字段', typeof sc.body.data.ok === 'boolean');
  const st = await call('/api/admin/selfcheck');
  ok('自检状态可读', st.status === 200 && 'lastResult' in st.body.data);

  /* ================================================================ */
  section('4. 深色模式：四种模式与按时段');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('ERR ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errs.push('LOG ' + m.text());
  });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // 连点 8 次收集模式，确认四种都到得了
  const modes = [];
  for (let i = 0; i < 8; i++) {
    await page.click('#theme-toggle');
    await page.waitForTimeout(220);
    modes.push(await page.evaluate(() => localStorage.getItem('your-site:theme')));
  }
  ok('四种模式都能切到',
    ['light', 'dark', 'auto', 'system'].every((m) => modes.includes(m)),
    [...new Set(modes)].join(','));
  ok('每次点击都真的换了模式',
    modes.every((m, i) => i === 0 || m !== modes[i - 1]), modes.join(' → '));

  // 关键体验：从没选过主题的人（大多数第一次点的状态），点一下必须看得出变化
  await page.evaluate(() => localStorage.removeItem('your-site:theme'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const beforeResolved = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);
  const afterResolved = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('第一次点主题按钮必定有可见变化', beforeResolved !== afterResolved,
    `${beforeResolved} → ${afterResolved}`);
  ok('按钮 title 会说明当前模式',
    /主题：/.test(await page.getAttribute('#theme-toggle', 'title')),
    await page.getAttribute('#theme-toggle', 'title'));

  // 切到 auto，验证它按当前小时解析
  await page.evaluate(() => localStorage.setItem('your-site:theme', 'auto'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const autoResolved = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const hourNow = new Date().getHours();
  const shouldBeDark = hourNow >= 18 || hourNow < 6;
  ok('auto 模式按当前时段解析主题',
    autoResolved === (shouldBeDark ? 'dark' : 'light'),
    `当前 ${hourNow} 点 → ${autoResolved}（期望 ${shouldBeDark ? 'dark' : 'light'}）`);

  await page.evaluate(() => localStorage.setItem('your-site:theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  ok('light 模式生效', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');
  await page.evaluate(() => localStorage.setItem('your-site:theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  ok('dark 模式生效', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');

  /* ================================================================ */
  section('5. @回复');
  await call('/api/messages', { method: 'POST', json: { name: '小明' + tag, content: '我是楼上的小明' } });
  const parentMsg = (await call('/api/messages?size=100')).body.data.items.find((m) => m.name === '小明' + tag);
  await call('/api/messages', { method: 'POST', json: { name: '小红' + tag, content: '@小明' + tag + ' 我回复你', parent_id: parentMsg.id } });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#messages-list li').length > 0, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  ok('@提及被渲染成标签', (await page.locator('#messages-list [data-mention]').count()) >= 1,
    String(await page.locator('#messages-list [data-mention]').count()));
  const mentionName = await page.locator('#messages-list [data-mention]').first().getAttribute('data-mention');
  ok('@标签带上了对方昵称', mentionName && mentionName.includes('小明'), String(mentionName));
  ok('长着 data-author 的留言存在', (await page.locator('#messages-list [data-author]').count()) >= 2);

  // 点 @ 应该能滚动到目标并高亮
  await page.locator('#messages-list [data-mention]').first().click();
  await page.waitForTimeout(1000);
  const highlighted = await page.locator('#messages-list [data-author].ring-2').count();
  ok('点 @ 会高亮目标留言', highlighted >= 1, `高亮 ${highlighted} 个`);

  // 点「回复」应预填 @昵称
  await page.locator('#messages-list [data-reply-to]').first().click();
  await page.waitForTimeout(400);
  const ta = page.locator('#messages-list .reply-box textarea').first();
  ok('点回复会预填 @昵称', (await ta.inputValue()).startsWith('@'), await ta.inputValue());

  /* ================================================================ */
  section('6. 文章目录 / 进度条 / 分享');
  const longMd = ['# 长文', '', '引言。']
    .concat(['## 第一节', '内容', '', '### 1.1 小节', '内容', '', '## 第二节', '内容', '', '### 2.1 小节', '内容', '', '## 第三节', '内容'])
    .join('\n');
  await call('/api/admin/articles', {
    method: 'POST',
    json: { title: '目录测试文章 ' + tag, summary: '', tags: '测试', status: 'published', content: longMd },
  });

  await page.goto(BASE + '/articles', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#article-list li').length > 0, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  ok('文章列表有内容', (await page.locator('#article-list li').count()) >= 1);

  await page.locator('#article-list a').first().click();
  await page.waitForFunction(() => (document.querySelector('#article-body')?.innerText || '').length > 20, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const tocCount = await page.locator('#toc-desktop a[data-toc]').count();
  ok('目录生成（h2+h3 共 5 条）', tocCount === 5, String(tocCount));
  ok('正文里的标题带上了锚点 id', (await page.locator('#article-body h2[id^="sec-"], #article-body h3[id^="sec-"]').count()) === 5);
  ok('h1 不进目录', (await page.locator('#toc-desktop a[data-toc]').evaluateAll((as) =>
    as.every((a) => !a.textContent.includes('长文')))));

  ok('移动端目录在桌面隐藏',
    (await page.evaluate(() => getComputedStyle(document.querySelector('#toc-mobile')).display)) === 'none');

  // 点目录跳转
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const targetId = await page.locator('#toc-desktop a[data-toc]').nth(2).getAttribute('data-toc');
  await page.locator('#toc-desktop a[data-toc]').nth(2).click();
  await page.waitForTimeout(1200);
  const topPos = await page.evaluate((id) => document.getElementById(id).getBoundingClientRect().top, targetId);
  ok('点目录能跳到对应小节', topPos > -60 && topPos < 400, `${Math.round(topPos)}px`);

  // 进度条
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const w0 = await page.evaluate(() => document.querySelector('#reading-progress').style.width);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);
  const w1 = await page.evaluate(() => document.querySelector('#reading-progress').style.width);
  ok('阅读进度条随滚动增长', parseFloat(w1) > parseFloat(w0), `${w0} → ${w1}`);

  // 分享
  ok('有复制链接按钮', await page.locator('#share-copy').isVisible());
  ok('有微博分享按钮', await page.locator('#share-weibo').isVisible());
  const weiboHref = await page.locator('#share-weibo').getAttribute('href');
  // 分享地址现在用 /a/<slug>（那条路由有服务端注入的 og 标签，
  // 微信/QQ 里才会出卡片），不再是 /articles?slug=
  ok('微博链接指向可分享地址 /a/<slug>',
    weiboHref && weiboHref.includes('service.weibo.com')
      && (weiboHref.includes('%2Fa%2F') || weiboHref.includes('/a/')),
    String(weiboHref).slice(0, 110));

  // 复制链接（给剪贴板权限）
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#share-copy');
  await page.waitForTimeout(800);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok('复制链接得到 /a/<slug>', /\/a\//.test(decodeURIComponent(clip)), clip.slice(0, 80));

  /* ================================================================ */
  section('7. 后台界面（批量 / 自检 / 恢复）');
  const pa = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errsA = [];
  pa.on('pageerror', (e) => errsA.push('ERR ' + e.message));
  pa.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errsA.push('LOG ' + m.text());
  });
  pa.on('dialog', (d) => d.accept());

  await pa.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await pa.fill('#password', PW);
  await pa.click('#login-btn');
  await pa.waitForTimeout(4500);

  ok('后台登录成功', await pa.locator('#admin-view').isVisible());
  ok('批量工具条存在', await pa.locator('#batch-bar').isVisible());
  const boxes = await pa.locator('.msg-pick').count();
  ok('每条留言都有勾选框', boxes >= 1, String(boxes));
  ok('未选中时批量按钮禁用', await pa.locator('[data-batch="approve"]').isDisabled());

  await pa.locator('#select-all').check();
  await pa.waitForTimeout(400);
  ok('全选后计数正确', (await pa.locator('#batch-count').innerText()).includes(`已选 ${boxes}`),
    await pa.locator('#batch-count').innerText());
  ok('全选后按钮可用', !(await pa.locator('[data-batch="approve"]').isDisabled()));

  await pa.locator('[data-batch="approve"]').click();
  await pa.waitForTimeout(3000);
  ok('批量通过有反馈', /批量通过完成/.test(await pa.locator('#admin-status').innerText()),
    await pa.locator('#admin-status').innerText());

  ok('自检板块存在', await pa.locator('#selfcheck-run').isVisible());
  await pa.locator('#selfcheck-run').click();
  await pa.waitForTimeout(10000);
  ok('自检出结果', (await pa.locator('#selfcheck-list li').count()) >= 4,
    String(await pa.locator('#selfcheck-list li').count()));

  ok('恢复板块存在', await pa.locator('#restore-file').isVisible());
  ok('没预览前恢复按钮禁用', await pa.locator('#restore-merge').isDisabled());

  const path = require('path');
  const tmp = path.join(require('os').tmpdir(), 'feat4-backup.json');
  require('fs').writeFileSync(tmp, JSON.stringify(makeBackup('ui' + tag)));
  await pa.setInputFiles('#restore-file', tmp);
  await pa.waitForTimeout(400);
  await pa.click('#restore-preview');
  await pa.waitForTimeout(2500);
  ok('预览展示了各表条数', (await pa.locator('#restore-result tbody tr').count()) >= 4,
    String(await pa.locator('#restore-result tbody tr').count()));
  ok('预览后按钮启用', !(await pa.locator('#restore-merge').isDisabled()));
  await pa.click('#restore-merge');
  await pa.waitForTimeout(3500);
  ok('界面恢复成功', /恢复完成/.test(await pa.locator('#restore-status').innerText()),
    (await pa.locator('#restore-status').innerText()).slice(0, 80));

  ok('后台无 JS 报错', errsA.length === 0, errsA.join(' | ').slice(0, 200));
  ok('前台无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 200));

  await pa.screenshot({ path: `${TESTS}/admin-v7.png`, fullPage: true });
  await page.goto(BASE + '/articles', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#article-list li').length > 0, null, { timeout: 20000 }).catch(() => {});
  await page.locator('#article-list a').first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${TESTS}/article-v7.png`, fullPage: true });
  await browser.close();

  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(log.join('\n'));
  console.error('\n测试崩溃:', e.message);
  process.exit(2);
});
