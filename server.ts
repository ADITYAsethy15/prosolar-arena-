import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import type { Mode, ModelCapability, ProviderId } from './src/types';
import {
  buildGeminiThinkingAttempts,
  buildLearnedCapability,
  describeAppliedOpenAIThinking,
  reasonFields,
  reasonRule,
  type OpenAIReasoningFields,
} from './src/lib/reasoning';
import {
  compareModelIds,
  extractModelCapability,
  isTextOutputModel,
} from './src/lib/providers';

dotenv.config();

const INITIAL_TIMEOUT_MS = 600_000; // 10 min before first token
const ACTIVE_TIMEOUT_MS = 1_200_000; // 20 min once streaming starts
const HANDOFF_LEG_MS =
  Number(process.env.HANDOFF_LEG_MS) > 0 ? Number(process.env.HANDOFF_LEG_MS) : 250_000; // Hand off 50s before Cloud Run's 300s cap
const LEG_HARD_CAP_MS =
  Number(process.env.LEG_HARD_CAP_MS) > 0 ? Number(process.env.LEG_HARD_CAP_MS) : 280_000; // Force-close old leg cleanly before 300s
const JOB_RETENTION_MS = 60_000; // Retain finished job 60s for late resume replay
const DISCONNECT_GRACE_MS = 15_000; // 15s grace window for brief network drops
// The resume buffer exists so a handoff can replay missed bytes; it is otherwise pure RAM.
// Measured on this build: 3012 buffered events cost 2.4MB (~800B each), so an unbounded buffer
// would park ~25MB per stream for a 20-minute max-length answer. Env-overridable so the trim
// path can be exercised with a tiny value instead of trusting it.
const MAX_REPLAY_EVENTS =
  Number(process.env.MAX_REPLAY_EVENTS) > 0 ? Number(process.env.MAX_REPLAY_EVENTS) : 12_000;
const REQUEST_TIMEOUT_MS = INITIAL_TIMEOUT_MS;
const ACTIVE_STREAM_TIMEOUT_MS = ACTIVE_TIMEOUT_MS;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per file
const TAVILY_URL = 'https://api.tavily.com/search';

const longFetchAgent = new Agent({
  connectTimeout: 30_000,
  headersTimeout: ACTIVE_TIMEOUT_MS,
  bodyTimeout: ACTIVE_TIMEOUT_MS,
  keepAliveTimeout: 60_000,
});
setGlobalDispatcher(longFetchAgent);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProd = process.env.NODE_ENV === 'production';

// Stateless CORS + Body limits (30 MB JSON + 25 MB binary multipart)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// ============================================================================
// 🔒 SOLARA PASSWORD GATE
// Visitors without the cookie get a tiny password page; correct password
// sets a 7-day HttpOnly cookie; /api/* without it gets 401 JSON.
// Change PW to rotate the password (change KEY too). No client code changes.
// ============================================================================
const PW = 'agentsol';
const KEY = 'f7471b0f3d5d529a25174e24bcdd4833'; // random cookie value, moves with PW (deliberately NOT the password)

// Whitespace-normalized copies used for the actual comparisons. The password
// check trims user input, so an untrimmed PW/KEY with a stray trailing space
// (exactly what the placeholder above has) makes the gate impossible to open,
// and a cookie value containing a space is invalid and gets dropped by browsers.
const PW_EXPECT = PW.trim();
const COOKIE_VALUE = KEY.trim();

if (PW_EXPECT === 'change this' || COOKIE_VALUE === 'change this too' || !PW_EXPECT) {
  console.warn(
    '[Solara] \u26a0 Password gate is using placeholder values. Set PW and KEY in server.ts ' +
      'before trusting this deploy \u2014 the repo is public, so the current password is readable there.',
  );
}

// Liveness probe for platform health checks (Render, etc.). Deliberately registered
// before the gate below: a health check that answers 401 makes Render declare the
// service unhealthy and restart-loop a perfectly fine app. It exposes no secrets and
// no data — just 'alive'.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, gated: true });
});

app.use((req, res, next) => {
  if (req.path === '/api/unlock' && req.method === 'POST') {
    const pw = String((req.body as any || {}).password || '').trim();
    if (pw && pw === PW_EXPECT) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
      const isHttps = req.secure || forwardedProto.includes('https');
      const cookieAttrs = isHttps
        ? 'Path=/; Max-Age=604800; HttpOnly; SameSite=None; Secure; Partitioned'
        : 'Path=/; Max-Age=604800; HttpOnly; SameSite=Lax';
      res.setHeader('Set-Cookie', `solara_key=${COOKIE_VALUE}; ${cookieAttrs}`);
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false });
  }
  if (String(req.headers.cookie || '').includes('solara_key=' + COOKIE_VALUE)) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ requiresPassword: true });
  res.status(401).type('html').send(
    '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Solara</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif}div{padding:24px;border:1px solid #27272a;border-radius:14px;background:#18181b;width:min(90vw,340px)}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #3f3f46;background:#09090b;color:#fff;font-size:15px}button{margin-top:10px;width:100%;padding:10px;border:0;border-radius:8px;background:#0891b2;color:#fff;font-size:14px;cursor:pointer}p{font-size:12px;color:#71717a}a{color:#22d3ee}</style></head><body><div><b>🔒 This Solara is private</b><p>Enter the access password to continue</p><input id="p" type="password" placeholder="password" autofocus><button type="button" onclick="k()">Enter</button><p id="e"></p></div><script>async function k(){var e=document.getElementById("e"),p=document.getElementById("p");e.textContent="";var r=await fetch("/api/unlock",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({password:p.value})});if(!r.ok){e.textContent="Wrong password";return}var h=await fetch("/api/health",{credentials:"same-origin",cache:"no-store"});if(h.ok){location.reload()}else{e.innerHTML="Browser blocked cookies in this embedded preview. <a href=\\""+location.href+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">Open Solara in a new tab</a> to unlock."}}document.getElementById("p").onkeydown=function(x){if(x.key==="Enter")k()}</script></body></html>'
  );
});

// ============================================================================
// CROSS-ORIGIN ISOLATION (required by the in-browser sandbox)
// WebContainers need SharedArrayBuffer, which needs COOP+COEP on the top-level
// document. 'credentialless' (not 'require-corp') so cross-origin subresources
// that send no CORP header still load. Applied to every non-/api response: only
// the document strictly needs it, but path-matching the document is exactly the
// kind of cleverness that silently disables the sandbox. index.html is also
// marked no-cache so a header fix lands on the next reload instead of after a
// hard-clears-everything afternoon.
// Sits AFTER the password gate on purpose: unauthenticated visitors should not
// get isolation headers for a page they cannot use.
// ============================================================================
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Vary', 'Accept');
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 12,
  },
});

// In-memory registry of active abort controllers for true upstream cancellation
const activeRequests = new Map<string, AbortController>();

interface AttachmentInput {
  id?: string;
  name: string;
  mimeType: string;
  data?: string; // base64 without data: prefix
  size?: number;
}

interface MessageInput {
  role: 'user' | 'model' | 'assistant' | 'system';
  text?: string;
  content?: string;
  attachments?: AttachmentInput[];
}

const BUILTIN_BASE_URLS: Record<'gemini' | 'groq' | 'openrouter' | 'nvidia' | 'zai', string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  zai: 'https://api.z.ai/api/paas/v4',
};

function canonicalBase(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '';
  const u = new URL(text);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('Invalid provider base URL.');
  }
  const p = u.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/, '')
    .replace(/\/+$/, '');
  return u.origin + p;
}

function resolveEffectiveBaseUrl(providerId: ProviderId, rawBaseUrl?: string): string {
  if (providerId === 'custom1' || providerId === 'custom2') {
    return canonicalBase(rawBaseUrl || '');
  }
  if (rawBaseUrl && rawBaseUrl.trim()) {
    try {
      return canonicalBase(rawBaseUrl);
    } catch {
      return BUILTIN_BASE_URLS[providerId];
    }
  }
  return BUILTIN_BASE_URLS[providerId];
}

function resolveEffectiveKey(providerId: ProviderId, reqKey?: string): string {
  const trimmed = (reqKey || '').trim();
  if (trimmed) return trimmed;
  if (providerId === 'gemini') return (process.env.GEMINI_API_KEY || '').trim();
  return '';
}

function isTextMime(mime: string, name: string): boolean {
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m.startsWith('text/')) return true;
  if (
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/javascript' ||
    m === 'application/typescript'
  ) {
    return true;
  }
  return /\.(txt|md|markdown|csv|tsv|json|log|py|js|ts|tsx|jsx|html|css|yml|yaml|xml|sql|sh|c|cpp|h|java|rs|go)$/i.test(
    n
  );
}

