/**
 * ============================================================
 *  个人主页后端 API —— Cloudflare Worker + D1
 *  文件：worker/worker.js
 *
 *  路由：
 *    GET  /api/profile    返回个人信息
 *    GET  /api/messages   返回留言列表（时间倒序）
 *    POST /api/messages   新增留言  { name, content }
 *    GET  /api/visits     返回总访问量
 *    POST /api/visits     访问量 +1
 *    GET  /api/health     健康检查（自测用）
 * ============================================================
 */

/* ============================================================
 *  模块导入
 *
 *  一批新功能放在独立的模块里，避免这个文件无限膨胀：
 *    lib/markdown.js    Markdown 渲染（先转义再套规则，天然防 XSS）
 *    lib/spam.js        垃圾内容过滤
 *    lib/audit.js       后台操作日志
 *    lib/backup.js      数据自动备份到 GitHub
 *    routes/posts.js      说说
 *    routes/articles.js   文章
 *    routes/friends.js    友链
 *    routes/misc.js       关于我 / 搜索 / RSS / GitHub 卡片
 *    routes/system.js     操作日志 / 垃圾词 / 访问来源 / 备份（后台）
 *
 *  这些模块不直接 import worker.js 里的函数（那会形成循环引用），
 *  而是由 worker.js 把工具集合 H 传进去。
 * ============================================================ */
import { renderMarkdown, markdownToText } from './lib/markdown.js';
import { checkSpam } from './lib/spam.js';
import { verifyTurnstile, turnstileErrorMessage } from './lib/turnstile.js';
import { auditLog, listAuditLog } from './lib/audit.js';
import { performBackup, previewBackup, restoreImages } from './lib/backup.js';
import { route as postsRoute } from './routes/posts.js';
import { route as articlesRoute } from './routes/articles.js';
import { route as friendsRoute } from './routes/friends.js';
import { route as miscRoute } from './routes/misc.js';
import { route as systemRoute, runSelfCheck, alertIfBroken } from './routes/system.js';

/* ============================================================
 * 一、个人信息 —— 改这一段就行，改完重新部署 Worker 即可生效
 * ============================================================ */
const PROFILE = {
  // 名字、头像、一句话简介、自我介绍
  name: 'Demo',
  avatar: 'https://avatars.githubusercontent.com/u/9919?v=4',
  tagline: '独立开发者 / Indie Developer',
  bio: '这是一个示例站点。打开后台把这段文字换成你自己的介绍，' +
       '再改改下面的技能、项目、歌单和联系方式，就是你的主页了。',

  // 技能支持两种写法（可以混用）：
  //   写字符串          → 渲染成一个小标签
  //   写 {name, level}  → 渲染成带百分比进度条的卡片
  skills: [
    'HTML / CSS / JavaScript',
    { name: '示例：带进度条的技能', level: 80 },
    'Cloudflare Workers',
  ],

  // 项目经历
  projects: [
    {
      title: '示例项目',
      desc: '这里写项目简介。描述会自动换行，长一点也没关系。',
      tags: ['JavaScript', '示例标签'],
      link: 'https://github.com/your-name/your-project',
      // demos：可以直接玩的在线地址，写几个就渲染几个按钮
      demos: [
        { label: '在线试玩', url: 'https://your-name.github.io/your-project/' },
      ],
    },
    {
      title: '第二个示例项目',
      desc: '没有 demos 的项目就只显示一个「查看源码」按钮。',
      tags: ['HTML', 'CSS'],
      link: 'https://github.com/your-name/another-project',
    },
  ],

  // 歌单：只展示 + 跳转到 B站，不做站内播放
  // （站内播放要面临版权问题，而且浏览器会拦截自动播放，所以这里只做"歌单卡片"）
  // 每条：title 歌名 / artist 歌手 / note 你的短评（可留空）/ url B站链接
  // 没有填 artist / note 的条目，前端会自动不渲染那两行
  playlist: [
    { title: '示例曲目一', artist: '示例歌手', note: '一句短评', url: 'https://www.bilibili.com/' },
    { title: '示例曲目二', url: 'https://www.bilibili.com/' },
  ],

  // 联系方式：label 显示的名字 / value 显示的值 / link 点开去哪
  contacts: [
    { label: 'GitHub', value: 'github.com/your-name', link: 'https://github.com/your-name' },
    { label: '邮箱', value: 'you@example.com', link: 'mailto:you@example.com' },
  ],
};

/* ============================================================
 * 二、工具函数
 * ============================================================ */

/** 统一的 JSON 响应 */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', // 留言/计数都是实时数据，不让中间层缓存
      // 禁止浏览器嗅探内容类型。JSON 接口本来不该有这个风险，
      // 但万一哪天某个接口把用户可控的字符串回了出去，
      // 这一行能挡住「浏览器把它当 HTML 执行」那条路。
      // 图片接口 /api/media/ 自己已经带了同样的头。
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

/**
 * 计算 CORS 响应头。
 * ALLOWED_ORIGINS 支持三种写法：'*' 全部放行 / 单个域名 / 逗号分隔的多个域名。
 * 用逗号分隔时会把请求里的 Origin 回显回去，这样浏览器才认。
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAll = list.includes('*');
  const matched = allowAll || list.includes(origin);

  return {
    // 不匹配时返回 'null'，浏览器会直接拦掉，等于拒绝跨域
    'Access-Control-Allow-Origin': matched ? (allowAll ? '*' : origin) : 'null',
    // 必须把实际用到的动词都列上，否则浏览器预检会直接拦掉 DELETE 这类"非简单请求"
    // 必须把实际用到的动词都列上，否则浏览器预检会直接拦掉 PUT/DELETE 这类"非简单请求"
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

/**
 * HTML 转义。
 * 说明：本项目入库存的是「原文」，转义放在前端渲染时做（见 frontend/app.js），
 * 这样 API 返回的数据是干净的，任何客户端都能直接复用。
 * 这里保留一份，方便你将来在 Worker 里做服务端渲染时直接调用。
 */
function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 文本清洗：去掉控制字符、统一换行、裁剪空白、限制长度。
 * 注意这里不替换 < > 等符号 —— 转义是渲染层的事，在入库时转义会造成双重转义。
 */
function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  return input
    // 去掉除换行/制表符以外的控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')     // 统一换行符
    .replace(/\n{3,}/g, '\n\n')  // 最多保留一个空行
    .trim()
    .slice(0, maxLen);
}


  /**
   * 把用户输入做成安全的 LIKE 通配模式（'%xxx%'），并按**字节**截断。
   *
   * ⚠️ 为什么必须按字节截：
   *
   *    D1 对 LIKE 模式有长度上限（实测约 50 字节），超过就抛
   *      D1_ERROR: LIKE or GLOB pattern too complex
   *    整个请求直接 500。
   *
   *    而 sanitizeText 是按**字符**截的。一个中文占 3 字节，
   *    17 个中文 = 51 字节就踩线了 —— 英文搜 300 个字符却没事，
   *    因为被截到 40 个字符 = 40 字节。
   *
   *    所以搜索框里输一长串中文会直接 500，这是线上真实报过的 bug。
   *
   * 按码点遍历，保证不会把一个多字节字符切成两半。
   */
  function likeSafe(input, maxBytes = 40) {
    const src = String(input == null ? '' : input);
    let out = '';
    let bytes = 0;
    for (const ch of src) {
      const cp = ch.codePointAt(0);
      const b = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (bytes + b > maxBytes) break;
      out += ch;
      bytes += b;
    }
    return '%' + out + '%';
  }


/** 从 D1 查询访问量，没有记录时兜底返回 0 */
async function readVisits(env) {
  const row = await env.DB
    .prepare('SELECT count FROM visits WHERE id = 1')
    .first();
  return row ? row.count : 0;
}

/* ============================================================
 * 二·B、管理后台的认证
 *
 * 设计要点：
 *  1. 密码存在 Cloudflare Secret（env.ADMIN_PASSWORD）里，不写进代码、不进 git。
 *  2. 登录成功后不返回密码，而是返回一枚「HMAC 签名的会话令牌」，2 小时过期。
 *     令牌 = base64(payload) + "." + HMAC-SHA256(payload, 密码派生密钥)
 *     不知道密码就无法伪造令牌，所以令牌可以安全地放在浏览器里。
 *  3. 登录失败按 IP 计数，15 分钟内错 5 次就锁定，防暴力破解。
 * ============================================================ */

const ADMIN_TOKEN_TTL = 2 * 60 * 60 * 1000; // 令牌有效期：2 小时
const ADMIN_MAX_FAILS = 5;                  // 15 分钟内允许的最大失败次数
const ADMIN_LOCK_WINDOW = '-15 minutes';    // 锁定时长窗口

