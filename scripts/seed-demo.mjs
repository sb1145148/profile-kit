/* ============================================================
 *  往本地/线上站点灌一批示例数据
 *
 *  用途：刚部署完站点是空的，跑一下这个就有内容可以看效果。
 *  注意：会真的写数据 —— 别对着生产环境的正式库跑。
 *
 *  用法：
 *    node scripts/seed-demo.mjs                          # 打本地 8787
 *    TARGET=https://your-site.pages.dev node scripts/seed-demo.mjs
 *    ADMIN_PASSWORD=xxx node scripts/seed-demo.mjs
 * ============================================================ */
const API = (process.env.API || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PW = process.env.ADMIN_PASSWORD || 'test-admin-pw-123';

let token = null;

async function call(path, { method = 'GET', json } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, {
    method, headers, body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

async function main() {
  console.log('  目标:', API);

  // ---- 登录 ----
  const login = await call('/api/admin/login', { method: 'POST', json: { password: PW } });
  if (login.status !== 200) {
    console.error('  ❌ 登录失败:', login.body?.error || login.status, '\n     密码用 ADMIN_PASSWORD 环境变量传');
    process.exit(1);
  }
  token = login.body.data.token;
  console.log('  ✅ 已登录');

  // ---- 说说 ----
  const posts = [
    '站点搭好了。前面是资料卡，往下是说说、作品集、文章、留言板。',
    '这些文字都在后台改 —— 打开 /admin，登录后就能编辑。',
  ];
  for (const content of posts) {
    const fd = new FormData();
    fd.append('content', content);
    const r = await fetch(API + '/api/admin/posts', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
    });
    console.log('  说说:', (r.status === 200 || r.status === 201) ? '✅' : '❌ ' + r.status);
  }

  // ---- 文章 ----
  const articles = [
    {
      title: '第一篇文章：这个站是怎么搭的',
      slug: 'hello',
      summary: 'Cloudflare Pages + Workers + D1，全程免费。',
      tags: '建站,教程',
      status: 'published',
      content: `## 为什么这么做

个人站不需要服务器。静态页面交给 **Pages**，接口交给 **Workers**，
数据放在 **D1**（SQLite）—— 三样都在免费额度里。

## 技术栈

- 前端：原生 HTML / CSS / JS，没有框架
- 样式：Tailwind v4，构建一次就能用
- 后端：一个 Worker，按资源拆成几个文件

\`\`\`js
// 接口长这样
export default {
  async fetch(request, env) {
    return new Response('hi');
  },
};
\`\`\`

## 接下来

打开 \`/admin\`，把这篇删掉，写你自己的。
`,
    },
    {
      title: '第二篇：Markdown 支持哪些语法',
      slug: 'markdown',
      summary: '标题、列表、代码块、表格、引用都支持。',
      tags: '教程,Markdown',
      status: 'published',
      content: `## 支持的语法

**加粗**、*斜体*、~~删除线~~、\`行内代码\`、[链接](https://example.com)。

- 无序列表
- 第二项

1. 有序列表
2. 第二项

> 引用块

| 列一 | 列二 |
| --- | --- |
| A | B |

\`\`\`python
print("代码块")
\`\`\`

### 不能用的

原始 HTML 会被转义掉 —— 这是有意的，防止 XSS。
`,
    },
  ];
  for (const a of articles) {
    const r = await call('/api/admin/articles', { method: 'POST', json: a });
    console.log('  文章:', (r.status === 200 || r.status === 201) ? '✅ ' + a.title.slice(0, 12) : '❌ ' + (r.body?.error || r.status));
  }

  // ---- 留言 ----
  for (const [name, content] of [
    ['示例访客', '这个站点结构挺清楚的，**Markdown** 也能用 👍'],
    ['另一个访客', '想问一下背景图在哪里换？'],
  ]) {
    const r = await call('/api/messages', { method: 'POST', json: { name, content } });
    console.log('  留言:', (r.status === 200 || r.status === 201) ? '✅' : '❌ ' + (r.body?.error || r.status));
  }

  // ---- 更新日志 ----
  for (const e of [
    { date: '2026-10-01', title: '站点上线', content: '第一版跑起来了：资料卡、说说、作品集、留言板。' },
    { date: '2026-10-05', title: '加了文章模块', content: '支持 Markdown、目录、标签和相关文章。' },
  ]) {
    const r = await call('/api/admin/changelog', { method: 'POST', json: e });
    console.log('  日志:', (r.status === 200 || r.status === 201) ? '✅ ' + e.title : '❌ ' + (r.body?.error || r.status));
  }

  console.log('\n  完成。打开站点看看效果。');
}

main().catch((e) => { console.error('  出错:', e.message); process.exit(1); });