function extractErrorMessage(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw);
    const msg =
      typeof parsed?.error === 'string'
        ? parsed.error
        : parsed?.error?.message || parsed?.message || parsed?.detail;
    if (typeof msg === 'string' && msg.trim()) {
      return msg.trim().slice(0, 500);
    }
  } catch {
    // Plain text error
  }
  const clean = (raw || '').trim();
  if (!clean || /^\s*[<{]/.test(clean)) {
    return `Upstream returned HTTP ${status}`;
  }
  return clean.slice(0, 350);
}

const MODEL_ERROR_REGEX =
  /(unsupported_model|model_not_allowed|missing_model|model_not_found|does not exist|not enabled for your workspace|no such model|unknown model|invalid model|model .* not found|permission denied|insufficient_quota|rate limit|billing_unbounded|billing)/i;

const SYSTEM_INSTRUCTION_UNSUPPORTED_REGEX =
  /(developer instruction is not enabled|system[_ ]instruction|system role is not supported|developer role is not supported)/i;

const URL_CONTEXT_ERROR_REGEX = /(url_context|urlcontext|tools|tool_use)/i;

const PARAMETER_ERROR_REGEX =
  /(thinking|thinkingconfig|thinking_level|reasoning|reasoning_effort|reasoning_format|include_reasoning|chat_template_kwargs|temperature|top_p|top_k|max_tokens|max_completion_tokens|developer instruction|system[_ ]instruction|url_context|urlcontext|tools|tool_use|provider|extra_forbidden|additional properties|unrecognized|unsupported parameter|unknown field|invalid value|cannot be used with|not supported for this model|invalid argument|invalid)/i;

function isParameterRejection(status: number, message: string): boolean {
  if ([401, 402, 403, 429].includes(status)) return false;
  const m = (message || '').toLowerCase();
  // Model-level / auth / billing / quota errors must fail over to next cascade model immediately
  if (MODEL_ERROR_REGEX.test(m)) return false;

  const isParamStatus =
    status === 400 ||
    status === 422 ||
    (status === 404 && /(endpoint|parameter|reasoning)/i.test(m));
  if (!isParamStatus) return false;

  return PARAMETER_ERROR_REGEX.test(m);
}

// ============================================================================
// Message Formatting (Gemini SDK vs OpenAI-Compatible)
// ============================================================================
function sliceHistory(messages: MessageInput[], historyLimit?: number): MessageInput[] {
  const limit =
    typeof historyLimit === 'number' && historyLimit >= 5 && historyLimit <= 40
      ? Math.round(historyLimit)
      : 10;
  return messages.length > limit ? messages.slice(-limit) : messages;
}

function formatMessagesForGemini(
  messages: MessageInput[],
  historyLimit?: number,
  systemPrompt?: string,
  isGemma = false
) {
  const recent = sliceHistory(messages, historyLimit);
  const contents: any[] = [];

  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (m.role === 'system') continue;
    const role = m.role === 'model' || m.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [];

    const text = (m.text ?? m.content ?? '').trim();
    if (isGemma && i === 0 && role === 'user' && systemPrompt && systemPrompt.trim()) {
      parts.push({ text: `[System Instructions: ${systemPrompt.trim()}]\n\n` });
    }

    if (m.attachments && m.attachments.length > 0) {
      for (const att of m.attachments) {
        if (!att.data) continue;
        const attMime = (att.mimeType || '').toLowerCase();
        if (attMime === 'application/zip' || attMime === 'application/x-zip-compressed') {
          parts.push({
            text: `\n[Unsupported raw ZIP attachment: ${att.name} (${Math.round((att.size || 0) / 1024)} KB)]\n`,
          });
        } else if (isTextMime(att.mimeType, att.name)) {
          try {
            const decoded = Buffer.from(att.data, 'base64').toString('utf8');
            parts.push({
              text: `\n[Attached File: ${att.name}]\n\`\`\`\n${decoded.slice(0, 1_600_000)}\n\`\`\`\n`,
            });
          } catch {
            parts.push({
              inlineData: {
                mimeType: att.mimeType || 'text/plain',
                data: att.data,
              },
            });
          }
        } else {
          parts.push({
            inlineData: {
              mimeType: att.mimeType || 'application/octet-stream',
              data: att.data,
            },
          });
        }
      }
    }

    if (text) {
      parts.push({ text });
    }
    if (parts.length === 0) {
      parts.push({ text: ' ' });
    }
    contents.push({ role, parts });
  }

  return contents;
}

function formatMessagesForOpenAI(
  providerId: ProviderId,
  messages: MessageInput[],
  historyLimit?: number,
  systemPrompt?: string
) {
  const recent = sliceHistory(messages, historyLimit);
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [];

  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt.trim() });
  }

  let hasPdf = false;
  for (const m of recent) {
    if (m.role === 'system') continue;
    const role: 'user' | 'assistant' =
      m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user';
    const rawText = m.text ?? m.content ?? '';

    if (role === 'user' && m.attachments && m.attachments.length > 0) {
      const contentParts: any[] = [];
      let textAccum = rawText;

      for (const att of m.attachments) {
        if (!att.data) continue;
        const mime = (att.mimeType || '').toLowerCase();
        if (mime.startsWith('image/')) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${att.data}` },
          });
        } else if (mime === 'application/pdf' || att.name.toLowerCase().endsWith('.pdf')) {
          if (providerId === 'openrouter') {
            hasPdf = true;
            contentParts.push({
              type: 'file',
              file: {
                filename: att.name,
                file_data: `data:application/pdf;base64,${att.data}`,
              },
            });
          } else {
            textAccum += `\n\n[Attached PDF: ${att.name} (${Math.round((att.size || 0) / 1024)} KB) — Note: Native PDF binary parsing on OpenAI-compatible endpoints requires OpenRouter or Gemini AI Studio.]`;
          }
        } else if (isTextMime(mime, att.name)) {
          try {
            const decoded = Buffer.from(att.data, 'base64').toString('utf8');
            textAccum += `\n\n[Attached File: ${att.name}]\n\`\`\`\n${decoded.slice(0, 1_600_000)}\n\`\`\``;
          } catch {
            textAccum += `\n\n[Attached File: ${att.name}]`;
          }
        } else {
          textAccum += `\n\n[Attached File: ${att.name} (${mime || 'binary'})]`;
        }
      }

      if (contentParts.length > 0) {
        contentParts.unshift({ type: 'text', text: textAccum || ' ' });
        out.push({ role, content: contentParts });
      } else {
        out.push({ role, content: textAccum || ' ' });
      }
    } else {
      out.push({ role, content: rawText || ' ' });
    }
  }

  return { messages: out, hasPdf };
}

// ============================================================================
// Health, Upload & Stream Resume / Abort Routes
// ============================================================================
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    stateless: true,
    timeoutMs: INITIAL_TIMEOUT_MS,
    activeTimeoutMs: ACTIVE_TIMEOUT_MS,
  });
});

app.post('/api/upload', upload.array('files', 12), (req, res) => {
  const uploaded = (req.files as Express.Multer.File[] | undefined) || [];
  const files = uploaded.map((f) => ({
    name: f.originalname,
    mimeType: f.mimetype || 'application/octet-stream',
    size: f.size,
    data: f.buffer.toString('base64'),
  }));
  res.json({ files });
});

interface StoredSseEvent {
  seq: number;
  payload: Record<string, unknown>;
}

interface StreamJob {
  jobId: string;
  controller: AbortController;
  events: StoredSseEvent[];
  nextSeq: number;
  lastSeq: number;
  lastSentSeq: number;
  writer: express.Response | null;
  finished: boolean;
  aborted: boolean;
  startedAt: number;
  promotedToActive: boolean;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  legTimer: ReturnType<typeof setTimeout> | null;
  hardCloseTimer: ReturnType<typeof setTimeout> | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  jobTimeoutTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const activeJobs = new Map<string, StreamJob>();

function clearWriterTimers(job: StreamJob): void {
  if (job.keepaliveTimer) {
    clearInterval(job.keepaliveTimer);
    job.keepaliveTimer = null;
  }
  if (job.legTimer) {
    clearTimeout(job.legTimer);
    job.legTimer = null;
  }
  if (job.hardCloseTimer) {
    clearTimeout(job.hardCloseTimer);
    job.hardCloseTimer = null;
  }
}

function emitJobEvent(job: StreamJob, payload: Record<string, unknown>): void {
  const seq = job.nextSeq++;
  job.lastSeq = seq;
  const eventPayload = { ...payload, _seq: seq };
  job.events.push({ seq, payload: eventPayload });
  // Drop only from the front, and only events some writer has already been handed, so a client
  // that is still connected (or reconnecting) never loses bytes it has not received. Gaps are
  // safe by construction: the reader dedupes on _seq and keeps appending.
  if (job.events.length > MAX_REPLAY_EVENTS && job.events[0].seq < job.lastSentSeq) {
    job.events.splice(0, job.events.length - MAX_REPLAY_EVENTS);
  }
  if (job.writer && !job.writer.writableEnded && !job.writer.destroyed) {
    job.writer.write(`data: ${JSON.stringify(eventPayload)}\n\n`);
    job.lastSentSeq = seq;
  }
}

function finishJob(job: StreamJob): void {
  if (job.finished) return;
  job.finished = true;
  if (job.jobTimeoutTimer) {
    clearTimeout(job.jobTimeoutTimer);
    job.jobTimeoutTimer = null;
  }
  if (job.disconnectTimer) {
    clearTimeout(job.disconnectTimer);
    job.disconnectTimer = null;
  }
  clearWriterTimers(job);
  if (job.writer && !job.writer.writableEnded && !job.writer.destroyed) {
    job.writer.end();
  }
  job.writer = null;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    if (activeJobs.get(job.jobId) === job) {
      activeJobs.delete(job.jobId);
    }
  }, JOB_RETENTION_MS);
}

