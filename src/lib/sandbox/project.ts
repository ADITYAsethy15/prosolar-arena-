// ============================================================================
// Project store: the tracked view of /workspace that the tool layer works on.
//
// Why a store at all (bolt.diy calls the equivalent `FilesStore` +
// `WorkbenchStore`): the project tools need three things the raw filesystem
// cannot give them cheaply —
//   * `list_paths` without walking node_modules on every call,
//   * a *generation* counter so a tool call that started against one project
//     cannot land its write on the next one,
//   * a serialised mutation queue, so "read revision -> patch -> save" from two
//     concurrent tool calls cannot interleave.
//
// Everything still round-trips through the container filesystem: the map is a
// cache, not the source of truth. `refresh()` rebuilds it from disk.
// ============================================================================
import {
  getContainer,
  listTree,
  mkdir,
  readBytes,
  readTextFile,
  removePath,
  toContainerPath,
  writeTextFile,
} from './container';
import { parentOf, relPath, toVirtualPath, WORKSPACE_ROOT } from './path';

export type ProjectFile =
  | { type: 'file'; content: string; isBinary: boolean; size: number }
  | { type: 'folder' };

export type FileMap = Record<string, ProjectFile | undefined>;

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', '.next']);
const MAX_TRACKED_FILE_BYTES = 512 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Uint8Array): { content: string; isBinary: boolean } {
  try {
    return { content: utf8.decode(bytes), isBinary: false };
  } catch {
    return { content: '', isBinary: true };
  }
}

class ProjectStore {
  #files: FileMap = {};
  #generation = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #loaded: Promise<void> | null = null;
  #subs = new Set<() => void>();
  #termSink: ((chunk: string) => void) | null = null;
  #terminalWanted = false;

  get generation(): number {
    return this.#generation;
  }

  get files(): FileMap {
    return this.#files;
  }

  /** Run a mutation after every mutation already queued (and after model actions). */
  queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Await the queue without adding to it. */
  async drain(): Promise<void> {
    await this.#queue.catch(() => undefined);
  }

  subscribe(handler: () => void): () => void {
    this.#subs.add(handler);
    return () => {
      this.#subs.delete(handler);
    };
  }

  #emit(): void {
    for (const handler of [...this.#subs]) {
      try {
        handler();
      } catch {
        // a broken subscriber must not break a tool call
      }
    }
  }

  /**
   * Called when the project is replaced (a new chat, or an import that wipes the
   * workspace). Tools in flight against the old generation are cancelled by the
   * MCP bridge, and processes belonging to them are killed there.
   */
  bumpGeneration(): number {
    this.#generation += 1;
    this.#emit();
    return this.#generation;
  }

  // --- terminal bus -------------------------------------------------------
  // Tools stream command output into the panel's xterm. The panel may not be
  // mounted yet, so this is a bus with a subscriber set rather than a callback.
  setTerminalSink(sink: ((chunk: string) => void) | null): void {
    this.#termSink = sink;
  }

  writeToTerminal(chunk: string): void {
    try {
      this.#termSink?.(chunk);
    } catch {
      // ignore
    }
  }

  requestTerminal(): void {
    this.#terminalWanted = true;
    this.#emit();
  }

  takeTerminalRequest(): boolean {
    const wanted = this.#terminalWanted;
    this.#terminalWanted = false;
    return wanted;
  }

