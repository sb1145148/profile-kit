/**
 * 本地端到端测试服务器
 *  - 用 Node 24 内置的 node:sqlite 扮演 D1，直接跑真实的 worker.js
 *  - 同时把 frontend/ 当静态目录伺服
 * 这样不依赖 Cloudflare 账号就能把前后端整条链路跑通。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// 相对路径：本文件在 <仓库>/tests/ 下
import worker from '../worker/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');       // 仓库根目录（本文件在 tests/ 下）
const TESTS = __dirname;                          // 测试目录
const ROOT = REPO;
const PORT = Number(process.env.PORT || 8787);

/* ---------- 1. 建一个内存 SQLite，执行 schema.sql ---------- */
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));

/* ---------- 2. 把 D1 的 Workers Binding API 映射到 node:sqlite ---------- */
function makeStatement(sql) {
  let params = [];
  return {
    bind(...args) { params = args; return this; },
    async first() {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
    async run() {
      const info = db.prepare(sql).run(...params);
      return {
        success: true,
        meta: {
          last_row_id: Number(info.lastInsertRowid),
          changes: Number(info.changes),
        },
      };
    },
  };
}

const env = {
  DB: { prepare: (sql) => makeStatement(sql) },
  ALLOWED_ORIGINS: '*',
  // 管理后台密码（本地测试用固定值；线上是 Cloudflare Secret）
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'test-admin-pw-123',
  // 自动备份用的 GitHub 令牌（线上是 Cloudflare Secret，这里从环境变量取）
  GH_TOKEN: process.env.GH_TOKEN || '',
  SITE_URL: process.env.SITE_URL || 'https://example.com',
  // Pages Functions 要请求的 API 地址。线上是 api.example.com，
  // 本地必须指回自己，否则 Function 会去查生产数据。
  API_BASE: process.env.API_BASE || 'http://127.0.0.1:' + PORT,
  SITE_BASE: process.env.SITE_BASE || 'http://127.0.0.1:' + PORT,
  // Turnstile 的 secret。默认空 = 后端跳过人机校验。
  // 测试时可以用 Cloudflare 的官方测试密钥：
  //   1x0000000000000000000000000000000AA  永远通过
  //   2x0000000000000000000000000000000AA  永远失败
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET || '',
};


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith('/api')) {
    // 把 node 的 req 转成标准的 Request
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });

    // 真实 Worker 运行时会传一个带 waitUntil 的 ctx；
    // 这里补上，否则「后台异步任务」（比如兜底备份）在本地永远不会跑。
    const pending = [];
    const fakeCtx = {
      waitUntil: (p) => { pending.push(Promise.resolve(p)); },
      passThroughOnException: () => {},
    };
    const response = await worker.fetch(request, env, fakeCtx);
    // 等后台任务收尾，保证本地测试能看到结果
    if (pending.length) await Promise.allSettled(pending);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }


    // ============================================================
    // Cloudflare Pages Functions 的本地模拟
    //
    // 线上 /a/<slug> 和 /sitemap.xml 走 Functions，
    // 本地如果模拟不了，这两个功能就没法端到端测。
    //
    // 做法：真的把 functions/ 下的模块 import 进来调用，
    //       给它一个能读静态文件的 env.ASSETS。
    // ============================================================
    const FRONT_DIR = path.join(ROOT, 'frontend');

    const assetsEnv = {
      ...env,
      ASSETS: {
        fetch: async (input) => {
          const u = typeof input === 'string' ? new URL(input, url.origin) : input;
          let fp = path.join(FRONT_DIR, u.pathname === '/' ? 'index.html' : u.pathname);
          if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp = fp + '.html';
          if (!fs.existsSync(fp)) return new Response('not found', { status: 404 });
          return new Response(fs.readFileSync(fp), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
      },
    };

    async function runFunction(relPath, params) {
      const mod = await import(path.join(FRONT_DIR, relPath));
      const request = new Request(url.toString(), { method: 'GET' });
      const ctx = { request, env: assetsEnv, params, next: async () => new Response('next') };
      return mod.onRequestGet(ctx);
    }

    // /a/<slug>
    if (url.pathname.startsWith('/a/')) {
      const slug = decodeURIComponent(url.pathname.slice(3));
      try {
        const response = await runFunction('functions/a/[slug].js', { slug });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      } catch (e) {
        console.error('Function /a/ 失败:', e.message);
      }
    }

    // /sitemap.xml
    if (url.pathname === '/sitemap.xml') {
      try {
        const response = await runFunction('functions/sitemap.xml.js', {});
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      } catch (e) {
        console.error('Function /sitemap.xml 失败:', e.message);
      }
    }


/* ---------- 3. HTTP 服务：/api/* 交给 worker，其余当静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};


    // ============================================================
    // 模拟 Cloudflare Pages 的 _redirects
    //
    // 只实现我们真正用到的那部分：<来源> <目标> [状态码]。
    // 通配符和占位符不支持 —— 用不到，实现了也没法验证。
    // ============================================================
    const redirectsFile = path.join(FRONT_DIR, '_redirects');
    if (fs.existsSync(redirectsFile)) {
      const rules = fs.readFileSync(redirectsFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/\s+/));

      for (const [from, to, codeRaw] of rules) {
        if (url.pathname !== from) continue;
        const code = Number(codeRaw || 302);

        if (code === 200) {
          // 重写：把目标文件的内容直接返回，地址栏不变
          let fp = path.join(FRONT_DIR, to);
          if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp = fp + '.html';
          if (fs.existsSync(fp)) {
            res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
            res.end(fs.readFileSync(fp));
            return;
          }
        } else {
          res.writeHead(code, { Location: to });
          res.end();
          return;
        }
      }
    }


  // 静态文件
  // 模拟 Cloudflare Pages 的行为：
  //   1) 无扩展名的路径自动补 .html（/articles → articles.html）
  //   2) 找不到时返回自定义 404 页
  const FRONT = path.join(ROOT, 'frontend');
  let filePath = path.join(FRONT, url.pathname === '/' ? 'index.html' : url.pathname);

  if (!filePath.startsWith(FRONT)) { res.writeHead(403); res.end(); return; }

  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    const asHtml = filePath + '.html';
    if (fs.existsSync(asHtml)) filePath = asHtml;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const idx = path.join(filePath, 'index.html');
    if (fs.existsSync(idx)) filePath = idx;
  }

  if (!fs.existsSync(filePath)) {
    // 和线上一样走自定义 404 页
    const custom = path.join(FRONT, '404.html');
    const body = fs.existsSync(custom) ? fs.readFileSync(custom) : '404';
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 和 Pages 一致：HTML 每次校验，其它资源可以缓一会儿
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=14400',
  });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[test-server] http://127.0.0.1:${PORT}  (frontend + api)`);
});