function failJobOnTimeout(job: StreamJob, message: string): void {
  if (job.finished) return;
  emitJobEvent(job, { type: 'error', error: message });
  finishJob(job);
  job.controller.abort(new DOMException(message, 'TimeoutError'));
}

function promoteJobTimeout(job: StreamJob): void {
  if (job.promotedToActive || job.finished || job.controller.signal.aborted) return;
  job.promotedToActive = true;
  if (job.jobTimeoutTimer) {
    clearTimeout(job.jobTimeoutTimer);
    job.jobTimeoutTimer = null;
  }
  const remaining = Math.max(1000, ACTIVE_TIMEOUT_MS - (Date.now() - job.startedAt));
  job.jobTimeoutTimer = setTimeout(() => {
    failJobOnTimeout(job, 'Upstream model timed out after 20 minutes.');
  }, remaining);
}

function attachWriter(
  job: StreamJob,
  req: express.Request,
  res: express.Response,
  skipHeaders = false
): void {
  if (!skipHeaders) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  req.setTimeout(LEG_HARD_CAP_MS + 15_000);
  res.setTimeout(LEG_HARD_CAP_MS + 15_000);

  if (job.disconnectTimer) {
    clearTimeout(job.disconnectTimer);
    job.disconnectTimer = null;
  }
  clearWriterTimers(job);
  job.writer = res;

  job.keepaliveTimer = setInterval(() => {
    if (job.writer === res && !res.writableEnded && !res.destroyed) {
      res.write(': keepalive\n\n');
    }
  }, 15_000);

  job.legTimer = setTimeout(() => {
    if (!job.finished && job.writer === res && !res.writableEnded && !res.destroyed) {
      res.write(
        `data: ${JSON.stringify({
          type: 'handoff',
          jobId: job.jobId,
          afterSeq: job.lastSeq,
        })}\n\n`
      );
    }
  }, HANDOFF_LEG_MS);

  job.hardCloseTimer = setTimeout(() => {
    if (job.writer === res && !res.writableEnded && !res.destroyed) {
      (res as any).__handedOff = true;
      clearWriterTimers(job);
      job.writer = null;
      res.end();
      if (!job.finished && !job.disconnectTimer) {
        job.disconnectTimer = setTimeout(() => {
          job.disconnectTimer = null;
          if (!job.finished && !job.writer) {
            job.aborted = true;
            job.controller.abort(new Error('Client failed to resume after handoff'));
            finishJob(job);
          }
        }, DISCONNECT_GRACE_MS);
      }
    }
  }, LEG_HARD_CAP_MS);

  res.on('close', () => {
    if (job.writer === res) {
      clearWriterTimers(job);
      job.writer = null;
    }
    if ((res as any).__handedOff || job.finished || job.aborted || job.writer !== null) {
      return;
    }
    if (!job.disconnectTimer) {
      job.disconnectTimer = setTimeout(() => {
        job.disconnectTimer = null;
        if (!job.finished && !job.writer) {
          job.aborted = true;
          job.controller.abort(new Error('Client disconnected'));
          finishJob(job);
        }
      }, DISCONNECT_GRACE_MS);
    }
  });
}

