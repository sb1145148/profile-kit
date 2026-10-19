# Deployment guide

~15 minutes. Everything here fits in Cloudflare's free tier.

The **Deploy to Cloudflare** button only handles the Worker. Follow this guide
for the whole thing — D1 database, Worker API, Pages frontend, and the optional
extras.

---

## 0. What you need

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- Node.js 22 or newer
- A terminal

Nothing else. No domain required — you can run entirely on `*.workers.dev` and
`*.pages.dev`.

---

## 1. Get the code

```bash
git clone https://github.com/sb1145148/profile-kit
cd profile-kit
npm install
```

---

## 2. Create the database

```bash
npx wrangler login
npx wrangler d1 create your-site-db
```

It prints something like:

```
✅ Successfully created DB 'your-site-db'
database_id = "a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy that id into `wrangler.toml`:**

```toml
[[d1_databases]]
binding = "DB"
database_name = "your-site-db"
database_id = "a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # ← here
```

Now create the tables:

```bash
npx wrangler d1 execute your-site-db --remote --file=./worker/schema.sql
```

> The schema uses `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE`, so running
> it twice is safe. For an existing database, use the numbered files in
> `worker/migrations/` instead, **in order**.

---

## 3. Set the admin password

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Type a password when prompted. This is what `/admin` asks for.

> Cloudflare stores it as a secret — it is never in the repo and never in
> `wrangler.toml`. To change it later, run the same command again.

---

## 4. Deploy the API

```bash
npx wrangler deploy
```

You'll get a URL like:

```
https://your-site-api.your-subdomain.workers.dev
```

**Write it down** — the frontend needs it.

---

## 5. Point the frontend at your API

The API base lives in `frontend/core.js`:

```js
const API_BASE = 'https://api.example.com';   // ← change to your Worker URL
```

Also update these, all in `frontend/`:

| File | What to change |
| --- | --- |
| `core.js` | `API_BASE` — your Worker URL |
| `index.html` and every other `.html` | `<meta property="og:url">`, `<link rel="canonical">`, the RSS `<link>` |
| `manifest.json` | `name`, `short_name` |
| `sw.js` | nothing (it uses relative paths) |

And in `wrangler.toml`, update `[vars]`:

```toml
ALLOWED_ORIGINS = "https://your-site.pages.dev"
SITE_URL = "https://your-site.pages.dev"
```

Redeploy the Worker after changing `[vars]`:

```bash
npx wrangler deploy
```

> `SITE_URL` is what RSS and sitemap use to build absolute links. If it's wrong,
> your feed links will point to the wrong host.

---

## 6. Deploy the frontend

```bash
cd frontend
npx wrangler pages deploy . --project-name=your-site
```

First run asks you to create a project — say yes. You'll get:

```
https://your-site.pages.dev
```

Open it. You should see the demo homepage.

Then go to **`/admin`**, log in with the password from step 3, and start editing.

---

## 7. (Optional) Custom domain

**Frontend:** Pages dashboard → your project → *Custom domains* → add your domain.

**API:** uncomment the `routes` block in `wrangler.toml`:

```toml
routes = [
  { pattern = "api.example.com", custom_domain = true }
]
```

…then `npx wrangler deploy`. Wrangler creates the DNS record and the certificate
for you — but the domain must already be on your Cloudflare account.

Finally set `ALLOWED_ORIGINS` and `SITE_URL` to the new domain and redeploy.

---

## 8. (Optional) Turnstile — bot protection for the guestbook

1. Cloudflare dashboard → *Turnstile* → *Add site*
2. Add your domain, get the **site key** and **secret key**
3. `npx wrangler secret put TURNSTILE_SECRET` → paste the secret key
4. In `/admin` → *Site settings* → paste the **site key**

Without this, the guestbook still works — there's a built-in spam filter
(blocked words, link limits, rate limiting). Turnstile just adds a human check.

---

## 9. (Optional) Auto-backup to GitHub

The site can commit a JSON snapshot of all your data to a GitHub repo every day.

1. Create a **private** repo for backups
2. Make a [fine-grained PAT](https://github.com/settings/tokens?type=beta) with
   **Contents: Read and write** on that repo only
3. `npx wrangler secret put GH_TOKEN` → paste the token
4. In `/admin` → *Site settings* → enable auto-backup, set the repo as
   `your-name/your-backups`

Backups run at 03:00 UTC daily, and also roll forward when the site gets traffic
(so a missed cron doesn't lose a day).

---

## 10. Check it works

In `/admin` there's a **Site self-check** panel. It verifies:

- the database is reachable and the schema is current
- the Worker can read every table
- required secrets are present
- the RSS feed and sitemap respond

Run it right after deploying. If something's off it tells you which piece.

Locally, the full test suite is the other check:

```bash
cd tests
npm install && npx playwright install chromium
npm test
```

---

## Common problems

| Symptom | Cause |
| --- | --- |
| Page loads but everything is empty | `API_BASE` in `core.js` still points at `example.com` |
| `CORS` errors in the console | `ALLOWED_ORIGINS` in `wrangler.toml` doesn't match your Pages domain |
| RSS links point to the wrong host | `SITE_URL` is not set to your domain |
| `/admin` says wrong password | The `ADMIN_PASSWORD` secret isn't set — rerun step 3 |
| 500 on every API call | `database_id` in `wrangler.toml` is wrong, or `schema.sql` was never run |
| Images 404 | `/api/media/...` is fetched from the wrong host — check `API_BASE` |

---

## Updating

```bash
git pull
npm run css        # only if Tailwind classes changed
npx wrangler deploy
cd frontend && npx wrangler pages deploy . --project-name=your-site
```

If the update includes new files in `worker/migrations/`, run them in numeric
order against your database.
