# FIXER PROMPT — Solara + Universa (`sol`) merge

**Goal:** Build one minimalist, full-stack AI chat app. Take **Solara's** UI/UX foundation and merge in **Universa's** multi-provider engine. The result must be stateless on the server, persist everything user-facing in `localStorage`, start with **empty** provider cascades, and support 5 built-in providers + 2 custom OpenAI-compatible providers with drag-reorderable per-provider cascades, a 4-minute stream timeout, true stream abort, file uploads to 25 MB, Tavily web search, per-model thinking levels, and editable system prompts.

You are given two source archives to inspect in full before writing code:
- **Solara** (`solara.zip`): `server.ts`, `src/App.tsx`, `src/components/MarkdownRenderer.tsx`, `src/components/SystemPromptModal.tsx`, `src/components/MiniPromptDrawer.tsx`, `src/components/AuthGateModal.tsx`, `src/components/FormulaVaultModal.tsx`, `src/components/FocusTimer.tsx`, `src/types.ts`, `package.json`.
- **Universa / `sol`** (`7b22799ea434c29912499aca3a4ef003ac145bcade4c7cd31fc57802617d7d7b.zip`): `src/lib/sol/complete.ts` (`buildPayload`), `src/lib/sol/providers.ts` (`streamCompletion`, `testConnection`, `call`), `src/lib/sol/models.ts` (`parseCatalog`, `defaultFromCatalog`), `src/lib/sol/reasoning.ts` (`reasonRule`, `reasonFields`, `modeFor`, `Mode` type), `src/lib/sol/endpoints.ts` (`apiBase`, `providerAt`, `canonicalOrEmpty`, `endpoint`), `src/lib/sol/store.ts` (zustand `localStorage` persist, `customProviders`), `src/lib/sol/custom-providers.ts` (`namedProvider`, `restoreProviders`), `src/lib/sol/tavily.ts` (`fetchSearch`, `searchBody`, `TAVILY_URL`), `src/lib/sol/types.ts` (`PROVIDERS`, `Settings`), `src/lib/sol/protocol.ts` (`Part`, `WireMessage`, `MAX_BODY`), `src/components/model-picker.tsx` (manual model slug entry), `src/routes/api/chat.ts`.

Ground every file path, component name, and API shape in those actual files. Do not guess.

---

## 1. Base codebase & UI (from Solara)