// ============================================================================
// Seamless Overlap SSE Resume Endpoint
// ============================================================================
app.get('/api/chat/resume', (req, res) => {
  const jobId = typeof req.query.jobId === 'string' ? req.query.jobId.trim() : '';
  const afterSeq = Math.max(0, Number(req.query.afterSeq || 0) || 0);
  const job = jobId ? activeJobs.get(jobId) : undefined;

  if (!job) {
    return res.status(404).json({ error: 'Stream session expired.' });
  }

  // Immediately flush SSE headers + keepalive comment byte so reverse proxies commit the stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  if (!res.writableEnded && !res.destroyed) {
    res.write(': resume-ok\n\n');
  }

  // Replay any missed events before attaching the live writer
  let maxReplayedSeq = job.lastSentSeq;
  for (const ev of job.events) {
    if (ev.seq > afterSeq && !res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(ev.payload)}\n\n`);
      if (ev.seq > maxReplayedSeq) {
        maxReplayedSeq = ev.seq;
      }
    }
  }
  job.lastSentSeq = Math.max(job.lastSentSeq, maxReplayedSeq);

  const prevWriter = job.writer;
  if (prevWriter && prevWriter !== res) {
    (prevWriter as any).__handedOff = true;
    clearWriterTimers(job);
  }

  if (job.finished) {
    if (prevWriter && prevWriter !== res && !prevWriter.writableEnded && !prevWriter.destroyed) {
      prevWriter.end();
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    return;
  }

  // Swap writer to new connection BEFORE closing previous leg (0ms gap)
  attachWriter(job, req, res, true);

  if (prevWriter && prevWriter !== res && !prevWriter.writableEnded && !prevWriter.destroyed) {
    prevWriter.end();
  }
});

// ============================================================================
// Instant True Stream Abort Endpoint (0ms delay)
// ============================================================================
app.post('/api/chat/abort', (req, res) => {
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
  let aborted = false;

  if (requestId && activeJobs.has(requestId)) {
    const job = activeJobs.get(requestId)!;
    job.aborted = true;
    aborted = true;
    job.controller.abort(new Error('User aborted request'));
    finishJob(job);
  }

  if (requestId && activeRequests.has(requestId)) {
    const ctrl = activeRequests.get(requestId)!;
    ctrl.abort(new Error('User aborted request'));
    activeRequests.delete(requestId);
    aborted = true;
  }

  return res.json({ aborted, requestId });
});

// ============================================================================
// Models Discovery Route (Text-Output Filtering + Live Capabilities)
// ============================================================================
// ============================================================================
// SANDBOX TURN — verbatim OpenAI-compatible passthrough for tool-calling turns.
// Deliberately NOT reusing /api/chat: that route rebuilds the payload from
// whitelisted fields and coerces every role to user|assistant, which destroys
// assistant.tool_calls and role:'tool' results. This route forwards an exact
// body and returns the assistant message untouched, so the tool loop works
// without a single change to the text-chat path. The password gate already covers
// /api*, and baseUrl is restricted to https, so this adds no new unauthenticated
// reach. Nothing here is logged: apiKey never appears in a console call.
// ============================================================================
const SANDBOX_TURN_TIMEOUT_MS = 120_000;

// Some providers answer HTTP 200 with an apology inside message.content once a free quota
// is gone (observed live: "accounts that have not been recharged can only try 10 times",
// 0 completion tokens). Passed through unchanged, that becomes the agent's final answer.
// Only short, whole-message matches count, so a real reply that mentions a quota is safe.
function detectSoftError(json: any): string | null {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return null;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return null;
  const text = typeof msg.content === "string" ? msg.content.trim() : "";
  if (!text || text.length > 400) return null;
  const patterns = [
    /can only try \d+ times/i,
    /quota\s*(?:exceeded|exhausted|reached|used up)/i,
    /insufficient\s*(?:credit|balance|funds|quota)/i,
    /not been recharged/i,
    /credits?\s*(?:required|needed|exhausted)/i,
    /add credits/i,
    /paid model/i,
    /free\s*(?:tier|trial)[\s\S]{0,40}?(?:limit|exhausted|expired)/i,
    /account[\s\S]{0,30}?(?:suspended|disabled|blocked)/i,
  ];
  for (const p of patterns) if (p.test(text)) return text.slice(0, 240);
  return null;
}

app.post('/api/sandbox/turn', async (req, res) => {
  // Deliberately NOT INITIAL_TIMEOUT_MS (10 min): an agent turn is interactive, and a
  // provider that accepts the connection then stalls should surface as an error the user
  // can act on long before a browser tab looks permanently busy.
  req.setTimeout(SANDBOX_TURN_TIMEOUT_MS);
  res.setTimeout(SANDBOX_TURN_TIMEOUT_MS);

  const body = (req.body || {}) as Record<string, unknown>;
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || '').trim();
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]).slice(0, 64) : [];
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).slice(0, 16) : undefined;

  // https everywhere, except loopback: local model servers (Ollama, LM Studio) speak plain
  // http on 127.0.0.1, and refusing those would only teach users to disable TLS checking
  // globally. Remote http stays rejected.
  let turnHost = '';
  try {
    turnHost = new URL(baseUrl).hostname;
  } catch {
    turnHost = '';
  }
  const loopback = turnHost === 'localhost' || turnHost === '127.0.0.1' || turnHost === '[::1]';
  if (!/^https:\/\//i.test(baseUrl) && !(loopback && /^http:\/\//i.test(baseUrl))) {
    return res
      .status(400)
      .json({ error: 'baseUrl must be an https URL (http is allowed only for localhost)' });
  }
  if (!apiKey || !model || messages.length === 0) {
    return res.status(400).json({ error: 'apiKey, model and messages are required' });
  }

  // Only send max_tokens when the caller asked for it. Measured against a live
  // OpenAI-compatible proxy: with max_tokens=8000 a reasoning model burned the
  // whole budget and returned an empty message (finish_reason=length), 16000
  // returned nothing at all, and omitting the field produced a correct tool call
  // in seconds. This route's job is to forward faithfully, so an unspecified
  // budget stays unspecified and the provider's own default applies.
  const requestedMaxTokens = Number(body.maxTokens);
  const maxTokens =
    Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? Math.max(256, Math.min(32_000, Math.round(requestedMaxTokens)))
      : undefined;
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), SANDBOX_TURN_TIMEOUT_MS);

  // Stop-button parity with the streaming route. Panel.tsx:676 aborts the browser fetch and
  // tools.ts:271 refuses to start another round once its signal is set, but until now nothing
  // told the *in-flight* provider request to stop: the round already sent kept generating to
  // its end (up to 120s) for an answer nobody would read, billed to the user's key. A torn-down
  // socket is the only signal the server gets, so forward it upstream.
  const onClientGone = () => {
    controller.abort(new Error('Client disconnected mid-turn'));
  };
  res.on('close', onClientGone);

  try {
    const upstream = await undiciFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(tools ? { tools, tool_choice: body.toolChoice === 'none' ? 'none' : 'auto' } : {}),
      }),
      signal: controller.signal as any,
      dispatcher: longFetchAgent,
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      // A typo'd model id on some gateways is a BILLING error, not a 404: Kilo answers
      // 402 "Paid Model - Credits Required" for any model the account can't use free,
      // which reads as "you owe money" unless the real cause is named.
      const paidForUnknown = upstream.status === 402 && /paid model|credits/i.test(raw);
      return res.status(upstream.status).json({
        error: paidForUnknown
          ? `that model id is not available free on this account (HTTP 402 from provider) — Kilo free models end in ":free", or use "kilo-auto/free". Provider said: ${raw.slice(0, 240)}`
          : `upstream ${upstream.status}: ${raw.slice(0, 600)}`,
      });
    }

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: 'upstream returned non-JSON' });
    }

    const softError = detectSoftError(json);
    if (softError) {
      return res.status(429).json({ error: `provider refused: ${softError}` });
    }

    const choice = json?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      return res.status(502).json({ error: 'upstream returned no assistant message' });
    }
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((part: any) => part?.text ?? '').join('')
          : '';
    // Reasoning models bill thinking tokens before they write anything, so a turn can
    // come back with content '' and finish_reason=length (measured live on two providers).
    // The field name is provider-specific — AIHubMix uses reasoning_content, Kilo uses
    // reasoning plus a reasoning_details[] array — so read all three and keep the first
    // non-empty one. Forwarding it turns a mysterious blank turn into a diagnosable one.
    const reasoningCandidates: unknown[] = [
      msg.reasoning_content,
      msg.reasoning,
      ...(Array.isArray(msg.reasoning_details) ? msg.reasoning_details : []),
    ];
    const reasoningContent =
      reasoningCandidates
        .map((v: any) => (typeof v === 'string' ? v : typeof v?.text === 'string' ? v.text : ''))
        .find((v: string) => v.trim()) ?? '';

    return res.json({
      ok: true,
      message: {
        role: 'assistant',
        content,
        ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length
          ? { tool_calls: msg.tool_calls.slice(0, 8) }
          : {}),
      },
      ...(reasoningContent ? { reasoningContent: reasoningContent.slice(0, 20_000) } : {}),
      usage: json?.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({
        error: `sandbox turn timed out after ${Math.round(SANDBOX_TURN_TIMEOUT_MS / 1000)}s — the provider accepted the request but stopped responding. Wait a moment and retry.`,
      });
    }
    return res.status(502).json({ error: String(err?.message ?? err) });
  } finally {
    clearTimeout(killer);
    res.off('close', onClientGone);
  }
});

app.post('/api/models', async (req, res) => {
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS);

  const { providerId, baseUrl: rawBaseUrl, apiKey: rawApiKey } = req.body as {
    providerId: ProviderId;
    baseUrl?: string;
    apiKey?: string;
  };

  if (!providerId) {
    return res.status(400).json({ error: 'providerId is required.' });
  }

  let baseUrl = '';
  try {
    baseUrl = resolveEffectiveBaseUrl(providerId, rawBaseUrl);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Invalid Base URL.' });
  }

  if (!baseUrl) {
    return res.status(400).json({ error: 'Provider base URL is not configured.' });
  }

  const key = resolveEffectiveKey(providerId, rawApiKey);
  const isPublic = providerId === 'openrouter' || providerId === 'nvidia';

  if (!key && !isPublic) {
    return res.status(400).json({ error: 'Enter this provider API key first.' });
  }

  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  try {
    if (providerId === 'gemini') {
      const ai = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          apiVersion: 'v1beta',
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const pager = await ai.models.list();
      const ids = new Set<string>();
      const capabilities: Record<string, ModelCapability> = {};

      for await (const m of pager as any) {
        const rawName = typeof m?.name === 'string' ? m.name : '';
        const cleaned = rawName.replace(/^models\//, '').trim();
        if (!cleaned) continue;
        if (!isTextOutputModel('gemini', cleaned, m)) continue;
        ids.add(cleaned);
        capabilities[cleaned] = extractModelCapability('gemini', cleaned, m);
      }
      const sorted = [...ids].sort(compareModelIds);
      return res.json({ listed: true, ids: sorted, publicCatalog: false, capabilities });
    }

    const modelsUrl = `${baseUrl}/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    const upstream = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal,
    });

    if ([404, 405, 501].includes(upstream.status)) {
      return res.json({ listed: false, ids: [], publicCatalog: isPublic, capabilities: {} });
    }

    const rawText = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: extractErrorMessage(rawText, upstream.status),
      });
    }

    let json: any = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      return res.json({ listed: false, ids: [], publicCatalog: isPublic, capabilities: {} });
    }

    const rows = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : null;

    if (!rows) {
      return res.json({ listed: false, ids: [], publicCatalog: isPublic, capabilities: {} });
    }

    const ids = new Set<string>();
    const capabilities: Record<string, ModelCapability> = {};
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : '';
      if (!id || !isTextOutputModel(providerId, id, row)) continue;
      ids.add(id);
      capabilities[id] = extractModelCapability(providerId, id, row);
    }

    return res.json({
      listed: true,
      ids: [...ids].sort(compareModelIds),
      publicCatalog: isPublic && !key,
      capabilities,
    });
  } catch (err: any) {
    return res.status(502).json({
      error: err?.message || 'Failed to fetch model catalog.',
    });
  }
});

// ============================================================================
// Tavily Web Search Proxy + Optional Model Decision Route
// ============================================================================
function parseDomainList(raw: unknown): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const domains = new Set<string>();
  for (const token of raw.toLowerCase().split(/[\s,;]+/).filter(Boolean)) {
    const clean = token.replace(/^\*\./, '').replace(/\.$/, '');
    if (/^(?=.{3,253}$)(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(clean)) {
      domains.add(clean);
    }
  }
  return [...domains].slice(0, 12);
}

app.post('/api/search', async (req, res) => {
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS);

  const {
    query,
    tavilyKey,
    depth = 'basic',
    results = 4,
    allowSites = '',
    blockSites = '',
  } = req.body as {
    query?: string;
    tavilyKey?: string;
    depth?: string;
    results?: number;
    allowSites?: string;
    blockSites?: string;
  };

  const key = (tavilyKey || '').trim();
  if (!key) {
    return res.status(401).json({ error: 'Add your Tavily API key in Settings.' });
  }
  const trimmedQuery = (query || '').trim().slice(0, 400);
  if (!trimmedQuery) {
    return res.status(400).json({ error: 'Search query is required.' });
  }

  const validDepth = ['basic', 'advanced', 'fast', 'ultra-fast'].includes(depth) ? depth : 'basic';
  const maxResults = Math.max(1, Math.min(10, Math.round(Number(results) || 4)));
  const includeDomains = parseDomainList(allowSites);
  const excludeDomains = parseDomainList(blockSites);

  const payload: Record<string, unknown> = {
    query: trimmedQuery,
    search_depth: validDepth,
    max_results: maxResults,
    safe_search: true,
    include_answer: false,
    include_images: false,
    include_raw_content: false,
    ...(includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
    ...(excludeDomains.length > 0 ? { exclude_domains: excludeDomains } : {}),
  };

  try {
    const upstream = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: extractErrorMessage(raw, upstream.status),
      });
    }

    const data = JSON.parse(raw);
    const rows = Array.isArray(data?.results) ? data.results : [];
    const sources = rows.slice(0, maxResults).map((r: any, idx: number) => ({
      id: idx + 1,
      title: typeof r?.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 180) : String(r?.url || 'Source'),
      url: typeof r?.url === 'string' ? r.url : '',
      content: typeof r?.content === 'string' ? r.content.trim().slice(0, 1400) : '',
      score: typeof r?.score === 'number' ? r.score : undefined,
    }));

    return res.json({ sources, query: trimmedQuery });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || 'Tavily search failed.' });
  }
});