  // --- loading ------------------------------------------------------------
  /** One-time scan of the workspace into the map. Idempotent and safe to await repeatedly. */
  ensureLoaded(): Promise<void> {
    if (!this.#loaded) {
      this.#loaded = this.refresh().catch((err) => {
        this.#loaded = null;
        throw err;
      });
    }
    return this.#loaded;
  }

  /** Rebuild the map from disk (Files tab refresh, after a zip import, after a reset). */
  async refresh(): Promise<void> {
    const container = await getContainer();
    const next: FileMap = {};
    const walk = async (virtualDir: string, depth: number): Promise<void> => {
      if (depth > 6) {
        return;
      }
      let dirents: Array<{ name: string; isDirectory: () => boolean }>;
      try {
        dirents = (await container.fs.readdir(toContainerPath(virtualDir), {
          withFileTypes: true,
        })) as unknown as Array<{ name: string; isDirectory: () => boolean }>;
      } catch {
        return;
      }
      for (const entry of dirents) {
        const path = `${virtualDir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            continue;
          }
          next[path] = { type: 'folder' };
          await walk(path, depth + 1);
          continue;
        }
        try {
          const bytes = await readBytes(path);
          if (bytes.byteLength > MAX_TRACKED_FILE_BYTES) {
            next[path] = { type: 'file', content: '', isBinary: true, size: bytes.byteLength };
            continue;
          }
          const { content, isBinary } = decode(bytes);
          next[path] = { type: 'file', content, isBinary, size: bytes.byteLength };
        } catch {
          // unreadable: leave it untracked rather than lying about its contents
        }
      }
    };
    await walk(WORKSPACE_ROOT, 0);
    this.#files = next;
    this.#emit();
  }

  /** Cheap top-level listing for the Files tab (skips node_modules, depth-limited). */
  async tree(depth = 3) {
    return listTree(WORKSPACE_ROOT, depth);
  }

  get(path: string): ProjectFile | undefined {
    return this.#files[path];
  }

  /** True when the map has not seen this path yet but disk might (imports, manual writes). */
  async onDisk(path: string): Promise<boolean> {
    try {
      await readTextFile(path);
      return true;
    } catch {
      return false;
    }
  }

  // --- mutations ----------------------------------------------------------
  async createFile(path: string, content: string): Promise<void> {
    await mkdir(parentOf(path));
    await writeTextFile(path, content);
    this.#files[path] = { type: 'file', content, isBinary: false, size: content.length };
    this.#ensureFolderEntry(parentOf(path));
    this.#emit();
  }

  async saveFileContent(path: string, content: string): Promise<void> {
    await writeTextFile(path, content);
    this.#files[path] = { type: 'file', content, isBinary: false, size: content.length };
    this.#ensureFolderEntry(parentOf(path));
    this.#emit();
  }

  async createFolder(path: string): Promise<void> {
    await mkdir(path);
    this.#files[path] = { type: 'folder' };
    this.#ensureFolderEntry(parentOf(path));
    this.#emit();
  }

  async deleteFile(path: string): Promise<void> {
    await removePath(path, false);
    delete this.#files[path];
    this.#emit();
  }

  async deleteFolder(path: string): Promise<void> {
    await removePath(path, true);
    for (const key of Object.keys(this.#files)) {
      if (key === path || key.startsWith(`${path}/`)) {
        delete this.#files[key];
      }
    }
    this.#emit();
  }

  #ensureFolderEntry(dir: string): void {
    if (dir === WORKSPACE_ROOT || this.#files[dir]) {
      return;
    }
    this.#files[dir] = { type: 'folder' };
  }

  /** Reset the map when the workspace is replaced wholesale. */
  async replaceAll(entries: Record<string, string>): Promise<void> {
    for (const key of Object.keys(this.#files)) {
      if (key !== WORKSPACE_ROOT) {
        delete this.#files[key];
      }
    }
    for (const [path, content] of Object.entries(entries)) {
      this.#files[path] = { type: 'file', content, isBinary: false, size: content.length };
      let dir = parentOf(path);
      while (dir !== WORKSPACE_ROOT) {
        this.#ensureFolderEntry(dir);
        dir = parentOf(dir);
      }
    }
    this.#emit();
  }

  // --- locks --------------------------------------------------------------
  // bolt.diy lets a user lock files/folders so the agent cannot touch them. The
  // panel has the same switch; the set is persisted per browser, not per chat,
  // because Solara is stateless.
  #lockedFiles = new Set<string>();
  #lockedFolders = new Set<string>();

  loadLocks(): void {
    try {
      const raw = localStorage.getItem('solara_project_locks');
      const parsed = raw ? (JSON.parse(raw) as { files?: string[]; folders?: string[] }) : null;
      this.#lockedFiles = new Set(parsed?.files ?? []);
      this.#lockedFolders = new Set(parsed?.folders ?? []);
    } catch {
      this.#lockedFiles = new Set();
      this.#lockedFolders = new Set();
    }
  }

  #saveLocks(): void {
    try {
      localStorage.setItem(
        'solara_project_locks',
        JSON.stringify({ files: [...this.#lockedFiles], folders: [...this.#lockedFolders] }),
      );
    } catch {
      // ignore quota errors: the lock still applies for this session
    }
    this.#emit();
  }

  toggleLock(path: string, folder: boolean): void {
    const set = folder ? this.#lockedFolders : this.#lockedFiles;
    if (set.has(path)) {
      set.delete(path);
    } else {
      set.add(path);
    }
    this.#saveLocks();
  }

  isFileLocked(path: string): { locked: boolean; lockedBy?: string } {
    if (this.#lockedFiles.has(path)) {
      return { locked: true };
    }
    for (const folder of this.#lockedFolders) {
      if (path === folder || path.startsWith(`${folder}/`)) {
        return { locked: true, lockedBy: folder };
      }
    }
    return { locked: false };
  }

  isFolderLocked(path: string): { locked: boolean; lockedBy?: string } {
    if (this.#lockedFolders.has(path)) {
      return { locked: true };
    }
    for (const folder of this.#lockedFolders) {
      if (path.startsWith(`${folder}/`)) {
        return { locked: true, lockedBy: folder };
      }
    }
    return { locked: false };
  }

  lockedSummary(): { files: string[]; folders: string[] } {
    return { files: [...this.#lockedFiles], folders: [...this.#lockedFolders] };
  }

  displayPath(path: string): string {
    return relPath(toVirtualPath(path));
  }
}

export const projectStore = new ProjectStore();

/**
 * Adds/overwrites a file exactly as the tools do, so a zip import and an agent
 * write leave the store in the same state (the import path used to bypass it).
 */
export async function importTextFile(path: string, content: string): Promise<void> {
  await projectStore.queue(() => projectStore.saveFileContent(path, content));
}
