import { PreviewMessageType, WebContainer, type PreviewMessage } from '@webcontainer/api';
import { parentOf, safePath, WORKSPACE_ROOT } from './path';

export type FileEntry = { name: string; path: string; dir: boolean };

// boot() must happen exactly once for the lifetime of the page. A second call
// throws "Proxy has been released and is not usable" — and StrictMode
// double-mounts, so the guard has to be the promise itself, not a boolean.
let bootPromise: Promise<WebContainer> | null = null;

export function getContainer(): Promise<WebContainer> {
  if (!bootPromise) {
    bootPromise = WebContainer.boot({
      coep: 'credentialless',
      // WebContainer injects a tiny reporter into preview iframes and posts what the page
      // logs/throws back to us. Without this the agent is blind to its own running app:
      // a page that renders fine but throws on load looks like total success.
      forwardPreviewErrors: true,
    })
      .then((booted) => {
        wirePreviewMessages(booted);
        return booted;
      })
      .catch((err: unknown) => {
      // A failed boot must not poison the singleton forever.
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

export async function listDir(dir: string = WORKSPACE_ROOT): Promise<FileEntry[]> {
  const container = await getContainer();
  const base = safePath(dir);
  const entries = await container.fs.readdir(base, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      path: base === WORKSPACE_ROOT ? `${WORKSPACE_ROOT}/${entry.name}` : `${base}/${entry.name}`,
      dir: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** Recursive listing, depth-limited, skipping node_modules — for the Files tab. */
export async function listTree(root: string = WORKSPACE_ROOT, maxDepth = 3): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= 400) {
      return;
    }
    let entries: FileEntry[] = [];
    try {
      entries = await listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      out.push(entry);
      if (entry.dir) {
        await walk(entry.path, depth + 1);
      }
    }
  };
  await walk(root, 1);
  return out;
}

export async function readTextFile(path: string): Promise<string> {
  const container = await getContainer();
  return container.fs.readFile(safePath(path), 'utf8');
}

export async function writeTextFile(path: string, content: string): Promise<string> {
  const container = await getContainer();
  const target = safePath(path);
  await container.fs.mkdir(parentOf(target), { recursive: true });
  await container.fs.writeFile(target, content, 'utf8');
  return target;
}

// WebContainer 1.6.x exposes preview URLs only through the 'port' and
// 'server-ready' events (there is no synchronous getPreviewUrl), so the URLs are
// recorded as they happen and waiters are drained from that registry.
const previewUrls = new Map<number, string>();
const previewWaiters = new Map<number, Set<(url: string) => void>>();
let listenersWired: Promise<void> | null = null;

async function ensurePreviewListeners(): Promise<void> {
  if (!listenersWired) {
    listenersWired = (async () => {
      const container = await getContainer();
      container.on('port', (port, type, url) => {
        if (type === 'open') {
          previewUrls.set(port, url);
          drain(port, url);
        } else {
          previewUrls.delete(port);
        }
      });
      container.on('server-ready', (port, url) => {
        previewUrls.set(port, url);
        drain(port, url);
      });
    })();
  }
  return listenersWired;
}

function drain(port: number, url: string): void {
  for (const notify of previewWatchers) {
    try {
      notify(port, url);
    } catch {
      // a broken subscriber must never break WebContainer's event loop
    }
  }
  const waiters = previewWaiters.get(port);
  if (!waiters) {
    return;
  }
  previewWaiters.delete(port);
  for (const resolve of waiters) {
    resolve(url);
  }
}

// startPreview() only knows about servers IT spawned. But the agent spawns plenty of
// servers by itself (`node server.js &`), and those fire the same port events — so the
// panel subscribes here and adopts whatever port the sandbox actually opened.
const previewWatchers = new Set<(port: number, url: string) => void>();

export function onPreview(notify: (port: number, url: string) => void): () => void {
  previewWatchers.add(notify);
  void ensurePreviewListeners();
  // Adopt an already-open port too: the agent may have started the server before the
  // Preview tab was ever mounted, and 'port' events do not repeat.
  for (const [port, url] of previewUrls) {
    try {
      notify(port, url);
    } catch {
      // ignore
    }
  }
  return () => {
    previewWatchers.delete(notify);
  };
}

// --- preview issues -------------------------------------------------------
// Known wart: focusing the Preview tab swaps this hidden watcher for the visible iframe,
// so the page reloads once. Cheap compared to the alternative (no error feedback at all).
// Everything the running preview complains about, queued for the next model round.
// Fed to the model rather than only shown in the UI: bolt.diy stops at an alert card,
// but the agent can actually fix these, which is the whole point of having a preview.
const previewIssues: string[] = [];
const previewIssueSeen = new Set<string>();
const previewIssueSubs = new Set<(line: string) => void>();

function describePreviewIssue(message: PreviewMessage): string {
  const where = `:${message.port}${message.pathname || '/'}`;
  if (message.type === PreviewMessageType.ConsoleError) {
    const args = (message.args ?? [])
      .map((a: unknown) => (typeof a === 'string' ? a : String(a)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `console.error (${where}) ${args || '(no args)'}`.slice(0, 500);
  }
  const kind =
    message.type === PreviewMessageType.UnhandledRejection
      ? 'unhandled promise rejection'
      : 'uncaught exception';
  const stack = String(message.stack ?? '')
    .split('\n')
    .slice(1, 4)
    .map((l) => l.trim().replace(/https?:\/\/[^\s)]+/g, '<url>').replace(/^at\s+/, ''))
    .filter(Boolean)
    .join(' at ');
  return `${kind} (${where}) ${message.message}${stack ? ` at ${stack}` : ''}`.slice(0, 500);
}

function wirePreviewMessages(container: WebContainer): void {
  container.on('preview-message', (message: PreviewMessage) => {
    const line = describePreviewIssue(message);
    if (previewIssueSeen.has(line)) {
      return; // an iframe reload re-reports the same error forever
    }
    previewIssueSeen.add(line);
    previewIssues.push(line);
    if (previewIssues.length > 12) {
      previewIssues.shift();
    }
    for (const notify of previewIssueSubs) {
      try {
        notify(line);
      } catch {
        // a broken subscriber must not break the container's event loop
      }
    }
  });
}

export function onPreviewIssue(notify: (line: string) => void): () => void {
  previewIssueSubs.add(notify);
  return () => previewIssueSubs.delete(notify);
}

/** Take everything queued so far (used by the agent loop before it calls the model). */
export function drainPreviewIssues(): string[] {
  return previewIssues.splice(0, previewIssues.length);
}

export function previewUrlFor(port: number): string | null {
  return previewUrls.get(port) ?? null;
}

/**
 * Resolves the container's own preview URL for a port, waiting for it to appear
 * if the dev server has not bound yet. No port scanning, no proxy: the iframe
 * gets this URL and nothing else.
 */
export async function waitForPreview(port: number, timeoutMs = 25_000): Promise<string> {
  await ensurePreviewListeners();
  const immediate = previewUrls.get(port);
  if (immediate) {
    return immediate;
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const set = previewWaiters.get(port);
      set?.delete(waiter);
      reject(new Error(`Nothing is listening on port ${port} after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    const waiter = (url: string) => {
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };
    const set = previewWaiters.get(port) ?? new Set<(url: string) => void>();
    set.add(waiter);
    previewWaiters.set(port, set);
  });
}