// ============================================================================
// Chat Execution Helpers (Gemini SDK + OpenAI-Compatible with Self-Healing Retry)
// ============================================================================
interface ChatRequestPayload {
  requestId?: string;
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  cascade: string[];
  messages: MessageInput[];
  systemPrompt?: string;
  thinkingLevel?: Mode;
  historyLimit?: number;
  maxTokens?: number;
  streaming?: boolean;
  capabilities?: Record<string, ModelCapability>;
}

interface ModelExecutionResult {
  text: string;
  thought: string;
  appliedSummary: string;
  retried: boolean;
  retryReason?: string;
  learnedCapability?: ModelCapability;
}

function parseChatPayload(req: express.Request): ChatRequestPayload {
  let body: any = req.body;
  if (typeof req.body?.payload === 'string') {
    body = JSON.parse(req.body.payload);
  }
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  const messages: MessageInput[] = Array.isArray(body?.messages) ? body.messages : [];

  if (files.length > 0 && messages.length > 0) {
    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    const extraAttachments: AttachmentInput[] = files.map((f, idx) => ({
      id: `multer-${Date.now()}-${idx}`,
      name: f.originalname,
      mimeType: f.mimetype || 'application/octet-stream',
      size: f.size,
      data: f.buffer.toString('base64'),
    }));
    messages[lastIdx] = {
      ...lastMsg,
      attachments: [...(lastMsg.attachments || []), ...extraAttachments],
    };
  }

  return {
    requestId: typeof body?.requestId === 'string' ? body.requestId : '',
    providerId: body?.providerId || 'gemini',
    baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl : '',
    apiKey: typeof body?.apiKey === 'string' ? body.apiKey : '',
    cascade: Array.isArray(body?.cascade)
      ? body.cascade.filter((m: unknown): m is string => typeof m === 'string' && m.trim().length > 0)
      : [],
    messages,
    systemPrompt: typeof body?.systemPrompt === 'string' ? body.systemPrompt : '',
    thinkingLevel: (body?.thinkingLevel as Mode) || 'default',
    historyLimit: typeof body?.historyLimit === 'number' ? body.historyLimit : 10,
    maxTokens: Math.max(500, Math.min(100_000, Math.round(Number(body?.maxTokens) || 8192))),
    streaming: body?.streaming !== false,
    capabilities:
      body?.capabilities && typeof body.capabilities === 'object' ? body.capabilities : undefined,
  };
}

function resolveSdkThinkingConfig(rawConfig?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!rawConfig) return undefined;
  const out = { ...rawConfig };
  if (typeof out.thinkingLevel === 'string') {
    const key = out.thinkingLevel.toUpperCase();
    out.thinkingLevel = (ThinkingLevel as any)[key] ?? key;
  }
  return out;
}

