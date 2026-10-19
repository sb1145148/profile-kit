-- ============================================================
--  迁移脚本 009：Turnstile 人机校验
--
--  执行方式（在 worker/ 目录下）：
--    npx wrangler d1 execute profile-db --remote --file=./migrations/009_turnstile.sql
--
--  说明：
--    turnstile_site_key 是**公开值**（本来就要写进网页 HTML），
--    所以放在 settings 表里、从公共接口返回，没问题。
--
--    真正需要保密的是 secret，那个存成 Worker 密钥：
--      npx wrangler secret put TURNSTILE_SECRET
--    没有对应字段存在数据库里。
--
--    空串 = 不启用人机校验。没配 TURNSTILE_SECRET 时后端也直接放行，
--    这样在去 Cloudflare 建好 widget 之前，留言功能不会坏。
-- ============================================================

INSERT OR IGNORE INTO settings (key, value) VALUES ('turnstile_site_key', '');
