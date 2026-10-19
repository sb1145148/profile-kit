-- ============================================================
--  迁移脚本：给 images 表加 token，避免「id 复用导致返回旧缓存图片」
--
--  为什么需要：
--    图片地址原本是 /api/media/<id>，而响应头声明了 immutable（缓存一年）。
--    "immutable" 的前提是 **同一个 URL 永远对应同一份内容**。
--    但 images.id 是自增的，一旦自增计数器被重置（清空表、恢复备份等），
--    新图片会重新拿到 id=1，而边缘缓存里 /api/media/1 还是旧图 →
--    用户看到的是别人的旧图片。
--
--    改成随机 token 后，URL 天然唯一，且无法被枚举遍历。
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/004_image_token.sql
--
--  ⚠️ ALTER 那句只能执行一次，第二次会报 duplicate column，忽略即可。
-- ============================================================

ALTER TABLE images ADD COLUMN token TEXT;

-- 给已有图片补上 token（随机 32 位十六进制）
UPDATE images SET token = lower(hex(randomblob(16))) WHERE token IS NULL OR token = '';

-- 唯一索引：token 必须唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_token ON images (token);
