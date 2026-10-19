-- ============================================================
--  迁移脚本 006：留言点赞 / 作品集相册
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/006_likes_gallery.sql
--
--  ⚠️ ALTER 只能执行一次，第二次会报 duplicate column，忽略即可。
--     CREATE TABLE 带 IF NOT EXISTS，重复执行没问题。
-- ============================================================

-- ---------- 1. 留言点赞数 ----------
-- 前端用 localStorage 防止同一个人重复点赞；服务端只负责累加。
-- （没有做账号体系，所以这是"轻量点赞"，不是严格的唯一性点赞）
ALTER TABLE messages ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;

-- ---------- 2. 作品集相册 ----------
-- 复用已有的 images 表存图，这里只存"这张图在相册里的位置和说明"
CREATE TABLE IF NOT EXISTS gallery (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id   INTEGER NOT NULL,                     -- 指向 images.id
  title      TEXT,                                 -- 作品名
  note       TEXT,                                 -- 一句说明
  sort       INTEGER NOT NULL DEFAULT 0,           -- 排序权重，越大越靠前
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gallery_sort ON gallery (sort DESC, id DESC);
