/* ============================================================
 *  跑全部测试套件
 *
 *  每个套件跑之前都会重启一次本地服务器 —— 因为服务器用的是
 *  :memory: 的 SQLite，重启等于清库，避免上一个套件的测试数据
 *  影响下一个套件。
 *
 *  用法：
 *    node profile-server.mjs   （终端 A，先起服务器）
 *    node run-all.mjs          （终端 B）
 * ============================================================ */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const SUITES = [
  ['profile-e2e.js', '主站'],
  ['upload-test.js', '配图'],
  ['admin-test.js', '后台'],
  ['features-test.js', '第一批'],
  ['features2-test.js', '第二批'],
  ['features3-test.js', '第三批'],
  ['features4-test.js', '第四批'],
  ['features5-test.js', '第五批'],
  ['features6-test.js', '第六批'],
];

/* ---------- 服务器管理 ---------- */

async function ping() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function waitUp(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 本脚本自己管理服务器：如果已经有在跑的（比如你手动起来的），就不重复起。
 */
let ownServer = null;

async function ensureServer() {
  if (await ping()) return false;       // 已有服务器，不用自己起
  ownServer = spawn(process.execPath, [path.join(__dirname, 'profile-server.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const ok = await waitUp();
  if (!ok) throw new Error(`本地服务器起不来（端口 ${PORT}）`);
  return true;
}

/* ---------- 跑 ---------- */

let total = 0, failed = 0;

const started = await ensureServer();
if (started) console.log(`  自己起了本地服务器（:${PORT}）`);
else console.log(`  复用已有服务器（:${PORT}）`);

for (const [file, label] of SUITES) {
  if (!fs.existsSync(path.join(__dirname, file))) {
    console.log(`  ${label.padEnd(6)} 跳过（缺 ${file}）`);
    continue;
  }
  // 每个套件之间重启自己起的服务器，保证干净的库
  if (ownServer) {
    ownServer.kill();
    ownServer = null;
    ownServer = spawn(process.execPath, [path.join(__dirname, 'profile-server.mjs')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
    if (!(await waitUp())) throw new Error('服务器重启失败');
  }

  const out = execFileSync(process.execPath, [file], {
    cwd: __dirname,
    env: { ...process.env, TARGET: BASE },
    encoding: 'utf8',
  });
  const m = out.match(/通过 (\d+) \/ (\d+)/);
  if (m) {
    total += Number(m[1]);
    failed += Number(m[2]) - Number(m[1]);
    console.log(`  ${label.padEnd(6)} 通过 ${m[1]} / ${m[2]}`);
  } else {
    console.log(`  ${label.padEnd(6)} 没有输出结果`);
    failed++;
  }
}

if (ownServer) ownServer.kill();

console.log('  ' + '─'.repeat(20));
console.log(`  合计 ${total} 项${failed ? `，失败 ${failed} 项` : ''}`);
process.exit(failed ? 1 : 0);
