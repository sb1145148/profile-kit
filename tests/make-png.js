/* 生成真实的 PNG 图片字节（测试压缩用）
   用随机像素让 zlib 压不动，从而得到一张"体积很大"的真实图片 */
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 width×height 的 PNG；random=true 时像素随机（不易压缩，体积大） */
function makePNG(width, height, random = true) {
  const bpp = 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (width * bpp + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * bpp;
      if (random) {
        raw[p] = (x * 7919 + y * 104729) & 0xFF;
        raw[p + 1] = (x * 31 + y * 17) & 0xFF;
        raw[p + 2] = ((x ^ y) * 13 + (x * y)) & 0xFF;
      } else {
        raw[p] = 200; raw[p + 1] = 120; raw[p + 2] = 60;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makePNG };

if (require.main === module) {
  const p = makePNG(900, 700, true);
  console.log('生成 PNG:', (p.length / 1024).toFixed(0), 'KB');
}
