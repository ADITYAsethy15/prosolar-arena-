# Universal AI Chat — Solara + Universa (`sol`) Merge

A minimalist, full-stack AI chat application built from the [fixer prompt](fixer-prompt.md). Combines **Solara's** UI/UX (dark theme, heavy Markdown+KaTeX renderer, drag-reorder cascade cards, read-aloud/copy/edit-message actions, mini-prompts, history-limit slider) with **Universa's** multi-provider engine (7 providers, `getModels()` catalog discovery, per-model thinking levels, Tavily web search, `localStorage` custom providers).

## Design Principles

- **100% client-side persistence** — API keys, custom endpoints, cascades, system prompts, themes, and chat history all live in `localStorage`. The server is stateless.
- **Empty cascades by default** — no hardcoded default models. On first load, all 5 built-in + 2 custom provider cascades are `[]`.
- **One cascade list per provider** — no 4-way Gemini split. Drag-reorderable model cards, fully editable.
- **4-minute stream timeout** (240,000 ms) with true server-side abort.
- **File uploads up to 25 MB** with Express `30 MB` body limit + multipart safeguard.
- **No vault, no subject filters, no sprint timer, no usage counter, no auth gate.**

## Provider Map

| Provider | Base URL | Auth | Notes |
|---|---|---|---|
| Gemini AI Studio | `generativelanguage.googleapis.com` | `x-goog-api-key` | Native Gen AI SDK, `thinkingConfig` |
| Groq | `api.groq.com/openai/v1` | `Bearer` | `reasoning_effort` + `include_reasoning` |
| OpenRouter | `openrouter.ai/api/v1` | `Bearer` | `reasoning {effort, exclude}` |
| NVIDIA NIM | `integrate.api.nvidia.com/v1` | `Bearer` | `reasoning_effort` or `chat_template_kwargs` |
| Z.AI | `api.z.ai/api/paas/v4` | `Bearer` | `thinking {type:"enabled"}` mandatory |
| Custom 1 | user-defined | `Bearer` | OpenAI-compatible (e.g. Arena `api.arena.ai/v1`) |
| Custom 2 | user-defined | `Bearer` | OpenAI-compatible |

## Local Development

```bash
cd project
npm install
npm run dev          # Vite dev server on :5173
npm run build        # Vite production build -> dist/
npm run preview      # Preview production build
npm run typecheck    # tsc --noEmit
```

The frontend calls `POST /api/chat` for streaming. In development, the Vite server proxies or you run the API separately.

## Deploy on Vercel

1. Push this folder to a GitHub repository.
2. Import the repo in [vercel.com](https://vercel.com).
3. Vercel auto-detects the Vite build and the `/api/*` serverless functions.
4. Add any environment variables if needed (none required by default — all keys are client-side `localStorage`).
5. Deploy.

### Vercel Notes

- **Streaming timeout**: Vercel Hobby tier limits serverless functions to ~10s; Pro tier to ~60s. The 4-minute (240s) timeout in the code requires Vercel Pro+ or Enterprise. On lower tiers, streams may be cut early — the client handles this gracefully with a fallback error message.
- **File upload limit**: Vercel serverless functions have a ~4.5 MB (Hobby) request body limit. For 25 MB file uploads, use a Vercel Pro plan or upload files directly to a storage provider from the client.
- **CORS**: The API route accepts same-origin requests. If you call it from a different domain, add CORS headers in `api/chat.ts`.

## Project Structure

```
project/
├── api/
│   ├── chat.ts          # Vercel serverless: streaming chat proxy
│   └── _stream.ts       # SSE stream processing + 4-min timeout
├── src/
│   ├── main.tsx         # Entry point
│   ├── index.css        # Tailwind + custom styles
│   ├── App.tsx          # Main app (state, chat flow, SSE client)
│   ├── types.ts         # Type definitions + provider map
│   ├── lib/
│   │   ├── storage.ts   # localStorage persistence layer
│   │   ├── providers.ts # Provider config + payload building
│   │   ├── reasoning.ts # Per-provider thinking rules + self-healing retries
│   │   └── search.ts    # Tavily web search
│   └── components/
│       ├── ChatCanvas.tsx
│       ├── Composer.tsx
│       ├── CascadeEditor.tsx
│       ├── ChatHistoryDrawer.tsx
│       ├── SystemPromptEditor.tsx
│       ├── TavilySettings.tsx
│       ├── SettingsPanel.tsx
│       ├── ProviderSwitcher.tsx
│       ├── MarkdownRenderer.tsx
│       ├── MessageBubble.tsx
│       └── MiniPromptDrawer.tsx
├── vercel.json          # Vercel deployment config
├── vite.config.ts       # Vite config
├── tailwind.config.js   # Tailwind CSS
├── package.json
└── README.md
```

## License

MIT
