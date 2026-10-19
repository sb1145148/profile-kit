-- ============================================================
--  迁移脚本：给已有的 messages 表加上配图字段，并新建 images 表
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/003_message_image_d1.sql
--
--  ⚠️ SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--     所以 ALTER 那两句**只能执行一次**。第二次会报
--     "duplicate column name: image_id"，忽略即可。
--     CREATE TABLE 带 IF NOT EXISTS，重复执行没问题。
-- ============================================================

-- 图片以 base64 文本存在 D1 里（单行上限 2 MB，所以图片限制到 1 MB）
CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 留言关联到配图
ALTER TABLE messages ADD COLUMN image_id INTEGER;

-- 上传限流表
CREATE TABLE IF NOT EXISTS upload_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_upload_log_ip
  ON upload_log (ip, created_at);