function hasPublicHttpUrl(messages: MessageInput[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const raw = String(messages[i]?.text ?? messages[i]?.content ?? '').split(
      /\n\n---\n\[Web Search Results for /
    )[0];
    const matches = raw.match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
    for (const candidate of matches) {
      try {
        const u = new URL(candidate.replace(/[.,;!?]+$/, ''));
        if (!['http:', 'https:'].includes(u.protocol)) continue;
        const host = u.hostname.toLowerCase();
        if (
          !host ||
          host === 'localhost' ||
          host === '0.0.0.0' ||
          host === '::1' ||
          host.endsWith('.local') ||
          host.endsWith('.internal') ||
          /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
          !host.includes('.')
        ) {
          continue;
        }
        return true;
      } catch {
        // Ignore malformed URL candidates
      }
    }
    return false;
  }
  return false;
}

function safelyReadCandidateUrlCitations(candidate: any, seenUrls: Set<string>): void {
  try {
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
    if (Array.isArray(groundingChunks)) {
      for (const ch of groundingChunks) {
        const uri = ch?.web?.uri || ch?.retrievedContext?.uri;
        if (typeof uri === 'string' && uri.trim()) seenUrls.add(uri.trim());
      }
    }
    const urlMeta = candidate?.urlContextMetadata?.urlMetadata;
    if (Array.isArray(urlMeta)) {
      for (const item of urlMeta) {
        const retrievedUrl = item?.retrievedUrl || item?.retrieved_url;
        if (typeof retrievedUrl === 'string' && retrievedUrl.trim()) {
          seenUrls.add(retrievedUrl.trim());
        }
      }
    }
  } catch {
    // Safely ignore unexpected citation metadata shapes
  }
}

async function runGeminiModel(options: {
  model: string;
  apiKey: string;
  messages: MessageInput[];
  systemPrompt: string;
  thinkingLevel: Mode;
  historyLimit: number;
  maxTokens: number;
  streaming: boolean;
  capability?: ModelCapability;
  signal: AbortSignal;
  onThought?: (text: string) => void;
  onChunk?: (text: string) => void;
  onThinkingStart?: () => void;
}): Promise<ModelExecutionResult> {
  const {
    model,
    apiKey,
    messages,
    systemPrompt,
    thinkingLevel,
    historyLimit,
    maxTokens,
    streaming,
    capability,
    signal,
    onThought,
    onChunk,
    onThinkingStart,
  } = options;

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: 'v1beta',
      timeout: ACTIVE_TIMEOUT_MS,
      headers: { 'User-Agent': 'aistudio-build' },
    },
  });

  const modelLower = model.trim().toLowerCase();
  const isGemmaFamily = modelLower.startsWith('gemma');
  const isLegacyGemma = isGemmaFamily && !modelLower.startsWith('gemma-4');
  let systemAsUser = Boolean(capability?.systemAsUser) || isLegacyGemma;
  let learnedSystemAsUser = false;
  let useUrlContext = !isGemmaFamily && hasPublicHttpUrl(messages);
  let strippedUrlContextOnRetry = false;

  let contents = formatMessagesForGemini(messages, historyLimit, systemPrompt, systemAsUser);
  const attempts = buildGeminiThinkingAttempts(model, thinkingLevel, capability);

  let lastErr: any = null;
  let retryReason: string | undefined;

  for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx++) {
    if (signal.aborted) throw new Error('Aborted');
    const attempt = attempts[attemptIdx];
    const resolvedThinking = resolveSdkThinkingConfig(attempt.thinkingConfig);

    const config: any = {
      abortSignal: signal,
    };
    if (!systemAsUser && systemPrompt.trim()) {
      config.systemInstruction = systemPrompt.trim();
    }
    if (attempt.includeMaxTokens) {
      config.maxOutputTokens = maxTokens;
    }
    if (resolvedThinking) {
      config.thinkingConfig = resolvedThinking;
    }
    if (useUrlContext) {
      config.tools = [{ urlContext: {} }];
    }

    const maybeLearned = (): ModelCapability | undefined => {
      if (attemptIdx === 0 && !learnedSystemAsUser) return undefined;
      return buildLearnedCapability({
        providerId: 'gemini',
        model,
        requestedMode: thinkingLevel,
        priorCapability: capability,
        succeededMode: attempt.effectiveMode,
        strippedThinking: !attempt.thinkingConfig && thinkingLevel !== 'default',
        systemAsUser: learnedSystemAsUser || capability?.systemAsUser,
      });
    };

    try {
      const urlCitations = new Set<string>();
      if (streaming) {
        if (resolvedThinking && resolvedThinking.includeThoughts !== false) {
          onThinkingStart?.();
        }
        const stream = await ai.models.generateContentStream({
          model,
          contents,
          config,
        });

        let fullText = '';
        let fullThought = '';
        for await (const chunk of stream) {
          if (signal.aborted) break;
          const candidate = chunk.candidates?.[0];
          safelyReadCandidateUrlCitations(candidate, urlCitations);
          const parts = candidate?.content?.parts || [];
          if (parts.length > 0) {
            for (const part of parts) {
              const rawThought = (part as any).thought;
              const isThought = rawThought === true || typeof rawThought === 'string';
              const thoughtText =
                typeof rawThought === 'string' ? rawThought : rawThought ? part.text || '' : '';
              if (isThought && thoughtText) {
                fullThought += thoughtText;
                onThought?.(thoughtText);
              } else if (!isThought && part.text) {
                fullText += part.text;
                onChunk?.(part.text);
              }
            }
          } else if (chunk.text) {
            fullText += chunk.text;
            onChunk?.(chunk.text);
          }
        }
        return {
          text: fullText,
          thought: fullThought,
          appliedSummary: learnedSystemAsUser
            ? `${attempt.summary} (system folded to user)`
            : attempt.summary,
          retried: attemptIdx > 0 || learnedSystemAsUser || strippedUrlContextOnRetry,
          retryReason,
          learnedCapability: maybeLearned(),
        };
      } else {
        const resp = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        let fullText = '';
        let fullThought = '';
        const candidate = resp.candidates?.[0];
        safelyReadCandidateUrlCitations(candidate, urlCitations);
        const parts = candidate?.content?.parts || [];
        for (const part of parts) {
          const rawThought = (part as any).thought;
          const isThought = rawThought === true || typeof rawThought === 'string';
          if (isThought) {
            fullThought += typeof rawThought === 'string' ? rawThought : part.text || '';
          } else if (part.text) {
            fullText += part.text;
          }
        }
        if (!fullText && resp.text) fullText = resp.text;
        return {
          text: fullText,
          thought: fullThought,
          appliedSummary: learnedSystemAsUser
            ? `${attempt.summary} (system folded to user)`
            : attempt.summary,
          retried: attemptIdx > 0 || learnedSystemAsUser || strippedUrlContextOnRetry,
          retryReason,
          learnedCapability: maybeLearned(),
        };
      }
    } catch (err: any) {
      lastErr = err;
      if (signal.aborted) throw err;
      const status = Number(err?.status || err?.code || 0);
      const msg = String(err?.message || '');
      const effectiveStatus = status || (msg.includes('400') ? 400 : 0);

      // If urlContext tool was rejected (or final attempt failed parameter check with tools attached), strip tools and retry
      if (
        useUrlContext &&
        isParameterRejection(effectiveStatus, msg) &&
        (URL_CONTEXT_ERROR_REGEX.test(msg) || attemptIdx === attempts.length - 1)
      ) {
        useUrlContext = false;
        strippedUrlContextOnRetry = true;
        retryReason = msg.slice(0, 120);
        attemptIdx--;
        continue;
      }

      // If systemInstruction itself was rejected, fold systemPrompt into the user message and retry same thinking attempt
      if (
        !systemAsUser &&
        systemPrompt.trim() &&
        isParameterRejection(effectiveStatus, msg) &&
        SYSTEM_INSTRUCTION_UNSUPPORTED_REGEX.test(msg)
      ) {
        systemAsUser = true;
        learnedSystemAsUser = true;
        contents = formatMessagesForGemini(messages, historyLimit, systemPrompt, true);
        retryReason = msg.slice(0, 120);
        attemptIdx--;
        continue;
      }

      if (attemptIdx < attempts.length - 1 && isParameterRejection(effectiveStatus, msg)) {
        retryReason = msg.slice(0, 120);
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('Gemini request failed');
}

async function runGeminiWithFallback(options: {
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: MessageInput[];
  systemPrompt: string;
  thinkingLevel: Mode;
  historyLimit: number;
  maxTokens: number;
  streaming: boolean;
  capability?: ModelCapability;
  signal: AbortSignal;
  onThought?: (text: string) => void;
  onChunk?: (text: string) => void;
  onThinkingStart?: () => void;
}): Promise<ModelExecutionResult> {
  // If user configured a Gemini OpenAI-compatible base URL directly, route straight to it
  if (options.baseUrl.includes('/openai')) {
    return runOpenAIModel({
      providerId: 'gemini',
      ...options,
    });
  }

  try {
    return await runGeminiModel(options);
  } catch (err: any) {
    if (options.signal.aborted) throw err;
    const status = Number(err?.status || err?.code || 0);
    // Do not retry auth/quota/not-found errors on OpenAI-compat endpoint; only fall back if SDK transport/parameter path fails
    if ([401, 402, 403, 404, 429].includes(status)) {
      throw err;
    }
    const cleanBase = options.baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/, '');
    const openAiBase = `${cleanBase}/v1beta/openai`;
    return await runOpenAIModel({
      providerId: 'gemini',
      baseUrl: openAiBase,
      apiKey: options.apiKey,
      model: options.model,
      messages: options.messages,
      systemPrompt: options.systemPrompt,
      thinkingLevel: options.thinkingLevel,
      historyLimit: options.historyLimit,
      maxTokens: options.maxTokens,
      streaming: options.streaming,
      capability: options.capability,
      signal: options.signal,
      onThought: options.onThought,
      onChunk: options.onChunk,
      onThinkingStart: options.onThinkingStart,
    });
  }
}

interface OpenAIAttemptPlan {
  payload: Record<string, unknown>;
  reasoningFields: OpenAIReasoningFields;
  effectiveMode: Mode;
  swappedStyle?: 'effort' | 'nim-switch' | 'zai-53' | 'zai-toggle';
}

function buildOpenAIAttemptPayloads(options: {
  providerId: ProviderId;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }>;
  hasPdf: boolean;
  maxTokens: number;
  streaming: boolean;
  thinkingLevel: Mode;
  capability?: ModelCapability;
}): OpenAIAttemptPlan[] {
  const {
    providerId,
    model,
    messages,
    hasPdf,
    maxTokens,
    streaming,
    thinkingLevel,
    capability,
  } = options;

  const reasoning = reasonFields(providerId, model, thinkingLevel, capability);
  const plugins =
    providerId === 'openrouter' && hasPdf
      ? [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]
      : undefined;

  const tokenField =
    providerId === 'groq' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };

  const primary: Record<string, unknown> = {
    model,
    messages,
    stream: streaming,
    ...tokenField,
    ...reasoning,
    ...(plugins ? { plugins } : {}),
  };

  if (providerId === 'zai') {
    primary.temperature = 0.7; // safely within (0.02, 1.0]
  }

  // Attempt 1 (Retry 1): smart provider-specific repair / step-down
  let retry1Fields: OpenAIReasoningFields = {};
  let retry1Mode: Mode = thinkingLevel;
  let retry1SwappedStyle: OpenAIAttemptPlan['swappedStyle'];

  const retry1Base: Record<string, unknown> = {
    model,
    messages,
    stream: streaming,
    ...tokenField,
    ...(plugins ? { plugins } : {}),
  };

  if (providerId === 'nvidia' && thinkingLevel !== 'default') {
    if (reasoning.reasoning_effort !== undefined) {
      retry1Fields = { chat_template_kwargs: { enable_thinking: thinkingLevel !== 'none' } };
      retry1Mode = thinkingLevel === 'none' ? 'none' : 'on';
      retry1SwappedStyle = 'nim-switch';
    } else if (reasoning.chat_template_kwargs?.enable_thinking !== undefined) {
      retry1Fields = { chat_template_kwargs: { thinking: thinkingLevel !== 'none' } };
      retry1Mode = thinkingLevel === 'none' ? 'none' : 'on';
      retry1SwappedStyle = 'nim-switch';
    } else if (reasoning.chat_template_kwargs !== undefined) {
      retry1Fields = { reasoning_effort: thinkingLevel === 'none' ? 'low' : 'high' };
      retry1Mode = thinkingLevel === 'none' ? 'low' : 'high';
      retry1SwappedStyle = 'effort';
    }
  } else if (providerId === 'zai') {
    retry1Base.temperature = 0.95;
    if (thinkingLevel !== 'default') {
      retry1Fields = model.toLowerCase().includes('glm-5.3')
        ? { thinking: { type: 'enabled' } }
        : { thinking: { type: thinkingLevel === 'none' ? 'disabled' : 'enabled' } };
      retry1Mode = thinkingLevel === 'none' ? 'none' : 'on';
      retry1SwappedStyle = 'zai-toggle';
    }
  } else if (providerId === 'groq') {
    const groqRule = reasonRule('groq', model, capability);
    if (groqRule && thinkingLevel !== 'default' && thinkingLevel !== 'none') {
      if (groqRule.style === 'groq-oss') {
        retry1Fields = { reasoning_effort: 'low', include_reasoning: true };
        retry1Mode = 'low';
      } else if (groqRule.style === 'groq-qwen') {
        retry1Fields = { reasoning_effort: 'default', reasoning_format: 'parsed' };
        retry1Mode = 'on';
      } else {
        retry1Fields = { reasoning_effort: 'high' };
        retry1Mode = 'high';
      }
    }
    // Unknown Groq models (groqRule === undefined) skip straight to stripping reasoning_effort
  } else if (providerId === 'openrouter' && thinkingLevel !== 'default' && capability?.supportsThinking !== false) {
    const curEffort = reasoning.reasoning?.effort;
    if (curEffort === 'max') {
      retry1Fields = { reasoning: { effort: 'xhigh', exclude: false } };
      retry1Mode = 'xhigh';
    } else if (curEffort === 'xhigh') {
      retry1Fields = { reasoning: { effort: 'high', exclude: false } };
      retry1Mode = 'high';
    } else if (curEffort === 'medium' || curEffort === 'high') {
      retry1Fields = { reasoning: { effort: 'low', exclude: false } };
      retry1Mode = 'low';
    }
  } else if (
    (providerId === 'custom1' || providerId === 'custom2') &&
    (thinkingLevel === 'xhigh' || thinkingLevel === 'max') &&
    capability?.supportsThinking !== false
  ) {
    retry1Fields = { reasoning_effort: 'high' };
    retry1Mode = 'high';
  }

  const retry1Payload: Record<string, unknown> = {
    ...retry1Base,
    ...retry1Fields,
  };

  // Attempt 2 (Retry 2): bare minimal OpenAI-compatible payload (tokenField preserved)
  const retry2Payload: Record<string, unknown> = {
    model,
    messages,
    stream: streaming,
    ...tokenField,
    ...(plugins ? { plugins } : {}),
  };

  const plans: OpenAIAttemptPlan[] = [
    { payload: primary, reasoningFields: reasoning, effectiveMode: thinkingLevel },
  ];

  if (JSON.stringify(retry1Payload) !== JSON.stringify(primary)) {
    plans.push({
      payload: retry1Payload,
      reasoningFields: retry1Fields,
      effectiveMode: retry1Mode,
      swappedStyle: retry1SwappedStyle,
    });
  }
  if (
    JSON.stringify(retry2Payload) !== JSON.stringify(retry1Payload) &&
    JSON.stringify(retry2Payload) !== JSON.stringify(primary)
  ) {
    plans.push({ payload: retry2Payload, reasoningFields: {}, effectiveMode: 'default' });
  }

  return plans;
}

