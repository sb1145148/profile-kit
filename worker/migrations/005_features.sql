-- ============================================================
--  迁移脚本 005：留言分页 / 审核 / 回复 / 设置 / 访问量趋势
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/005_features.sql
--
--  ⚠️ ALTER 那几句只能执行一次，第二次会报 duplicate column，忽略即可。
--     CREATE TABLE 带 IF NOT EXISTS，重复执行没问题。
-- ============================================================

-- ---------- 1. 留言：审核状态 ----------
-- pending  = 待审核，前台看不到
-- approved = 已通过，前台正常展示
-- 已有留言默认都是 approved，不会突然消失
ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';

-- ---------- 2. 留言：管理员回复 ----------
ALTER TABLE messages ADD COLUMN reply TEXT;
ALTER TABLE messages ADD COLUMN replied_at TIMESTAMP;

-- 前台只查 approved 且按时间倒序，补一个联合索引
CREATE INDEX IF NOT EXISTS idx_messages_status_created
  ON messages (status, created_at DESC, id DESC);

-- 后台按"待审核"筛选时用
CREATE INDEX IF NOT EXISTS idx_messages_status
  ON messages (status, id DESC);

-- ---------- 3. 站点设置（键值对） ----------
-- 目前用到：
--   require_approval = '0' | '1'      新留言是否需审核
--   notify_type      = 'off' | 'json' | 'wecom' | 'dingtalk' | 'serverchan'
--   notify_webhook   = 推送地址
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('require_approval', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_type', 'off');
INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_webhook', '');

-- ---------- 4. 每日访问量（趋势图用） ----------
-- 注意：这张表从本脚本执行之后才开始有数据，
-- 之前的历史访问量没有按天记录，所以趋势图是从现在开始累积的。
CREATE TABLE IF NOT EXISTS visit_daily (
  day   TEXT PRIMARY KEY,              -- YYYY-MM-DD（UTC）
  count INTEGER NOT NULL DEFAULT 0
);