/** base64url 编码 */
function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 计算 HMAC-SHA256，密钥由管理员密码派生（用 Web Crypto，Workers 原生支持） */
async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('admin-token-v1:' + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** 定长比较，避免通过响应时间猜密码（时序攻击） */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 签发会话令牌 */
async function issueToken(env) {
  const payload = b64url(new TextEncoder().encode(
    JSON.stringify({ exp: Date.now() + ADMIN_TOKEN_TTL })
  ));
  return payload + '.' + await hmacSign(payload, env.ADMIN_PASSWORD);
}

/** 校验会话令牌：签名对得上 && 没过期 */
async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = await hmacSign(payload, env.ADMIN_PASSWORD);
  if (!safeEqual(sig, expect)) return false;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(atob(b64));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch (e) {
    return false;
  }
}

/** 取出请求头里的 Bearer 令牌并校验 */
async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return { error: json({ ok: false, error: '管理后台未启用：请先设置 ADMIN_PASSWORD 密钥' }, 503) };
  }
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!await verifyToken(token, env)) {
    return { error: json({ ok: false, error: '未登录或登录已过期，请重新登录' }, 401) };
  }
  return { ok: true };
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** 读取该 IP 在锁定窗口内的失败次数 */
async function recentFails(env, ip) {
  const row = await env.DB
    .prepare(`SELECT fails FROM admin_attempts
               WHERE ip = ?1 AND last_at > datetime('now', ?2)`)
    .bind(ip, ADMIN_LOCK_WINDOW)
    .first();
  return row ? row.fails : 0;
}

/** 记一次失败；窗口已过就重新从 1 开始计 */
async function bumpFail(env, ip) {
  await env.DB
    .prepare(`INSERT INTO admin_attempts (ip, fails, last_at)
              VALUES (?1, 1, CURRENT_TIMESTAMP)
              ON CONFLICT(ip) DO UPDATE SET
                fails   = CASE WHEN last_at > datetime('now', ?2) THEN fails + 1 ELSE 1 END,
                last_at = CURRENT_TIMESTAMP`)
    .bind(ip, ADMIN_LOCK_WINDOW)
    .run();
}

/** 登录成功就清掉该 IP 的失败记录 */
async function clearFails(env, ip) {
  await env.DB.prepare('DELETE FROM admin_attempts WHERE ip = ?1').bind(ip).run();
}

/* ============================================================
 *  二·C、留言配图（存在 D1 里）
 *
 *  为什么用 D1 而不是 R2：不用额外开通 R2、不用绑卡，现有权限就能用。
 *  代价是容量小得多（D1 免费单库 500 MB），所以配图限制到 1 MB。
 *
 *  存储方式：图片以 **base64 文本** 存进 images.data。
 *  不用 BLOB 是因为 base64 在各种驱动下读写行为确定，
 *  不会出现"本地测没问题、线上读回来类型不对"的坑；代价是体积膨胀 33%。
 *
 *  ⚠️ 这是**公开上传接口**（任何访问网站的人都能传），所以防护做得多：
 *    1. 只允许图片，且用「文件头魔数」判断真实类型，不信任客户端给的 Content-Type
 *    2. 单张大小上限 1 MB（base64 后约 1.37 MB，仍在 D1 单行 2 MB 限制内）
 *    3. 同一个 IP 每小时上传次数上限
 *    4. 读取走 Worker 并带一年强缓存，命中缓存后不再查库
 * ============================================================ */

const MAX_IMAGE_BYTES = 1 * 1024 * 1024;   // 单张图片最大 1 MB（前端会先压一次）
const MAX_UPLOADS_PER_HOUR = 8;            // 同一个 IP 每小时最多传 8 张

/**
 * 允许的图片类型 + 各自的文件头魔数。
 * 只看扩展名或 Content-Type 是能被伪造的，必须验字节。
 */
const IMAGE_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg',  bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  ext: 'png',  bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/gif',  ext: 'gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: 'RIFF' .... 'WEBP'，所以先匹配 RIFF，再单独查第 8-11 字节
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
];

/** 根据文件头判断真实图片类型；不是允许的图片就返回 null */
function sniffImageType(buffer) {
  const head = new Uint8Array(buffer.slice(0, 16));
  for (const sig of IMAGE_SIGNATURES) {
    if (head.length < sig.bytes.length) continue;
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (head[i] !== sig.bytes[i]) { hit = false; break; }
    }
    if (!hit) continue;
    if (sig.extra) {
      for (let i = 0; i < sig.extra.bytes.length; i++) {
        if (head[sig.extra.offset + i] !== sig.extra.bytes[i]) { hit = false; break; }
      }
      if (!hit) continue;
    }
    return sig;
  }
  return null;
}

/** 字节数组 → base64。分块处理，避免大图时 String.fromCharCode 爆栈 */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 生成图片访问令牌（32 位十六进制）。用它当 URL 的一部分，天然唯一且不可枚举 */
function newImageToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** base64 → 字节数组 */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 上传限流：查这个 IP 最近一小时传了几张 */
async function uploadsInLastHour(env, ip) {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM upload_log
               WHERE ip = ?1 AND created_at > datetime('now', '-1 hour')`)
    .bind(ip)
    .first();
  return row ? row.n : 0;
}

/** 记一次上传，顺手清掉过期的日志（只留最近一天） */
async function logUpload(env, ip) {
  await env.DB.prepare('INSERT INTO upload_log (ip) VALUES (?1)').bind(ip).run();
  await env.DB.prepare("DELETE FROM upload_log WHERE created_at < datetime('now', '-1 day')").run();
}

/** 把图片存进 images 表，返回 { id, mime, size } 或 { error } */
async function storeImage(env, file, thumbFile) {
  const buf = await file.arrayBuffer();

  if (buf.byteLength === 0) {
    return { error: json({ ok: false, error: '图片是空文件' }, 400) };
  }
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { error: json({ ok: false, error: `图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }, 413) };
  }

  const sig = sniffImageType(buf);
  if (!sig) {
    return { error: json({ ok: false, error: '只支持 JPG / PNG / GIF / WebP 图片（已按文件内容校验）' }, 415) };
  }

  const b64 = bytesToBase64(new Uint8Array(buf));

  // base64 之后必须还在 D1 的单行 2 MB 限制内，否则插入会失败
  if (b64.length > 1.9 * 1024 * 1024) {
    return { error: json({ ok: false, error: '图片太大了，请压缩后再传' }, 413) };
  }

  // ── 缩略图（可选）──
  //
  // 前端上传前用 canvas 生成一张最长边 640px 的小图，一起传上来。
  // 网格用它，灯箱还是原图 —— 首页能少传八成字节。
  //
  // 缩略图是**锦上添花**：没传、传坏了、比原图还大，都只是省不了流量，
  // 不能让整次上传失败。所以这里全部容错，出错就忽略。
  let thumbB64 = null, thumbMime = null, thumbSize = null;
  if (thumbFile && typeof thumbFile === 'object' && typeof thumbFile.size === 'number' && thumbFile.size > 0) {
    try {
      const tb = await thumbFile.arrayBuffer();
      const tsig = sniffImageType(tb);
      const tb64 = bytesToBase64(new Uint8Array(tb));
      // 比原图还大就说明前端算错了，丢掉
      if (tsig && tb.byteLength < buf.byteLength && tb64.length < 1.9 * 1024 * 1024) {
        thumbB64 = tb64;
        thumbMime = tsig.mime;
        thumbSize = tb.byteLength;
      }
    } catch (err) {
      console.warn('[storeImage] 缩略图处理失败，已忽略:', err && err.message);
    }
  }

  const token = newImageToken();

  const r = await env.DB
    .prepare('INSERT INTO images (token, mime, size, data, thumb_data, thumb_mime, thumb_size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(token, sig.mime, buf.byteLength, b64, thumbB64, thumbMime, thumbSize)
    .run();

  return {
    id: r.meta && r.meta.last_row_id,
    token,
    mime: sig.mime,
    size: buf.byteLength,
    has_thumb: !!thumbB64,
  };
}