async function runOpenAIModel(options: {
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: MessageInput[];
  systemPrompt: string;
  thinkingLevel: Mode;
  historyLimit: number;
  maxTokens: number;
  streaming: boolean;
  capability?: ModelCapability;
  signal: AbortSignal;
  onThought?: (text: string) => void;
  onChunk?: (text: string) => void;
  onThinkingStart?: () => void;
}): Promise<ModelExecutionResult> {
  const {
    providerId,
    baseUrl,
    apiKey,
    model,
    messages,
    systemPrompt,
    thinkingLevel,
    historyLimit,
    maxTokens,
    streaming,
    capability,
    signal,
    onThought,
    onChunk,
    onThinkingStart,
  } = options;

  const { messages: formattedMessages, hasPdf } = formatMessagesForOpenAI(
    providerId,
    messages,
    historyLimit,
    systemPrompt
  );

  const attempts = buildOpenAIAttemptPayloads({
    providerId,
    model,
    messages: formattedMessages,
    hasPdf,
    maxTokens,
    streaming,
    thinkingLevel,
    capability,
  });

  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: streaming ? 'text/event-stream' : 'application/json',
    ...(providerId === 'openrouter'
      ? {
          'HTTP-Referer': process.env.APP_URL || 'https://solara.local',
          'X-Title': 'Solara AI Chat',
        }
      : {}),
  };

  let lastError: Error | null = null;
  let retryReason: string | undefined;

  for (let idx = 0; idx < attempts.length; idx++) {
    if (signal.aborted) throw new Error('Aborted');
    const attempt = attempts[idx];
    const appliedSummary = describeAppliedOpenAIThinking(
      providerId,
      model,
      thinkingLevel,
      attempt.reasoningFields,
      capability,
      idx > 0
    );

    const upstream = await undiciFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(attempt.payload),
      signal: signal as any,
      dispatcher: longFetchAgent,
    });

    if (!upstream.ok) {
      const errRaw = await upstream.text().catch(() => '');
      const errMsg = extractErrorMessage(errRaw, upstream.status);
      const err = new Error(`HTTP ${upstream.status}: ${errMsg}`) as Error & { status?: number };
      err.status = upstream.status;
      lastError = err;

      if (idx < attempts.length - 1 && isParameterRejection(upstream.status, errMsg)) {
        retryReason = errMsg.slice(0, 120);
        continue;
      }
      throw err;
    }

    if (!streaming || !upstream.body) {
      const json = (await upstream.json()) as any;
      const choice = json?.choices?.[0];
      const msgObj = choice?.message || {};
      const content =
        typeof msgObj.content === 'string'
          ? msgObj.content
          : Array.isArray(msgObj.content)
            ? msgObj.content.map((p: any) => p?.text || '').join('')
            : '';
      const reasoning =
        typeof msgObj.reasoning_content === 'string'
          ? msgObj.reasoning_content
          : typeof msgObj.reasoning === 'string'
            ? msgObj.reasoning
            : '';
      const maybeLearned =
        idx > 0
          ? buildLearnedCapability({
              providerId,
              model,
              requestedMode: thinkingLevel,
              priorCapability: capability,
              succeededMode: attempt.effectiveMode,
              strippedThinking:
                Object.keys(attempt.reasoningFields).length === 0 && thinkingLevel !== 'default',
              swappedStyle: attempt.swappedStyle,
            })
          : undefined;

      return {
        text: content,
        thought: reasoning,
        appliedSummary,
        retried: idx > 0,
        retryReason,
        learnedCapability: maybeLearned,
      };
    }

    // Parse SSE stream cleanly with immediate abort propagation
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let fullThought = '';
    let signaledThinking = false;

    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;
          const rawJson = trimmed.slice(5).trim();
          if (!rawJson || rawJson === '[DONE]') continue;

          let packet: any = null;
          try {
            packet = JSON.parse(rawJson);
          } catch {
            continue;
          }

          if (packet?.error) {
            const msg =
              typeof packet.error === 'string'
                ? packet.error
                : packet.error?.message || 'Upstream stream error';
            throw new Error(msg);
          }

          const choice = packet?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || choice.message || {};

          // Reasoning fields across OpenRouter, NVIDIA NIM, Z.AI, Groq
          const rDelta =
            typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
                ? delta.reasoning
                : Array.isArray(delta.reasoning_details)
                  ? delta.reasoning_details.map((d: any) => d?.text || '').join('')
                  : '';

          if (rDelta) {
            if (!signaledThinking) {
              signaledThinking = true;
              onThinkingStart?.();
            }
            fullThought += rDelta;
            onThought?.(rDelta);
          }

          const cVal = delta.content ?? choice.text;
          const cDelta =
            typeof cVal === 'string'
              ? cVal
              : Array.isArray(cVal)
                ? cVal.filter((v: any) => v?.type === 'text' && typeof v.text === 'string').map((v: any) => v.text).join('')
                : '';

          if (cDelta) {
            fullText += cDelta;
            onChunk?.(cDelta);
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    const maybeLearned =
      idx > 0
        ? buildLearnedCapability({
            providerId,
            model,
            requestedMode: thinkingLevel,
            priorCapability: capability,
            succeededMode: attempt.effectiveMode,
            strippedThinking:
              Object.keys(attempt.reasoningFields).length === 0 && thinkingLevel !== 'default',
            swappedStyle: attempt.swappedStyle,
          })
        : undefined;

    return {
      text: fullText,
      thought: fullThought,
      appliedSummary,
      retried: idx > 0,
      retryReason,
      learnedCapability: maybeLearned,
    };
  }

  throw lastError || new Error('OpenAI-compatible request failed');
}

