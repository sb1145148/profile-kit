const REPO = require('path').resolve(__dirname, '..');
/* 生成 PWA 图标：icon-192.png / icon-512.png */
const { chromium } = require('playwright');

const HTML = (size) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${size}px; height:${size}px; }
  .icon {
    width:${size}px; height:${size}px;
    background: linear-gradient(140deg, #1e3a8a 0%, #0f172a 55%, #312e81 100%);
    display:flex; align-items:center; justify-content:center;
    position:relative; overflow:hidden;
    font-family: -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
  }
  /* 右下角的柔和光晕 */
  .glow {
    position:absolute; width:${size * 0.9}px; height:${size * 0.9}px;
    right:${-size * 0.3}px; bottom:${-size * 0.3}px;
    background: radial-gradient(circle, rgba(96,165,250,.55) 0%, rgba(96,165,250,0) 68%);
  }
  .mark {
    position:relative; color:#fff; font-weight:800;
    font-size:${size * 0.42}px; letter-spacing:-0.03em;
    text-shadow: 0 ${size * 0.012}px ${size * 0.05}px rgba(0,0,0,.35);
  }
  .dot {
    position:absolute; top:${size * 0.17}px; right:${size * 0.19}px;
    width:${size * 0.075}px; height:${size * 0.075}px; border-radius:9999px;
    background:#60a5fa; box-shadow:0 0 ${size * 0.06}px rgba(96,165,250,.9);
  }
</style></head>
<body>
  <div class="icon">
    <div class="glow"></div>
    <div class="mark">sb</div>
    <div class="dot"></div>
  </div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(HTML(size), { waitUntil: 'load' });
    await page.waitForTimeout(150);
    await page.screenshot({
      path: `${REPO}/frontend/icon-${size}.png`,
      omitBackground: false,
    });
    console.log(`  ✅ icon-${size}.png`);
    await page.close();
  }
  await browser.close();
})();