/** GET /api/media/<token> —— 从 D1 读图并交给边缘缓存 */
async function handleMedia(token, request, env, ctx) {
  // token 是 32 位十六进制；格式不对直接 404，连库都不用查
  if (!/^[0-9a-f]{32}$/.test(token)) return new Response('Not found', { status: 404 });

  // ?s=thumb 表示要缩略图（网格用）。原图仍然是不带参数的地址（灯箱用）。
  const wantThumb = new URL(request.url).searchParams.get('s') === 'thumb';

  // 命中 Cloudflare 边缘缓存就直接返回，不再查 D1、也不占 D1 的行读额度。
  // 缓存键用的是完整 URL，所以 ?s=thumb 和原图自然是两份缓存，不会互相污染。
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('X-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  }

  const row = wantThumb
    ? await env.DB.prepare('SELECT mime, data, thumb_mime, thumb_data FROM images WHERE token = ?1').bind(token).first()
    : await env.DB.prepare('SELECT mime, data FROM images WHERE token = ?1').bind(token).first();
  if (!row) return new Response('Not found', { status: 404 });

  // 老图片没有缩略图 —— 回落成原图。不理想，但比 404 强，
  // 而且前端拿到的缩略图地址永远有效。
  const useThumb = wantThumb && row.thumb_data;
  const payload = useThumb ? row.thumb_data : row.data;
  const mime = useThumb ? (row.thumb_mime || row.mime) : row.mime;

  const bytes = base64ToBytes(payload);

  const headers = new Headers();
  headers.set('Content-Type', mime || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Cache', 'MISS');
  headers.set('Content-Length', String(bytes.length));

  const res = new Response(bytes, { status: 200, headers });

  // 写缓存失败不该影响图片本身，所以单独兜住异常（同时留日志方便排查）
  if (cache && ctx && ctx.waitUntil) {
    ctx.waitUntil(
      cache.put(request, res.clone()).catch((err) => {
        console.error('写边缘缓存失败:', err && err.message ? err.message : err);
      })
    );
  }
  return res;
}

/* ============================================================
 *  二·D、站点设置、分页、通知
 * ============================================================ */

/** 读取所有设置项，返回 { key: value } */
async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

/** 写一个设置项（存在就更新） */
async function setSetting(env, key, value) {
  await env.DB
    .prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, String(value == null ? '' : value))
    .run();
}

/** 解析分页参数，并做边界保护（防止一次拉几万条把 Worker 拖死） */
function parsePaging(url, defSize = 10, maxSize = 50) {
  const rawPage = parseInt(url.searchParams.get('page') || '1', 10);
  const rawSize = parseInt(url.searchParams.get('size') || String(defSize), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  let size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : defSize;
  size = Math.min(maxSize, Math.max(1, size));
  return { page, size, offset: (page - 1) * size };
}

/**
 * 把留言内容渲染成 HTML（Markdown + @提及）
 *
 * ⚠️ 为什么提及必须在 Markdown **之前**处理：
 *
 *   如果在渲染完的 HTML 上再用正则找 @xxx，有可能匹配到标签内部
 *   （比如 <a href="mailto:x@y.com">），那就把标签结构改坏了。
 *   所以先把 @name 挖成占位符 → 跑 Markdown → 占位符换回按钮。
 *   占位符用 \u0001M0\u0001 这种，Markdown 的规则不会碰它。
 *
 * ⚠️ 留言板用**受限语法**（关掉标题 / 图片 / 表格）：
 *   · 标题：卡片里冒出个 <h1> 会破坏页面层级和排版
 *   · 图片：放行等于任何人都能让别人的浏览器去加载任意地址
 *           （追踪像素、慢资源、不合适的内容）。想看图的直接上传附件，
 *           那条路走自己的图床，可控。
 *   · 表格：500 字的留言用不上，窄屏下也难看
 */
function renderMessageHtml(raw) {
  const text = String(raw || '');
  if (!text) return '';

  const mentions = [];
  // 边界字符和前端 renderMentions 保持一致
  const withHoles = text.replace(
    /(^|[\s，,。.!！?？:：])@([^\s@，,。.!！?？:：]{1,20})/g,
    (full, pre, name) => {
      mentions.push(name);
      return `${pre}\u0001M${mentions.length - 1}\u0001`;
    }
  );

  let html = renderMarkdown(withHoles, {
    allowHeadings: false,
    allowImages: false,
    allowTables: false,
  });

  html = html.replace(/\u0001M(\d+)\u0001/g, (m, idx) => {
    const name = mentions[Number(idx)];
    if (!name) return m;
    const safe = escapeHtml(name);
    return `<button type="button" data-mention="${safe}"`
      + ` class="mention-chip inline-flex items-center rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"`
      + ` title="点击跳到 TA 的留言">@${safe}</button>`;
  });

  return html;
}


/** 把数据库行统一转成对外的留言结构（顺带把 image_token 拼成可访问地址） */
function mapMessage(origin) {
  return (r) => ({
    id: r.id,
    name: r.name,
    content: r.content,
    content_html: renderMessageHtml(r.content),
    reply: r.reply || null,
    replied_at: r.replied_at || null,
    likes: r.likes || 0,
    status: r.status,
    parent_id: r.parent_id || null,
    created_at: r.created_at,
    image_url: r.image_token ? `${origin}/api/media/${r.image_token}` : null,
  });
}

/** 每天的日期键（UTC，和数据库 CURRENT_TIMESTAMP 保持一致） */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}


/**
 * 真正把通知发出去，返回 { ok, status?, reason? }。
 * 抽成独立函数是为了让「测试通知」接口也能复用同一套逻辑，
 * 避免"测试通过、实际却发不出去"的情况。
 */
async function deliverNotification(env, type, hook, msg) {
  const lines = [
    '📬 收到一条新留言',
    `昵称：${msg.name}`,
    `内容：${msg.content}`,
    msg.image_url ? '（带配图）' : null,
    msg.pending ? '⚠️ 需要审核后才能在前台显示' : null,
    `时间：${msg.created_at || new Date().toISOString()}`,
  ].filter(Boolean);
  const text = lines.join('\n');

  let init;
  if (type === 'wecom' || type === 'dingtalk') {
    // 这两个平台的群机器人格式恰好一致
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    };
  } else if (type === 'serverchan') {
    // Server酱用表单编码，字段固定是 title / desp
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: '收到一条新留言', desp: text.replace(/\n/g, '\n\n') }),
    };
  } else {
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'new_message', text, ...msg }),
    };
  }

  try {
    const res = await fetch(hook, init);
    const bodyText = (await res.text()).slice(0, 300);
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}: ${bodyText}` };
    // 企业微信 / 钉钉即使失败也返回 200，要靠 body 里的 errcode 判断
    if (/"errcode"\s*:\s*(?!0\b)\d+/.test(bodyText)) {
      return { ok: false, status: res.status, reason: '平台返回错误：' + bodyText };
    }
    return { ok: true, status: res.status, reason: bodyText };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * 有新留言时推送到管理员配置的地址。
 * 支持四种格式：json / wecom（企业微信）/ dingtalk（钉钉）/ serverchan（Server酱）。
 *
 * 通知失败绝不能影响留言本身，所以异步发（waitUntil），并且内部全部兜住异常。
 */
async function notifyNewMessage(env, ctx, msg) {
  let s;
  try {
    s = await getSettings(env);
  } catch (e) {
    return;
  }
  const type = s.notify_type || 'off';
  const hook = (s.notify_webhook || '').trim();
  if (type === 'off' || !hook) return;

  const doSend = async () => {
    const r = await deliverNotification(env, type, hook, msg);
    if (!r.ok) console.error('通知发送失败:', r.reason);
  };

  if (ctx && ctx.waitUntil) ctx.waitUntil(doSend());
  else await doSend();
}

/* ============================================================
 * 三、各个接口的处理逻辑
 * ============================================================ */

/** GET /api/profile */
async function handleGetProfile(env) {

  // 人机校验的 sitekey 是**公开值**（本来就要写进 HTML 里），
  // 所以从公共接口返回没问题。放在 settings 里是为了不用改代码
  // 就能换 —— 建好 widget 之后在后台填一下就生效。
  let turnstileSiteKey = '';
  try {
    const row = await env.DB
      .prepare("SELECT value FROM settings WHERE key = 'turnstile_site_key'")
      .first();
    turnstileSiteKey = (row && row.value) || '';
  } catch (e) {
    // 迁移还没跑或者表不存在，当成没配就行
  }

  return json({
    ok: true,
    data: {
      ...PROFILE,
      // 没配时返回空串，前端据此决定要不要渲染验证组件
      turnstile_site_key: turnstileSiteKey,
    },
  });
}

/** GET /api/messages —— 只返回已通过的留言，按时间倒序分页 */
async function handleGetMessages(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const { page, size, offset } = parsePaging(url, 10, 50);

  // 只统计顶层留言（子回复不算进总数，否则分页会乱）
  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'approved' AND parent_id IS NULL`)
    .first();
  const total = totalRow ? totalRow.n : 0;

  const { results } = await env.DB
    .prepare(
      `SELECT m.id, m.name, m.content, m.reply, m.replied_at, m.likes, m.status,
              m.parent_id, m.created_at, i.token AS image_token
         FROM messages m
         LEFT JOIN images i ON i.id = m.image_id
        WHERE m.status = 'approved' AND m.parent_id IS NULL
        ORDER BY datetime(m.created_at) DESC, m.id DESC
        LIMIT ?1 OFFSET ?2`
    )
    .bind(size, offset)
    .all();

  const rows = results || [];

  // 把这一页顶层留言的子回复一次性查出来，避免 N+1 查询
  const repliesByParent = {};
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const holes = ids.map(() => '?').join(',');
    const { results: kids } = await env.DB
      .prepare(
        `SELECT m.id, m.name, m.content, m.reply, m.replied_at, m.likes, m.status,
                m.parent_id, m.created_at, i.token AS image_token
           FROM messages m
           LEFT JOIN images i ON i.id = m.image_id
          WHERE m.status = 'approved' AND m.parent_id IN (${holes})
          ORDER BY m.id ASC
          LIMIT 500`
      )
      .bind(...ids)
      .all();
    for (const k of kids || []) {
      (repliesByParent[k.parent_id] = repliesByParent[k.parent_id] || []).push(k);
    }
  }

  const mapper = mapMessage(origin);
  const items = rows.map((r) => ({
    ...mapper(r),
    replies: (repliesByParent[r.id] || []).map(mapper),
    reply_count: (repliesByParent[r.id] || []).length,
  }));

  return json({
    ok: true,
    data: {
      items,
      total,
      page,
      size,
      totalPages: Math.max(1, Math.ceil(total / size)),
    },
  });
}

