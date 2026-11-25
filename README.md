# Solara — Minimalist Stateless Multi-Provider AI Chat

Solara is a stateless, full-stack multi-provider AI chat application built with **React 19**, **TypeScript**, **Vite**, **Tailwind CSS v4**, and an **Express** proxy server (`server.ts`). All user-facing state—API keys, custom endpoints, ordered model cascades, learned model capabilities, thinking-level preferences, system prompts, UI theme settings, and your last 10 conversations—is persisted strictly in browser `localStorage`.
---


## Deploy to Render (free)

One click, no dashboard typing: push this repo to GitHub, then Render reads `render.yaml` (its Blueprint
file) and creates the service with the right values automatically — *New* → *Blueprint* → pick the repo.
If you'd rather fill the form by hand, it's:

| field | value |
| --- | --- |
| Runtime | Node |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Instance type | Free |
| Health check path | `/api/health` |

**No environment variables are required.** The access password lives in `server.ts` (`PW` / `KEY`) — change
those two constants and push, that's the whole configuration. `PORT` is supplied by Render and already read.

Honest free-tier caveats, before you hit deploy:

- **Spins down after 15 idle minutes**, and the next visitor waits ~30–60 s for it to wake up. For a personal
  app this is a feature: a service that sleeps most of the day uses a tiny fraction of the monthly hours.
- **750 instance-hours per workspace per month** — that is roughly one always-on free service, so don't run
  three of them.
- **512 MB RAM, 0.1 CPU, single instance.** Fine here: the sandbox (WebContainers) runs entirely in the
  visitor's browser, so it adds no server load at all.
- **No persistent disk.** Anything written server-side vanishes on redeploy — which is fine by design, since
  chat state lives in `localStorage` and the sandbox lives in the tab.
- **100-minute maximum request duration**, comfortably above the 10-min/20-min stream budgets in `server.ts`,
  so long reasoning cascades survive.
- **Free Postgres is not used** — there is no database here, so its 30-day expiry can't bite you.
- `npm ci` needs the committed `package-lock.json` — and `.gitignore` used to ignore exactly that file, so a
  Git-deployed Render build resolved fresh ranges instead (a different `undici`/`esbuild` than the app is tested
  against). The lockfile is tracked now and `render.yaml` runs `npm ci && npm run build`.
