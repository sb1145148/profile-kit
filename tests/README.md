# 测试

这个站的端到端测试。**不依赖 Cloudflare 账号** —— 本地起一个用 `node:sqlite`
扮演 D1 的服务器，直接跑真实的 `worker/worker.js` 和 `frontend/`，
再用 Playwright 在真实浏览器里点。

加起来 **917 项断言**。

## 跑起来

```bash
cd tests
npm install          # 装 playwright
npx playwright install chromium

# 终端 A：起本地服务器（默认 8787）
npm run serve

# 终端 B：跑全部测试
npm test
```

或者只跑某个套件：

```bash
node features6-test.js
```

## 套件

| 文件 | 覆盖什么 |
| --- | --- |
| `profile-e2e.js` | 主站：资料卡、说说、作品集、留言、RSS、sitemap |
| `upload-test.js` | 图片上传、压缩、WebP、灯箱 |
| `admin-test.js` | 登录、鉴权、设置、导出、操作日志 |
| `features-test.js` | 第一批：留言分页/审核/回复、PWA、搜索 |
| `features2-test.js` | 第二批：文章、归档、标签、友链 |
| `features3-test.js` | 第三批：Markdown、备份、图片备份 |
| `features4-test.js` | 第四批：主题、背景、日历、批量操作 |
| `features5-test.js` | 第五批：自检、恢复、分享、进度条 |
| `features6-test.js` | 第六批：无障碍、安全头、Turnstile、Markdown、缩略图、离线缓存、窄屏 |
| `live-*.js` | **打线上**的测试，要真令牌（见下） |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TARGET` | `http://127.0.0.1:8787` | 测试哪个地址 |
| `ADMIN_PASSWORD` | `test-admin-pw-123` | 本地服务器的管理密码 |
| `PORT` | `8787` | 本地服务器端口 |

`live-*` 测试还需要：

```bash
export CLOUDFLARE_API_TOKEN=...   # 备份相关
export GH_TOKEN=...               # GitHub 备份仓库
```

**注意**：`live-*` 会真的往线上写数据，跑完记得清理。

## 两个坑（都踩过）

**① 本地不注册 Service Worker**

`core.js` 的 `initPWA` 里有一句「本地开发时不注册 SW，免得缓存干扰调试」。

所以**离线相关的东西本地测不了**，只能上线验。`features6-test.js` 里
对离线缓存做的是**源码级校验**（检查 `sw.js` 的预缓存列表），不是行为测试。

**② 测后台的时候注意时序**

后台的数据加载统一挂在 `admin.js` 的 `refreshAll()` 里（登录成功后）。
测试里点完登录要等一会儿，别立刻去读面板内容 —— 会读到「登录后加载…」。

## 断言总数

```
917 项
```

数字来自全部 9 个套件之和。改动之后如果数字变了，说明有断言被删了或者加漏了。
