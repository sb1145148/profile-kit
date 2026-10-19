# AGENTS.md

Working notes for AI agents and new contributors. Read this before touching
anything — it's the 5-minute version of the pitfalls you'd otherwise hit.

For humans: [README.md](README.md) · [中文](README.zh-CN.md) · [DEPLOY.md](DEPLOY.md)

---

## What this project is

A personal homepage running on Cloudflare: static frontend on **Pages**, API on
**Workers**, data in **D1** (SQLite). No framework, no bundler. The frontend is
plain HTML files served as-is; the backend is one Worker with routes split by
resource.

```
frontend/   static site (Pages)          worker/   API (Workers)      tests/   914 assertions
```

---

## The five things you'll actually need

### 1. Changing the profile → `worker/worker.js`, line ~47

```js
const PROFILE = { name, avatar, tagline, bio, skills, projects, playlist, contacts };
```

This is the **only** place profile data lives. Not in D1, not in the HTML.
Skills accept either a string (renders as a pill) or `{ name, level }` (renders
as a progress bar).

Everything else — posts, articles, images, guestbook, changelog — is in D1 and
edited through `/admin`.

### 2. Changing colors → `frontend/style.css`

CSS variables in `:root` and `[data-theme="dark"]`. There are also four
day-part variants (`morning` / `day` / `evening` / `night`) that shift the glow.

**If you add or change a Tailwind utility class anywhere in `frontend/`, you must
rebuild the CSS:**

```bash
npm run css        # Tailwind v4 → frontend/tailwind.css
```

`frontend/tailwind.css` is committed and prebuilt, so the site works without
this step — but your new class won't exist until you run it.

### 3. After editing HTML/JS/CSS → `npm run release`

This stamps a content hash into every `?v=` reference and bumps the service
worker cache name. Without it, returning visitors and the PWA keep the old files.

```bash
npm run release    # writes ?v=<hash8> into all HTML + syncs sw.js
```

### 4. Running the tests

```bash
cd tests
npm install && npx playwright install chromium    # first time only
npm test
```

914 assertions, no Cloudflare account, no network. A local server replays
`worker/worker.js` against in-memory SQLite standing in for D1.

**Two gotchas that will waste your time:**

- **The service worker is not registered on localhost** (`core.js` → `initPWA`).
  Offline behavior can't be tested locally — `features6` checks `sw.js` at the
  source level instead. Don't try to test offline locally; you'll chase a ghost.
- **Admin panels load after login.** Everything fetches in `admin.js` →
  `refreshAll()`. If you read panel content right after clicking login you'll
  get "loading…". Wait ~4s or wait for a specific element.

### 5. Deploying

```bash
npx wrangler deploy                                    # Worker
cd frontend && npx wrangler pages deploy . --project-name=your-site
```

**`cd frontend` is required.** Pages Functions only get bundled when you deploy
from inside `frontend/`. Deploying from the repo root silently ships without
`functions/`, and `/a/<slug>` share cards + `sitemap.xml` stop working.

`npm run release` prints this same warning, so if you see it — it's about this.

---

## Things you cannot do (and shouldn't try)

These need a human with a Cloudflare account:

| Task | Why |
| --- | --- |
| `wrangler deploy` / `wrangler d1 create` | Needs `wrangler login` (browser OAuth) |
| `wrangler secret put ADMIN_PASSWORD` | Same |
| Testing the "Deploy to Cloudflare" button | Browser session required |
| Verifying Turnstile end-to-end | Needs a real domain + key pair |

**Don't fabricate a deployment result.** If you can't run it, say so.

---

## Architecture notes worth knowing

**Markdown is escape-first.** Input is HTML-escaped, *then* Markdown rules are
applied (`worker/lib/markdown.js`). Raw HTML can never pass through. If you add
a Markdown feature, keep that order — reversing it is an XSS hole.

**Images come in two sizes.** Uploads store the original plus a browser-generated
640px JPEG (`frontend/media.js`). Grids request `/api/media/<token>?s=thumb`,
the lightbox uses the original. Missing thumbnails fall back to the original, so
nothing 404s. If you touch the upload path, keep the thumbnail optional —
a failed thumbnail must never fail the upload.

**D1 LIKE patterns have a ~50 byte limit.** Exceeding it throws
`LIKE or GLOB pattern too complex` and the whole request 500s. Always build
search patterns with `H.likeSafe(q)` (byte-aware truncation), never
`'%' + q + '%'` — 17 Chinese characters is enough to break it.

**The service worker precaches pretty URLs too**, not just `.html` files.
`/changelog` and `/changelog.html` are both in `SHELL`. Dropping either breaks
offline navigation for that page.

---

## Conventions in this codebase

- **Comments are in Chinese, code is English.** Match the file you're editing.
- **Comments explain *why*, not *what*.** Existing ones are long on purpose —
  they exist because someone already made the mistake.
- **Tests are source-level where behavior can't be tested.** e.g. offline cache
  checks `sw.js` text. Don't "fix" those into browser tests; they can't work.
- **No build step for HTML.** Pages are served as written. Don't introduce one.

---

## Quick reference

| I want to… | Do this |
| --- | --- |
| Change the name / bio / projects | `worker/worker.js` → `PROFILE` |
| Change colors | `frontend/style.css` → `:root` variables |
| Add a nav link | `frontend/index.html` header + every other page's header |
| Add an API route | `worker/routes/<resource>.js` + wire it in `worker.js` |
| Add a DB column | `worker/migrations/NNN_name.sql` **and** `worker/schema.sql` |
| Change the guestbook form | `frontend/index.html` + `frontend/app.js` |
| Verify nothing broke | `cd tests && npm test` |
