/* ============================================================
 *  lib/backup.js —— 数据自动备份到 GitHub
 *
 *  由 Cron Trigger 每天触发（见 wrangler.toml 的 [triggers]）。
 *  做一件很朴素但很重要的事：把数据库里的内容导成 JSON，
 *  提交到 GitHub 仓库，这样数据就有一份异地副本 + 完整历史版本。
 *
 *  为什么选 GitHub 而不是别的：
 *    - 免费，而且已经有仓库了
 *    - 每次提交都是一条历史记录，天然是"版本化备份"
 *    - 不需要额外服务
 *
 *  需要配置：
 *    - Worker 密钥 GH_TOKEN（细粒度 PAT，只需 Contents: Read and write）
 *    - 设置项 backup_enabled / backup_repo / backup_path
 * ============================================================ */

/**
 * 导出各张表。
 *
 * 关于图片：`images.data` 是 base64，直接塞进 JSON 会让备份文件膨胀 33%，
 * 而且每天提交一份、仓库会疯长。所以拆开处理：
 *   - 这里只导出**元信息**（id / token / mime / size / created_at）
 *   - 图片本体由 performBackup 单独写成 `images/<token>.<ext>` 文件
 *
 * 这么做还有个好处：token 是随机的、永不复用，所以
 * **文件名本身就是内容指纹** —— 文件已存在就等于内容没变，直接跳过，
 * 天然做到"只提交新图"，仓库不会因为每天备份而变大。
 */
async function dumpAll(env) {
  const q = async (sql) => {
    try {
      const { results } = await env.DB.prepare(sql).all();
      return results || [];
    } catch (e) {
      return [];   // 表不存在（迁移没跑完）就跳过，不让备份整体失败
    }
  };

  const [messages, posts, articles, friends, gallery, visits, visitDaily, images] = await Promise.all([
    q(`SELECT id, name, content, status, reply, replied_at, likes, parent_id, created_at FROM messages ORDER BY id`),
    q(`SELECT id, content, status, likes, created_at FROM posts ORDER BY id`),
    q(`SELECT id, slug, title, summary, content, tags, status, pinned, views, cover_image_id, created_at, updated_at FROM articles ORDER BY id`),
    q(`SELECT id, name, url, avatar, desc, status, sort, created_at FROM friends ORDER BY id`),
    q(`SELECT id, image_id, title, note, sort, created_at FROM gallery ORDER BY id`),
    q(`SELECT count FROM visits WHERE id = 1`),
    q(`SELECT day, count FROM visit_daily ORDER BY day`),
    q(`SELECT id, token, mime, size, created_at FROM images ORDER BY id`),
  ]);

  return {
    exported_at: new Date().toISOString(),
    counts: {
      messages: messages.length,
      posts: posts.length,
      articles: articles.length,
      friends: friends.length,
      gallery: gallery.length,
      images: images.length,
    },
    messages, posts, articles, friends, gallery,
    images,
    visits: visits[0] ? visits[0].count : 0,
    visit_daily: visitDaily,
  };
}

/** MIME → 文件后缀，用于备份里的图片文件名 */
function extOf(mime) {
  if (/jpeg|jpg/i.test(mime)) return 'jpg';
  if (/png/i.test(mime)) return 'png';
  if (/gif/i.test(mime)) return 'gif';
  if (/webp/i.test(mime)) return 'webp';
  return 'bin';
}

/** 查一个文件在仓库里是否已存在 */
async function fileExists(token, repo, filePath) {
  const api = `https://api.github.com/repos/${repo}/contents/${encodeURI(filePath)}`;
  const res = await fetch(api + '?ref=main', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'your-site-backup',
    },
  });
  return res.ok;
}

/**
 * 把所有图片写进仓库。
 *
 * 已经存在的跳过 —— token 是随机且不复用的，所以
 * 「文件存在」= 「内容相同」，不需要比对。
 *
 * @returns {{written:number, skipped:number, failed:number, names:string[]}}
 */
