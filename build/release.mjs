#!/usr/bin/env node
/* ============================================================
 *  build/release.mjs —— 发版前跑一次，自动对齐所有静态资源版本号
 *
 *  用法：
 *    node build/release.mjs          正常发版（会改文件）
 *    node build/release.mjs --check   只检查，不改（CI / 提交前用）
 *
 * ------------------------------------------------------------
 *  为什么要有这个脚本
 *
 *  之前版本号是手工维护的 `?v=3`、`?v=4`…，结果我连续栽了三次：
 *
 *    1. 改了 JS 忘了加版本号  → 老用户拿到缓存里的旧文件
 *    2. 部署刚完成就去请求新的 ?v=N → 某个边缘节点当时还是旧文件，
 *       把旧内容缓存到了这个新 URL 上（TTL 4 小时），等于"污染"了新地址
 *    3. 改完文件忘了跑构建    → 本地检查和线上不一致
 *
 *  所以改成**内容哈希**：
 *
 *    <script src="app.js?v=8f3a91c2">
 *
 *  文件内容一变，哈希就变，URL 就变 —— 天然不会命中旧缓存，
 *  也就不存在"忘了加版本号"和"污染缓存"这两类问题。
 *  反过来，没改的文件哈希不变，缓存继续有效。
 *
 * ------------------------------------------------------------
 *  为什么不用文件名哈希（app.8f3a91c2.js）
 *
 *  那更彻底，但要真的重命名文件、还要写映射表，对这个纯静态站
 *  收益不大。用 query string 能达到同样效果，而 HTML 里改动最小。
 * ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONT = path.join(ROOT, 'frontend');

const CHECK_ONLY = process.argv.includes('--check');

/* ------------------------------------------------------------
 * 1. 先编译 Tailwind
 *    必须在算哈希之前做，否则算出来的是上一版的哈希。
 * ------------------------------------------------------------ */
function buildTailwind() {
  const bin = path.join(ROOT, 'build', 'node_modules', '.bin', 'tailwindcss');
  if (!fs.existsSync(bin)) {
    console.log('  ⚠️ 没找到 tailwindcss，跳过编译（先跑 cd build && npm install）');
    return;
  }
  execFileSync(bin, [
    '-i', path.join(ROOT, 'build', 'tailwind.input.css'),
    '-o', path.join(FRONT, 'tailwind.css'),
    '--minify',
  ], { cwd: path.join(ROOT, 'build'), stdio: ['ignore', 'ignore', 'pipe'] });
  console.log('  ✅ Tailwind 已重新编译');
}

/* ------------------------------------------------------------
 * 2. 每个资源算一个短哈希
 * ------------------------------------------------------------ */
const shortHash = (file) => {
  const buf = fs.readFileSync(path.join(FRONT, file));
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
};

/* ------------------------------------------------------------
 * 3. 改写所有 HTML 里的 ?v=
 * ------------------------------------------------------------ */
const HTML_FILES = fs.readdirSync(FRONT).filter((f) => f.endsWith('.html'));

// 匹配 src="xxx.js?v=..." 或 href="xxx.css?v=..."，也兼容 /xxx.js?v=
const REF_RE = /(\/?)([A-Za-z0-9_-]+\.(?:js|css))\?v=[A-Za-z0-9]+/g;

function rewriteHtml(name, hashes) {
  const file = path.join(FRONT, name);
  const before = fs.readFileSync(file, 'utf8');
  const missing = new Set();

  const after = before.replace(REF_RE, (full, slash, asset) => {
    if (!(asset in hashes)) missing.add(asset);
    return `${slash}${asset}?v=${hashes[asset] ?? '??'}`;
  });

  const changed = after !== before;
  if (changed && !CHECK_ONLY) fs.writeFileSync(file, after);
  return { changed, missing: [...missing] };
}

/* ------------------------------------------------------------
 * 4. Service Worker 的缓存版本
 *    用所有资源哈希拼起来再哈希 —— 只要有一个文件变了它就变，
 *    一个都没变就保持原样（不会白白让 SW 重新拉一遍全部资源）。
 * ------------------------------------------------------------ */
