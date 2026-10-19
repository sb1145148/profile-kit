/* 个人主页前端端到端测试（对本地 test-server，真实 worker + sqlite） */
const { chromium } = require('playwright');
/* 路径：本文件在 <仓库>/tests/ 下 */
const REPO = require('path').resolve(__dirname, '..');
const TESTS = __dirname;


const URL = 'http://127.0.0.1:8787/';
let pass = 0, fail = 0; const log = [];
const ok = (n, c, e) => { c ? (pass++, log.push('  ✅ ' + n)) : (fail++, log.push('  ❌ ' + n + (e ? '  → ' + e : ''))); };
const section = t => log.push('\n【' + t + '】');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; let dialogFired = null;

  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', async d => { dialogFired = d.message(); await d.dismiss(); });

  section('1. 页面加载与 Tailwind 生效');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // 等资料卡真渲染出来再断言（改 domcontentloaded 后固定等待不够稳）
  await page.waitForFunction(
    () => document.querySelectorAll('#skills > *').length > 0
       && document.querySelectorAll('#projects-list > *').length > 0,
    null, { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(600);

  const h1Size = await page.evaluate(() => getComputedStyle(document.querySelector('#profile-name')).fontSize);
  // 新布局里资料卡的 h1 是 text-2xl（24px）
  ok('Tailwind 字号类生效（h1 字号 24px）', h1Size === '24px', h1Size);
  const headerPos = await page.evaluate(() => getComputedStyle(document.querySelector('header')).position);
  ok('顶部导航 sticky 生效', headerPos === 'sticky', headerPos);
  const borderColor = await page.evaluate(() => getComputedStyle(document.querySelector('header')).borderBottomColor);
  ok('border 颜色已解析（不是 currentColor）', borderColor !== 'currentcolor' && borderColor !== 'rgb(15, 23, 42)', borderColor);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // Tailwind v4 默认输出 oklch() 色域，rgb()/oklch() 都算通过
  ok('body 背景色生效（v4 oklch）', /^oklch\(/.test(bg) || bg === 'rgb(248, 250, 252)', bg);

  section('2. 个人信息渲染');
  ok('姓名已渲染', (await page.locator('#profile-name').innerText()) === 'Demo', await page.locator('#profile-name').innerText());
  ok('一句话简介已渲染', (await page.locator('#profile-tagline').innerText()) === '独立开发者 / Indie Developer', await page.locator('#profile-tagline').innerText());
  ok('自我简介已渲染', /这是一个示例站点/.test(await page.locator('#profile-bio').innerText()), await page.locator('#profile-bio').innerText());
  ok('头像 src 已设置', (await page.getAttribute('#profile-avatar', 'src')).includes('avatars.githubusercontent'));
  const skillCount = await page.locator('#skills-list > span').count();
  ok('技能以标签形式渲染（3 个）', skillCount === 3, String(skillCount));
  ok('技能标签含示例技能', (await page.locator('#skills').innerText()).includes('HTML / CSS / JavaScript'));
  const projCount = await page.locator('#projects-list article').count();
  ok('项目卡片数 = 2', projCount === 2, String(projCount));
  const projText = await page.locator('#projects-list').innerText();
  ok('示例项目都在页面上', /示例项目/.test(projText) && /第二个示例项目/.test(projText));

  // "直接玩"按钮（示例数据里第一个项目有一个 demos，第二个没有）
  const playBtns = page.locator('#projects-list a[href*="github.io"]');
  ok('「直接玩」按钮共 1 个', (await playBtns.count()) === 1, '实际 ' + await playBtns.count());
  const playHrefs = await playBtns.evaluateAll(as => as.map(a => a.href));
  ok('含试玩链接 your-project/', playHrefs.includes('https://your-name.github.io/your-project/'), playHrefs.join(' '));
  ok('按钮文案有「在线试玩」', /在线试玩/.test(projText));
  ok('按钮在新标签页打开（rel=noopener）',
    (await playBtns.evaluateAll(as => as.every(a => a.target === '_blank' && a.rel.includes('noopener')))));
  ok('没有 demos 的项目不显示试玩按钮',
   (await page.locator('#projects-list article').filter({ hasText: '第二个示例项目' }).locator('a[href*="github.io"]').count()) === 0);
  const contactCount = await page.locator('#contacts a').count();
  ok('联系方式按钮数 = 2', contactCount === 2, String(contactCount));
  const contactText = await page.locator('#contacts').innerText();
  ok('含 GitHub / 邮箱', /GitHub/.test(contactText) && /邮箱/.test(contactText), contactText.replace(/\n/g,' '));

  section('3. 留言列表（自建数据，可重复运行）');
  // 直接用接口写入一条，再刷新列表验证渲染与排序
  const stamp = Date.now();
  await page.evaluate(async (t) => {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '自测机器人', content: '基准留言 ' + t })
    });
  }, stamp);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const listText = await page.locator('#messages-list').innerText();
  ok('留言列表已渲染', (await page.locator('#messages-list li').count()) >= 1);
  ok('刚写入的留言出现在列表里', listText.includes('基准留言 ' + stamp));
  const firstText = await page.locator('#messages-list li').first().innerText();
  ok('最新留言排在最前（时间倒序）', firstText.includes('基准留言 ' + stamp), firstText.slice(0, 40));

  section('4. XSS 防护（关键）');
  // 写入两条恶意 payload，再刷新页面看是否会被执行
  await page.evaluate(async () => {
    const bad = ['<script>alert("xss")<\/script>', '<img src=x onerror="window.__xss=1">'];
    for (let i = 0; i < bad.length; i++) {
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'XSS测试' + i, content: bad[i] })
      });
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  ok('没有任何 alert 弹窗', dialogFired === null, String(dialogFired));
  ok('DOM 里没有被注入的 script 标签',
    await page.evaluate(() => ![...document.querySelectorAll('#messages-list script')].length));
  ok('DOM 里没有被注入的 img 标签',
    await page.evaluate(() => ![...document.querySelectorAll('#messages-list img')].length));
  ok('onerror payload 未被执行', await page.evaluate(() => window.__xss === undefined));
  const rendered = await page.locator('#messages-list').innerText();
  ok('尖括号以纯文本形式展示',
    rendered.includes('<script>alert("xss")</script>') && rendered.includes('onerror'),
    rendered.slice(0, 80).replace(/\n/g, ' / '));

  section('5. 提交留言 → 清空表单 + 刷新列表');
  const before = await page.locator('#messages-list li').count();
  await page.fill('#msg-name', '李四');
  await page.fill('#msg-content', '你好，这是测试留言');
  await page.click('#submit-btn');
  await page.waitForTimeout(1500);
  const after = await page.locator('#messages-list li').count();
  ok('提交后列表条数 +1', after === before + 1, `${before} → ${after}`);
  ok('表单已清空（昵称）', (await page.inputValue('#msg-name')) === '');
  ok('表单已清空（内容）', (await page.inputValue('#msg-content')) === '');
  ok('提示"留言成功"', /留言成功/.test(await page.locator('#form-status').innerText()));
  ok('新留言出现在列表里', (await page.locator('#messages-list').innerText()).includes('你好，这是测试留言'));
  const firstItem = await page.locator('#messages-list li').first().innerText();
  ok('最新留言排在最前（时间倒序）', firstItem.includes('你好，这是测试留言'), firstItem.slice(0, 40));

  section('6. 表单校验');
  await page.fill('#msg-name', '');
  await page.fill('#msg-content', '');
  await page.evaluate(() => { document.querySelector('#msg-name').removeAttribute('required'); document.querySelector('#msg-content').removeAttribute('required'); });
  await page.click('#submit-btn');
  await page.waitForTimeout(400);
  ok('空昵称被拦截', /请填写昵称/.test(await page.locator('#form-status').innerText()));
  await page.fill('#msg-name', '王五');
  await page.click('#submit-btn');
  await page.waitForTimeout(400);
  ok('空内容被拦截', /请填写留言内容/.test(await page.locator('#form-status').innerText()));

  section('7. 访问量统计');
  const visitTxt = await page.locator('#visit-count').innerText();
  ok('页脚访问量有数字', /^[\d,]+$/.test(visitTxt), visitTxt);
  const n1 = parseInt(visitTxt.replace(/,/g, ''), 10);
  ok('访问量 >= 1', n1 >= 1, String(n1));

  // 同一天再刷新，不应重复计数
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const n2 = parseInt((await page.locator('#visit-count').innerText()).replace(/,/g, ''), 10);
  ok('同一天刷新不重复计数（localStorage 去重）', n2 === n1, `${n1} → ${n2}`);

  // 清掉 localStorage 再刷新，应该 +1
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const n3 = parseInt((await page.locator('#visit-count').innerText()).replace(/,/g, ''), 10);
  ok('清掉标记后再访问会 +1', n3 === n2 + 1, `${n2} → ${n3}`);

  section('8. 响应式');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflowInfo = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const bad = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0) {
        const chain = [];
        let n = el;
        for (let i = 0; i < 4 && n; i++) { chain.push((n.id ? '#' + n.id : '') + '.' + String(n.className || '').split(' ').slice(0, 3).join('.')); n = n.parentElement; }
        bad.push(`<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> right=${Math.round(r.right)} w=${Math.round(r.width)}`
          + ` cls="${String(el.className || '').slice(0, 90)}"`
          + ` html="${el.outerHTML.slice(0, 120).replace(/\s+/g, ' ')}"`
          + ` 祖先=${chain.join(' < ')}`);
      }
    });
    return { vw, sw, bad: bad.slice(0, 6) };
  });
  ok('移动端无横向溢出', overflowInfo.sw <= overflowInfo.vw + 1,
    `scrollWidth=${overflowInfo.sw} 视口=${overflowInfo.vw}` + (overflowInfo.bad.length ? ' | 溢出: ' + overflowInfo.bad.join(' ;; ') : ' | 未定位到元素'));
  await page.screenshot({ path: `${TESTS}/profile-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${TESTS}/profile-desktop.png`, fullPage: true });

  section('9. 无 JS 报错');
  ok('无页面错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
