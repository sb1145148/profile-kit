-- ============================================================
--  D1 初始化脚本：schema.sql（全新安装用）
--  执行方式（在 worker/ 目录下）：
--    本地测试： npx wrangler d1 execute profile-db --local  --file=./schema.sql
--    线上正式： npx wrangler d1 execute profile-db --remote --file=./schema.sql
--  说明：脚本用了 IF NOT EXISTS / INSERT OR IGNORE，重复执行不会报错、也不会清空已有数据。
--  ⚠️ 已经在跑的数据库要升级，请按顺序执行 migrations/ 里的脚本，不要跑这个文件。
-- ============================================================

-- ---------- 1. 留言表 ----------
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,                        -- 昵称
  content    TEXT NOT NULL,                        -- 正文
  image_id   INTEGER,                              -- 配图，指向 images.id
  status     TEXT NOT NULL DEFAULT 'approved',     -- pending 待审核 / approved 已通过
  reply      TEXT,                                 -- 管理员回复
  replied_at TIMESTAMP,                            -- 回复时间
  likes      INTEGER NOT NULL DEFAULT 0,           -- 点赞数
  parent_id  INTEGER,                              -- 嵌套回复：指向顶层留言
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 前台：只要 approved，按时间倒序分页
CREATE INDEX IF NOT EXISTS idx_messages_status_created
  ON messages (status, created_at DESC, id DESC);

-- 后台：按状态筛选
CREATE INDEX IF NOT EXISTS idx_messages_status
  ON messages (status, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id, id);

-- ---------- 2. 配图表 ----------
-- 图片以 base64 文本存在 D1 里。
-- 用 base64 而不是 BLOB：base64 在各种驱动下的读写行为确定，
-- 不会出现"本地能用、线上读回来是另一种类型"的坑。代价是体积膨胀 33%。
-- 单行上限 2 MB（D1 硬限制），所以图片本身限到 1 MB。
CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL,                        -- 随机访问令牌，图片地址用它而不是 id
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       TEXT NOT NULL,                        -- base64
  thumb_data TEXT,                              -- base64（缩略图，网格用）
  thumb_mime TEXT,
  thumb_size INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 图片地址是 /api/media/<token>，且响应头声明了 immutable（缓存一年）。
-- immutable 的前提是「同一 URL 永远同一内容」，所以绝不能用会复用的自增 id 当地址。
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_token ON images (token);

-- ---------- 2.5 作品集相册 ----------
-- 复用 images 表存图，这里只存"这张图在相册里的位置和说明"
CREATE TABLE IF NOT EXISTS gallery (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id   INTEGER NOT NULL,
  title      TEXT,
  note       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gallery_sort ON gallery (sort DESC, id DESC);

-- ---------- 3. 访问量 ----------
-- 总量（这张表永远只有一行）
CREATE TABLE IF NOT EXISTS visits (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  count INTEGER DEFAULT 0
);
INSERT OR IGNORE INTO visits (id, count) VALUES (1, 0);

-- 每日明细（趋势图用）
CREATE TABLE IF NOT EXISTS visit_daily (
  day   TEXT PRIMARY KEY,                          -- YYYY-MM-DD（UTC）
  count INTEGER NOT NULL DEFAULT 0
);

-- ---------- 4. 站点设置 ----------
-- ---------- 更新日志 ----------
CREATE TABLE IF NOT EXISTS changelog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_changelog_date ON changelog (entry_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('require_approval', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_type', 'off');
INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_webhook', '');

-- ---------- 5. 管理后台登录失败记录（防暴力破解） ----------
CREATE TABLE IF NOT EXISTS admin_attempts (
  ip      TEXT PRIMARY KEY,
  fails   INTEGER NOT NULL DEFAULT 0,
  last_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- 6. 上传记录（给公开的配图上传做限流） ----------
CREATE TABLE IF NOT EXISTS upload_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_upload_log_ip ON upload_log (ip, created_at);

-- ---------- 7. 说说（短动态） ----------
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  image_id   INTEGER,
  status     TEXT NOT NULL DEFAULT 'approved',
  likes      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status, id DESC);

-- ---------- 8. 文章（Markdown 博客） ----------
CREATE TABLE IF NOT EXISTS articles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT,
  content    TEXT NOT NULL,
  tags       TEXT,
  status     TEXT NOT NULL DEFAULT 'draft',
  pinned     INTEGER NOT NULL DEFAULT 0,
  views      INTEGER NOT NULL DEFAULT 0,
  cover_image_id INTEGER,                          -- 封面图，指向 images.id
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_slug ON articles (slug);
CREATE INDEX IF NOT EXISTS idx_articles_status_created ON articles (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_list ON articles (status, pinned DESC, id DESC);

-- ---------- 9. 友链 ----------
CREATE TABLE IF NOT EXISTS friends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  avatar     TEXT,
  desc       TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_friends_list ON friends (status, sort DESC, id DESC);

-- ---------- 10. 操作日志 ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log ON audit_log (id DESC);

-- ---------- 11. 访问来源 ----------
CREATE TABLE IF NOT EXISTS visit_refs (
  day   TEXT NOT NULL,
  ref   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ref)
);

-- ---------- 12. 垃圾词 ----------
CREATE TABLE IF NOT EXISTS blocked_words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  word       TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_words ON blocked_words (word);

-- ---------- 13. 新设置项 ----------
INSERT OR IGNORE INTO settings (key, value) VALUES ('spam_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('spam_max_links', '3');
INSERT OR IGNORE INTO settings (key, value) VALUES ('about_md', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('now_md', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('now_updated_at', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('turnstile_site_key', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('github_user', 'Demo');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_enabled', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_repo', 'your-name/your-site');
INSERT OR IGNORE INTO settings (key, value) VALUES ('backup_path', 'backup');
