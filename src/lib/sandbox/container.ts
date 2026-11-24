// ============================================================================
// WebContainer lifecycle, filesystem, previews and preview-error forwarding.
//
// This module is the single owner of the container instance. Everything above it
// (project store, MCP tool server, terminal, agent loop, panel) talks through
// these functions, so the two-root split in path.ts and the "boot exactly once"
// rule live in exactly one place.
//
// Ported structure from bolt.diy's app/lib/webcontainer/index.ts and
// app/lib/stores/previews.ts, adapted to this app: no Vite HMR data, no
// nanostores, and a path jail that also understands the legacy /workspace form.
// ============================================================================
import { PreviewMessageType, WebContainer, type PreviewMessage } from '@webcontainer/api';
import { parentOf, toContainerPath, toVirtualPath, WORK_DIR_NAME, WORKSPACE_ROOT } from './path';

export { toContainerPath, toVirtualPath } from './path';

export type FileEntry = { name: string; path: string; dir: boolean };

// boot() must happen exactly once for the lifetime of the page. A second call
// throws "Proxy has been released and is not usable" — and StrictMode
// double-mounts, so the guard has to be the promise itself, not a boolean.
let bootPromise: Promise<WebContainer> | null = null;

export function getContainer(): Promise<WebContainer> {
  if (!bootPromise) {
    bootPromise = WebContainer.boot({
      coep: 'credentialless',
      // bolt.diy pins the workdir name too; it keeps `path.relative` results clean and
      // makes the project root addressable as /home/project in tool output.
      workdirName: WORK_DIR_NAME,
      // WebContainer injects a tiny reporter into preview iframes and posts what the
      // page logs/throws back to us. Without this the agent is blind to its own
      // running app: a page that renders but throws on load looks like total success.
      forwardPreviewErrors: true,
    })
      .then((booted) => {
        wirePreviewMessages(booted);
        // Adopt any port a previous page-load opened before the listeners were wired.
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

// --- filesystem -------------------------------------------------------------

export async function listDir(dir: string = WORKSPACE_ROOT): Promise<FileEntry[]> {
  const container = await getContainer();
  const virtual = dir === WORKSPACE_ROOT ? WORKSPACE_ROOT : dir;
  const real = toContainerPath(virtual);
  const entries = await container.fs.readdir(real, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      path: virtual === WORKSPACE_ROOT ? `${WORKSPACE_ROOT}/${entry.name}` : `${virtual}/${entry.name}`,
      dir: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** Recursive listing, depth-limited, skipping node_modules/.git — for the Files tab. */
export async function listTree(root: string = WORKSPACE_ROOT, maxDepth = 3): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= 800) {
      return;
    }
    let entries: FileEntry[] = [];
    try {
      entries = await listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.cache') {
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

export async function readBytes(path: string): Promise<Uint8Array> {
  const container = await getContainer();
  return new Uint8Array(await container.fs.readFile(toContainerPath(path)));
}

export async function readTextFile(path: string): Promise<string> {
  const container = await getContainer();
  return container.fs.readFile(toContainerPath(path), 'utf8');
}

export async function writeTextFile(path: string, content: string): Promise<string> {
  const container = await getContainer();
  const real = toContainerPath(path);
  await container.fs.mkdir(parentOf(real), { recursive: true });
  await container.fs.writeFile(real, content, 'utf8');
  return toVirtualPath(real);
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<string> {
  const container = await getContainer();
  const real = toContainerPath(path);
  await container.fs.mkdir(parentOf(real), { recursive: true });
  await container.fs.writeFile(real, bytes);
  return toVirtualPath(real);
}

export async function mkdir(path: string): Promise<string> {
  const container = await getContainer();
  const real = toContainerPath(path);
  await container.fs.mkdir(real, { recursive: true });
  return toVirtualPath(real);
}

export async function removePath(path: string, recursive = true): Promise<void> {
  const container = await getContainer();
  await container.fs.rm(toContainerPath(path), { recursive, force: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readBytes(path);
    return true;
  } catch {
    return false;
  }
}

// --- previews -----------------------------------------------------------------
// WebContainer 1.6.x exposes preview URLs only through the 'port' and
// 'server-ready' events (there is no synchronous getPreviewUrl), so the URLs are
// recorded as they happen and waiters are drained from that registry.

export type PreviewInfo = { port: number; url: string; ready: boolean };

const previewUrls = new Map<number, string>();
const previewWaiters = new Map<number, Set<(url: string) => void>>();
const previewWatchers = new Set<(info: PreviewInfo[]) => void>();
let listenersWired: Promise<void> | null = null;

function snapshot(): PreviewInfo[] {
  return [...previewUrls.entries()]
    .map(([port, url]) => ({ port, url, ready: true }))
    .sort((a, b) => a.port - b.port);
}

function publish(): void {
  const list = snapshot();
  for (const notify of [...previewWatchers]) {
    try {
      notify(list);
    } catch {
      // a broken subscriber must never break WebContainer's event loop
    }
  }
}

function drain(port: number, url: string): void {
  const waiters = previewWaiters.get(port);
  if (!waiters) {
    return;
  }
  previewWaiters.delete(port);
  for (const resolve of waiters) {
    resolve(url);
  }
}

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
        publish();
      });
      container.on('server-ready', (port, url) => {
        previewUrls.set(port, url);
        drain(port, url);
        publish();
      });
    })();
  }
  return listenersWired;
}

/** Subscribe to the live preview list. Adopts already-open ports immediately. */
export function onPreview(notify: (info: PreviewInfo[]) => void): () => void {
  previewWatchers.add(notify);
  void ensurePreviewListeners();
  try {
    notify(snapshot());
  } catch {
    // ignore
  }
  return () => {
    previewWatchers.delete(notify);
  };
}

export function listPreviews(): PreviewInfo[] {
  return snapshot();
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
      previewWaiters.get(port)?.delete(waiter);
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

// --- preview issues -----------------------------------------------------------
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
    message.type === PreviewMessageType.UnhandledRejection ? 'unhandled promise rejection' : 'uncaught exception';
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
  return () => {
    previewIssueSubs.delete(notify);
  };
}

/** Take everything queued so far (used by the agent loop before it calls the model). */
export function drainPreviewIssues(): string[] {
  return previewIssues.splice(0, previewIssues.length);
}

/** Drop the queue (project replaced, or the user fixed and reloaded the preview). */
export function clearPreviewIssues(): void {
  previewIssues.splice(0, previewIssues.length);
  previewIssueSeen.clear();
}

export function previewIssueCount(): number {
  return previewIssues.length;
}