- `render.yaml` also sets `NODE_VERSION=22.20.0`. Node 20 fails at import time
  (`TypeError: Cannot read properties of undefined (reading 'bind')` in `undici`'s zstd decompressor), which
  looks like an app bug and is not one.

Node 22 is required (`undici@8` refuses to load on older majors; `engines` and `.node-version` pin it).

### Sandbox (files, shell, tests, previews) — in your browser tab

The terminal icon in the composer opens the **Sandbox** panel: a real Node.js runtime (WebContainers) running
inside the tab, driven by the model through **12 project tools** exposed as an in-memory **MCP server**, with a
persistent `/bin/jsh` terminal, real `ripgrep`, a live preview and a completion gate. The execution framework is
ported from [bolt.diy](https://github.com/stackblitz-labs/bolt.diy); `SANDBOX-RUNTIME.md` is the module-by-module
map and the reasoning behind each piece.

- Nothing runs on the server, nothing is stored on the server, and nothing is sent anywhere except the model
  endpoint you already chose. Your API keys never enter the sandbox.
- **The tools are a real MCP client/server pair** (`@modelcontextprotocol/sdk`, `InMemoryTransport`): reads
  (`project_read_file`, `project_list_paths`, `project_search_content`, `project_find_related_files`), writes
  (`project_write_file`, `project_replace_lines`, `project_patch_file`, `project_create_directory`,
  `project_delete_path`), processes (`project_run_command`, `project_get_process_output`, `project_stop_process`),
  and research (`web_search`, `web_fetch`, relayed through this app's server), plus the two gate tools
  (`agent_plan`, `agent_complete`). The Activity tab lists this surface under **"N tools available"**, generated
  from the same definitions the provider is given, so what you see cannot drift from what is callable.
- **Writes are validated before they are saved.** A `.ts`/`.tsx`/`.js` file is parsed with Prettier's own parser
  first; a syntax error comes back to the model with the line and a hint instead of a bundler error three rounds
  later. Edits go through line-range patches guarded by a SHA-256 revision, so a stale patch is a hard conflict
  rather than a silent clobber.
- **Commands are processes, not strings.** `project_run_command` returns a `processId`: installs are polled to
  exit code 0 before a dependent command may start, a repeated `run` reuses the live server instead of binding the
  port twice, and every output is real (exit codes are not scraped from a shared shell).
- **A completion gate the model cannot talk past.** `agent_plan` before edits; `agent_complete` is refused unless
  a check passed *after* the last edit and the last failure, and every planned criterion is reported by id. When
  the model stops early, the loop tells it the single next required action. Preview exceptions and
  `console.error`s are fed into the following round, so "it renders" cannot survive `boom is not defined`.
- **Tokens stream as they arrive.** `/api/sandbox/stream` proxies the provider's SSE with
  `stream_options.include_usage`, reassembles indexed `tool_calls` fragments, and keeps the connection alive;
  the panel coalesces deltas into one growing bubble on a 60 ms timer instead of re-rendering per token. Any
  stream failure falls back to the blocking `/api/sandbox/turn` path silently, so a provider that cannot
  stream still works.
- **It does not waste requests looking around.** The workspace inventory (paths, sizes,
  file contents up to a budget) is written into the first message, so round 1 writes code
  instead of asking for a directory listing. When the request budget is small, the panel
  switches to **single-shot** automatically: plan + every write + the first run in one
  response, then one request for the summary — and the transcript states plainly what was
  not verified.
- **One request can carry several tool calls.** The model is told to batch independent
  work, `parallel_tool_calls` is sent upstream (and dropped with a visible note if a
  gateway rejects the field), and the loop runs every call in a single response up to a
  ceiling you control — so five file writes cost one request instead of five. The budget
  is three separate numbers in the composer: **requests** per task, **calls/request**, and
  **max tokens** per answer. Each task also reports the **tokens it actually used**
  (prompt / completion / reasoning), updated live from each turn's `usage`.
- **Every write is reviewable as a diff.** Before a write tool runs the loop snapshots the file, after it
  compares and emits a `change` event (`created`/`updated`/`deleted`, `+added`/`-removed`, unified patch).
  The Activity tab lists changed files with badges, the Files tab badges them in the tree, and the viewer
  toggles between the file and its patch. The diff is an LCS over lines with unchanged runs collapsed and a
  400k-cell cap, so a 4000-line file cannot stall the tab.
- **The conversation survives a reload.** The transcript is saved to IndexedDB alongside the project, so a
  refreshed tab shows the last thread next to the files, not an empty log in front of a finished project.
- **Local model servers work over plain http on your LAN.** `http://192.168.1.20:8080/v1`
  (Ollama, LM Studio, llama.cpp, vLLM) is accepted alongside https URLs; loopback and
  private ranges need no opt-in, a public http host needs an explicit switch, and the
  settings form says which rule applied before you save.
- **Ported from OpenHands:** a `never / risky / always` confirmation policy with real risk
  classification (destructive commands, secrets, the lockfile) instead of one auto-approve
  checkbox; stuck detection (repeated identical calls, repeated failures, and read-only
  calls with no write) that redirects the model instead of letting it burn the budget;
  task-triggered playbooks (three.js, Vite, Node, tests, debugging) written for this
  sandbox; and deterministic conversation condensation that keeps decisions when a long
  thread has to be shortened.
- **`stop` means stop.** It interrupts the model request, kills the running command (before this it ran to its
  own timeout — up to 300 s for an install — which is why `stop` looked dead), and answers an open approval
  prompt as a rejection. Closing the panel stops the turn as well.
- **Approvals** cover every mutating call and `project_run_command` (opt-in auto-approve, off by default).
  **Lock a file or folder** in the Files tab and the agent's write to it is refused with a message it can read.
- Commands are capped at 120 s (5 min for installs) with a 100 KB output tail; the agent gets up to **24**
  tool calls per message (the `tool calls` box, 1–60). Every run prints what it is limited by —
  `budget: 24 tool call(s), up to 8,192 tokens per turn` — so a truncated turn is never mistaken for a lazy model.
- Node.js only — no Python, no apt. `npm i` works through StackBlitz's registry proxy, so it needs a network
  connection. The project **persists in IndexedDB** across reloads (text files only), and exports/imports as a
  `.zip`; `reset` wipes the workspace and its processes.
- The workspace is an ES module (`package.json` has `"type": "module"`), so `require(...)` in a `.js` file fails.
  The agent is told to switch to `import` or a `.cjs` file, and usually self-corrects in one round.
- A command ending in `&` is left running instead of being waited on, and whatever port a server opens is adopted
  by the **Preview** tab automatically. The **Terminal** tab is an interactive `/bin/jsh` session of your own;
  agent commands are spawned as their own processes and mirrored into it, which is what keeps a dev server from
  blocking the next tool call.
- **The preview URL is not a URL you can share, and that is not a bug in this app.** The address the container
  hands back is a StackBlitz-hosted proxy to the container instance living *in this tab*. The panel's iframe is
  inside that tab, so it renders; a fresh tab has no container behind it and says the project is not connected.
  No header, CORS setting or `render.yaml` key changes that — the proxy is not the app's origin. Three controls
  cover what you actually want:
  - **fullscreen** enlarges the panel's iframe to cover the window and keeps the container alive, so the app
    still runs, hot-reloads and talks to its own dev server. `Esc` or **close** puts it back. This is the one to
    use while the agent is iterating.
  - **open standalone** makes a copy that *can* leave: `src/lib/sandbox/snapshot.ts` reads `dist/index.html`
    (falling back to `index.html`) out of `/workspace` and rebuilds it as ONE self-contained document, then opens
    it from a `blob:` URL in a new tab. Every `<script src>`, `<link href>`, `@import` and `url()` — including
    ones inside imported stylesheets and inline `style` attributes — is resolved and replaced with a `data:` URL,
    recursively for module graphs (depth 12), because a relative `./util.js` left alone would resolve against the
    blob and 404. Dev-server hooks like `/@vite/client` are stripped, `</script>` inside inlined code cannot break
    out of the tag, and a cycle terminates instead of hanging. Ceilings: 4 MB per file, 24 MB per document;
    anything over, or missing, is left as-is and *reported* under the button rather than silently dropped.
    Three things make it work on a real project rather than a toy page:
    - **bare imports are resolved through `node_modules`** the way a bundler does — the package's `exports`
      map, then `module`, then `main`, then `index`. `import * as THREE from 'three'` becomes the ESM build
      inlined into the page (a `require`-only package is reported instead of half-inlined, and the import is
      stubbed so the rest of the page still runs).
    - **`import './style.css'` is hoisted into a `<style>`** in the head. A module graph cannot carry a
      stylesheet, so before this the copy loaded as unstyled text — the "only letters" preview.
    - **`new URL('./x.png', import.meta.url)` becomes the data URL** it points at, because inside a `data:`
      module `import.meta.url` is the module itself, which is how a three.js texture silently fails to load.
  - **build then open** runs the project's own build in the container (`npm run build`, or `npx vite build`
    when there is no script) and snapshots `dist/`. Use it for Vite/React/TS/TSX or SCSS entries: those are not
    valid browser syntax, so a snapshot of the source can only ever be partial — the note says so and points here.
  - **save .html** writes that same document to disk — no popup to block, no iframe sandbox in the way, and it
    keeps working after you close the tab.
  - **raw preview URL** is the old plain link, kept but labelled honestly: it only answers while the tab holding
    the container is open.
- A snapshot is a copy, not a tunnel: it captures the workspace at the moment you click, so a dev-server-only
  project must be built first (`npm run build`), and a page that fetches data from a server still has no server.
- It requires a cross-origin-isolated top-level page, so it will not run inside an embedded preview iframe —
  the panel tells you to open Solara in a new tab rather than failing mysteriously.
- `@webcontainer/api` is MIT and free for open-source use per StackBlitz, but depends on their hosted
  registry proxy; check their terms before making this a paid product.

**Point it at the right base URL.** The panel uses the provider you already configured, and the agent path is
`{baseUrl}/chat/completions`, so `baseUrl` must be the OpenAI-compatible root — e.g. AIHubMix is
`https://aihubmix.com/v1`, **not** `https://aihubmix.com/api/v1` (that namespace serves their model catalog and
answers `404 not_found` for chat). Plain `http` is allowed only for `localhost`/`127.0.0.1`, so Ollama and
LM Studio work while a remote `http` endpoint is refused.

**If an agent turn stops with a blank answer, raise `max tokens`.** Reasoning models bill thinking tokens
before they write anything, so a budget that looks generous can leave `content` empty with
`finish_reason=length`. The panel field now defaults to **8192** (it was 2048, which is smaller than a single
`write_file` call: the file's whole text travels inside that one answer, so the JSON broke mid-call and the turn
ended having applied nothing). It is a clamped number box, 500–32000, and the value you set is the value sent
upstream — asserted end-to-end in the panel harness. 4000–8000 suits tool-calling reasoning models; some models
spend the entire budget deliberating and return nothing, which is why the ceiling is not higher and why the
refusal line names the exact figure: `raise max tokens above 8,192`.

**The agent can see its own running page.** WebContainer boots with `forwardPreviewErrors`, so an uncaught
exception or rejected promise in the preview is forwarded to the tab and injected into the model's next request
(`The running preview reported these problems: …`), with one extra round granted if it only appears after the
model already answered. Console-only failures that never fire `window.onerror` — a `<script src>` served with the
wrong MIME type, a 404 — are invisible to this mechanism by design, so a blank page with no error line is
possible.

**A provider can say "no" with HTTP 200.** Free accounts that run out of quota sometimes answer
`200 OK` with an apology inside `message.content`; that used to become the agent's final answer. Refusals are
recognised and shown as errors, and they are not retried (a refusal is not a throttle).

## for hosting just fork the repo or download the zip then upload it to any host like cloudrun or  render 

but don't forget to change the password and its cookie 🍪 in server.ts  
```
const PW = 'change this ';
const KEY = 'change this too '; // random cookie value, moves with PW

```

---

## Key Features

- **5 Built-in Providers + 2 Custom OpenAI-Compatible Slots**:
  - **Gemini AI Studio** (`https://generativelanguage.googleapis.com` via `@google/genai` `v1beta`, with automatic OpenAI-compatible fallback to `/v1beta/openai` on non-auth/non-404 transport failures)
  - **Groq** (`https://api.groq.com/openai/v1`)
  - **OpenRouter** (`https://openrouter.ai/api/v1` — supports public catalog discovery & Cloudflare AI PDF parsing plugin)
  - **NVIDIA NIM** (`https://integrate.api.nvidia.com/v1` — supports public catalog discovery)
  - **Z.AI** (`https://api.z.ai/api/paas/v4`)
  - **Custom #1 & Custom #2** — user-defined HTTPS OpenAI-compatible endpoints (e.g., Arena `https://api.arena.ai/v1` or self-hosted gateways)
- **Empty-by-Default Drag-Reorderable Model Cascades**:
  - One ordered fallback cascade per provider (`CascadeEditor.tsx`) using drag-and-drop (`motion/react` `Reorder.Group`), manual model slug entry (`Top` / `End`), live catalog search, and full JSON export/import.
  - Models are called in exact cascade order; HTTP `401`/`402`/`403`/`429` (rate limit), `503`/`5xx` upstream failures, auth/billing/quota/missing-model errors, and empty responses immediately fail over to the next model without wasting parameter retries (emitting `fallback_notice`), while `400`/`422` parameter rejections trigger self-healing retries first.
- **Text-Output-Only Model Filtering**:
  - Both `/api/models` (`server.ts`) and `parseCatalog()` (`src/lib/providers.ts`) filter catalogs to **text-output** chat models while preserving multimodal-input models (image, PDF, audio, video → text). Pure image/video/audio generators, TTS, ASR/STT, embeddings, rerankers, and guard models are excluded.
- **Live Capability Discovery & Runtime Self-Healing Learning**:
  - Reads live provider metadata (`row.thinking`, `outputTokenLimit`, OpenRouter `reasoning.supported_efforts` including `null` and `supported_parameters`, generic `supported_efforts` / boolean flags) and falls back to `'adaptive'` (`supportsThinking: 'unknown'`) when metadata is omitted so brand-new models can always be tested.
  - Emits `learned_capability` and `model_meta` SSE events whenever a parameter retry or fallback repair succeeds (e.g., ceiling/floor clamping, NVIDIA NIM `chat_template_kwargs` ↔ `reasoning_effort` swaps, Gemini `systemInstruction` → user-message folding), caching `learned-runtime` capabilities in `localStorage` and preserving them across catalog refreshes unless overridden by live API metadata.
- **Unified Thinking-Level Control (`src/lib/reasoning.ts`)**:
  - Single shared client/server engine supporting 9 modes (`Default`, `None`, `On`, `Minimal`, `Low`, `Medium`, `High`, `XHigh`, `Max`).
  - Dynamic dropdown option labels preview exact effective behavior for the top model in the active cascade (e.g., `XHigh (→ High)`, `None (mandatory → Low)`, `High (Supported)`).
  - Gemini 3.x / 4.x / 5.x+ and Gemma 4+ use `thinkingConfig.thinkingLevel` (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`, `XHIGH`, `MAX`) resolved safely via `(ThinkingLevel as any)[key] ?? key`, with step-down retries before cleanly stripping `thinkingConfig`.
- **Adaptive Global Timeout (5 min → 10 min) & True Server-Side Stream Abort**:
  - **5-Minute Initial / Idle Timeout (`300,000 ms`)**: All requests start with a 5-minute ceiling (`REQUEST_TIMEOUT_MS`) while waiting for the upstream model to respond; silent or hung connections fail cleanly at 5 minutes.
  - **10-Minute Active-Stream Promotion (`600,000 ms`)**: Globally across all providers (both in `server.ts` via `createAdaptiveTimeout()` and in `src/App.tsx`), as soon as a model emits real `thought` or text `chunk` output, the request deadline promotes automatically to **10 minutes** (`ACTIVE_STREAM_TIMEOUT_MS`) from request start, backed by `605,000 ms` Node HTTP/Express socket ceilings (`requestTimeout`, `headersTimeout`, `keepAliveTimeout`, `req/res.setTimeout`) so heavy reasoning models are not cut off mid-stream.
  - **Immediate Upstream Cancellation**: Client `AbortController` + `POST /api/chat/abort` backup + Express `res.on('close')` listener abort upstream provider requests immediately so zero extra tokens are consumed after stopping.
- **25 MB File Uploads & Multimodal Attachments**:
  - Paste, drag-and-drop, or pick files up to **25 MB** each (up to 12 files per turn). Small files (`≤ 4 MB` or images) encode inline; larger files stream via `multipart/form-data` (`multer` memory storage) and are stripped before saving chat history to `localStorage`.
- **Tavily Web Search & Native Gemini URL Context**:
  - **Tavily Web Search**: Toggleable per turn across all providers (including Gemini) with `Always` or `Model`-decided query generation, configurable search depth (`basic`, `advanced`, `fast`, `ultra-fast`), result count (`1–10`), allow/block domain lists, per-chat call cap (`1–25`), custom instructions, and clickable `[1]`, `[2]` source citations.
  - **Native Gemini URL Context**: On Gemini models (excluding `gemma*`), if the latest user prompt contains a public `http://` or `https://` URL (filtering out `localhost`/private IPs), `server.ts` automatically attaches `tools: [{ urlContext: {} }]`, with self-healing retry stripping `tools` cleanly if rejected by a specific model.
- **Rich Markdown, Math & Voice UX**:
  - Heavy Markdown + KaTeX math renderer (`MarkdownRenderer.tsx`) with LaTeX auto-healing, syntax-highlighted code blocks with copy buttons, tables, and collapsible live/saved `Thinking Process` blocks.
  - Per-message controls: **Copy Markdown**, **Copy Text**, **Read Aloud** (browser `speechSynthesis` with Play/Pause/Resume/Stop via `speechSanitizer.ts`), **Edit Query & Re-run** (user messages), and **Delete**.
  - Quick-insert **Mini Prompts Drawer** (`MiniPromptDrawer.tsx`), in-chat message filter, configurable **History Limit** (`5..40` in steps of 5), **Max Tokens** (`500..100000`), **Stream ON/OFF** toggle, and live surface/accent/text/prose-size **Appearance** customizer.

---

## Project Structure

```text
├── server.ts                        # Stateless Express API proxy, SSE orchestrator, Vite dev/static host
├── index.html                       # SPA HTML shell (Plus Jakarta Sans font, metadata)
├── metadata.json                    # App manifest & server-side Gemini capability declaration
├── package.json                     # Dependencies & npm scripts (dev, build, start, lint)
├── tsconfig.json                    # TypeScript configuration
├── vite.config.ts                   # Vite + Tailwind v4 build config
├── .env.example                     # Optional server environment variables
└── src/
    ├── App.tsx                      # Main chat layout, streaming SSE loop, Tavily flow, localStorage sync
    ├── main.tsx                     # React 19 entry point
    ├── index.css                    # Tailwind CSS v4 styles & utility rules
    ├── types.ts                     # Shared types, ProviderId, Mode, ModelCapability, PROVIDERS config
    ├── lib/
    │   ├── reasoning.ts             # Unified wire-protocol thinking adapter, clamping & runtime learning
    │   ├── providers.ts             # URL normalization, text-output filtering, live capability extraction
    │   └── storage.ts               # Browser localStorage persistence & quota-safe chat compaction
    ├── utils/
    │   └── speechSanitizer.ts       # Markdown/LaTeX sanitization & chunking for Web Speech API
    └── components/
        ├── CascadeEditor.tsx        # Drag-reorderable cascades, catalog search, live/learned badges, JSON I/O
        ├── ChatHistoryDrawer.tsx    # Last-10-sessions switcher & manager
        ├── MarkdownRenderer.tsx     # Marked + KaTeX + code highlighting renderer
        ├── MiniPromptDrawer.tsx     # Quick-insert prompt snippets popover
        ├── ProviderSwitcher.tsx     # Responsive provider selector bar
        ├── SystemPromptEditor.tsx   # Global system prompt editor modal
        └── TavilySettings.tsx       # Connection Settings modal (API keys, Custom #1/#2, Tavily config)
```

### Sandbox runtime (`src/lib/sandbox/`), ported from bolt.diy

```
path.ts              # two-root jail: /workspace (tools) <-> /home/project (container)
container.ts         # boot once, fs, preview-port registry, preview-error queue
project.ts           # tracked file map, generation counter, mutation queue, locks
bootstrap.ts         # restore from IndexedDB -> scaffold -> index
persist.ts           # IndexedDB project persistence (text only, debounced)
terminal.ts          # interactive /bin/jsh --osc session for the Terminal tab
runner.ts            # one command = one process: timeout, abort, output cap, error hints
sourceCheck.ts       # numbered reads, revision-guarded line patches, parse-before-save
ripgrep.ts           # rg.wasm over a WASI preopen of the project (+ public/rg.wasm)
projectTools.ts      # the 12 tool schemas, defined once; JSON Schema via z.toJSONSchema
projectMcp.ts        # MCP server + client, process registry, install gating, web relay
provider.ts          # one model turn: SSE through /api/sandbox/stream, blocking fallback
loop.ts              # agent loop, progress record, completion gate, line diffs
snapshotWorkspace.ts # build-then-inline one self-contained .html
Panel.tsx            # activity / files / terminal / preview UI
runtime.test.ts      # vitest: jail, patches, parse-before-save, completion gate
```

---

## Getting Started

### Prerequisites

Node **22.19+**. Not cosmetic: `undici@8` refuses to load on older majors (`TypeError: Cannot read properties of undefined (reading 'bind')` in `zstdDecompress`), and `@modelcontextprotocol/sdk` declares `node >=22.19`. `engines` and `.node-version` pin 22; if your shell has 20, use `nvm use` first.

- **Node.js 20+** (recommended `22.x`)
- **npm**

### Installation

```bash
npm install
```

### Environment Variables (Optional)

Create a `.env` file if you want optional server-side defaults (see `.env.example`). **All provider keys and Tavily keys can be entered directly in the browser UI via Settings and stored strictly in `localStorage`.**

```env
# Optional fallback Gemini AI API key when not supplied per-request from browser settings
GEMINI_API_KEY="MY_GEMINI_API_KEY"

# Optional public URL of this app (used for OpenRouter HTTP-Referer header)
APP_URL="MY_APP_URL"
```

### Running Locally

- **Development mode** (Express + Vite middleware on port `3000`):
  ```bash
  npm run dev
  ```
- **Typecheck & Production Build**:
  ```bash
  npm run lint
  npm run build
  ```
- **Production mode** (serves compiled `dist/` via `tsx server.ts` on port `3000`):
  ```bash
  npm start
  ```

---

## Backend API Reference (`server.ts`)

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Returns `{ status: "ok", stateless: true, timeoutMs: 300000, activeTimeoutMs: 600000 }`. |
| `/api/models` | `POST` | Fetches provider catalog, filters to text-output models, and returns `{ listed, ids, publicCatalog, capabilities }`. |
| `/api/chat/stream` | `POST` | Runs cascade-ordered streaming/non-streaming completions over SSE (`application/json` or `multipart/form-data` up to 25 MB/file) with adaptive 5 min → 10 min active-stream timeout. |
| `/api/chat` | `POST` | Non-streaming cascade completion endpoint (used for Tavily model query-intent planning and direct calls). |
| `/api/chat/abort` | `POST` | Aborts an active `requestId` controller server-side to stop upstream token generation immediately. |
| `/api/upload` | `POST` | Converts up to 12 uploaded files (max 25 MB each) into base64 attachment payloads. |
| `/api/search` | `POST` | Stateless proxy to `https://api.tavily.com/search` supporting depth, result limit, and allow/block domain filters. Backs the agent's `web_search` tool. |
| `/api/fetch-url` | `POST` | Readable text of one URL for the agent's `web_fetch` tool: Tavily `extract` when a key is supplied, otherwise a plain fetch plus an HTML-to-text pass. Same request budget as `/api/search`. |

### SSE Event Types (`/api/chat/stream`)

Each chunk is emitted as `data: <JSON>\n\n`:

- `model_init`: `{ type: "model_init", model }` — active model selected from cascade.
- `thinking`: `{ type: "thinking" }` — signals reasoning phase started.
- `thought`: `{ type: "thought", text }` — incremental reasoning/thought delta.
- `chunk`: `{ type: "chunk", text }` — incremental assistant output delta.
- `fallback_notice`: `{ type: "fallback_notice", failedModel, nextModel, reason }` — cascade failed over to next model.
- `learned_capability`: `{ type: "learned_capability", model, capability }` — runtime-learned capability saved to `localStorage`.
- `model_meta`: `{ type: "model_meta", model, requestedMode, appliedSummary, retried, retryReason }` — final applied thinking/reasoning summary.
- `done`: `{ type: "done", modelUsed }` — stream completed cleanly.
- `error`: `{ type: "error", error }` — all models in the cascade failed.

---

## Client Persistence (`localStorage`)

Managed in `src/lib/storage.ts` under the following keys:

| Key | Contents |
| :--- | :--- |
| `api_keys` | Per-provider API keys + Tavily key (all empty on fresh boot). |
| `custom_providers` | Name, HTTPS base URL, and API key for `custom1` and `custom2`. |
| `provider_cascades` | Ordered arrays of model IDs per provider (all empty on fresh boot). |
| `thinking_levels` | Selected `Mode` per provider (`default` initially). |
| `model_capabilities` | Cached `live-api`, `adaptive`, and `learned-runtime` capabilities per provider/model. |
| `system_prompt` | Global system prompt string. |
| `ui_settings` | Active provider, theme colors, prose size, history limit (`5..40`), max tokens (`500..100000`), streaming toggle, and Tavily settings. |
| `chat_history` | Up to 10 most recent chat sessions (with raw binary attachment data stripped). |
| `active_chat_id` | Currently open session ID. |

---

## Request budget, timeouts, and what Stop cancels (v8)

Everything below was measured against this build, not assumed.

### How many provider requests does one Enter cost?

| action | upstream calls |
| --- | --- |
| one chat message (plain cascade, model answers directly) | **1** |
| same, but the first model in the cascade errors | **2** (one per cascade entry that fails; verified: `force-400 -> stream-8-200`) |
| one **sandbox agent task** | **1 per tool round, up to 12** (`MAX_TOOL_ROUNDS` in `src/lib/sandbox/tools.ts`) |

So a 20-requests-per-day free allowance is 20 chat messages, but only ~2–5 agent tasks: a task that
writes 3 files, runs `npm install`, starts a server and fixes an error is 6–9 calls, and the count is
paid per round whether or not the answer is long. A leg **handoff** is not a request: measured over a
stream that handed off 4 times, the upstream saw **1** call and the client received 40/40 unique
chunks with **0** duplicated tokens (the buffer replays by `_seq`, it never re-fetches).

### `max_tokens`

Still honoured everywhere, including through the proxy: `{max_tokens}` is forwarded for chat
(`server.ts:1305`, groq gets `max_completion_tokens`) and for agent turns the panel value is clamped
to `256…32000` and only sent when you actually set one (`server.ts:797-801`) — measured live, an
`8000` budget on a reasoning model returns an empty message with `finish_reason:"length"`, so the
field is respected by the provider and forwarded verbatim. Leaving the panel field empty sends
nothing and the provider default applies. That clamp is why 8 is not configurable in the panel.

### Timeouts (all in `server.ts`, verified at the source)

| knob | value | meaning |
| --- | --- | --- |
| `INITIAL_TIMEOUT_MS` | 600 000 = **10 min** | budget before the first token, then `TimeoutError` |
| `ACTIVE_TIMEOUT_MS` | 1 200 000 = **20 min** | budget once tokens are flowing (promoted by `promoteJobTimeout`) |
| `HANDOFF_LEG_MS` | 250 000, **env-overridable** | end a leg and resume (tuned for Cloud Run's 300 s, not 260 s) |
| `LEG_HARD_CAP_MS` | 280 000, **env-overridable** | force-close a leg whose browser never resumes |
| `SANDBOX_TURN_TIMEOUT_MS` | 120 000 | one agent round, deliberately short so a stalled model is an error you can retry |
| keepalive | `: keepalive` every 15 s | survives proxy idle timeouts without ending the response |

**Do not build a 10 → 20 → 30-minute handoff ladder.** Render's own limit is 100 minutes per HTTP
response (a lifetime ceiling, not idle), which already exceeds the 20-minute active cap, so extra
handoffs buy nothing; each one only re-opens a browser `fetch`. `render.yaml` now raises the legs to
25 min instead, so on Render the ladder simply never fires while staying correct on Cloud Run.

### Stop / abort

`/api/chat/abort` marks the job aborted and calls `controller.abort()` immediately, and the browser
delivers it with `keepalive: true` so it survives the tab losing focus. Measured on an 18-second
mock stream aborted at 5 s: upstream socket closed at **5012 ms** with **17 of 60** chunks delivered,
and still 17 three seconds later — generation stops with the socket, it does not drip to completion.
The client's resilience loop only ever calls `/api/chat/resume`, never re-`POST`s `/api/chat/stream`,
so a reconnect cannot double-bill either.

**v8 fix:** agent turns previously had no such path — `Panel.tsx`'s Stop aborted the browser fetch and
the loop refused further rounds, but the round already in flight kept running server-side to its end.
`/api/sandbox/turn` — and `/api/sandbox/stream` — watch `res.on('close')` and abort the provider request with it. There is no
queue in front of the provider call anywhere in this server: one user action makes the requests in the
table and nothing else waits behind it.

---

## Chat mode vs Agent mode, and the tool-call budget (v9)

The composer has a two-state toggle. **Chat** is what this app always did: one message, exactly one
provider request. **Agent** hands the message to the in-browser sandbox loop, which may call tools up
to *N* times — and **every round is another request on your key**. The budget is now a UI control
(`tool calls` in the sandbox panel, mirrored as a `≤N` chip on the toggle) instead of a constant in
`tools.ts`.

### Choosing N

| N | what it is good for | one task costs |
| --- | --- | --- |
| **1** | "make this one edit", read-only questions, or any day you are rationing a 20/day free key. The model gets one batch of tool calls and must then answer. | 1 request |
| **3–4** | small, well-specified changes: edit → run → fix once | 3–4 requests |
| **12** *(what v9 shipped with)* | "scaffold a small app": write a few files, install, start it, fix what broke | ≤12 requests |
| **24** *(default since v11)* | a real Vite project: install, 4–6 files, build, read the error, fix, rebuild — which is exactly the sequence that used to run out of budget mid-task | ≤24 requests |
| **60** *(maximum)* | big multi-file builds where you intend to walk away and come back | ≤60 requests |

The bounds are deliberate:

- **Floor 1**, not 0 — a task that may not touch the sandbox is just chat, and that mode already exists.
- **Ceiling 60**, because each round is separately capped at 120 s by `SANDBOX_TURN_TIMEOUT_MS`, so 60 rounds
  is up to two hours of live tab time, and on a 20-requests-per-day key one task at 60 is three days of quota.
  Raising it anyway is a deliberate trade: **stop** works now (it kills the command mid-run, and a run parked on
  an approval card releases immediately), and every round is visible in Activity, so the cost of a runaway is a
  button press instead of a stalled tab. That is the only reason a ceiling this loose is defensible.
- Anything out of range is clamped in `src/lib/sandbox/mode.ts` (`clampRounds`), so a hand-typed
  `999` or `0` in the box cannot hang a session.

On prior art: bolt.diy exposes no such cap at all — its project MCP bounds *per-call* output
(`MAX_LIST_RESULTS = 500`, `MAX_TEXT_BYTES = 256_000`, `MAX_PROCESSES = 50`) and lets the loop run
until the model stops emitting actions. The fixed 12 this app shipped with was already stricter; N9
just makes it yours.

### What was measured (v9, mock upstream + the real server, no tokens spent)

- Budgets **1 / 3 / 24 / 60** produced exactly **1 / 3 / 24 / 60** upstream requests against a mock
  that *never* stops asking for tools; `999` → 60, `abc`/`0`/empty → 24 (`MAX_TOOL_ROUNDS` in `tools.ts` is now
  defined as `DEFAULT_ROUNDS`, so the loop's fallback and the panel's default cannot drift apart).
- A turn truncated at `finish_reason=length` costs 1 request and prints
  `Model ran out of tokens (finish_reason=length) — raise max tokens above 2,048. The turn was not completed.`;
  with no cap passed at all the budget line says `up to 8,192 tokens per turn (server default)`.
- A model that finishes on its own after one tool call cost **3** requests at budget 12 and reported
  `used 3 of 12 tool calls`.
- In the mounted app: **chat** mode Enter → exactly one `/api/chat/stream`; **agent** mode Enter →
  zero stream calls and one task on the bus, with the user message still landing in the transcript.
- End-to-end through the proxy: budget 5 + a model that answers after 1 tool call → 2 upstream calls,
  2 proxy calls (no hidden retries), and the reply arrives back in the chat with
  `_agent · used 2 of 5 tool calls_`.
- Budget 1 against the endless model → stopped after 1 call with `Stopping: 1-tool-call limit reached`
  rendered in Activity.

Agent mode is also the only mode that can spend your quota by accident, so the chip next to the
toggle always shows what one Enter will cost before you press it.
