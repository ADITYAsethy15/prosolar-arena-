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
- `npm install` needs the committed `package-lock.json`; it exists now, which matters because `esbuild` was
  pinned to a range that Vite 8 rejects and a lockfile-less `npm install` fails with `ERESOLVE`.

Node 22 is required (`undici@8` refuses to load on older majors; `engines` and `.node-version` pin it).

### Sandbox (files, shell, tests, previews) — in your browser tab

The terminal icon in the composer opens the **Sandbox** panel: a real Node.js runtime (WebContainers) running
inside the tab, driven by the model through four tools — `shell`, `read_file`, `write_file`, `list_dir` — with
a workspace at `/workspace` you can browse, run tests in, and preview.

- Nothing runs on the server, nothing is stored on the server, and nothing is sent anywhere except the model
  endpoint you already chose. Your API keys never enter the sandbox.
- Every `shell` command and `write_file` needs your click to run (there's an opt-in auto-approve switch, off by
  default). Reads are free.
- Commands are capped at 45 s and 100 KB of output; the agent gets 12 tool rounds per message; the path jail
  keeps every operation inside `/workspace`.
- Node.js only — no Python, no apt. `npm i` works through StackBlitz's registry proxy, so it needs a network
  connection, and files are per-session (export/import the workspace as a `.zip` to keep it).
- The workspace is an ES module (`package.json` has `"type": "module"`), so `require(...)` in a `.js` file fails.
  The agent is told to switch to `import` or a `.cjs` file, and usually self-corrects in one round.
- A command ending in `&` is left running instead of being waited on, and whatever port it opens is adopted by
  the **Preview** tab automatically — so "start the dev server and show me" works without typing a port.

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
`finish_reason=length`. The panel field defaults to 2048; 4000–8000 suits tool-calling reasoning models, and
the panel shows the tail of the model's reasoning so the failure names itself instead of looking like a hang.

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

---

## Getting Started

### Prerequisites

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
| `/api/search` | `POST` | Stateless proxy to `https://api.tavily.com/search` supporting depth, result limit, and allow/block domain filters. |

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
`/api/sandbox/turn` now watches `res.on('close')` and aborts the provider request with it. There is no
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
| **12** *(default, = the old fixed ceiling)* | "scaffold a small app": write a few files, install, start it, fix what broke | ≤12 requests |
| **30** *(maximum)* | big multi-file builds where you intend to walk away and come back | ≤30 requests |

The bounds are deliberate:

- **Floor 1**, not 0 — a task that may not touch the sandbox is just chat, and that mode already exists.
- **Ceiling 30**, because each round is separately capped at 120 s by `SANDBOX_TURN_TIMEOUT_MS`, so 30
  rounds is already up to an hour of live tab time; and on a 20-requests-per-day key, one task at 30 is
  more than a full day of quota. Past that the failure mode is a stalled tab, not a finished project.
- Anything out of range is clamped in `src/lib/sandbox/mode.ts` (`clampRounds`), so a hand-typed
  `999` or `0` in the box cannot hang a session.

On prior art: bolt.diy exposes no such cap at all — its project MCP bounds *per-call* output
(`MAX_LIST_RESULTS = 500`, `MAX_TEXT_BYTES = 256_000`, `MAX_PROCESSES = 50`) and lets the loop run
until the model stops emitting actions. The fixed 12 this app shipped with was already stricter; N9
just makes it yours.

### What was measured (v9, mock upstream + the real server, no tokens spent)

- Budgets **1 / 3 / 12 / 30** produced exactly **1 / 3 / 12 / 30** upstream requests against a mock
  that *never* stops asking for tools; `999` → 30, `abc`/`0`/empty → 12.
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
