/* ============================================================
 *  图片工具（缩略图相关）
 *  文件：frontend/media.js
 *
 *  ⚠️ 为什么单独一个文件：
 *
 *    这两个函数首页（core.js）和后台（admin.js）都要用，
 *    但后台页面**不加载 core.js**（它自己带一套 api 实现）。
 *    所以这些函数不能放在 core.js 里 —— 后台会报
 *    「makeThumb is not defined」。
 *
 *    抽成独立文件，两个页面各自 <script> 引入，谁都不依赖谁。
 *    不复制一份 —— 复制就要同步两处，早晚会漏（这个坑踩过了）。
 * ============================================================ */

/**
 * 把图片地址换成缩略图地址。
 *
 * 后端约定：/api/media/<token> 是原图，加 ?s=thumb 返回缩略图。
 * 老图片没有缩略图时后端会回落到原图 —— 前端不用关心。
 *
 * 为什么不在 API 里加 thumb_url 字段：
 *   那要把 11 处生成图片地址的地方都改一遍，还得考虑向后兼容。
 *   一个纯函数解决，而且以后新增接口也自动适用。
 */
function thumbUrl(url) {
  const u = String(url || '');
  if (!u) return u;
  // 已经是缩略图地址就别重复加
  if (u.includes('s=thumb')) return u;
  return u + (u.includes('?') ? '&' : '?') + 's=thumb';
}

/**
 * 生成缩略图（传给后端存起来，网格里用它）
 *
 * 参数：最长边 640px、JPEG 质量 0.75。
 *   · 640px 对网格格子的宽（桌面约 280px、2 倍屏也够）绰绰有余
 *   · 灯箱仍然看原图，所以这里压狠一点没有质量顾虑
 *
 * 返回 File 或 null。**失败一律返回 null** ——
 * 缩略图是优化项，不能因为它挂了导致图片传不上去。
 */
async function makeThumb(file, maxDim = 640, quality = 0.75) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return null;
  // 动图缩了只剩一帧，不缩
  if (file.type === 'image/gif') return null;

  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      // 少数格式 createImageBitmap 不支持，退回 <img>
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
        img.src = url;
      });
    }

    const sw = bitmap.width || bitmap.naturalWidth;
    const sh = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    // 本来就不大，没必要再生成一份
    if (scale >= 0.9) { bitmap.close && bitmap.close(); return null; }

    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // 先铺白底：PNG 的透明区域转成 JPEG 会变黑，白底更接近大多数网页背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return null;
    return new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
  } catch (err) {
    console.warn('[thumb] 生成失败，跳过:', err && err.message);
    return null;
  }
}