async function backupImages(env, token, repo, dir) {
  const { results } = await env.DB
    .prepare('SELECT id, token, mime, data FROM images ORDER BY id')
    .all();

  let written = 0, skipped = 0, failed = 0;
  const names = [];

  for (const img of results || []) {
    const path = `${dir}/images/${img.token}.${extOf(img.mime)}`;
    try {
      if (await fileExists(token, repo, path)) { skipped++; continue; }

      // data 本来就是 base64，直接拿去当 GitHub 的 content
      await putFileRaw(token, repo, path, img.data, `backup: image ${img.token.slice(0, 8)}`);
      written++;
      names.push(path);
    } catch (e) {
      failed++;
      console.error('图片备份失败', img.token, e && e.message);
    }
  }

  return { written, skipped, failed, names };
}

/**
 * 用 GitHub REST API 写入/更新一个文件。
 * 文件已存在时 API 要求带上旧的 sha，所以先查一次。
 */
async function putFile(token, repo, filePath, content, message) {
  const api = `https://api.github.com/repos/${repo}/contents/${encodeURI(filePath)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'your-site-backup',
    'Content-Type': 'application/json',
  };

  let sha = null;
  const head = await fetch(api + '?ref=main', { headers });
  if (head.ok) {
    const j = await head.json().catch(() => null);
    if (j && j.sha) sha = j.sha;
  }

  // 用 base64 传，避免中文在 JSON 里被反复转义
  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);

  const body = { message, content: b64, branch: 'main' };
  if (sha) body.sha = sha;

  const res = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub 返回 ${res.status}：${text.slice(0, 200)}`);
  }
  const out = JSON.parse(text);
  return out.commit && out.commit.sha ? out.commit.sha : null;
}

/**
 * 和 putFile 一样，但内容**已经是 base64**，不再编码一次。
 * 图片数据从数据库读出来就是 base64，这里直接用。
 */
async function putFileRaw(token, repo, filePath, base64Content, message) {
  const api = `https://api.github.com/repos/${repo}/contents/${encodeURI(filePath)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'your-site-backup',
    'Content-Type': 'application/json',
  };

  // 已经查过一次存在性了，这里直接新建即可
  const body = { message, content: base64Content, branch: 'main' };

  const res = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}：${text.slice(0, 200)}`);
  const out = JSON.parse(text);
  return out.commit && out.commit.sha ? out.commit.sha : null;
}

/**
 * 执行一次备份。永远不抛异常（Cron 里抛异常会留下噪音日志）。
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, file?:string, commit?:string, counts?:object}}
 */
