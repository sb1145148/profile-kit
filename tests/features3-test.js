/* ============================================================
 *  第三批功能测试：说说 / 文章 / 友链 / 关于我 / 搜索 / RSS / GitHub /
 *                PWA / 垃圾过滤 / 操作日志 / 访问来源 / 备份 / 嵌套回复
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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let TOKEN = '';

async function call(path, { method = 'GET', json, raw = false, token } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const tk = token === undefined ? TOKEN : token;
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(API + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  if (raw) return r;
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function upload(path, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('image', new Blob([file], { type: 'image/png' }), 'a.png');
  const r = await fetch(API + path, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

(async () => {
  TOKEN = (await call('/api/admin/login', { method: 'POST', json: { password: PW }, token: '' })).body.data.token;

  /* ================================================================ */
  section('1. 说说（发布 / 点赞 / 审核 / 删除）');
  const p1 = await upload('/api/admin/posts', { content: '第一条说说：测试一下' });
  ok('发布说说成功', p1.status === 201, JSON.stringify(p1.body).slice(0, 90));
  const p2 = await upload('/api/admin/posts', { content: '第二条：带图的', }, PNG);
  ok('带图说说发布成功', p2.status === 201);

  const posts = await call('/api/posts');
  ok('公开列表能看到 2 条', posts.body.data.total === 2, String(posts.body.data.total));
  ok('带图那条有 image_url', posts.body.data.items.some((x) => x.image_url && x.image_url.includes('/api/media/')));

  const pid = p1.body.data.id;
  const lk = await call(`/api/posts/${pid}/like`, { method: 'POST' });
  ok('说说点赞 → 1', lk.body.data.likes === 1, JSON.stringify(lk.body).slice(0, 60));

  // 审核
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: true } });
  const pend = await upload('/api/admin/posts', { content: '这条要审核', status: 'pending' });
  ok('可以发成待审核', pend.status === 201);
  const pub = await call('/api/posts');
  ok('待审核说说不显示', !pub.body.data.items.some((x) => x.content === '这条要审核'));
  await call(`/api/admin/posts/${pend.body.data.id}/approve`, { method: 'POST', json: { approve: true } });
  const pub2 = await call('/api/posts');
  ok('通过后显示', pub2.body.data.items.some((x) => x.content === '这条要审核'));
  await call('/api/admin/settings', { method: 'PUT', json: { require_approval: false } });

  /* ================================================================ */
  section('2. 文章（Markdown / slug / 阅读数 / 标签 / 草稿）');
  const a1 = await call('/api/admin/articles', {
    method: 'POST',
    json: {
      title: '测试文章：Markdown 全语法',
      summary: '摘要内容',
      tags: '测试, Markdown, 测试',
      status: 'published', pinned: true,
      content: '# 一级标题\n\n正文有 **粗体**、*斜体*、`代码` 和 [链接](https://example.com)。\n\n## 二级标题\n\n- 列表一\n- 列表二\n\n1. 有序一\n2. 有序二\n\n> 引用文字\n\n```js\nconst a = 1;\n```\n\n---\n\n结束。',
    },
  });
  ok('建文章成功', a1.status === 201, JSON.stringify(a1.body).slice(0, 90));
  const slug = a1.body.data.slug;
  ok('自动生成 slug', /^[\w\u4e00-\u9fa5-]+$/.test(slug), String(slug));

  // 草稿
  await call('/api/admin/articles', {
    method: 'POST',
    json: { title: '草稿不该出现', content: 'x', status: 'draft' },
  });
  const list = await call('/api/articles');
  ok('草稿不出现在公开列表', !list.body.data.items.some((a) => a.title === '草稿不该出现'));
  ok('标签去重了', list.body.data.items[0].tags.filter((t) => t === '测试').length === 1,
    JSON.stringify(list.body.data.items[0].tags));

  // 表格渲染（第四批加的 Markdown 能力）
  const tbl = await call('/api/admin/article-preview', {
    method: 'POST',
    json: { content: '| 项目 | 花费 |\n| --- | --- |\n| 域名 | **0** |\n| 托管 | 0 |' },
  });
  const th = tbl.body.data.html;
  ok('Markdown 支持表格', th.includes('<table class="md-table">'), th.slice(0, 80));
  ok('表格有表头和表体', th.includes('<thead>') && th.includes('<tbody>'));
  ok('表格单元格支持粗体', th.includes('<td><strong>0</strong></td>'));
  ok('表格不被 p 包裹', !th.includes('<p><div class="md-table-wrap"'));
  const notTbl = await call('/api/admin/article-preview', {
    method: 'POST', json: { content: '这是一句话 | 有竖线 | 但下一行不是分隔行' },
  });
  ok('普通竖线文本不会被误判成表格', !notTbl.body.data.html.includes('<table'), notTbl.body.data.html.slice(0, 60));

  const detail = await call('/api/articles/' + encodeURIComponent(slug));
  const h = detail.body.data.html;
  for (const [name, needle] of [
    ['h1', '<h1>'], ['h2', '<h2>'], ['粗体', '<strong>'], ['斜体', '<em>'],
    ['行内代码', 'md-code'], ['链接', '<a href'], ['无序列表', '<ul>'],
    ['有序列表', '<ol>'], ['引用', '<blockquote>'], ['代码块', 'md-pre'], ['分割线', '<hr>'],
  ]) {
    ok('渲染含 ' + name, h.includes(needle));
  }
  ok('危险标签被转义', !h.includes('<script'), '');

  const v1 = detail.body.data.views;
  const detail2 = await call('/api/articles/' + encodeURIComponent(slug));
  ok('阅读数会累加', detail2.body.data.views > v1, `${v1} → ${detail2.body.data.views}`);

  ok('不存在的 slug 返回 404',
    (await call('/api/articles/no-such-slug-xyz')).status === 404);

  /* ================================================================ */
  section('3. 友链（申请 / 审核 / 拒绝 / 校验）');
  const f1 = await call('/api/friends', { method: 'POST', json: { name: '朋友站A', url: 'https://a.example.com', desc: '测试' }, token: '' });
  ok('提交申请成功', f1.status === 201 && f1.body.data.status === 'pending', JSON.stringify(f1.body).slice(0, 80));
  ok('未通过的友链前台看不到', (await call('/api/friends')).body.data.total === 0);

  ok('重复网址会被拒',
    (await call('/api/friends', { method: 'POST', json: { name: '重复', url: 'https://a.example.com' }, token: '' })).status === 400);
  ok('非 http 网址会被拒',
    (await call('/api/friends', { method: 'POST', json: { name: 'x', url: 'javascript:alert(1)' }, token: '' })).status === 400);
  ok('缺名称会被拒',
    (await call('/api/friends', { method: 'POST', json: { name: '', url: 'https://b.example.com' }, token: '' })).status === 400);

  await call(`/api/admin/friends/${f1.body.data.id}/approve`, { method: 'POST', json: { approve: true } });
  ok('通过后前台可见', (await call('/api/friends')).body.data.total === 1);

  const f2 = await call('/api/friends', { method: 'POST', json: { name: '朋友站B', url: 'https://b.example.com' }, token: '' });
  await call(`/api/admin/friends/${f2.body.data.id}/reject`, { method: 'POST' });
  ok('拒绝后前台看不到', (await call('/api/friends')).body.data.total === 1);
  const fAdmin = await call('/api/admin/friends?status=rejected');
  ok('后台能按状态筛出已拒绝', fAdmin.body.data.items.some((x) => x.name === '朋友站B'));

  /* ================================================================ */
  section('4. 关于我');
  const aboutMd = '# 关于我\n\n我是一个**开发者**。\n\n- 喜欢折腾\n- 写点小工具\n';
  await call('/api/admin/settings', { method: 'PUT', json: { about_md: aboutMd } });
  const about = await call('/api/about');
  ok('返回 Markdown 原文', about.body.data.md.includes('关于我'));
  ok('返回渲染后的 HTML', about.body.data.html.includes('<h1>关于我</h1>'));
  ok('渲染含列表', about.body.data.html.includes('<ul>'));
  ok('渲染含粗体', about.body.data.html.includes('<strong>开发者</strong>'));

  /* ================================================================ */
  section('5. 垃圾过滤');
  await call('/api/admin/settings', { method: 'PUT', json: { spam_enabled: true, spam_max_links: 2 } });

  const bad1 = await call('/api/messages', { method: 'POST', json: { name: '刷子', content: '看看 https://a.com https://b.com https://c.com 这些' }, token: '' });
  ok('链接超限被拦', bad1.status === 400, JSON.stringify(bad1.body).slice(0, 80));

  const bad2 = await call('/api/messages', { method: 'POST', json: { name: '刷子', content: 'aaaaaaaaaa' }, token: '' });
  ok('连续重复字符被拦', bad2.status === 400, String(bad2.status));

  const bad3 = await call('/api/messages', { method: 'POST', json: { name: '刷子', content: '!!!!!!' }, token: '' });
  ok('纯符号被拦', bad3.status === 400, String(bad3.status));

  const good = await call('/api/messages', { method: 'POST', json: { name: '正常的人', content: '这是一条正常留言' }, token: '' });
  ok('正常内容能通过', good.status === 201, String(good.status));

  // 黑名单词
  await call('/api/admin/blocked-words', { method: 'POST', json: { word: '测试屏蔽词' } });
  const bad4 = await call('/api/messages', { method: 'POST', json: { name: '刷子2', content: '这里包含测试屏蔽词' }, token: '' });
  ok('命中黑名单词被拦', bad4.status === 400, String(bad4.status));
  const words = await call('/api/admin/blocked-words');
  ok('黑名单能列出', words.body.data.items.some((w) => w.word === '测试屏蔽词'));

  // 关掉过滤后应放行
  await call('/api/admin/settings', { method: 'PUT', json: { spam_enabled: false } });
  const nowOk = await call('/api/messages', { method: 'POST', json: { name: '刷子3', content: '这里包含测试屏蔽词' }, token: '' });
  ok('关掉过滤后放行', nowOk.status === 201, String(nowOk.status));
  await call('/api/admin/settings', { method: 'PUT', json: { spam_enabled: true } });

  /* ================================================================ */
  section('6. 操作日志');
  const audit = await call('/api/admin/audit');
  ok('日志有记录', audit.body.data.total > 0, String(audit.body.data.total));
  const actions = audit.body.data.items.map((a) => a.action);
  ok('记录了文章保存', actions.includes('article_save'), actions.join(','));
  ok('记录了说说发布', actions.includes('post_add'));
  ok('记录了改设置', actions.includes('update_settings'));
  ok('记录了垃圾词添加', actions.includes('blocked_word_add'));
  ok('日志条目有中文描述', audit.body.data.items.every((a) => typeof a.label === 'string' && a.label.length > 0));

  /* ================================================================ */
  section('7. 访问来源');
  for (const ref of ['https://www.bilibili.com/video/1', 'https://github.com/x', '', 'https://www.bilibili.com/video/2']) {
    await call('/api/visits', { method: 'POST', json: { ref }, token: '' });
  }
  const refs = await call('/api/admin/refs?days=7');
  ok('有来源数据', refs.body.data.byRef.length >= 1, JSON.stringify(refs.body.data.byRef));
  const refNames = refs.body.data.byRef.map((r) => r.raw);
  ok('识别出 bilibili', refNames.includes('bilibili.com'), refNames.join(','));
  ok('识别出 github', refNames.includes('github.com'), refNames.join(','));
  ok('空来源归为直接访问', refNames.includes('direct'));
  ok('www. 前缀被去掉', !refNames.some((r) => r.startsWith('www.')));

  /* ================================================================ */
  section('8. 备份（配置与状态）');
  const bk = await call('/api/admin/backup');
  ok('备份状态可读', bk.status === 200 && typeof bk.body.data.enabled === 'boolean');
  ok('能看到预览数据量', bk.body.data.preview && typeof bk.body.data.preview.counts.messages === 'number',
    JSON.stringify(bk.body.data.preview).slice(0, 90));
  ok('没有 GH_TOKEN 时明确提示', bk.body.data.hasToken === false);
  const bkRun = await call('/api/admin/backup', { method: 'POST' });
  ok('没令牌时立即备份给出明确错误', bkRun.status === 400 && /GH_TOKEN/.test(bkRun.body.error),
    JSON.stringify(bkRun.body).slice(0, 90));

  await call('/api/admin/settings', { method: 'PUT', json: { backup_enabled: true, backup_repo: 'your-name/your-site', backup_path: 'backup' } });
  const bk2 = await call('/api/admin/backup');
  ok('备份开关可保存', bk2.body.data.enabled === true);
  ok('仓库可保存', bk2.body.data.repo === 'your-name/your-site', bk2.body.data.repo);
  ok('非法仓库格式会被拒',
    (await call('/api/admin/settings', { method: 'PUT', json: { backup_repo: 'not-a-repo' } })).status === 400);

  /* ================================================================ */
  section('9. 留言嵌套回复');
  const parent = await call('/api/messages', { method: 'POST', json: { name: '楼主', content: '这是一条顶层留言' }, token: '' });
  const parentId = parent.body.data.id;
  ok('顶层留言 parent_id 为 null', parent.body.data.parent_id === null);

  const child = await call('/api/messages', { method: 'POST', json: { name: '回复者', content: '我回复楼主', parent_id: parentId }, token: '' });
  ok('回复成功', child.status === 201 && child.body.data.parent_id === parentId,
    JSON.stringify(child.body.data).slice(0, 90));

  // 再对回复回复 → 应该挂到顶层，不做无限层级
  const grand = await call('/api/messages', { method: 'POST', json: { name: '再回复', content: '回复这条回复', parent_id: child.body.data.id }, token: '' });
  ok('不允许无限层级（挂回顶层）', grand.body.data.parent_id === parentId, String(grand.body.data.parent_id));

  const list2 = await call('/api/messages?size=50');
  const top = list2.body.data.items.find((m) => m.id === parentId);
  ok('回复挂在父留言下', top && top.replies.length === 2, top ? String(top.replies.length) : 'null');
  ok('顶层列表不含回复', !list2.body.data.items.some((m) => m.id === child.body.data.id));
  ok('回复数正确', top.reply_count === 2, String(top && top.reply_count));

  /* ================================================================ */
  section('10. 全文搜索');
  const s1 = await call('/api/search?q=' + encodeURIComponent('Markdown'));
  ok('能搜到文章', s1.body.data.groups.some((g) => g.type === 'article'), JSON.stringify(s1.body.data.groups.map((g) => g.type)));
  const s2 = await call('/api/search?q=' + encodeURIComponent('顶层留言'));
  ok('能搜到留言', s2.body.data.groups.some((g) => g.type === 'message'));
  const s3 = await call('/api/search?q=' + encodeURIComponent('第二条'));
  ok('能搜到说说', s3.body.data.groups.some((g) => g.type === 'post'));
  const s4 = await call('/api/search?q=zzz' + Date.now());
  ok('搜不到时 total 为 0', s4.body.data.total === 0);
  const s5 = await call('/api/search?q=');
  ok('空关键词不报错', s5.status === 200 && s5.body.data.total === 0);

  /* ================================================================ */
  section('11. RSS');
  for (const [type, mustHave] of [['all', '文章'], ['articles', '文章'], ['posts', '说说'], ['messages', '留言']]) {
    const r = await fetch(API + '/api/feed.xml?type=' + type);
    const xml = await r.text();
    ok(`RSS(${type}) 返回正确类型`, (r.headers.get('content-type') || '').includes('rss+xml'), r.headers.get('content-type'));
    ok(`RSS(${type}) 是合法 XML 头`, xml.startsWith('<?xml'));
    ok(`RSS(${type}) 有 channel`, xml.includes('<channel>') && xml.includes('</rss>'));
    ok(`RSS(${type}) 含${mustHave}内容`, xml.includes('<item>'), '没有 item');
  }
  const rssAll = await (await fetch(API + '/api/feed.xml')).text();
  ok('RSS 里的链接是绝对地址', rssAll.includes('https://example.com'), '');
  ok('RSS 含 atom:link 自引用', rssAll.includes('atom:link'));

  /* ================================================================ */
  section('12. GitHub 卡片');
  // GitHub 是外部依赖，本地网络抖动时应视为跳过而不是失败
  let gh = await call('/api/github');
  if (!gh.body || !gh.body.data) {
    await new Promise((r) => setTimeout(r, 3000));
    gh = await call('/api/github');
  }
  if (gh.body && gh.body.data) {
    const d = gh.body.data;
    ok('返回 GitHub 数据', !!d.login, JSON.stringify(d).slice(0, 90));
    ok('含仓库列表', Array.isArray(d.repos));
    ok('含关注者数', typeof d.followers === 'number');
    ok('含仓库数', typeof d.public_repos === 'number');
    const gh2 = await call('/api/github');
    ok('第二次成功（命中缓存或再次拉取）', gh2.status === 200);
  } else {
    log.push('  ⚠️  跳过 GitHub 卡片断言：外部网络不可达（非本站问题）');
  }

  /* ================================================================ */
  section('13. PWA 资源');
  for (const f of ['/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png']) {
    const r = await fetch(BASE + f);
    ok(`${f} 可访问`, r.status === 200, String(r.status));
  }
  const mani = await (await fetch(BASE + '/manifest.json')).json();
  ok('manifest 有 name', !!mani.name);
  ok('manifest 是 standalone', mani.display === 'standalone');
  ok('manifest 有 192 icon', (mani.icons || []).some((i) => i.sizes === '192x192'));
  ok('manifest 有 512 icon', (mani.icons || []).some((i) => i.sizes === '512x512'));
  ok('manifest 有 maskable 图标', (mani.icons || []).some((i) => i.purpose === 'maskable'));
  const sw = await (await fetch(BASE + '/sw.js')).text();
  ok('SW 有 install/activate/fetch', sw.includes("addEventListener('install'") && sw.includes("addEventListener('activate'") && sw.includes("addEventListener('fetch'"));

  /* ================================================================ */
  section('14. 浏览器端（真实渲染）');
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
  await page.waitForTimeout(2500);
  ok('首页说说渲染', (await page.locator('#posts-list li').count()) >= 1, String(await page.locator('#posts-list li').count()));
  ok('首页友链渲染', (await page.locator('#friends-grid a').count()) >= 1);
  // GitHub 卡片是懒加载的，先滚到它才触发请求；外部接口可能慢，等它出结果
  await page.locator('#github-section').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#github-card')?.innerText || '';
      return t.includes('@') || t.includes('拿不到');
    },
    null, { timeout: 25000 }
  ).catch(() => {});
  const ghText = await page.locator('#github-card').innerText();
  ok('首页 GitHub 卡片渲染或明确提示不可用',
    ghText.includes('@') || ghText.includes('拿不到'), ghText.slice(0, 60));
  ok('首页留言区有回复', (await page.locator('#messages-list .reply-box').count()) >= 1);
  ok('回复显示在留言下方', (await page.locator('#messages-list').innerText()).includes('我回复楼主'));

  // 点回复按钮 → 展开
  await page.locator('#messages-list [data-reply-to]').first().click();
  await page.waitForTimeout(400);
  ok('点回复展开输入框', !(await page.locator('#messages-list .reply-box').first().isHidden()));

  // 文章页
  await page.goto(BASE + '/articles.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  ok('文章列表渲染', (await page.locator('#article-list li').count()) >= 1);
  ok('标签栏渲染', (await page.locator('#list-tags a').count()) >= 1);
  await page.locator('#article-list a').first().click();
  await page.waitForTimeout(2200);
  ok('文章详情渲染', await page.locator('#detail-view').isVisible());
  ok('详情正文有排版', (await page.locator('#article-body').innerText()).length > 30);
  ok('详情有 h1/h2', (await page.locator('#article-body h1, #article-body h2').count()) >= 1);
  ok('详情有代码块样式', (await page.locator('#article-body pre.md-pre').count()) >= 1);

  // 关于我
  await page.goto(BASE + '/about.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  ok('关于我渲染', (await page.locator('#about-body').innerText()).includes('开发者'));
  ok('关于我有排版容器', (await page.locator('#about-body.prose-custom').count()) === 1);

  // 搜索
  await page.goto(BASE + '/search.html?q=' + encodeURIComponent('Markdown'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ok('搜索结果渲染', (await page.locator('#search-results a').count()) >= 1);
  ok('搜索高亮命中词', (await page.locator('#search-results mark').count()) >= 1);

  // 后台
  const pAdmin = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errsA = [];
  pAdmin.on('pageerror', (e) => errsA.push('ERR ' + e.message));
  pAdmin.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|40[13]/.test(m.text())) return;
    errsA.push('LOG ' + m.text());
  });
  await pAdmin.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await pAdmin.fill('#password', PW);
  await pAdmin.click('#login-btn');
  await pAdmin.waitForTimeout(4500);

  ok('后台登录成功', await pAdmin.locator('#admin-view').isVisible());
  ok('后台说说列表渲染', (await pAdmin.locator('#admin-posts li').count()) >= 1);
  ok('后台文章列表渲染', (await pAdmin.locator('#admin-articles li').count()) >= 1);
  ok('后台友链列表渲染', (await pAdmin.locator('#admin-friends li').count()) >= 1);
  ok('后台操作日志渲染', (await pAdmin.locator('#audit-list li').count()) >= 1);
  ok('后台访问来源渲染', (await pAdmin.locator('#refs-chart li').count()) >= 1);
  ok('后台垃圾词渲染', (await pAdmin.locator('#word-list li').count()) >= 1);
  ok('后台趋势图渲染', (await pAdmin.locator('#trend-chart svg').count()) === 1);
  ok('后台概览含新统计', /文章 \d+ 篇/.test(await pAdmin.locator('#stat-content-detail').innerText()),
    await pAdmin.locator('#stat-content-detail').innerText());

  // 文章编辑器
  await pAdmin.click('#article-new');
  await pAdmin.waitForTimeout(400);
  ok('编辑器能打开', await pAdmin.locator('#article-form').isVisible());
  await pAdmin.fill('#article-title', '后台创建的文章 ' + Date.now());
  await pAdmin.fill('#article-content', '# 标题\n\n**粗体**内容');
  await pAdmin.click('#article-preview');
  await pAdmin.waitForTimeout(1200);
  ok('预览能渲染', await pAdmin.locator('#article-preview-box').isVisible());
  ok('预览内容正确', (await pAdmin.locator('#article-preview-box').innerText()).includes('粗体'));
  await pAdmin.click('#article-save');
  await pAdmin.waitForTimeout(2200);
  ok('保存成功', /已保存/.test(await pAdmin.locator('#article-msg').innerText()),
    await pAdmin.locator('#article-msg').innerText());

  // 说说发布
  await pAdmin.fill('#post-content', '从后台发的说说 ' + Date.now());
  await pAdmin.click('#post-save');
  await pAdmin.waitForTimeout(2200);
  ok('后台发说说成功', /已发布/.test(await pAdmin.locator('#post-status').innerText()),
    await pAdmin.locator('#post-status').innerText());

  ok('后台无 JS 报错', errsA.length === 0, errsA.join(' | ').slice(0, 200));
  ok('前台无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 200));

  await pAdmin.screenshot({ path: `${TESTS}/admin-v6.png`, fullPage: true });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${TESTS}/site-v6.png`, fullPage: true });
  await browser.close();

  console.log(log.join('\n'));
  console.log(`\n================ 通过 ${pass} / ${pass + fail} ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(log.join('\n'));
  console.error('\n测试崩溃:', e.message);
  process.exit(2);
});
