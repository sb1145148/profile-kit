-- ============================================================
--  迁移脚本 008：文章封面图 / Now 页面 / 归档与标签支持
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/008_cover_now.sql
--
--  ⚠️ ALTER 只能执行一次，第二次会报 duplicate column，忽略即可。
-- ============================================================

-- ---------- 1. 文章封面图 ----------
-- 指向 images.id，和相册、留言配图共用同一套图片存储
ALTER TABLE articles ADD COLUMN cover_image_id INTEGER;

-- 列表页要按"有没有封面"来排版，所以这个字段会频繁读
CREATE INDEX IF NOT EXISTS idx_articles_status_created
  ON articles (status, created_at DESC, id DESC);

-- ---------- 2. Now 页面 ----------
-- 存 Markdown 原文，和 about_md 一样在渲染时才转义
INSERT OR IGNORE INTO settings (key, value) VALUES ('now_md', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('now_updated_at', '');
