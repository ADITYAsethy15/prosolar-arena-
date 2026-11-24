// ============================================================================
// Workspace persistence (IndexedDB).
//
// A WebContainer's disk lives in the tab: reload and the project is gone. bolt.diy
// persists its file map to IndexedDB and re-mounts it on boot; this does the same
// for Solara, with two differences that follow from the app being stateless:
//
//   * Only *text* files are stored, capped in count and size, so a stray binary or
//     a huge asset cannot bloat the database or blow the quota.
//   * `node_modules` is never stored: it is generated, large, and reinstalling is
//     the documented contract of this sandbox.
//
// Restore happens before any tool runs (see Panel's boot sequence), so a reloaded
// tab gets the project the agent left behind instead of an empty workspace that
// makes the model re-scaffold everything.
// ============================================================================

const DB_NAME = 'solara-project';
const STORE = 'files';
const MAX_FILES = 600;
const MAX_BYTES = 4_000_000;
const SKIP = /(^|\/)(node_modules|\.git|\.cache|dist)\//;

export type StoredProject = {
  id: string;
  files: Record<string, string>;
  savedAt: number;
};

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function saveProject(files: Record<string, string>): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    return false;
  }
  const trimmed: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  for (const [path, content] of Object.entries(files)) {
    if (SKIP.test(path)) {
      continue;
    }
    const size = content.length;
    if (count >= MAX_FILES || bytes + size > MAX_BYTES) {
      continue;
    }
    trimmed[path] = content;
    bytes += size;
    count += 1;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id: 'current', files: trimmed, savedAt: Date.now() } satisfies StoredProject);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function loadProject(): Promise<StoredProject | null> {
  const db = await openDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get('current');
      request.onsuccess = () => resolve((request.result as StoredProject) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The transcript, not just the files. bolt keeps a thread you can scroll back through;
 * a reload that keeps the workspace but throws away the conversation makes the agent
 * look amnesiac about work it just did. Keyed separately so a project reset can keep
 * the thread, and capped hard because this store has no eviction of its own.
 */
const THREAD_ID = 'current-thread';
const MAX_THREAD_EVENTS = 400;

export type StoredThread = {
  id: string;
  events: Array<{ kind: string; at: number; data: unknown }>;
  savedAt: number;
};

export async function saveThread(events: Array<{ kind: string; at: number; data: unknown }>): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    return false;
  }
  const trimmed = events.slice(-MAX_THREAD_EVENTS);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id: THREAD_ID, events: trimmed, savedAt: Date.now() } satisfies StoredThread);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function loadThread(): Promise<StoredThread | null> {
  const db = await openDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(THREAD_ID);
      request.onsuccess = () => resolve((request.result as StoredThread) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function clearThread(): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(THREAD_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearProject(): Promise<void> {
  const db = await openDb();
  if (!db) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Debounced saver: a run touches the store dozens of times per minute. */
export function createAutoSaver(collect: () => Record<string, string>): { schedule: () => void; flush: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> = Promise.resolve();

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const files = collect();
    pending = pending.then(async () => {
      await saveProject(files);
    });
    await pending;
  };

  return {
    schedule() {
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, 1_500);
    },
    flush,
  };
}
