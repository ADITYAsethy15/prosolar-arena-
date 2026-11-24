# Deploying Solara (with the bolt.diy sandbox runtime)

Three things are true about this app that decide the whole deployment:

1. **The server is stateless.** No database, no disk, no env vars required for the
   core app. The only server state is an in-memory registry of in-flight streams.
2. **The sandbox runs in the visitor's browser** (WebContainers), not on the host.
   A 512 MB / 0.1 CPU free instance is enough even when a task installs 300 packages,
   because that install happens in the tab.
3. **Cross-origin isolation is mandatory.** The server sends
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: credentialless` on every non-`/api` response.
   Without them `SharedArrayBuffer` is unavailable and the sandbox panel refuses to
   boot with an explicit reason. Any proxy that strips or rewrites those headers
   breaks the sandbox — not the app.

---

## Render (free tier), from a Git repo

### 1. Push this directory to GitHub

```bash
cd Prosolar--main
git init && git add -A && git commit -m "Solara + bolt.diy sandbox runtime"
git remote add origin git@github.com:you/solara.git && git push -u origin main
```

`package-lock.json` **must** be in the commit. It is no longer ignored; `npm ci`
fails without it and that is deliberate (see `README.md`).

### 2. Blueprint deploy

Render → **New +** → **Blueprint** → pick the repo. `render.yaml` is already correct:

| field | value |
| --- | --- |
| Runtime | Node |
| Build | `npm ci && npm run build` |
| Start | `npm start` (`NODE_ENV=production tsx server.ts`) |
| Health check | `/healthz` — public, 200, never behind the password gate |
| `NODE_VERSION` | `22.20.0` |
| `PORT` | supplied by Render, already read |

No other env vars are required. `GEMINI_API_KEY` is an optional server-side fallback
only; every other key lives in the browser's `localStorage` through Settings.

### 3. Or by hand, same numbers

Runtime Node, build `npm ci && npm run build`, start `npm start`, health check path
`/healthz`, add env var `NODE_VERSION=22.20.0`.

### 4. First visit

The password gate is in `server.ts` (`PW = 'agentsol'`). **Change those two
constants before you make the URL public** — `PW` is the password, `KEY` is the
cookie value and moves with it. Then: unlock → Settings → paste one provider key and
a model into a cascade → composer → **Agent** → open the Sandbox panel.

Free-tier caveats that matter here:

- **Spins down after 15 idle minutes**; the next visitor waits ~30–60 s. The
  browser sandbox needs the page anyway, so this costs nothing but the cold start.
- **750 instance-hours/month** = roughly one always-on free service.
- **100-minute ceiling per HTTP response.** The app's own caps are 10 min before the
  first token and 20 min while streaming, so this never binds.
- **No persistent disk** — by design. Chat history is `localStorage`; the sandbox
  project is IndexedDB in the tab; export a `.zip` to keep a project.

### Why `npm ci` and not `npm install`

The previous `render.yaml` used `npm install` and `.gitignore` ignored
`package-lock.json`, so a Git deploy resolved fresh ranges. With this app that is
not a style preference: `undici@8` and the MCP SDK are pinned by the lockfile, and a
version drift there fails at *import* time, not build time.

---

## Other hosts

- **Cloud Run / Fly / Railway / a VPS**: the same three facts apply. `npm ci && npm
  run build`, `npm start`, `PORT` from the environment, and make sure the proxy
  passes COOP/COEP through (Cloud Run does; some CDNs strip them).
- **Static-only hosts (GitHub Pages, Netlify static, S3)**: does **not** work. The
  password gate, the provider proxy, `/api/search`, `/api/fetch-url` and the
  `/api/sandbox/turn` tool relay all need the Express server.
- **Docker**: no `Dockerfile` is shipped; `node:22-alpine`, `npm ci && npm run
  build`, `npm start` is the whole file if you want one.

---

## The zip

If you only want to hand someone the project, the archive contains everything except
`node_modules` and `dist` and is reproducible with:

```bash
zip -qr prosolar-sandbox-bolt.zip Prosolar--main \
  -x "Prosolar--main/node_modules/*" -x "Prosolar--main/dist/*"
```

Checksums for the shipped archive:

```
sha256  57239b203436ef1bbfda93f8b1e4efc5a4bbdd92deb96c7670532f856ae5a185
size    4557890 bytes uncompressed, ~2.4 MB zipped, 69 files
```

Verify a download with
`curl -s https://evapfile.space/<hash>.zip | sha256sum` — evapfile addresses files by
their sha-256, so the hash in the URL is the checksum.
