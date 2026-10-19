-- ============================================================
--  迁移脚本 011：图片缩略图
--
--  执行方式：npx wrangler d1 execute profile-db --remote --file=./migrations/011_image_thumb.sql
--
--  为什么需要这个：
--
--    首页实测传输 1.86 MB，其中 1.9 MB 全是图片。
--    作品集把图显示成 aspect-[4/3] 的缩略格（约 280px 宽），
--    却下载了 800 KB 的原图 —— 字节全浪费在「不需要的细节」上。
--
--    但直接把原图压小不行：灯箱要显示到 1248px，
--    压小了灯箱就糊。所以需要**两个尺寸**。
--
--  设计：缩略图存在同一行里（thumb_* 三个字段），
--        地址是 /api/media/<token>?s=thumb。
--        不另开一张表、不另生成 token —— 一行图就是一个完整的东西。
--
--  老图片（迁移前上传的）没有缩略图，?s=thumb 会回落成原图。
--  这不影响正确性，只是省不了那点流量。新上传的才有。
-- ============================================================

ALTER TABLE images ADD COLUMN thumb_data TEXT;
ALTER TABLE images ADD COLUMN thumb_mime TEXT;
ALTER TABLE images ADD COLUMN thumb_size INTEGER;