export async function performBackup(env) {
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
    const s = {};
    for (const r of results || []) s[r.key] = r.value;

    if (s.backup_enabled !== '1') return { skipped: true, reason: '自动备份未启用' };

    const repo = String(s.backup_repo || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { skipped: true, reason: '备份仓库格式不对（应为 owner/repo）' };

    const token = env.GH_TOKEN;
    if (!token) return { skipped: true, reason: '没有配置 GH_TOKEN 密钥' };

    const dir = String(s.backup_path || 'backup').replace(/^\/+|\/+$/g, '');
    const day = new Date().toISOString().slice(0, 10);

    const data = await dumpAll(env);
    // 同一天重复执行就覆盖当天那份，不堆垃圾文件
    const file = `${dir}/${day}.json`;
    const content = JSON.stringify(data, null, 2);

    const commit = await putFile(token, repo, file, content, `backup: ${day}`);

    // 图片单独存成二进制文件。放在 JSON 之后，
    // 这样万一图片这步失败，数据备份至少已经提交了。
    const imgStat = await backupImages(env, token, repo, dir);

    await env.DB
      .prepare(`INSERT INTO settings (key, value) VALUES ('backup_last_at', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(new Date().toISOString())
      .run();
    await env.DB
      .prepare(`INSERT INTO settings (key, value) VALUES ('backup_last_result', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(`成功 · ${file} · 新图 ${imgStat.written} 张 · ${commit ? commit.slice(0, 7) : '?'}`)
      .run();

    return {
      ok: true, file, commit, counts: data.counts, bytes: content.length,
      images: imgStat,
      total_bytes: content.length,
    };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    try {
      await env.DB
        .prepare(`INSERT INTO settings (key, value) VALUES ('backup_last_result', ?1)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .bind('失败 · ' + msg.slice(0, 150))
        .run();
    } catch (e2) {}
    console.error('备份失败:', msg);
    return { ok: false, reason: msg };
  }
}

/** 后台预览用：不写文件，只统计会备份多少东西 */
export async function previewBackup(env) {
  const data = await dumpAll(env);
  return { counts: data.counts, bytes: JSON.stringify(data, null, 2).length };
}

/**
 * 从备份仓库恢复图片。
 *
 * 使用场景：D1 里的图片丢了（误删 / 数据库重建），但仓库里的备份还在。
 * 只补**库里没有的** token，不覆盖已有的。
 *
 * @returns {{added:number, skipped:number, failed:number, detail:string[]}}
 */
export async function restoreImages(env) {
  const { results: rows } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows || []) s[r.key] = r.value;

  const repo = String(s.backup_repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('备份仓库格式不对（应为 owner/repo）');

  const token = env.GH_TOKEN;
  if (!token) throw new Error('没有配置 GH_TOKEN 密钥');

  const dir = String(s.backup_path || 'backup').replace(/^\/+|\/+$/g, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'your-site-backup',
  };

  // 1. 仓库里有哪些图片
  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${encodeURI(dir + '/images')}?ref=main`,
    { headers }
  );
  if (listRes.status === 404) return { added: 0, skipped: 0, failed: 0, detail: ['仓库里还没有 images 目录'] };
  if (!listRes.ok) throw new Error(`读取备份目录失败：${listRes.status}`);
  const files = await listRes.json();
  if (!Array.isArray(files)) return { added: 0, skipped: 0, failed: 0, detail: ['备份目录为空'] };

  // 2. 库里已经有哪些 token
  const { results: have } = await env.DB.prepare('SELECT token FROM images').all();
  const haveSet = new Set((have || []).map((x) => x.token));

  let added = 0, skipped = 0, failed = 0;
  const detail = [];

  for (const f of files) {
    if (f.type !== 'file') continue;
    const m = String(f.name).match(/^([0-9a-f]+)\.(jpg|png|gif|webp|bin)$/i);
    if (!m) continue;

    const imgToken = m[1];
    if (haveSet.has(imgToken)) { skipped++; continue; }

    try {
      // 3. 取原始内容（download_url 是免鉴权的直链）
      const raw = await fetch(f.download_url, { headers });
      if (!raw.ok) throw new Error(`下载失败 ${raw.status}`);
      const buf = new Uint8Array(await raw.arrayBuffer());

      // base64 编码（Workers 里 btoa 只吃 latin1，必须分块喂）
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      const b64 = btoa(bin);

      const mime = m[2] === 'jpg' ? 'image/jpeg'
        : m[2] === 'png' ? 'image/png'
        : m[2] === 'gif' ? 'image/gif'
        : m[2] === 'webp' ? 'image/webp' : 'application/octet-stream';

      // 固定 id 有风险（可能撞上现有 id），所以不指定 id，用 token 唯一索引兜底
      await env.DB
        .prepare('INSERT OR IGNORE INTO images (token, mime, size, data) VALUES (?1, ?2, ?3, ?4)')
        .bind(imgToken, mime, buf.length, b64)
        .run();

      added++;
      detail.push(`+ ${f.name}`);
    } catch (e) {
      failed++;
      detail.push(`✗ ${f.name}: ${e && e.message}`);
    }
  }

  return { added, skipped, failed, detail: detail.slice(0, 20) };
}
