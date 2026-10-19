-- ============================================================
--  迁移脚本 010：更新日志（changelog）
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/010_changelog.sql
--
--  设计说明：
--
--    一条记录 = 一天的更新。正文用 Markdown，这样：
--      · 后台只需要一个大文本框，不用给每条改动做单独的表单
--      · 同一天有多个改动时，写成同一篇里的列表就行
--      · 展示时按 entry_date 倒序，天然就是「最新在最上面」
--
--    entry_date 用 TEXT 存 'YYYY-MM-DD'：
--      · 不存完整时间戳，是因为更新日志只需要「哪一天」
--      · 这个格式按字符串排序就等于按时间排序，省得转换
--      · 也不能用 CURRENT_TIMESTAMP 默认值 —— 站长可能补录前几天的
-- ============================================================

CREATE TABLE IF NOT EXISTS changelog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,                        -- 'YYYY-MM-DD'
  title      TEXT NOT NULL,                        -- 这一天的标题，如「留言板支持 Markdown」
  content    TEXT,                                 -- Markdown 正文
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 列表页就是按日期倒序取，这个索引直接服务于它
CREATE INDEX IF NOT EXISTS idx_changelog_date ON changelog (entry_date DESC, id DESC);
