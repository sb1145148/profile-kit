# profile-kit

一个完全跑在 Cloudflare 免费额度上的个人主页。**Pages + Workers + D1** ——
不用买服务器、前端不需要构建、也没有月账单。

[English](README.md) · [部署指南](DEPLOY.md)

用 AI 改这个项目？先让它读 [AGENTS.md](AGENTS.md) —— 里面写了东西都在哪、
以及 5 个会白白浪费一下午的坑。[llms.txt](llms.txt) 是给机器读的索引。

![首页](docs/home.jpg)

<p align="center">
  <img src="docs/mobile.jpg" width="220" alt="手机版">
  &nbsp;&nbsp;
  <img src="docs/article.jpg" width="420" alt="文章页">
  &nbsp;&nbsp;
  <img src="docs/admin.jpg" width="420" alt="后台">
</p>

---

## 有什么

不是个落地页，是一整套个人站：

| | |
| --- | --- |
| **资料卡** | 头像、一句话简介、自我介绍、技能（可选进度条）、项目、歌单、联系方式 —— 都在后台改 |
| **说说** | 短动态 + 配图 + 点赞 + 分页 |
| **作品集** | 图片网格 + 灯箱 |
| **文章** | Markdown 服务端渲染、目录、阅读进度、标签、归档、相关文章、每篇文章独立的分享卡片 |
| **留言板** | 嵌套回复、点赞、Markdown、配图、垃圾词过滤、可选 Turnstile、手动审核 |
| **更新日志** | 按日期记录的更新，后台可改 |
| **友链** | 自动抓头像的友情链接 |
| **搜索** | 跨文章 / 说说 / 留言的全文搜索 |
| **后台** | 12 个区块、密码登录、操作日志、备份与恢复、站点自检 |

还有那些通常会被跳过的部分：RSS、sitemap、PWA 离线、深色模式、
无障碍的触摸目标，以及 **914 项端到端断言**。

---

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sb1145148/profile-kit)

> ⚠️ 按钮只部署 **Worker 后端**。数据库要自己建、前端要自己部署，都是两三条命令。
> 完整步骤见 **[DEPLOY.md](DEPLOY.md)**（大约 15 分钟）。

手动部署：

```bash
git clone https://github.com/sb1145148/profile-kit
cd profile-kit
npm install

npx wrangler d1 create your-site-db      # 把输出的 id 填进 wrangler.toml
npx wrangler d1 execute your-site-db --remote --file=./worker/schema.sql
npx wrangler secret put ADMIN_PASSWORD   # 你的后台密码

npx wrangler deploy                      # 部署 API
cd frontend && npx wrangler pages deploy . --project-name=your-site
```

然后打开你站点上的 `/admin` 登录。

---

## 结构

```
frontend/            静态站点，由 Cloudflare Pages 托管
  *.html             一个页面对应一个文件 —— 没有 SPA 路由，HTML 不需要构建
  app.js pages.js    页面逻辑，一个文件管一块
  core.js            公共部分：主题、页头、API 客户端、Markdown 辅助
  media.js           前端生成图片缩略图（见下文）
  sw.js              Service Worker —— 离线缓存
  functions/         Pages Functions：/a/<slug>（注入 og 标签）、sitemap.xml
  tailwind.css       预编译好的 Tailwind v4（只在改样式时重新生成）

worker/              API，由 Cloudflare Workers 托管
  worker.js          路由 + PROFILE 常量 + 工具函数
  routes/            一个资源一个文件：posts / articles / friends / misc / system
  lib/               markdown、垃圾词、turnstile、操作日志、备份
  schema.sql         完整的 D1 建表脚本 —— 新库跑一次
  migrations/        已有数据库用的增量迁移

tests/               914 项端到端断言，不需要 Cloudflare 账号
build/               Tailwind 输入文件 + 给资源加哈希的发版脚本
```

**为什么不用框架？** 个人站就这么几个页面、一点动态内容。原生 JS 让整个项目
可审计、秒级部署、永久免费。代价是要多写点 DOM 代码 —— 这个体量完全可以接受。

---

## 怎么改成你自己的

**资料卡**只有一个地方 —— `worker/worker.js` 顶部的 `PROFILE` 常量。改完重新
部署 Worker 即可：

```js
const PROFILE = {
  name: '你的名字',
  tagline: '一句话简介',
  skills: ['JavaScript', { name: 'Rust', level: 60 }],
  projects: [{ title: '…', desc: '…', link: '…', demos: [{ label: '在线试玩', url: '…' }] }],
  contacts: [{ label: 'GitHub', value: 'github.com/you', link: 'https://github.com/you' }],
  // …
};
```

**其它所有内容** —— 说说、文章、图片、留言、更新日志、站点设置 ——
都存在 D1 里，在 `/admin` 后台编辑。

**配色**是 Tailwind 类加上 `frontend/style.css` 里的 CSS 变量。如果你新增或改了
工具类，要重新生成：

```bash
npm run css        # 然后再 npm run release
```

---

## 几个值得看的地方

**不花钱也能做图片缩略图。** 作品集把图显示成 280px 的格子，灯箱却需要原图。
为了填一个小格子去下载 800 KB 的照片，90% 的字节都浪费了。Cloudflare 的实时图片
缩放是付费附加功能，所以改成上传时用浏览器 `canvas` 生成一张 640px 的 JPEG 一起传。
网格请求 `/api/media/<token>?s=thumb`，灯箱仍用原图。没有缩略图的老图片自动回落成
原图，不会 404。结果：首页传输从 **1.86 MB 降到 179 KB**。

**Markdown 是服务端渲染的，而且先转义。** 先做 HTML 转义，**再**套 Markdown 规则，
所以原始 HTML 永远进不来。@提及会先变成占位符再转义，之后才渲染成按钮。

**离线是真的能用。** Service Worker 同时预缓存 `.html` 文件和 pretty URL
（`/changelog` 和 `/changelog.html` 都缓存）—— 这是个很隐蔽的 bug，
修之前除了首页，所有页面离线都打不开。

---

## 测试

```bash
cd tests
npm install && npx playwright install chromium
npm test
```

9 个套件、914 项断言。**不需要 Cloudflare 账号，也不需要联网** —— 本地起一个
服务器，用内存 SQLite 扮演 D1 跑真实的 `worker/worker.js`，Playwright 驱动真实浏览器。
详见 [tests/README.md](tests/README.md)。

---

## 许可证

代码是 [MIT](LICENSE)。

内容不是。示例文字、截图和图片都是占位内容，请换成你自己的 ——
不要把本仓库的示例内容当成自己的再发布一遍。