// ============================================================================
// Streaming Chat Endpoint (Decoupled StreamJob + Overlap SSE Handoff)
// ============================================================================
async function executeStreamJob(
  job: StreamJob,
  params: {
    providerId: ProviderId;
    baseUrl: string;
    apiKey: string;
    cascade: string[];
    messages: MessageInput[];
    systemPrompt: string;
    thinkingLevel: Mode;
    historyLimit: number;
    maxTokens: number;
    streaming: boolean;
    capabilities?: Record<string, ModelCapability>;
  }
): Promise<void> {
  const {
    providerId,
    baseUrl,
    apiKey,
    cascade,
    messages,
    systemPrompt,
    thinkingLevel,
    historyLimit,
    maxTokens,
    streaming,
    capabilities,
  } = params;

  try {
    for (let i = 0; i < cascade.length; i++) {
      if (job.controller.signal.aborted || job.finished) break;
      const targetModel = cascade[i];
      const modelCap = capabilities?.[targetModel];
      emitJobEvent(job, { type: 'model_init', model: targetModel });

      try {
        let result: ModelExecutionResult;
        if (providerId === 'gemini') {
          result = await runGeminiWithFallback({
            baseUrl,
            model: targetModel,
            apiKey,
            messages,
            systemPrompt,
            thinkingLevel,
            historyLimit,
            maxTokens,
            streaming,
            capability: modelCap,
            signal: job.controller.signal,
            onThinkingStart: () => emitJobEvent(job, { type: 'thinking' }),
            onThought: (text) => {
              promoteJobTimeout(job);
              emitJobEvent(job, { type: 'thought', text });
            },
            onChunk: (text) => {
              promoteJobTimeout(job);
              emitJobEvent(job, { type: 'chunk', text });
            },
          });
        } else {
          result = await runOpenAIModel({
            providerId,
            baseUrl,
            apiKey,
            model: targetModel,
            messages,
            systemPrompt,
            thinkingLevel,
            historyLimit,
            maxTokens,
            streaming,
            capability: modelCap,
            signal: job.controller.signal,
            onThinkingStart: () => emitJobEvent(job, { type: 'thinking' }),
            onThought: (text) => {
              promoteJobTimeout(job);
              emitJobEvent(job, { type: 'thought', text });
            },
            onChunk: (text) => {
              promoteJobTimeout(job);
              emitJobEvent(job, { type: 'chunk', text });
            },
          });
        }

        if (!streaming) {
          if (result.thought) {
            promoteJobTimeout(job);
            emitJobEvent(job, { type: 'thought', text: result.thought });
          }
          if (result.text) {
            promoteJobTimeout(job);
            emitJobEvent(job, { type: 'chunk', text: result.text });
          }
        }

        if (job.controller.signal.aborted || job.finished) break;

        if (!result.text.trim() && !result.thought.trim()) {
          throw new Error('Model returned an empty response');
        }

        if (result.learnedCapability) {
          emitJobEvent(job, {
            type: 'learned_capability',
            model: targetModel,
            capability: result.learnedCapability,
          });
        }
        emitJobEvent(job, {
          type: 'model_meta',
          model: targetModel,
          requestedMode: thinkingLevel,
          appliedSummary: result.appliedSummary,
          retried: result.retried,
          retryReason: result.retryReason,
        });
        emitJobEvent(job, { type: 'done', modelUsed: targetModel });
        finishJob(job);
        return;
      } catch (err: any) {
        if (job.controller.signal.aborted || job.finished) {
          break;
        }

        const reason = String(err?.message || 'Upstream error').slice(0, 140);
        if (i < cascade.length - 1) {
          emitJobEvent(job, {
            type: 'fallback_notice',
            failedModel: targetModel,
            nextModel: cascade[i + 1],
            reason,
          });
        } else {
          emitJobEvent(job, {
            type: 'error',
            error: `All ${cascade.length} model(s) in cascade failed. Last error (${targetModel}): ${reason}`,
          });
          finishJob(job);
          return;
        }
      }
    }
  } finally {
    finishJob(job);
  }
}

app.post(
  '/api/chat/stream',
  (req, res, next) => {
    if (req.is('multipart/form-data')) {
      return upload.array('files', 12)(req, res, next);
    }
    return next();
  },
  async (req, res) => {
    let parsed: ChatRequestPayload;
    try {
      parsed = parseChatPayload(req);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Invalid chat request payload.' });
    }

    const {
      requestId,
      providerId,
      baseUrl: rawBaseUrl,
      apiKey: rawApiKey,
      cascade,
      messages,
      systemPrompt = '',
      thinkingLevel = 'default',
      historyLimit = 10,
      maxTokens = 8192,
      streaming = true,
      capabilities,
    } = parsed;

    if (!messages.length) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }
    if (!cascade.length) {
      return res.status(400).json({ error: 'No models in cascade for this provider. Open Cascades to add at least one model.' });
    }

    let baseUrl = '';
    try {
      baseUrl = resolveEffectiveBaseUrl(providerId, rawBaseUrl);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Invalid provider Base URL.' });
    }
    if (!baseUrl) {
      return res.status(400).json({ error: 'Provider base URL is not configured.' });
    }

    const apiKey = resolveEffectiveKey(providerId, rawApiKey);
    if (!apiKey) {
      return res.status(401).json({ error: `Missing API key for ${providerId}. Add it in Connection Settings.` });
    }

    const jobId =
      (requestId || '').trim() || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const priorJob = activeJobs.get(jobId);
    if (priorJob) {
      priorJob.aborted = true;
      priorJob.controller.abort(new Error('Replaced by new request'));
      finishJob(priorJob);
      if (priorJob.cleanupTimer) {
        clearTimeout(priorJob.cleanupTimer);
        priorJob.cleanupTimer = null;
      }
      activeJobs.delete(jobId);
    }

    const job: StreamJob = {
      jobId,
      controller: new AbortController(),
      events: [],
      nextSeq: 1,
      lastSeq: 0,
      lastSentSeq: 0,
      writer: null,
      finished: false,
      aborted: false,
      startedAt: Date.now(),
      promotedToActive: false,
      keepaliveTimer: null,
      legTimer: null,
      hardCloseTimer: null,
      disconnectTimer: null,
      jobTimeoutTimer: null,
      cleanupTimer: null,
    };

    job.jobTimeoutTimer = setTimeout(() => {
      failJobOnTimeout(job, 'Upstream model timed out after 10 minutes without responding.');
    }, INITIAL_TIMEOUT_MS);

    activeJobs.set(jobId, job);
    attachWriter(job, req, res);

    void executeStreamJob(job, {
      providerId,
      baseUrl,
      apiKey,
      cascade,
      messages,
      systemPrompt,
      thinkingLevel,
      historyLimit,
      maxTokens,
      streaming,
      capabilities,
    });
  }
);

// ============================================================================
// Non-Streaming Chat Endpoint (also used for Tavily query-intent planning)
// ============================================================================
app.post(
  '/api/chat',
  (req, res, next) => {
    if (req.is('multipart/form-data')) {
      return upload.array('files', 12)(req, res, next);
    }
    return next();
  },
  async (req, res) => {
    req.setTimeout(REQUEST_TIMEOUT_MS);
    res.setTimeout(REQUEST_TIMEOUT_MS);

    let parsed: ChatRequestPayload;
    try {
      parsed = parseChatPayload(req);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Invalid chat request payload.' });
    }

    const {
      requestId,
      providerId,
      baseUrl: rawBaseUrl,
      apiKey: rawApiKey,
      cascade,
      messages,
      systemPrompt = '',
      thinkingLevel = 'default',
      historyLimit = 10,
      maxTokens = 8192,
      capabilities,
    } = parsed;

    if (!messages.length || !cascade.length) {
      return res.status(400).json({ error: 'Messages and at least one model in cascade are required.' });
    }

    let baseUrl = '';
    try {
      baseUrl = resolveEffectiveBaseUrl(providerId, rawBaseUrl);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Invalid provider Base URL.' });
    }

    const apiKey = resolveEffectiveKey(providerId, rawApiKey);
    if (!apiKey) {
      return res.status(401).json({ error: `Missing API key for ${providerId}.` });
    }

    const controller = new AbortController();
    if (requestId) activeRequests.set(requestId, controller);
    const combinedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

    try {
      let lastReason = 'All models failed';
      for (let i = 0; i < cascade.length; i++) {
        if (combinedSignal.aborted) break;
        const targetModel = cascade[i];
        const modelCap = capabilities?.[targetModel];
        try {
          const result =
            providerId === 'gemini'
              ? await runGeminiWithFallback({
                  baseUrl,
                  model: targetModel,
                  apiKey,
                  messages,
                  systemPrompt,
                  thinkingLevel,
                  historyLimit,
                  maxTokens,
                  streaming: false,
                  capability: modelCap,
                  signal: combinedSignal,
                })
              : await runOpenAIModel({
                  providerId,
                  baseUrl,
                  apiKey,
                  model: targetModel,
                  messages,
                  systemPrompt,
                  thinkingLevel,
                  historyLimit,
                  maxTokens,
                  streaming: false,
                  capability: modelCap,
                  signal: combinedSignal,
                });

          return res.json({
            text: result.text,
            reasoning: result.thought || undefined,
            modelUsed: targetModel,
            thinkingMeta: result.appliedSummary,
            learnedCapability: result.learnedCapability,
          });
        } catch (err: any) {
          lastReason = String(err?.message || 'Upstream error');
        }
      }
      return res.status(502).json({ error: lastReason });
    } finally {
      if (requestId) activeRequests.delete(requestId);
    }
  }
);

// ============================================================================
// Multer / Payload Error Handler
// ============================================================================
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 25 MB upload limit.' });
  }
  if (err) {
    return res.status(err.status || 400).json({ error: err.message || 'Bad request.' });
  }
  next();
});

// ============================================================================
// Vite / Static Bootstrapping (Port 3000, 0.0.0.0)
// ============================================================================
async function startServer() {
  const distPath = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build not found.');
      }
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Solara stateless server running on http://0.0.0.0:${PORT}`);
  });

  // 20-minute active stream server socket ceiling
  server.requestTimeout = ACTIVE_STREAM_TIMEOUT_MS + 5_000;
  server.headersTimeout = ACTIVE_STREAM_TIMEOUT_MS + 5_000;
  server.keepAliveTimeout = 65_000;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
