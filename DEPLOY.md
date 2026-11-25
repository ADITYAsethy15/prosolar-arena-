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
# Render-ready layout: the app IS the archive root.
(cd Prosolar--main && zip -qr ../prosolar-sandbox-render.zip . \
  -x "node_modules/*" -x "dist/*" -x ".git/*")
# Archive layout (what earlier deliveries used): app under Prosolar--main/.
zip -qr prosolar-sandbox-bolt.zip Prosolar--main \
  -x "Prosolar--main/node_modules/*" -x "Prosolar--main/dist/*"
```

## The Render build that fails with `ENOENT ... /opt/render/project/src/package.json`

That error is not about Node, npm or the lockfile: the build ran `npm install` in the
**repo root** and there was no `package.json` there, because the app lived in
`Prosolar--main/`. Three ways out, in order of preference:

1. **Push a repo whose root is the app** (what `prosolar-sandbox-render.zip` below is).
   Nothing to configure: `npm install && npm run build` and `npm start` are already
   correct, and `render.yaml` in that root matches.
2. **Keep the current repo layout** and set Render's **Root Directory** to
   `Prosolar--main` (Settings → Root Directory), or add `rootDir: Prosolar--main` to the
   service in `render.yaml`. Build command and start command stay as they are.
3. **Use the blueprint**: `render.yaml` at the repo root with `rootDir:` set, New →
   Blueprint, pick the repo.

Two details that bite after the path is fixed:

- **Start command must be `npm start`, not `node server.js`.** The server is TypeScript
  run through `tsx`; `dist/` is the Vite client bundle only, and `express.static` serves
  it from `process.cwd()/dist`.
- **Node 22 is required**, not preferred: `undici@8` throws
  `Cannot read properties of undefined (reading 'bind')` on Node 20 at import time, so a
  successful build followed by an instant crash is this, not the app. `.node-version` and
  `engines` both say 22; a Render `NODE_VERSION` env var should be `22.20.0` or omitted
  in favour of those.

`npm ci` also runs `node scripts/sync-workspace.mjs`, a no-op unless a `Prosolar--main/`
folder exists next to the root `package.json` — it keeps an archive-style checkout from
deploying stale code.

This build ships in two layouts: `prosolar-sandbox-render.zip` (app at the archive root,
for Render and any other git-push host) and `prosolar-sandbox-bolt.zip` (same code under
`Prosolar--main/`). Both are ~2.4 MB, ~72 files, no `node_modules`, no `dist`. evapfile URLs are content-addressed, so the hash **in the URL** is the
sha-256 of the archive — a download is verified by hashing it and comparing to that.
(The hash is deliberately not written into this file: any edit here changes the
archive's checksum, so a literal would be stale the moment it was saved.)

Verify a download with
`curl -s https://evapfile.space/<hash>.zip | sha256sum` — evapfile addresses files by
their sha-256, so the hash in the URL is the checksum. This archive was unpacked in a
clean directory and re-verified: `npm ci` (357 packages) → `npx vitest run` (35/35) →
`npm run build` (`dist/rg.wasm` present) → `npm start` → `/healthz` `{"ok":true}` →
unlock → `/api/sandbox/stream` returned a full SSE turn (reasoning, text, tool_delta,
done with usage).

---

## Local model servers over plain http (why it used to be refused)

The error *"Custom provider base URL must use HTTPS"* was a deliberate rule, not an
accident — but it was too blunt, and it made the most common local setup impossible: a
model server (Ollama, LM Studio, llama.cpp, vLLM, Jan) reached at the machine's **LAN**
address rather than `127.0.0.1`.

The rule is now explicit, and identical in the browser and in the proxy
(`src/lib/localProviders.ts`, imported by both):

| Base URL | Verdict |
| --- | --- |
| `https://…` | allowed, anywhere |
| `http://localhost`, `127.0.0.1`, `[::1]`, `*.localhost` | allowed — never leaves the machine |
| `http://10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `100.64–127.x`, IPv6 `fc00::/7` / `fe80::/10` | allowed — private network |
| `http://mylaptop`, `*.local`, `*.lan`, `*.home`, `*.internal` | allowed — mDNS/local name |
| `http://<public host>` | refused **unless** you opt in |

Two opt-ins for the public-http case (a local server tunnelled through an http hostname):
the **"allow plain http to any host"** checkbox per custom slot, or
`SOLARA_ALLOW_LAN_HTTP=1` on the server. They are off by default because enabling them
silently would make every key sent to any http host readable on the path.

**Only the local copy can reach your laptop.** The server does the upstream request, so:

- Running Solara on your laptop (`npm run dev` / `npm start`) → `http://192.168.1.20:8080/v1`
  works.
- Running it on Render → `http://192.168.1.20:8080/v1` is unreachable: Render's container
  cannot see your home network, and browsers block a public https page from calling a
  private http address (Private Network Access). For a deployed instance, put the model
  behind an https tunnel (cloudflared, ngrok, tailscale funnel) or point the provider slot
  at that https URL instead.

Also checked while fixing this: `POST /api/models` now applies the same rule, so a LAN
server can list its models and fill the model picker.