/**
 * POST /api/messages —— 新增留言
 * 支持两种请求体：
 *   application/json       { name, content }                    —— 纯文字
 *   multipart/form-data    name / content / image(=文件)         —— 带配图
 */
async function handlePostMessage(request, env, ctx) {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  const isMultipart = contentType.includes('multipart/form-data');

  // 1) 解析 body
  let rawName, rawContent, rawParent = null, file = null, rawTurnstile = null, thumbFile = null;
  try {
    if (isMultipart) {
      const form = await request.formData();
      rawName = form.get('name');
      rawContent = form.get('content');
      rawParent = form.get('parent_id');
      rawTurnstile = form.get('turnstile_token');
      // 前端生成的缩略图（可选，没有也能正常上传）
      const tf = form.get('thumb');
      if (tf && typeof tf === 'object' && typeof tf.size === 'number' && tf.size > 0) thumbFile = tf;
      const f = form.get('image');
      // File 对象才有 size；空表单域是空字符串，要排除掉
      if (f && typeof f === 'object' && typeof f.size === 'number' && f.size > 0) file = f;
    } else {
      const body = await request.json();
      rawName = body.name;
      rawContent = body.content;
      rawParent = body.parent_id;
      rawTurnstile = body.turnstile_token;
    }
  } catch (e) {
    return json({ ok: false, error: '请求体解析失败' }, 400);
  }

  // 2) 清洗 + 校验
  const name = sanitizeText(rawName, 30);
  const content = sanitizeText(rawContent, 500);

  if (!name) return json({ ok: false, error: '昵称不能为空' }, 400);
  if (!content) return json({ ok: false, error: '留言内容不能为空' }, 400);

  // 3) 人机校验（Turnstile）
  //
  // 位置是算过的：
  //   · 前面昵称/内容的校验是纯字符串操作，最便宜，先做
  //   · 后面的限流和垃圾词各要查一次数据库
  //   · 人机校验是一次外部网络请求
  // 让机器人卡在数据库之前，别白消耗 D1 的读配额。
  const ts = await verifyTurnstile(env, rawTurnstile, clientIp(request));
  if (!ts.ok) return json({ ok: false, error: turnstileErrorMessage(ts) }, 403);
  if (ts.skipped) {
    // 没配密钥时保护是静默失效的，留条日志免得没人发现
    console.log('[turnstile] 未配置 TURNSTILE_SECRET，本次留言未做人机校验');
  }

  // 3) 简单防刷：同一个昵称 5 秒内只能发一条
  const recent = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE name = ?1 AND created_at > datetime('now', '-5 seconds')`
    )
    .bind(name)
    .first();
  if (recent && recent.n > 0) {
    return json({ ok: false, error: '发言太快啦，请稍等几秒再试' }, 429);
  }

  // 3.5) 垃圾过滤：关键词 / 链接数 / 灌水
  const spam = await checkSpam(env, { text: content, name });
  if (spam.blocked) {
    return json({ ok: false, error: spam.reason || '内容不被允许' }, 400);
  }

  // 3.6) 嵌套回复：parent_id 只能指向顶层留言（只做两层，不做无限层级）
  let parentId = null;
  if (rawParent !== null && rawParent !== undefined && rawParent !== '') {
    const pid = Number(rawParent);
    if (Number.isInteger(pid) && pid > 0) {
      const parent = await env.DB
        .prepare(`SELECT id, parent_id FROM messages WHERE id = ?1 AND status = 'approved'`)
        .bind(pid)
        .first();
      if (parent) parentId = parent.parent_id === null ? parent.id : parent.parent_id;
    }
  }

  const origin = new URL(request.url).origin;

  // 4) 有配图就先存图（先做限流检查，避免无效请求占用额度）
  let imageId = null, storedToken = null;
  if (file) {
    const ip = clientIp(request);
    if (await uploadsInLastHour(env, ip) >= MAX_UPLOADS_PER_HOUR) {
      return json({ ok: false, error: `上传太频繁，每小时最多传 ${MAX_UPLOADS_PER_HOUR} 张图，请稍后再试` }, 429);
    }

    const stored = await storeImage(env, file, thumbFile);
    if (stored.error) return stored.error;

    imageId = stored.id;
    storedToken = stored.token;
    await logUpload(env, ip);
  }

  // 5) 判断是否需要审核
  const settings = await getSettings(env).catch(() => ({}));
  const needApproval = settings.require_approval === '1';
  const status = needApproval ? 'pending' : 'approved';

  // 6) 入库
  let result;
  try {
    result = await env.DB
      .prepare('INSERT INTO messages (name, content, image_id, status, parent_id) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(name, content, imageId, status, parentId)
      .run();
  } catch (err) {
    // 入库失败就把刚存进去的图删掉，别留孤儿图片
    if (imageId) { try { await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(imageId).run(); } catch (e) {} }
    throw err;
  }

  const created = {
    id: result.meta && result.meta.last_row_id,
    name,
    content,
    image_url: storedToken ? `${origin}/api/media/${storedToken}` : null,
    status,
    pending: needApproval,
    parent_id: parentId,
  };

  // 7) 通知管理员（异步，失败不影响留言）
  notifyNewMessage(env, ctx, created);

  return json({ ok: true, data: created }, 201);
}

/** GET /api/visits */
async function handleGetVisits(env) {
  return json({ ok: true, data: { count: await readVisits(env) } });
}

/**
 * POST /api/visits —— 总量 +1，同时累计当天明细和访问来源
 * 请求体可选：{ ref: 'https://example.com/page' }（前端传 document.referrer）
 */
async function handlePostVisits(request, env) {
  // D1 写操作是串行的，"count = count + 1" 在数据库侧完成，不会丢计数。
  await env.DB.prepare('UPDATE visits SET count = count + 1 WHERE id = 1').run();

  const day = todayKey();
  await env.DB
    .prepare(`INSERT INTO visit_daily (day, count) VALUES (?1, 1)
              ON CONFLICT(day) DO UPDATE SET count = count + 1`)
    .bind(day)
    .run();

  // ---- 访问来源 ----
  let refRaw = '';
  try {
    const body = await request.json();
    if (body && typeof body.ref === 'string') refRaw = body.ref;
  } catch (e) {
    // 没带 body 就用 Referer 头兜底
    refRaw = request.headers.get('Referer') || '';
  }
  if (!refRaw) refRaw = request.headers.get('Referer') || '';

  let ref = 'direct';
  if (refRaw) {
    try {
      const host = new URL(refRaw).hostname.replace(/^www\./, '').toLowerCase();
      // 站内跳转不算"来源"
      if (host && !host.endsWith('example.com')) ref = host.slice(0, 60);
    } catch (e) {}
  }
  try {
    await env.DB
      .prepare(`INSERT INTO visit_refs (day, ref, count) VALUES (?1, ?2, 1)
                ON CONFLICT(day, ref) DO UPDATE SET count = count + 1`)
      .bind(day, ref)
      .run();
  } catch (e) {
    // 表不存在（迁移没跑）就跳过，不能因为统计失败让访问量记不上
  }

  return json({ ok: true, data: { count: await readVisits(env) } });
}

/* ============================================================
 * 三·B、管理后台接口
 * ============================================================ */

/**
 * POST /api/messages/:id/like —— 点个赞
 * 没有账号体系，所以服务端只负责累加；"同一个人不重复赞"靠前端 localStorage。
 * 想做成严格唯一的点赞，需要引入设备指纹或登录，复杂度不划算。
 */
async function handleLikeMessage(id, env) {
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: '留言 id 不合法' }, 400);
  }
  const r = await env.DB
    .prepare(`UPDATE messages SET likes = likes + 1 WHERE id = ?1 AND status = 'approved'`)
    .bind(id)
    .run();
  if (!(r.meta && r.meta.changes)) {
    return json({ ok: false, error: '这条留言不存在或还没通过审核' }, 404);
  }
  const row = await env.DB.prepare('SELECT likes FROM messages WHERE id = ?1').bind(id).first();
  return json({ ok: true, data: { id, likes: row ? row.likes : 0 } });
}

/**
 * GET /api/gallery —— 作品集相册（公开）
 * 图片本体复用 images 表，这里只返回"哪张图 + 标题 + 说明"
 */
async function handleGetGallery(request, env) {
  const origin = new URL(request.url).origin;
  const { results } = await env.DB
    .prepare(`SELECT g.id, g.title, g.note, g.created_at, i.token AS image_token, i.size AS image_size
                FROM gallery g
                LEFT JOIN images i ON i.id = g.image_id
               ORDER BY g.sort DESC, g.id DESC
               LIMIT 100`)
    .all();
  const items = (results || [])
    .filter((r) => r.image_token)
    .map((r) => ({
      id: r.id,
      title: r.title || '',
      note: r.note || '',
      size: r.image_size || 0,
      created_at: r.created_at,
      image_url: `${origin}/api/media/${r.image_token}`,
    }));
  return json({ ok: true, data: { items, total: items.length } });
}

/** POST /api/admin/login —— 校验密码，成功则发一枚 2 小时有效的会话令牌 */
async function handleAdminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '管理后台未启用：请先设置 ADMIN_PASSWORD 密钥' }, 503);
  }

  const ip = clientIp(request);
  if (await recentFails(env, ip) >= ADMIN_MAX_FAILS) {
    return json({ ok: false, error: '失败次数过多，请 15 分钟后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是合法的 JSON' }, 400);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!safeEqual(password, env.ADMIN_PASSWORD)) {
    await bumpFail(env, ip);
    // 失败时故意慢一点，进一步抬高暴力破解成本
    await new Promise((r) => setTimeout(r, 400));
    return json({ ok: false, error: '密码错误' }, 401);
  }

  await clearFails(env, ip);
  return json({
    ok: true,
    data: { token: await issueToken(env), expiresIn: ADMIN_TOKEN_TTL }
  });
}

/** GET /api/admin/overview —— 后台首页的统计数字 */
async function handleAdminOverview(env) {
  const msg = await env.DB
    .prepare(`SELECT COUNT(*) AS total,
                     SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                     SUM(CASE WHEN reply IS NOT NULL AND reply != '' THEN 1 ELSE 0 END) AS replied
                FROM messages`)
    .first();
  const img = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM images').first();
  const settings = await getSettings(env).catch(() => ({}));

  // 新内容板块的计数（表可能还不存在，逐个兜住）
  const safeCount = async (sql) => {
    try { const r = await env.DB.prepare(sql).first(); return r ? (r.n || 0) : 0; } catch (e) { return 0; }
  };
  const [posts, postsPending, articles, articlesDraft, friends, friendsPending] = await Promise.all([
    safeCount('SELECT COUNT(*) AS n FROM posts'),
    safeCount(`SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'`),
    safeCount(`SELECT COUNT(*) AS n FROM articles WHERE status = 'published'`),
    safeCount(`SELECT COUNT(*) AS n FROM articles WHERE status = 'draft'`),
    safeCount(`SELECT COUNT(*) AS n FROM friends WHERE status = 'approved'`),
    safeCount(`SELECT COUNT(*) AS n FROM friends WHERE status = 'pending'`),
  ]);

  return json({
    ok: true,
    data: {
      messages: msg ? (msg.total || 0) : 0,
      pending: msg ? (msg.pending || 0) : 0,
      replied: msg ? (msg.replied || 0) : 0,
      images: img ? img.n : 0,
      imageBytes: img ? img.bytes : 0,
      visits: await readVisits(env),
      posts, postsPending,
      articles, articlesDraft,
      friends, friendsPending,
      requireApproval: settings.require_approval === '1',
      notifyType: settings.notify_type || 'off',
      notifyWebhookSet: !!(settings.notify_webhook || '').trim(),
      time: new Date().toISOString()
    }
  });
}

