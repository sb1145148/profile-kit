-- ============================================================
--  迁移脚本 007：说说 / 文章 / 友链 / 日志 / 来源 / 垃圾词 / 嵌套回复
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/007_content.sql
--
--  ⚠️ ALTER 只能执行一次，第二次会报 duplicate column，忽略即可。
--     CREATE TABLE / INDEX 都带 IF NOT EXISTS，重复执行没问题。
-- ============================================================

-- ---------- 1. 说说（短动态） ----------
-- 复用 images 表存配图，和留言是同一套；审核字段名也和 messages 保持一致
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  image_id   INTEGER,
  status     TEXT NOT NULL DEFAULT 'approved',   -- pending | approved
  likes      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status, id DESC);

-- ---------- 2. 文章 ----------
-- content 存 Markdown 原文，渲染在服务端做（先转义再套 Markdown 规则，天然防 XSS）
CREATE TABLE IF NOT EXISTS articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,                       -- URL 标识，如 hello-world
  title      TEXT NOT NULL,
  summary    TEXT,                                -- 列表页摘要
  content    TEXT NOT NULL,
  tags       TEXT,                                -- 逗号分隔
  status     TEXT NOT NULL DEFAULT 'draft',       -- draft | published
  pinned     INTEGER NOT NULL DEFAULT 0,          -- 置顶
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_slug ON articles (slug);
CREATE INDEX IF NOT EXISTS idx_articles_list ON articles (status, pinned DESC, id DESC);

-- ---------- 3. 友链 ----------
CREATE TABLE IF NOT EXISTS friends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  avatar     TEXT,                                -- 头像外链，可留空
  desc       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_friends_list ON friends (status, sort DESC, id DESC);

-- ---------- 4. 操作日志 ----------
-- 后台每次写操作都记一条，出问题能回溯（比如"那条留言是什么时候被谁删的"）
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,                       -- delete_message / approve / reply / ...
  target     TEXT,                                -- 目标 id
  detail     TEXT,                                -- 补充说明（截断后的摘要）
  ip         TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log ON audit_log (id DESC);

-- ---------- 5. 访问来源 ----------
-- 按天 + 来源域统计。ref 为 'direct' 表示直接访问
CREATE TABLE IF NOT EXISTS visit_refs (
  day   TEXT NOT NULL,
  ref   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ref)
);

-- ---------- 6. 垃圾留言关键词 ----------
CREATE TABLE IF NOT EXISTS blocked_words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  word       TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_words ON blocked_words (word);

-- ---------- 7. 留言嵌套回复 ----------
-- parent_id 指向被回复的留言；为 NULL 表示这是一条顶层留言
ALTER TABLE messages ADD COLUMN parent_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id, id);

-- ---------- 8. 新增设置项 ----------
INSERT OR IGNORE INTO settings (key, value) VALUES ('spam_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('spam_max_links', '3');
INSERT OR IGNORE INTO settings (key, value) VALUES ('about_md', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('github_user', 'Demo');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_enabled', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_repo', 'your-name/your-site');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_path', 'backup');