Use Solara's `server.ts` (Express + Vite SPA) and `src/App.tsx` React/TypeScript UI as the foundation. Keep:
- Dark aesthetic (`bg-black` / `#09090b` surface, zinc palette), responsive, font `Plus Jakarta Sans`.
- `src/components/MarkdownRenderer.tsx` — the heavy Markdown + KaTeX math renderer (syntax-highlighted code blocks with copy button, tables, blockquotes, collapsible thinking/reasoning block, LaTeX auto-healing). This is the core render engine; keep it intact.
- Per-message action buttons from Solara: on **assistant replies** — Read Aloud (browser `speechSynthesis` with Play/Pause/Resume/Stop), Copy as Markdown, Copy as Text; on **user queries** — Edit Query (inline edit + re-run), Copy as Markdown, Copy as Text, Read Aloud.
- Mini Prompts drawer (`MiniPromptDrawer`) in the composer textbox area — quick-insert snippets, **no subject filtering**.
- Drag-and-drop cascade card editing (Solara's `Reorder.Group` pattern) — one flex container per provider.
- Cascade export/import as JSON (Solara's `handleExportCascadeConfig` / `handleImportCascadeConfig`).
- History Limit slider behavior — sends only the selected number of most recent conversation turns to the model.
- True server-side stream abort: client `AbortController`, `POST /api/chat/abort` backup, Express `req.on('close')`/`res.on('close')`, break the cascade loop immediately so zero upstream tokens burn.
- SSE stream shape: `data: {type:'model_init'|'thinking'|'thought'|'chunk'|'fallback_notice'|'done'|'error'}`.
- File attachment handling in composer (paste, drag-drop, file picker) with preview chips and remove `×`.

---

## 2. Explicit removals (strip completely from UI, state, and backend)

Remove all of the following. Do not leave dead code, dead routes, or dead `localStorage` keys.

**From Solara:**
- **NO Vault**: no `FormulaVaultModal`, no Vault button, no pinned-items logic, no vault `localStorage`.
- **NO Subject filtering**: remove BOTH the top `Focus:` bar and the bottom `Subject:` selector, all subject-specific system directives/JEE/NCERT placeholder text, and the `SubjectType` subject field on messages (keep `role`, `text`, `timestamp`, `attachments`, `thought`, `modelUsed` only).
- **NO Usage counter / token-burn widget** (no daily quota bars, no `recordUsage`, no `applet_daily_quota`).
- **NO Sprint timer / FocusTimer**, no Play/Reset controls, no streak, no `Shift Topic / Milestone` button.
- **NO `Fresh Thread` + `Clear Chat` split buttons**: replace both with a single **New Chat** button + a **Chat History drawer/sidebar** (last 10 chats, switchable + per-chat delete).
- **NO `Directive Locked` toggle/presets**: replace with a clean editable **System Prompt** (button/modal/panel), persisted in `localStorage`.
- **NO 4-division Gemini split**: no `auto`/`flash-lite`/`flash`/`gemma`/`thinkHarder` tabs or separate Gemma provider. Every provider has **one single cascade list**.
- **NO disabled-models code**: no disabled-models tracking, filtering, blacklists, session-disabling, `Clear Disabled` button, or `disabledModels` set.
- **NO hardcoded default model lists**: no `DEFAULT_GEMINI_CASCADES`, `DEFAULT_THINKING_LEVELS`, `DEFAULT_GROQ_MODELS`, `FLASH_CASCADE`, etc. baked into client or server code.
- **NO master-password auth gate**: remove `MASTER_ACCESS_PASSWORD`, `requireServerAuth`, `AuthGateModal`, `/api/auth/verify`, `/api/auth/status`, `study_auth_token`, bearer-token checks. The app is open by default.
- **NO server disk persistence**: remove `data/` dir, `STATE_FILE`, `CASCADE_CONFIG_FILE`, `fs.writeFileSync` of keys/chats/cascades. The Express server must be **stateless** — it proxies inference and does not remember user keys, cascades, system prompts, themes, or chats.

**From Universa:** no better-auth, no pglite/postgres, no multiplayer/p2p, no TanStack Router file-route SSR stack, no relay requirement, no `relayEligible` gating, no `vercel.json` dependency. Keep the provider logic (`complete.ts`, `providers.ts`, `models.ts`, `reasoning.ts`, `tavily.ts`, `endpoints.ts`, `store.ts`, `types.ts`, `protocol.ts`) but port it into the Solara Express/Vite structure so it builds with `npm install && vite build`.

---

## 3. Providers, `getModels()`, and custom endpoints

Support **exactly 7 provider slots**: 5 built-in + up to 2 custom OpenAI-compatible. Each provider has **one cascade list** (array of model IDs), empty by default, fully editable, drag-reorderable, persisted in `localStorage`, and sent with every request so the server calls models **in that exact order**.

### Built-in provider map (base URLs from Universa `types.ts` `PROVIDERS`)

| # | Provider | Base URL | Chat endpoint | Auth header | Notes |
|---|----------|----------|---------------|-------------|-------|
| 1 | Gemini AI Studio | `https://generativelanguage.googleapis.com` | native Gen AI SDK (`@google/genai`, `v1beta`, `models.generateContentStream`) | `x-goog-api-key` / SDK `apiKey` | Native Gemini path with `thinkingConfig {thinkingLevel, includeThoughts}`. Also accept `.../v1beta/openai/chat/completions` OpenAI-compatible fallback. |
| 2 | Groq | `https://api.groq.com/openai/v1` | `/chat/completions` | `Bearer <key>` | OpenAI-compatible; `reasoning_effort` + `include_reasoning`; `max_completion_tokens`. |
| 3 | OpenRouter | `https://openrouter.ai/api/v1` | `/chat/completions` | `Bearer <key>` | `reasoning {effort, exclude}`, `provider.require_parameters`; OpenRouter model metadata. |
| 4 | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `/chat/completions` | `Bearer <key>` | `reasoning_effort` top-level OR `chat_template_kwargs {enable_thinking}` (never nested in `extra_body`); parse `delta.reasoning_content` / `delta.reasoning`. |
| 5 | Z.AI | `https://api.z.ai/api/paas/v4` | `/chat/completions` | `Bearer <key>` | GLM-5.3/FLASH: `thinking {type:"enabled"}` mandatory (never `disabled`); `reasoning_effort` low/high/max; clamp `temperature` to `(0.01, 1.0]`; parse `delta.reasoning_content`. |
| 6 | Custom #1 | user-defined | `/chat/completions` | `Bearer <key>` | OpenAI-compatible. |
| 7 | Custom #2 | user-defined | `/chat/completions` | `Bearer <key>` | OpenAI-compatible. User plans to use Arena API `https://api.arena.ai/v1` here. |

### `getModels()` for every provider (Universa's approach)

- Implement `testConnection(baseUrl, apiKey, signal)` → `GET {baseUrl}/models` → `parseCatalog(json)` → `{listed: boolean, ids: string[]}`. (Gemini: use the SDK's `models.list()` or the `/models` endpoint; strip `models/` prefix.)
- If a catalog is public/empty, still allow a manual model ID. Show `N models listed · public catalog` or "This endpoint does not expose a model list. Enter a model ID."
- Always allow **manual model slug entry** (Universa `model-picker.tsx` "Enter a model ID…") so users can add slugs not in the list.
- Refresh button per provider; sort IDs naturally (Intl.Collator numeric).
- Cache listed model IDs per provider in memory for the session; do not persist model *catalogs* (only the user's chosen cascade).

### Custom providers (2 slots)
- Form: **Provider name** (1–64 chars, distinct), **Base URL** (valid HTTPS, no creds/query/fragment), **API Key**.
- Always OpenAI-compatible `POST {baseUrl}/chat/completions`.
- Saved **only in `localStorage`** (key, endpoint, name). Never in server code, never in `.env`.
- Send `max_tokens` explicitly on every request (Arena returns `422 billing_unbounded_request` if omitted).
- Reasoning: if thinking level is `Default`, send a clean OpenAI-compatible request with no reasoning fields. If a specific effort is selected, send `reasoning_effort` only when not `Default`, then use the self-healing retry layer if the model rejects it.

---

## 4. Universal thinking configuration ("must not fail at any cost")

Implement a single `thinkingLevel` selector shared across all providers with modes: **`default | none | minimal | low | medium | high | xhigh | max`** (Universa `Mode` type). Port `reasoning.ts` rules so the app actively knows each provider's supported levels:

- **Gemini** (`reasoning.ts` `google` table): `gemini-4-hydrogen` → low/medium/high/xhigh; `gemini-2.5-flash`/`-lite` → none/minimal/low/medium/high; flashes → minimal/…; `gemini-3-pro-preview` → low/high. Map to SDK `ThinkingLevel` (`HIGH`, `XHIGH`) / thinking budget.
- **Groq**: `openai/gpt-oss-20b/120b` → low/medium/high (`groq-oss`, `include_reasoning: false`); `qwen/qwen3.8-27b` → none/low/medium/high (`groq-qwen`, `reasoning_format: "hidden"`); `qwen/qwen3-32b` → none/on; `meta-models/muse-spark-open` → …/xhigh. Clamp xhigh/max → high.
- **OpenRouter**: pass `reasoning.effort` through to the model; respect OpenRouter `reasoning` + model metadata.
- **NVIDIA NIM**: `nemotron-3-*`/`gpt-oss`/`muse*`/`mistral-large-4` → top-level `reasoning_effort`; `glm*`/`qwen3*`/`deepseek*`/`minimax*`/`gemma-4*`/`granite*` → top-level `chat_template_kwargs {enable_thinking}` (never nested); DeepSeek variants also `thinking: true/false`.
- **Z.AI**: GLM-5.3/FLASH → `thinking {type:"enabled"}` only, `reasoning_effort` low/high/max; GLM-5.2 → enabled/disabled; GLM-4.6/4.7/5/5.1 → enabled/disabled.
- **Custom (incl. Arena)**: `Default` → no reasoning fields; specific effort → `reasoning_effort` mapped to OpenAI standard, retry if rejected.

### Self-healing retry layer
If any provider returns HTTP `400` or `422` mentioning unsupported/invalid parameters (`thinking`, `thinkingConfig`, `thinking_level`, `thinking_budget`, `reasoning`, `reasoning_effort`, `reasoning_format`, `include_reasoning`, `chat_template_kwargs`, `temperature`, `top_p`, `top_k`, `max_tokens` vs `max_completion_tokens`):
1. **Do not abort.** Run up to 2 parameter-repair retries on the same model:
   - Retry 1: translate/fallback the field (Gemini: `thinkingLevel` ↔ `thinkingBudget` or clamp level; NVIDIA: `reasoning_effort` ↔ `chat_template_kwargs`; Z.AI: clamp `temperature` to `0.95`, force `thinking.type:"enabled"`; swap `max_tokens` ↔ `max_completion_tokens`; strip `temperature`/`top_p` if rejected).
   - Retry 2: strip all optional thinking/sampling params, send minimal payload (`model`, `messages`, `max_tokens`, `stream`).
2. Only advance to the next model in the cascade on `401/402/403/404/429/5xx`, network error, or timeout.

---

## 5. Streaming, 4-minute timeout, true abort, file uploads, limits

- **Timeout = 240,000 ms (4 minutes)** everywhere: client `fetch` + `AbortSignal.timeout(240000)`, Express server timeout, upstream provider `fetch` signal. Replace Universa's 60 s and any Solara implicit timeouts.
- **Max tokens**: numeric text box accepting **500–100,000** (validated/clamped, default e.g. 8192). Pass as `maxOutputTokens` (Gemini SDK), `max_tokens` / `max_completion_tokens` (OpenAI-compatible providers).
- **History Limit slider**: discrete steps **5, 10, 15, 20, 25, 30, 35, 40** (max 40). Sends only that many of the most recent conversation turns with each new query (Solara slicing behavior). Persist in `localStorage`.
- **File upload**: up to **25 MB per file** (images, PDFs, text/code, audio, documents where supported).
  - Express: `express.json({ limit: '30mb' })` AND `express.urlencoded({ limit: '30mb', extended: true })`.
  - Because base64 of a 25 MB file ≈ 33.4 MB (> 30 MB JSON limit), accept chat file uploads via **`multipart/form-data` with `multer` (25 MB file limit)** alongside JSON, or chunk/convert on the server before forwarding. A 25 MB upload must **never** produce Express `413 Payload Too Large`.
  - Client: `FileReader` data URLs for previews; strip oversized raw base64 attachment blobs before persisting old turns to `localStorage` (keep filenames/metadata) so `QuotaExceededError` never occurs.

---

## 6. Tavily web search (all providers)

Port Universa's Tavily system (`tavily.ts`, `search-settings.ts`):
- **Composer toggle**: `Web search` button in the composer toolbar.
- **Settings panel**:
  - Tavily API Key input — stored **only in `localStorage`** (never required in server `.env`).
  - Search Behavior: `Let the model decide` (quick query-intent step) OR `Always search`.
  - Search Depth: `basic`, `advanced`, `fast`, `ultra-fast`.
  - Results per call: 1–10.
  - Search Instructions, Trusted/Blocked domains, Calls-per-conversation counter/cap.
- Server-side `POST https://api.tavily.com/search` using the transient user Tavily key from the request; return cited source cards/links; inject numbered source excerpts `[1]`, `[2]` into prompt context; render citation badges in `MarkdownRenderer.tsx`.

---

## 7. `localStorage` inventory (everything user-facing)

Persist strictly in browser `localStorage`; the server touches none of it:
1. `api_keys` — API keys for all 5 built-in providers + up to 2 custom + Tavily key.
2. `custom_providers` — `{ [baseUrl]: { name, endpoint, apiKey } }` for the 2 custom slots (Universa `SavedProviders` shape).
3. `provider_cascades` — `{ [providerId]: string[] }` — exactly 5 built-in + 2 custom cascade lists. **Fresh load: all empty `[]`.**
4. `thinking_levels` — `{ [providerId]: Mode }` per provider (or per model).
5. `system_prompt` — editable system prompt string.
6. `ui_settings` — theme/accent/surface/text colors, history limit step, max tokens, streaming toggle.
7. `chat_history` — last 10 chat sessions (`[{id, title, messages[], updatedAt}]`), auto-prune beyond 10, per-chat delete; strip attachment base64 blobs before saving old turns.
8. `active_chat_id`.

On first open with empty `localStorage`: zero chats, empty composer, 5 empty cascades, no default models, no system prompt text.

---

## 8. Chat history: New Chat + last 10

- **New Chat** button: clears composer and canvas, starts a new session, pushes previous session into history drawer.
- **Chat History drawer/sidebar**: lists up to the last 10 saved chats (most recent first), click to load, trash icon to delete individual chats. Auto-prunes beyond 10.
- All chats, the API keys, custom endpoints, cascades, and system prompt saved in `localStorage` so the cloud server stays fast and light.

---

## 9. Complete minimalist UI feature checklist

Keep it clean, dark, responsive, minimalist — no clutter, yet every power feature present:

1. **Top header**: app title/logo, **New Chat** button, **Chat History** drawer button (last 10), **Quick Provider Switcher** — one horizontal flex row, **one button per provider** (Gemini / Groq / OpenRouter / NVIDIA / Z.AI / Custom 1 / Custom 2), **not stacked**, **System Prompt** edit button, **Theme/Color Customizer** (customizable UI surface + accent + text color on dark theme, persisted in `localStorage`), **Settings/Connection** button (API keys, custom providers, Tavily).
2. **Slim secondary bar** (optional/minimal): **History Limit** slider (steps 5–40), active model/cascade indicator. No Focus/Subject bar, no Sprint timer, no streak, no Vault, no token counter.
3. **Chat canvas**: `MarkdownRenderer.tsx` rendering; per-message action buttons (Read Aloud / Copy as Markdown / Copy as Text on assistant replies; Edit Query / Copy / Read Aloud on user queries); collapsible thinking/reasoning block; Tavily citation badges `[1]`, `[2]`.
4. **Bottom composer**: Attach File (25 MB) with preview chips + remove `×`; **Mini Prompts** button (no subject filtering); Streaming toggle; Thinking Level selector; Web Search toggle; **Cascades** modal button (per-provider drag-reorder + export/import); auto-expanding textarea; **Send / Stop** button (Stop = true abort).
5. **Cascades modal**: one section per provider (flex container of drag-reorderable model cards), add model by text input with manual slug, position top/end, delete card, export/import JSON. Fresh state = empty lists.

---

## 10. Required files / structure to produce

Deliver a working project in the workspace root (or a `project/` folder) with at least:
- `package.json` (React 19, TS, Vite, Express, `@google/genai`, `groq-sdk`, `express`, `marked`, `katex`, `lucide-react`, `multer`, `dotenv`, `vite`, `tsx`, `tailwindcss`; no better-auth/pglite/postgres/TanStack Router)
- `server.ts` — Express: stateless, CORS, `express.json({limit:'30mb'})`, `multer` 25 MB upload route, `POST /api/chat/stream`, `POST /api/chat`, `POST /api/chat/abort` (`{requestId}`), provider adapters (Gemini SDK, Groq, OpenRouter, NVIDIA, Z.AI, Custom ×2), Tavily search route, 240 s timeouts, cascade passed in request body and used in order, SSE stream format, abort registry.
- `src/App.tsx` — the merged UI (per checklist above).
- `src/components/MarkdownRenderer.tsx` — kept from Solara.
- `src/components/CascadeEditor.tsx` — per-provider drag-reorder lists + add/delete/export/import.
- `src/components/ProviderSwitcher.tsx` — one button per provider.
- `src/components/ChatHistoryDrawer.tsx` — last 10 chats.
- `src/components/SystemPromptEditor.tsx` — editable system prompt.
- `src/components/TavilySettings.tsx` — search settings panel.
- `src/types.ts` — `ChatMessage`, `ProviderConfig`, `CascadeConfig`, `Settings`, `Mode`, `AttachmentItem`.
- `src/lib/providers.ts` — `getModels()`/`testConnection`, `parseCatalog`, provider adapters.
- `src/lib/reasoning.ts` — per-provider thinking rules + `reasonFields`.
- `src/lib/storage.ts` — all `localStorage` read/write helpers with the exact key inventory.
- `vite.config.ts`, `tsconfig.json`, `index.html`, `src/index.css` (Tailwind).

---

## 11. Verification before finishing

1. `npm install` → `tsc --noEmit` → `npm run build` (`vite build`) with **zero** TypeScript or bundler errors.
2. Audit the code to confirm:
   - Zero Vault code, zero Subject filtering, zero Sprint/usage counter/timer code, zero disabled-models code, zero hardcoded default cascades/models, zero auth gate, zero server disk persistence of user data.
   - Fresh `localStorage` boot → empty cascades, 5 built-in + 2 custom provider slots, History Limit steps 5–40, no default models.
   - 4-minute (`240000 ms`) timeout wired client + server + upstream.
   - `30mb` Express limit + safe 25 MB `multer` upload handling; base64 safeguard.
   - True server-side upstream stream abort (`AbortController` + `/api/chat/abort` + `req.on('close')` + cascade loop break).
   - Tavily + universal `thinkingAdapter` + self-healing retry layer wired.
   - All provider base URLs, auth headers, and thinking rules match the provider table above.
3. Summarize the exact file structure created/modified and give install/run instructions (`npm install && npm run dev`).

The output should be a clean, complete, buildable codebase that an AI can generate from this prompt alone — grounded in the real Solara and Universa files, with every removal, provider, limit, and behavior stated explicitly so nothing is left to interpretation.