/** GET /api/admin/messages —— 分页 + 状态筛选 + 关键词搜索 */
async function handleAdminMessages(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const { page, size, offset } = parsePaging(url, 20, 100);

  const filter = url.searchParams.get('status') || 'all';   // all | pending | approved
  const q = sanitizeText(url.searchParams.get('q') || '', 50);

  // 动态拼条件，参数统一用位置占位符 ?
  const conds = [];
  const args = [];
  if (filter === 'pending' || filter === 'approved') {
    conds.push('m.status = ?');
    args.push(filter);
  }
  if (q) {
    conds.push('(m.name LIKE ? OR m.content LIKE ? OR m.reply LIKE ?)');
    const like = likeSafe(q);
    args.push(like, like, like);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages m ${where}`)
    .bind(...args)
    .first();
  const total = totalRow ? totalRow.n : 0;

  const { results } = await env.DB
    .prepare(`SELECT m.id, m.name, m.content, m.image_id, m.status, m.reply, m.replied_at,
                     m.likes, m.parent_id, m.created_at,
                     i.token AS image_token, i.size AS image_size
                FROM messages m
                LEFT JOIN images i ON i.id = m.image_id
                ${where}
               ORDER BY m.id DESC
               LIMIT ? OFFSET ?`)
    .bind(...args, size, offset)
    .all();

  return json({
    ok: true,
    data: {
      items: (results || []).map(mapMessage(origin)),
      total,
      page,
      size,
      totalPages: Math.max(1, Math.ceil(total / size)),
      filter,
      q,
    },
  });
}

/** POST /api/admin/messages/:id/approve —— 通过审核（也支持取消通过） */
async function handleAdminApprove(id, approve, env) {
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: '留言 id 不合法' }, 400);
  }
  const status = approve ? 'approved' : 'pending';
  const r = await env.DB
    .prepare('UPDATE messages SET status = ?1 WHERE id = ?2')
    .bind(status, id)
    .run();
  const changes = (r.meta && r.meta.changes) || 0;
  if (!changes) return json({ ok: false, error: '这条留言不存在' }, 404);
  return json({ ok: true, data: { id, status } });
}

/** POST /api/admin/messages/:id/reply —— 写入/修改管理员回复（空字符串表示删除回复） */
async function handleAdminReply(id, replyRaw, env) {
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: '留言 id 不合法' }, 400);
  }
  const reply = sanitizeText(replyRaw, 300);
  // 注意两处的占位符：删除回复时只有 id 一个参数，写成 ?2 会绑不上值直接报错
  const r = reply
    ? await env.DB.prepare('UPDATE messages SET reply = ?1, replied_at = CURRENT_TIMESTAMP WHERE id = ?2').bind(reply, id).run()
    : await env.DB.prepare('UPDATE messages SET reply = NULL, replied_at = NULL WHERE id = ?1').bind(id).run();
  const changes = (r.meta && r.meta.changes) || 0;
  if (!changes) return json({ ok: false, error: '这条留言不存在' }, 404);
  return json({ ok: true, data: { id, reply: reply || null } });
}

/** DELETE /api/admin/messages/:id —— 删除单条（连同它的 R2 配图一起删） */
async function handleAdminDeleteMessage(id, env) {
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: '留言 id 不合法' }, 400);
  }

  // 先查出配图 id，删完留言再删图片行，避免留下没人引用的孤儿图片
  const row = await env.DB
    .prepare('SELECT image_id FROM messages WHERE id = ?1')
    .bind(id)
    .first();

  const r = await env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(id).run();
  const changes = (r.meta && r.meta.changes) || 0;
  if (!changes) return json({ ok: false, error: '这条留言不存在（可能已被删除）' }, 404);

  let imageDeleted = false;
  if (row && row.image_id) {
    await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(row.image_id).run();
    imageDeleted = true;
  }

  return json({ ok: true, data: { deleted: id, imageDeleted } });
}

/** DELETE /api/admin/messages —— 清空全部（同时清空 R2 里的配图） */
async function handleAdminClearMessages(env) {
  const r = await env.DB.prepare('DELETE FROM messages').run();
  // 顺手把自增计数器也重置，让下一条留言从 id=1 开始
  await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'messages'").run();

  // 清空 images 表（配图本体都在这里）。
  // 注意：**不要**重置 images 的自增计数器。图片地址用的是随机 token 而不是 id，
  // 但让 id 保持单调递增可以避免任何"复用旧标识"的隐患。
  const ir = await env.DB.prepare('DELETE FROM images').run();
  const imagesDeleted = (ir.meta && ir.meta.changes) || 0;

  return json({
    ok: true,
    data: { deleted: (r.meta && r.meta.changes) || 0, imagesDeleted }
  });
}

/** GET /api/admin/settings —— 读取设置（webhook 地址做部分打码，避免明文回传） */
async function handleAdminGetSettings(env) {
  const st = await getSettings(env);
  const hook = (st.notify_webhook || '').trim();
  const masked = hook ? hook.replace(/\/([^/]{4})[^/]*$/, '/$1****') : '';
  return json({
    ok: true,
    data: {
      require_approval: st.require_approval === '1',
      notify_type: st.notify_type || 'off',
      notify_webhook_set: !!hook,
      notify_webhook_masked: masked,
      // 新增的设置项
      about_md: st.about_md || '',
      now_md: st.now_md || '',
      now_updated_at: st.now_updated_at || null,
      turnstile_site_key: st.turnstile_site_key || '',
      spam_enabled: st.spam_enabled !== '0',
      spam_max_links: Number(st.spam_max_links || 3),
      github_user: st.github_user || 'Demo',
      backup_enabled: st.backup_enabled === '1',
      backup_repo: st.backup_repo || '',
      backup_path: st.backup_path || 'backup',
      backup_has_token: !!env.GH_TOKEN,
      backup_last_at: st.backup_last_at || null,
      backup_last_result: st.backup_last_result || null,
    }

  });
}

/** PUT /api/admin/settings —— 更新设置 */
async function handleAdminPutSettings(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是合法的 JSON' }, 400);
  }

  if (body.require_approval !== undefined) {
    await setSetting(env, 'require_approval', body.require_approval ? '1' : '0');
  }
  if (body.notify_type !== undefined) {
    const allowed = ['off', 'json', 'wecom', 'dingtalk', 'serverchan'];
    if (!allowed.includes(body.notify_type)) {
      return json({ ok: false, error: '不支持的推送类型' }, 400);
    }
    await setSetting(env, 'notify_type', body.notify_type);
  }
  if (body.notify_webhook !== undefined) {
    const hook = String(body.notify_webhook).trim();
    // 要求 https，但放行本机地址 —— 方便本地起个接收器调试通知链路
    const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(hook);
    if (hook && !/^https:\/\//i.test(hook) && !isLocal) {
      return json({ ok: false, error: '推送地址必须是 https:// 开头' }, 400);
    }
    if (hook.length > 500) {
      return json({ ok: false, error: '推送地址过长' }, 400);
    }
    await setSetting(env, 'notify_webhook', hook);
  }

  // ---- 关于我（存 Markdown 原文，渲染时才转义，所以这里不做 HTML 转义）----
  if (body.about_md !== undefined && body.about_md !== null) {
    await setSetting(env, 'about_md', String(body.about_md).slice(0, 20000));
  }

  // ---- Now 页面 ----
  if (body.now_md !== undefined && body.now_md !== null) {
    await setSetting(env, 'now_md', String(body.now_md).slice(0, 20000));
    await setSetting(env, 'now_updated_at', new Date().toISOString().slice(0, 10));

  }

  // ---- 人机校验的 sitekey（公开值，所以存在 settings 里而不是密钥里）----
  // 空串表示不启用 —— 前端拿到空串就不渲染验证组件。
  if (body.turnstile_site_key !== undefined && body.turnstile_site_key !== null) {
    await setSetting(env, 'turnstile_site_key', String(body.turnstile_site_key).trim().slice(0, 100));
  }

  // ---- 垃圾过滤 ----
  if (body.spam_enabled !== undefined) {
    await setSetting(env, 'spam_enabled', body.spam_enabled ? '1' : '0');
  }
  if (body.spam_max_links !== undefined) {
    const n = parseInt(body.spam_max_links, 10);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      return json({ ok: false, error: '链接数量上限要在 0–20 之间' }, 400);
    }
    await setSetting(env, 'spam_max_links', String(n));
  }

  // ---- GitHub 卡片 ----
  if (body.github_user !== undefined) {
    const u = String(body.github_user).trim();
    if (u && !/^[\w-]{1,39}$/.test(u)) {
      return json({ ok: false, error: 'GitHub 用户名不合法' }, 400);
    }
    await setSetting(env, 'github_user', u);
  }

  // ---- 自动备份 ----
  if (body.backup_enabled !== undefined) {
    await setSetting(env, 'backup_enabled', body.backup_enabled ? '1' : '0');
  }
  if (body.backup_repo !== undefined) {
    const r = String(body.backup_repo).trim();
    if (r && !/^[\w.-]+\/[\w.-]+$/.test(r)) {
      return json({ ok: false, error: '仓库格式应为 owner/repo' }, 400);
    }
    await setSetting(env, 'backup_repo', r);
  }
  if (body.backup_path !== undefined) {
    const pp = String(body.backup_path).trim().replace(/[^\w./-]/g, '').replace(/^\/+|\/+$/g, '');
    await setSetting(env, 'backup_path', pp || 'backup');
  }

  return handleAdminGetSettings(env);
}

/** GET /api/admin/gallery —— 相册列表 */
async function handleAdminGallery(request, env) {
  const origin = new URL(request.url).origin;
  const { results } = await env.DB
    .prepare(`SELECT g.id, g.title, g.note, g.sort, g.created_at,
                     i.token AS image_token, i.size AS image_size
                FROM gallery g
                LEFT JOIN images i ON i.id = g.image_id
               ORDER BY g.sort DESC, g.id DESC
               LIMIT 200`)
    .all();
  const items = (results || [])
    .filter((r) => r.image_token)
    .map((r) => ({
      id: r.id,
      title: r.title || '',
      note: r.note || '',
      sort: r.sort || 0,
      size: r.image_size || 0,
      created_at: r.created_at,
      image_url: `${origin}/api/media/${r.image_token}`,
    }));
  return json({ ok: true, data: { items, total: items.length } });
}

/** POST /api/admin/gallery —— 新增一张作品（multipart：image / title / note / sort） */
async function handleAdminGalleryAdd(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ ok: false, error: '请求体解析失败' }, 400);
  }

  const file = form.get('image');
  if (!file || typeof file !== 'object' || typeof file.size !== 'number' || !file.size) {
    return json({ ok: false, error: '请选择一张图片' }, 400);
  }

  const title = sanitizeText(form.get('title'), 60);
  const note = sanitizeText(form.get('note'), 200);
  const sort = parseInt(form.get('sort') || '0', 10) || 0;

  // 相册只有管理员能传，所以不复用留言那套按 IP 限流
  const stored = await storeImage(env, file, form.get('thumb'));
  if (stored.error) return stored.error;

  let r;
  try {
    r = await env.DB
      .prepare('INSERT INTO gallery (image_id, title, note, sort) VALUES (?1, ?2, ?3, ?4)')
      .bind(stored.id, title, note, sort)
      .run();
  } catch (err) {
    // 入库失败就把刚存的图删掉，不留孤儿
    try { await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(stored.id).run(); } catch (e) {}
    throw err;
  }

  return json({ ok: true, data: { id: r.meta && r.meta.last_row_id } }, 201);
}

/** POST /api/admin/gallery/:id —— 改标题/说明/排序（JSON） */
async function handleAdminGalleryUpdate(id, body, env) {
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: '作品 id 不合法' }, 400);
  const title = sanitizeText(body.title, 60);
  const note = sanitizeText(body.note, 200);
  const sort = parseInt(body.sort, 10) || 0;
  const r = await env.DB
    .prepare('UPDATE gallery SET title = ?1, note = ?2, sort = ?3 WHERE id = ?4')
    .bind(title, note, sort, id)
    .run();
  if (!(r.meta && r.meta.changes)) return json({ ok: false, error: '这条作品不存在' }, 404);
  return json({ ok: true, data: { id } });
}

/** DELETE /api/admin/gallery/:id —— 删除作品（连同图片） */
async function handleAdminGalleryDelete(id, env) {
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: '作品 id 不合法' }, 400);
  const row = await env.DB.prepare('SELECT image_id FROM gallery WHERE id = ?1').bind(id).first();
  const r = await env.DB.prepare('DELETE FROM gallery WHERE id = ?1').bind(id).run();
  if (!(r.meta && r.meta.changes)) return json({ ok: false, error: '这条作品不存在' }, 404);
  let imageDeleted = false;
  if (row && row.image_id) {
    await env.DB.prepare('DELETE FROM images WHERE id = ?1').bind(row.image_id).run();
    imageDeleted = true;
  }
  return json({ ok: true, data: { deleted: id, imageDeleted } });
}

/**
 * GET /api/admin/export?format=json|csv —— 导出全部留言（数据备份用）
 * 直接返回文件流，前端拿到后触发下载。
 */
async function handleAdminExport(request, env) {
  const url = new URL(request.url);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();

  const { results } = await env.DB
    .prepare(`SELECT id, name, content, status, reply, replied_at, likes, created_at
                FROM messages ORDER BY id`)
    .all();
  const rows = results || [];
  const stamp = todayKey();

  if (format === 'csv') {
    const cols = ['id', 'name', 'content', 'status', 'reply', 'replied_at', 'likes', 'created_at'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => esc(r[c])).join(',')))
      .join('\r\n');
    return new Response('\uFEFF' + csv, {   // BOM：让 Excel 正确识别 UTF-8 中文
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="messages-${stamp}.csv"`,
      },
    });
  }

  return new Response(JSON.stringify({
    exported_at: new Date().toISOString(),
    count: rows.length,
    messages: rows,
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="messages-${stamp}.json"`,
    },
  });
}

/** POST /api/admin/notify-test —— 发一条测试通知，把结果同步返回给后台 */
async function handleAdminNotifyTest(env) {
  const st = await getSettings(env);
  const type = st.notify_type || 'off';
  const hook = (st.notify_webhook || '').trim();
  if (type === 'off' || !hook) {
    return json({ ok: true, data: { sent: false, reason: '还没有配置推送地址，或者通知处于关闭状态' } });
  }
  const r = await deliverNotification(env, type, hook, {
    name: '测试用户',
    content: '这是一条测试通知，看到就说明配置成功啦～',
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  return json({ ok: true, data: { sent: !!r.ok, reason: r.reason || '' } });
}

/** GET /api/admin/visits/trend —— 最近 N 天的访问量，null 补 0 让曲线连续 */
async function handleAdminVisitTrend(request, env) {
  const url = new URL(request.url);
  const raw = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Math.min(90, Math.max(7, Number.isFinite(raw) ? raw : 30));

  const { results } = await env.DB
    .prepare('SELECT day, count FROM visit_daily ORDER BY day DESC LIMIT ?1')
    .bind(days)
    .all();
  const map = new Map((results || []).map((r) => [r.day, r.count]));

  // 补齐没有访问的日期，否则折线会断、柱子会少
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) || 0 });
  }

  return json({
    ok: true,
    data: {
      days: out,
      total: await readVisits(env),
      // 说明趋势图是从哪天开始有数据的
      firstDay: (results && results.length) ? results[results.length - 1].day : null,
    }
  });
}

/** POST /api/admin/visits/reset —— 访问量归零 */
async function handleAdminResetVisits(env) {
  await env.DB.prepare('UPDATE visits SET count = 0 WHERE id = 1').run();
  return json({ ok: true, data: { count: 0 } });
}

/* ============================================================
 *  更新日志（changelog）
 *
 *  一条记录 = 一天的更新，正文是 Markdown。
 *  公开接口只读；增删改都在管理端。
 * ============================================================ */

/** GET /api/changelog —— 公开的更新日志列表（按日期倒序） */
async function handleGetChangelog(env) {
  const rows = await env.DB
    .prepare('SELECT id, entry_date, title, content FROM changelog ORDER BY entry_date DESC, id DESC LIMIT 500')
    .all();

  return json({
    ok: true,
    data: (rows.results || []).map((r) => ({
      id: r.id,
      date: r.entry_date,
      title: r.title,
      html: renderMarkdown(r.content || ''),
    })),
  });
}

/** GET /api/admin/changelog —— 管理端列表（带原文，方便编辑） */
async function handleAdminChangelogList(env) {
  const rows = await env.DB
    .prepare('SELECT id, entry_date, title, content, created_at, updated_at FROM changelog ORDER BY entry_date DESC, id DESC LIMIT 500')
    .all();
  return json({ ok: true, data: rows.results || [] });
}

/**
 * POST /api/admin/changelog —— 新增或修改（有 id 就是改）
 *
 * 校验就三条：日期格式、标题非空、长度上限。
 * 不校验「日期不能是未来」—— 可能想提前写发布计划的条目。
 */
async function handleAdminChangelogSave(body, env) {
  const date = String(body.date || '').trim();
  const title = String(body.title || '').trim();
  const content = String(body.content || '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ ok: false, error: '日期格式要是 YYYY-MM-DD，比如 2026-10-17' }, 400);
  }
  // 虽然格式对，但 2026-13-45 这种也要挡掉
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    return json({ ok: false, error: '这不是一个真实存在的日期：' + date }, 400);
  }

  if (!title) return json({ ok: false, error: '标题不能为空' }, 400);
  if (title.length > 100) return json({ ok: false, error: '标题最多 100 字' }, 400);
  if (content.length > 20000) return json({ ok: false, error: '正文太长了（上限 20000 字）' }, 400);

  const id = Number(body.id || 0);
  if (id) {
    const exists = await env.DB.prepare('SELECT id FROM changelog WHERE id = ?1').bind(id).first();
    if (!exists) return json({ ok: false, error: '这条更新日志不存在' }, 404);
    await env.DB
      .prepare('UPDATE changelog SET entry_date = ?1, title = ?2, content = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4')
      .bind(date, title, content, id)
      .run();
    return json({ ok: true, data: { id } });
  }

  const r = await env.DB
    .prepare('INSERT INTO changelog (entry_date, title, content) VALUES (?1, ?2, ?3)')
    .bind(date, title, content)
    .run();
  return json({ ok: true, data: { id: r.meta && r.meta.last_row_id } }, 201);
}

/** DELETE /api/admin/changelog/:id */
async function handleAdminChangelogDelete(id, env) {
  await env.DB.prepare('DELETE FROM changelog WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

/** 管理接口统一入口：先鉴权，再按子路径分发 */
async function handleAdmin(path, method, request, env, H) {
  // 登录接口不需要令牌，其余都需要
  if (path === '/api/admin/login' && method === 'POST') {
    return handleAdminLogin(request, env);
  }

  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  // 鉴权过了，先让新的后台模块认领（说说/文章/友链/日志/垃圾词/来源/备份）
  const modRes = await tryAdminRoutes(path, method, request, env, H);
  if (modRes) return modRes;

  // 后面这些操作都会写一条操作日志，先把 IP 取出来
  const ip = clientIp(request);
  // 只在响应成功（< 400）时记日志，失败了没必要记
  const audited = async (res, action, target, detail) => {
    if (res && res.status < 400) await auditLog(env, action, { target, detail, ip });
    return res;
  };

  if (path === '/api/admin/overview' && method === 'GET') {
    return handleAdminOverview(env);
  }
  if (path === '/api/admin/messages' && method === 'GET') {
    return handleAdminMessages(request, env);
  }
  if (path === '/api/admin/messages' && method === 'DELETE') {
    return audited(await handleAdminClearMessages(env), 'clear_messages', '全部');
  }
  if (path === '/api/admin/messages' && method === 'POST') {
    // 兼容不支持 DELETE 的客户端：用 POST + body 删单条
    try {
      const b = await request.json();
      return handleAdminDeleteMessage(Number(b.id), env);
    } catch (e) {
      return json({ ok: false, error: '请求体不是合法的 JSON' }, 400);
    }
  }
  const m = path.match(/^\/api\/admin\/messages\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const id = Number(m[1]);
    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: '留言 id 不合法' }, 400);
    }
    return audited(await handleAdminDeleteMessage(id, env), 'delete_message', id);
  }

  // 审核通过 / 取消通过
  const mApprove = path.match(/^\/api\/admin\/messages\/([^/]+)\/approve$/);
  if (mApprove && method === 'POST') {
    let approve = true;
    try { const b = await request.json(); if (b && b.approve === false) approve = false; } catch (e) {}
    return audited(
      await handleAdminApprove(Number(mApprove[1]), approve, env),
      approve ? 'approve_message' : 'unapprove_message',
      Number(mApprove[1])
    );
  }

  // 管理员回复
  const mReply = path.match(/^\/api\/admin\/messages\/([^/]+)\/reply$/);
  if (mReply && method === 'POST') {
    let reply = '';
    try { const b = await request.json(); reply = b && b.reply != null ? b.reply : ''; } catch (e) {}
    return audited(
      await handleAdminReply(Number(mReply[1]), reply, env),
      reply && reply.trim() ? 'reply_message' : 'clear_reply',
      Number(mReply[1])
    );
  }

  if (path === '/api/admin/gallery' && method === 'GET') {
    return handleAdminGallery(request, env);
  }
  if (path === '/api/admin/gallery' && method === 'POST') {
    return audited(await handleAdminGalleryAdd(request, env), 'gallery_add', '作品');
  }
  const mGal = path.match(/^\/api\/admin\/gallery\/([^/]+)$/);
  if (mGal && method === 'DELETE') {
    return audited(await handleAdminGalleryDelete(Number(mGal[1]), env), 'gallery_delete', Number(mGal[1]));
  }
  if (mGal && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    return handleAdminGalleryUpdate(Number(mGal[1]), body, env);
  }
  if (path === '/api/admin/export' && method === 'GET') {
    return handleAdminExport(request, env);
  }
  if (path === '/api/admin/notify-test' && method === 'POST') {
    return handleAdminNotifyTest(env);
  }
  if (path === '/api/admin/changelog' && method === 'GET') {
    return handleAdminChangelogList(env);
  }
  if (path === '/api/admin/changelog' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    return audited(await handleAdminChangelogSave(body, env), 'changelog_save', body.title || '');
  }
  const mCl = path.match(/^\/api\/admin\/changelog\/(\d+)$/);
  if (mCl && method === 'DELETE') {
    return audited(await handleAdminChangelogDelete(Number(mCl[1]), env), 'changelog_delete', Number(mCl[1]));
  }
  if (path === '/api/admin/settings' && method === 'GET') {
    return handleAdminGetSettings(env);
  }
  if (path === '/api/admin/settings' && method === 'PUT') {
    return audited(await handleAdminPutSettings(request, env), 'update_settings', '站点设置');
  }
  if (path === '/api/admin/visits/trend' && method === 'GET') {
    return handleAdminVisitTrend(request, env);
  }
  if (path === '/api/admin/visits/reset' && method === 'POST') {
    return audited(await handleAdminResetVisits(env), 'reset_visits', '访问量');
  }
  return json({ ok: false, error: '管理接口不存在: ' + escapeHtml(method + ' ' + path) }, 404);
}

/**
 * 兜底自动备份。
 *
 * 为什么需要这个：Cron Trigger 在有些情况下不会按时触发
 * （实测某个账号注册了触发器、脚本里也确实有 scheduled 处理器，但就是不跑）。
 * 所以再加一条路径：**有人访问站点时顺便检查"今天备份了没"**。
 *
 * 只要站点每天有至少一次访问，备份就能滚起来；
 * Cron 那条路照常保留，两条路都走同一个 performBackup，重复执行是幂等的
 * （同一天写同一个文件，覆盖即可）。
 *
 * 有 20 小时的冷却，而且跑在 waitUntil 里，不影响用户请求的响应时间。
 */
async function maybeRunScheduledBackup(env) {
  try {
    const s = await getSettings(env);

    // ---- 1) 自动备份 ----
    if (s.backup_enabled === '1' && env.GH_TOKEN && String(s.backup_repo || '').trim()) {
      const last = s.backup_last_at ? Date.parse(s.backup_last_at) : 0;
      if (!last || Date.now() - last >= 20 * 60 * 60 * 1000) {
        const result = await performBackup(env);
        console.log('[autobackup]', JSON.stringify(result));
      }
    }

    // ---- 2) 站点自检（每 6 小时最多一次）----
    const lastCheck = s.selfcheck_at ? Date.parse(s.selfcheck_at) : 0;
    if (!lastCheck || Date.now() - lastCheck >= 6 * 60 * 60 * 1000) {
      const result = await runSelfCheck(env);
      const brief = result.ok
        ? `全部通过（${result.checks.length} 项）`
        : `${result.failedCount} 项失败：` + result.checks.filter((c) => !c.ok).map((c) => c.name).join('、');

      await setSetting(env, 'selfcheck_at', result.at);
      await setSetting(env, 'selfcheck_result', brief);
      console.log('[selfcheck]', brief);

      // 只有失败才打扰你
      if (!result.ok) await alertIfBroken(env, result);
    }
  } catch (e) {
    // 兜底逻辑绝不能影响正常请求
    console.error('周期性检查出错:', e && e.message ? e.message : e);
  }
}

/* ============================================================
 * 三·B、给各功能模块用的工具集合
 *
 *  模块通过这个对象拿到 worker.js 里的能力，不用互相 import，避免循环引用。
 * ============================================================ */
function makeHelpers(env, ctx) {
  return {
    // 响应与输入
    json, escapeHtml, sanitizeText, likeSafe, clientIp,
    verifyTurnstile, turnstileErrorMessage,
    // 设置与分页
    getSettings, setSetting, parsePaging, todayKey,
    // 鉴权 / 存储 / 通知
    requireAdmin, storeImage, readVisits, notifyNewMessage, mapMessage,
    // 新能力的实现
    renderMarkdown, markdownToText, checkSpam, auditLog, listAuditLog,
    performBackup, previewBackup, restoreImages,
    // 上下文
    waitCtx: ctx,
    profileName: PROFILE.name,
  };
}

/** 公开模块的调度：返回 Response 表示已处理，null 表示不归它们管 */
async function tryPublicRoutes(path, method, request, env, H, ctx) {
  if (path.startsWith('/api/admin/')) return null;
  for (const mod of [postsRoute, articlesRoute, friendsRoute, miscRoute]) {
    const res = await mod({ path, method, request, env, H, ctx });
    if (res) return res;
  }
  return null;
}

/** 后台模块的调度（调用前已经鉴权过） */
async function tryAdminRoutes(path, method, request, env, H) {
  for (const mod of [postsRoute, articlesRoute, friendsRoute, systemRoute]) {
    const res = await mod({ path, method, request, env, H });
    if (res) return res;
  }
  return null;
}

/* ============================================================
 * 四、入口：路由分发
 * ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/'; // 去掉结尾斜杠，/api/xxx/ 也能命中
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, env);

    // 预检请求直接放行
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const H = makeHelpers(env, ctx);

    try {
      // 新模块先认领（说说 / 文章 / 友链 / 关于我 / 搜索 / RSS / GitHub 卡片）
      // 返回 null 表示不归它们管，继续走下面的老逻辑
      let res = await tryPublicRoutes(path, method, request, env, H, ctx);

      if (res) {
        // 已经被新模块处理掉了
      } else if (path === '/api/changelog' && method === 'GET') {
        res = await handleGetChangelog(env);
      } else if (path === '/api/profile' && method === 'GET') {
        res = await handleGetProfile(env);
      } else if (path.startsWith('/api/admin/')) {
        res = await handleAdmin(path, method, request, env, H);
      } else if (path.startsWith('/api/media/') && method === 'GET') {
        // 图片直接从 D1 读，不带 CORS 头（<img> 标签不需要跨域）
        return handleMedia(path.slice('/api/media/'.length), request, env, ctx);
      } else if (path === '/api/gallery' && method === 'GET') {
        res = await handleGetGallery(request, env);
      } else if (method === 'POST' && /^\/api\/messages\/[^/]+\/like$/.test(path)) {
        // 用 [^/]+ 而不是 \d+：格式不对的 id 交给处理器返回 400，
        // 而不是因为路由不匹配掉到 404（语义更准确）
        res = await handleLikeMessage(Number(path.split('/')[3]), env);
      } else if (path === '/api/messages' && method === 'GET') {
        res = await handleGetMessages(request, env);
      } else if (path === '/api/messages' && method === 'POST') {
        res = await handlePostMessage(request, env, ctx);
      } else if (path === '/api/visits' && method === 'GET') {
        res = await handleGetVisits(env);
      } else if (path === '/api/visits' && method === 'POST') {
        res = await handlePostVisits(request, env);
      } else if (path === '/api/health') {
        // 健康检查：顺便验证一下 D1 连接是否正常
        const count = await readVisits(env);
        res = json({
          ok: true, service: 'profile-api', db: 'connected', visits: count,
          storage: 'd1'
        });
      } else if (path === '/') {
        // 直接访问 API 根路径时给个自述，方便排查"域名到底通没通"
        res = json({
          ok: true,
          service: 'profile-api',
          endpoints: [
            'GET  /api/profile',
            'GET  /api/messages?page=1&size=10   分页，只返回已通过的',
            'POST /api/messages   { name, content }  或 multipart(name, content, image)',
            'GET  /api/media/<key>   留言配图',
            'GET  /api/gallery   作品集相册',
            'POST /api/messages/:id/like   点赞',
            'GET  /api/posts      说说列表        POST /api/posts/:id/like',
            'GET  /api/articles   文章列表        GET  /api/articles/:slug',
            'GET  /api/friends    友链            POST /api/friends  提交申请',
            'GET  /api/about      关于我',
            'GET  /api/search?q=  全文搜索',
            'GET  /api/feed.xml?type=all|articles|posts|messages   RSS 订阅',
            'GET  /api/github     GitHub 实时卡片',
            'GET  /api/visits',
            'POST /api/visits',
            'GET  /api/health'
          ]
        });
      } else {
        // 这里把请求路径回显给前端，属于攻击者可控内容，所以做一次 HTML 转义再返回
        res = json({ ok: false, error: '接口不存在: ' + escapeHtml(method + ' ' + path) }, 404);
      }

      // 兜底：Cron 不靠谱时，靠访问量把备份滚起来。
      // 只在少数入口路径上检查，避免每个请求都去读一次设置。
      if (ctx && ctx.waitUntil && method === 'GET' &&
          (path === '/api/health' || path === '/api/profile' || path === '/')) {
        ctx.waitUntil(maybeRunScheduledBackup(env));
      }

      // 给所有响应补上 CORS 头
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      // 出问题时不把堆栈暴露给前端，只回一句通用错误，细节留给日志
      console.error('Worker error:', err && err.stack ? err.stack : err);
      return json({ ok: false, error: '服务器内部错误，请稍后再试' }, 500, cors);
    }
  },

  /**
   * Cron 定时任务：自动备份。
   * 触发时间在 wrangler.toml 的 [triggers] 里配置。
   * 备份失败不能抛出去，否则 Cloudflare 会记录一堆错误，所以 performBackup 内部全兜住了。
   */
  async scheduled(event, env, ctx) {
    const run = async () => {
      // 先记一条心跳：这样在后台就能看出「cron 到底有没有触发」，
      // 排查定时任务时这一步能省掉很多猜测。
      try {
        await env.DB
          .prepare(`INSERT INTO settings (key, value) VALUES ('cron_last_ping', ?1)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .bind(new Date().toISOString() + ' · ' + (event && event.cron ? event.cron : '?'))
          .run();
      } catch (e) {
        console.error('写 cron 心跳失败:', e && e.message ? e.message : e);
      }

      const result = await performBackup(env);
      console.log('[cron] 备份结果:', JSON.stringify(result));
    };
    if (ctx && ctx.waitUntil) ctx.waitUntil(run());
    else await run();
  }
};
