/* 用 Playwright 渲染生成 favicon 和分享卡片（og:image）
   没有 ImageMagick/Pillow，但 Chromium 渲染 HTML 再截图效果更好 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
/* 路径：本文件在 <仓库>/tests/ 下 */
const REPO = require('path').resolve(__dirname, '..');
const TESTS = __dirname;


const OUT = `${REPO}/frontend`;
const avatarB64 = fs.readFileSync('/tmp/ogwork/avatar.png').toString('base64');
const AVATAR = `data:image/png;base64,${avatarB64}`;

(async () => {
  const browser = await chromium.launch();

  /* ============ 1. 分享卡片 og:image（1200×630，社交平台标准尺寸） ============ */
  const ogHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      width:1200px;height:630px;overflow:hidden;
      font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
      background:#0b1220;color:#f8fafc;position:relative;
    }
    /* 背景光晕 */
    .glow{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55}
    .g1{width:620px;height:620px;background:#2563eb;left:-160px;top:-220px}
    .g2{width:520px;height:520px;background:#7c3aed;right:-140px;bottom:-200px;opacity:.42}
    .g3{width:420px;height:420px;background:#0ea5e9;right:280px;top:-160px;opacity:.28}
    .wrap{position:relative;z-index:2;height:100%;padding:70px 76px;display:flex;flex-direction:column;justify-content:space-between}
    .top{display:flex;align-items:center;gap:36px}
    .avatar{width:168px;height:168px;border-radius:50%;object-fit:cover;
            border:5px solid rgba(255,255,255,.14);box-shadow:0 20px 50px rgba(0,0,0,.45);flex:none}
    .name{font-size:76px;font-weight:800;letter-spacing:-1px;line-height:1.05}
    .tagline{font-size:30px;color:#93c5fd;margin-top:14px;font-weight:500}
    .bio{font-size:24px;color:#cbd5e1;margin-top:12px}
    .chips{display:flex;gap:14px;flex-wrap:wrap}
    .chip{font-size:22px;padding:11px 24px;border-radius:999px;
          background:rgba(255,255,255,.09);border:1.5px solid rgba(255,255,255,.16);color:#e2e8f0}
    .foot{display:flex;justify-content:space-between;align-items:flex-end}
    .url{font-size:26px;color:#94a3b8;font-family:ui-monospace,monospace}
    .badge{font-size:22px;color:#64748b}
  </style></head><body>
    <div class="glow g1"></div><div class="glow g2"></div><div class="glow g3"></div>
    <div class="wrap">
      <div class="top">
        <img class="avatar" src="${AVATAR}">
        <div>
          <div class="name">Demo</div>
          <div class="tagline">个人开发者</div>
          <div class="bio">你好👋 欢迎你能看这个网站</div>
        </div>
      </div>
      <div class="chips">
        <span class="chip">用 AI 开发好玩的东西</span>
        <span class="chip">HTML / CSS / JavaScript</span>
        <span class="chip">GitHub Pages</span>
      </div>
      <div class="foot">
        <div class="url">example.com</div>
        <div class="badge">个人主页 · 技能 · 项目 · 留言板</div>
      </div>
    </div>
  </body></html>`;

  const p1 = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await p1.setContent(ogHtml, { waitUntil: 'load' });
  await p1.waitForTimeout(400);
  await p1.screenshot({ path: path.join(OUT, 'og-image.png') });
  console.log('✅ og-image.png  (1200×630)');
  await p1.close();

  /* ============ 2. favicon（小尺寸下要够清楚，所以用圆形头像 + 描边） ============ */
  const iconHtml = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0}
    html,body{width:${size}px;height:${size}px;overflow:hidden}
    .box{width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;overflow:hidden;
         background:linear-gradient(140deg,#2563eb,#7c3aed)}
    .box img{width:100%;height:100%;object-fit:cover;display:block}
  </style></head><body>
    <div class="box"><img src="${AVATAR}"></div>
  </body></html>`;

  for (const [file, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
    const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p.setContent(iconHtml(size), { waitUntil: 'load' });
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(OUT, file), omitBackground: false });
    console.log(`✅ ${file}  (${size}×${size})`);
    await p.close();
  }

  await browser.close();
})();