function bumpSW(hashes) {
  const file = path.join(FRONT, 'sw.js');
  const src = fs.readFileSync(file, 'utf8');

  const combined = crypto
    .createHash('sha256')
    .update(Object.keys(hashes).sort().map((k) => `${k}:${hashes[k]}`).join('|'))
    .digest('hex')
    .slice(0, 8);

  let next = src.replace(/const CACHE = '[^']*';/, `const CACHE = 'your-site-${combined}';`);

  // SHELL 里的 JS/CSS 也要带上 ?v=hash，否则预缓存的是 /core.js，
  // 而页面请求的是 /core.js?v=xxxx —— cache-first 匹配不上（ignoreSearch:false），
  // 预缓存就白做了，每个资源还得再拉一次。
  next = next.replace(
    /(['"])\/([A-Za-z0-9_-]+\.(?:js|css))(['"])/g,
    (full, q1, asset, q2) => {
      if (!(asset in hashes)) return full;
      return `${q1}/${asset}?v=${hashes[asset]}${q2}`;
    }
  );

  const changed = next !== src;
  if (changed && !CHECK_ONLY) fs.writeFileSync(file, next);
  return { changed, version: combined };
}

/* ------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------ */
console.log(CHECK_ONLY ? '\n🔍 检查模式（不会改文件）\n' : '\n🚀 发版\n');

if (!CHECK_ONLY) buildTailwind();

// 收集所有被引用的资源，逐个算哈希
const referenced = new Set();
for (const f of HTML_FILES) {
  const txt = fs.readFileSync(path.join(FRONT, f), 'utf8');
  for (const m of txt.matchAll(/["']\/?([A-Za-z0-9_-]+\.(?:js|css))\?v=/g)) referenced.add(m[1]);
}

const hashes = {};
for (const asset of [...referenced].sort()) {
  const full = path.join(FRONT, asset);
  if (!fs.existsSync(full)) {
    console.log(`  ❌ ${asset} 被引用了但文件不存在`);
    process.exitCode = 1;
    continue;
  }
  hashes[asset] = shortHash(asset);
}

console.log('  资源哈希：');
for (const [k, v] of Object.entries(hashes)) {
  const size = fs.statSync(path.join(FRONT, k)).size;
  console.log(`    ${k.padEnd(20)} ${v}  ${(size / 1024).toFixed(1)} KB`);
}

console.log();
let anyChanged = false;
for (const f of HTML_FILES.sort()) {
  const r = rewriteHtml(f, hashes);
  if (r.missing.length) {
    console.log(`  ❌ ${f} 引用了不存在的资源：${r.missing.join(', ')}`);
    process.exitCode = 1;
  } else if (r.changed) {
    console.log(`  ✏️  ${f} 已更新`);
    anyChanged = true;
  }
}

const sw = bumpSW(hashes);
if (sw.changed) {
  console.log(`  ✏️  sw.js 缓存版本 → ${sw.version}`);
  anyChanged = true;
}

console.log();
if (CHECK_ONLY) {
  console.log(anyChanged ? '  ⚠️ 有文件需要更新，跑 `node build/release.mjs`' : '  ✅ 全部已是最新');
} else {
  console.log(anyChanged ? '  ✅ 完成。现在可以：git commit → push → wrangler pages deploy' : '  ✅ 没有变化（资源内容和上次一致）');
}

/* ------------------------------------------------------------
 * 顺带提醒：改了 class 要记得重建 Tailwind（上面已经自动做了），
 * 但 Pages Functions 和 Worker 是分开部署的，这里列一下别忘。
 * ------------------------------------------------------------ */
const touchedFn = fs.existsSync(path.join(FRONT, 'functions'));
if (touchedFn) {
  console.log('\n  📌 提醒：functions/ 目录存在，部署前端时必须在 frontend/ 里执行');
  console.log('       cd frontend && npx wrangler pages deploy . --project-name=your-site --branch=main');
  console.log('       （从别的目录执行的话 wrangler 找不到 functions/，Functions 不会被打包）');
}
