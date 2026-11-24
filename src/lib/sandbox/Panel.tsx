import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  Check,
  Download,
  File as FileIcon,
  Folder,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { providerSupportsTools, sandboxUnavailableReason } from './support';
import {
  getContainer,
  listTree,
  onPreview,
  onPreviewIssue,
  readTextFile,
  waitForPreview,
  type FileEntry,
  type PreviewInfo,
} from './container';
import { snapshotWorkspace } from './snapshotWorkspace';
import type { SnapshotResult } from './snapshot';
import { relPath, WORKSPACE_ROOT } from './path';
import { bootWorkspace } from './bootstrap';
import { projectStore } from './project';
import { interactiveShell } from './terminal';
import { runShell } from './runner';
import { createAutoSaver, clearProject } from './persist';
import { closeProjectBridge } from './projectMcp';
import { runAgentTask, setApprovalSink, type AgentEvent } from './loop';
import {
  clampRounds,
  DEFAULT_ROUNDS,
  getRounds,
  MAX_ROUNDS,
  MIN_ROUNDS,
  onAgentTask,
  reportAgentResult,
  saveRounds,
} from './mode';

const AUTO_KEY = 'solara_sandbox_autoapprove';
const TOKENS_KEY = 'solara_sandbox_maxtokens';
// What one turn may spend on its answer. A `project_write_file` call carries the whole
// file as a string inside the assistant message, so a 250-line component needs ~4k
// tokens before it has written a word: at 2048 the JSON broke mid-call and the turn
// ended with finish_reason=length and nothing applied.
const MIN_TOKENS = 500;
const MAX_TOKENS = 32000;
const DEFAULT_TOKENS = 8192;
const clampTokens = (value: unknown) =>
  Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, Math.round(Number(value) || DEFAULT_TOKENS)));
const MAX_ZIP_FILE_BYTES = 600_000;
const MAX_ZIP_FILES = 400;

type Tab = 'activity' | 'files' | 'terminal' | 'preview';

export type SandboxPanelProps = {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
};

type Approval = { tool: string; detail: string; resolve: (ok: boolean) => void };

export default function SandboxPanel({
  open,
  onClose,
  baseUrl,
  apiKey,
  model,
  providerId,
  history,
}: SandboxPanelProps) {
  const [tab, setTab] = useState<Tab>('activity');
  const [status, setStatus] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [treeBusy, setTreeBusy] = useState(false);
  const [treeNote, setTreeNote] = useState('');
  const [viewing, setViewing] = useState<{ path: string; text: string; dirty: boolean } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [previews, setPreviews] = useState<PreviewInfo[]>([]);
  const [previewPort, setPreviewPort] = useState('5173');
  const [snapshot, setSnapshot] = useState<SnapshotResult | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotPhase, setSnapshotPhase] = useState<'bundle' | 'build'>('bundle');
  const [snapshotNote, setSnapshotNote] = useState('');
  const [bigPreview, setBigPreview] = useState(false);
  const [locks, setLocks] = useState(() => projectStore.lockedSummary());
  const [autoApprove, setAutoApprove] = useState<boolean>(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_KEY) === '1',
  );
  const [rounds, setRounds] = useState<string>(() => String(getRounds()));
  const [running, setRunning] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [maxTokens, setMaxTokens] = useState<string>(() => String(clampTokens(localStorage.getItem(TOKENS_KEY))));

  const termRef = useRef<{ write: (line: string) => void } | null>(null);
  const shellHostRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const treeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocked = sandboxUnavailableReason();
  const toolsOk = providerSupportsTools(providerId);

  const autoSaver = useMemo(
    () =>
      createAutoSaver(() => {
        const files: Record<string, string> = {};
        for (const [path, entry] of Object.entries(projectStore.files)) {
          if (entry?.type === 'file' && !entry.isBinary) {
            files[path] = entry.content;
          }
        }
        return files;
      }),
    [],
  );

  const refreshTree = useCallback(async () => {
    setTreeBusy(true);
    try {
      const entries = await listTree(WORKSPACE_ROOT, 4);
      setTree(entries);
      // Silence was the old bug: the click did work, it just never said so, so a refresh
      // that returned the same three files was indistinguishable from a dead button.
      setTreeNote(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      // Keep the old list. Blanking the pane on a failed read reports an empty
      // workspace that does not exist, which is worse than a stale one.
      setTreeNote(`refresh failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      setTreeBusy(false);
    }
  }, []);

  const log = useCallback(
    (event: AgentEvent) => {
      setEvents((prev) => [...prev.slice(-160), event]);
      if (event.kind === 'tool') {
        termRef.current?.write(`\r\n\x1b[36m$\x1b[0m ${event.detail}`);
        if (treeTimer.current) {
          clearTimeout(treeTimer.current);
        }
        treeTimer.current = setTimeout(() => {
          treeTimer.current = null;
          void refreshTree();
          setLocks(projectStore.lockedSummary());
        }, 400);
      } else if (event.kind === 'denied') {
        termRef.current?.write(`(rejected by user: ${event.detail})`);
      } else if (event.kind === 'error') {
        termRef.current?.write(`\x1b[31merror:\x1b[0m ${event.text}`);
      } else if (event.kind === 'gate') {
        termRef.current?.write(`\x1b[33mgate:\x1b[0m next required action — ${event.next}`);
      }
      autoSaver.schedule();
    },
    [refreshTree, autoSaver],
  );

  useEffect(
    () => () => {
      if (treeTimer.current) {
        clearTimeout(treeTimer.current);
      }
    },
    [],
  );

  // Boot lazily: opening the panel is the user gesture, and an unavailable sandbox
  // must never cost a fetch of the WebContainer runtime.
  useEffect(() => {
    if (!open || blocked) {
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus('starting sandbox…');
      try {
        await getContainer();
        const booted = await bootWorkspace();
        if (!cancelled) {
          setStatus('');
          setTreeNote(
            booted.restored
              ? `restored ${booted.restored} file(s) from the last session`
              : `${booted.tracked} file(s) in a fresh workspace`,
          );
          await refreshTree();
          setLocks(projectStore.lockedSummary());
        }
      } catch (err) {
        if (!cancelled) {
          setStatus(`boot failed: ${String((err as Error)?.message ?? err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, blocked]);

  // Track the project so the file list and locks survive any write path (agent, zip,
  // editor) without every caller having to remember to refresh.
  useEffect(() => {
    if (!open) {
      return;
    }
    return projectStore.subscribe(() => {
      autoSaver.schedule();
      setLocks(projectStore.lockedSummary());
      if (projectStore.takeTerminalRequest()) {
        setTab((current) => current);
      }
    });
  }, [open, autoSaver]);

  // Approval plumbing: the loop pauses until the card is answered. Removing the
  // sink on close makes anything pending fail closed instead of hanging.
  useEffect(() => {
    if (!open) {
      setApprovalSink(null);
      setApproval((current) => {
        current?.resolve(false);
        return null;
      });
      return;
    }
    setApprovalSink(
      (request) =>
        new Promise<boolean>((resolve) => {
          if (autoApprove) {
            resolve(true);
            return;
          }
          if (request.signal?.aborted) {
            resolve(false);
            return;
          }
          // Stop must answer the card, not leave the loop parked on a click nobody
          // will ever make.
          request.signal?.addEventListener('abort', () => resolve(false), { once: true });
          setApproval({ tool: request.tool, detail: request.detail, resolve });
        }),
    );
    return () => setApprovalSink(null);
  }, [open, autoApprove]);

  useEffect(() => {
    localStorage.setItem(AUTO_KEY, autoApprove ? '1' : '0');
  }, [autoApprove]);

  useEffect(() => {
    localStorage.setItem(TOKENS_KEY, String(clampTokens(maxTokens)));
  }, [maxTokens]);

  // A turn kept running when its panel went away: the loop carried on spending
  // requests with no UI left to read the answer. Closing the panel stops it now.
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      setRunning(false);
    }
  }, [open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // --- terminal ------------------------------------------------------------
  useEffect(() => {
    if (!open || tab !== 'terminal' || termRef.current || blocked) {
      return;
    }
    let disposed = false;
    let term: { dispose: () => void } | null = null;
    let cleanupResize: (() => void) | null = null;
    let dataSub: { dispose: () => void } | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !shellHostRef.current) {
        return;
      }
      const instance = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 12,
        scrollback: 4000,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#22d3ee' },
      });
      instance.open(shellHostRef.current);
      const fit = new FitAddon();
      instance.loadAddon(fit);
      fit.fit();

      const writeLine = (line: string) => instance.write(line);
      termRef.current = { write: writeLine };

      // The shell is a real /bin/jsh: the user's keystrokes and the agent's commands
      // share one session, which is what makes `cd`, env vars and a running dev server
      // persist across tool calls.
      interactiveShell.attachTerminal({
        write: (chunk) => instance.write(chunk),
        cols: instance.cols,
        rows: instance.rows,
      });
      dataSub = instance.onData((data) => interactiveShell.sendInput(data));
      await interactiveShell.init().catch((err: unknown) => {
        instance.writeln(`\r\n\x1b[31mfailed to start the shell: ${String((err as Error)?.message ?? err)}\x1b[0m`);
      });
      instance.writeln('\x1b[90mSolara sandbox · /bin/jsh in the project root · agent commands appear here too\x1b[0m');
      instance.write('\r\n');

      const onResize = () => fit.fit();
      window.addEventListener('resize', onResize);
      cleanupResize = () => window.removeEventListener('resize', onResize);
      term = { dispose: () => instance.dispose() };
    })();

    return () => {
      disposed = true;
      cleanupResize?.();
      dataSub?.dispose();
      interactiveShell.attachTerminal(null);
      term?.dispose();
      termRef.current = null;
    };
  }, [open, tab, blocked]);

  // --- previews ------------------------------------------------------------
  useEffect(() => {
    if (!open) {
      return;
    }
    return onPreview((list) => {
      setPreviews(list);
      if (list.length > 0) {
        setPreviewPort((current) => (list.some((entry) => String(entry.port) === current) ? current : String(list[0].port)));
      }
    });
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    return onPreviewIssue((line) => setIssues((prev) => [...prev.slice(-6), line]));
  }, [open]);

  const activePreview = previews.find((entry) => String(entry.port) === previewPort)?.url ?? '';

  const startPreview = async () => {
    const port = Number(previewPort) || 5173;
    setStatus(`starting dev server on :${port}…`);
    try {
      const container = await getContainer();
      // Deliberately not awaited: a dev server exits only when it dies.
      void container
        .spawn('npx', ['vite', '--port', String(port), '--host'], {
          cwd: '/home/project',
          env: { FORCE_COLOR: '0' },
        })
        .catch((err: unknown) => setStatus(`spawn failed: ${String((err as Error)?.message ?? err)}`));
      const url = await waitForPreview(port);
      setPreviews((prev) => (prev.some((entry) => entry.port === port) ? prev : [...prev, { port, url, ready: true }]));
      setStatus('');
    } catch (err) {
      setStatus(String((err as Error)?.message ?? err));
    }
  };

  const openStandalone = async (buildFirst = false) => {
    setSnapshotBusy(true);
    setSnapshotPhase(buildFirst ? 'build' : 'bundle');
    setSnapshotNote(buildFirst ? 'building in the container first (npm run build)…' : '');
    try {
      const result = await snapshotWorkspace({ buildFirst });
      const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html' }));
      if (snapshotUrl) {
        URL.revokeObjectURL(snapshotUrl);
      }
      setSnapshot(result);
      setSnapshotUrl(url);
      const opened = window.open(url, '_blank');
      const dangling = result.skipped.filter((entry) => entry.ref !== 'build');
      const parts = [
        `${result.entry.replace('/workspace/', '')} + ${result.inlined.length} file(s) inlined`,
        result.stylesHoisted > 0 ? `${result.stylesHoisted} stylesheet(s) hoisted out of JS` : '',
        dangling.length
          ? `${dangling.length} left as-is (${dangling[0].reason}${dangling.length > 1 ? `, +${dangling.length - 1} more` : ''})`
          : 'nothing left dangling',
        `${Math.round(result.bytes / 1024)} KB`,
      ].filter(Boolean);
      if (result.needsBuild && !buildFirst) {
        parts.push('this entry needs a bundler — use build then open');
      }
      if (!opened) {
        parts.push('popup blocked — use save .html');
      }
      setSnapshotNote(parts.join(' · '));
    } catch (err) {
      setSnapshotNote(String((err as Error)?.message ?? err).slice(0, 400));
    } finally {
      setSnapshotBusy(false);
    }
  };

  useEffect(() => {
    if (!bigPreview) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBigPreview(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bigPreview]);

  // --- actions -------------------------------------------------------------
  const answer = (ok: boolean) => {
    approval?.resolve(ok);
    setApproval(null);
  };

  /**
   * Stop covers all three phases: the loop checks the signal before every round and
   * every call, the runner kills the running process on it, and the approval card is
   * resolved as a rejection by the same signal — so nothing can be left parked.
   */
  const stopTask = () => {
    abortRef.current?.abort();
    setApproval(null);
    setStatus('stopping…');
  };

  const runTask = async (textOverride?: string) => {
    const text = (textOverride ?? prompt).trim();
    if (!text) {
      return;
    }
    if (running) {
      setStatus('agent is busy — stop the current task first');
      return;
    }
    const budget = clampRounds(rounds);
    if (String(budget) !== rounds) {
      setRounds(String(saveRounds(budget)));
    }
    let stats = { roundsUsed: 0, roundsAllowed: budget, upstreamCalls: 0 };
    setRunning(true);
    setStatus('agent running…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reply = await runAgentTask({
        prompt: text,
        history,
        baseUrl,
        apiKey,
        model,
        maxTokens: clampTokens(maxTokens),
        maxRounds: budget,
        emit: log,
        onStats: (next) => {
          stats = next;
        },
        signal: controller.signal,
      });
      await refreshTree();
      await autoSaver.flush();
      setStatus('');
      if (reply?.trim()) {
        reportAgentResult({ text: reply.trim(), ...stats });
      }
    } catch (err) {
      setStatus(String((err as Error)?.message ?? err));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const runTaskRef = useRef(runTask);
  runTaskRef.current = runTask;

  useEffect(() => onAgentTask((text) => void runTaskRef.current(text)), []);

  // --- file operations -----------------------------------------------------
  const exportZip = async () => {
    setStatus('zipping…');
    try {
      const zip = new JSZip();
      const entries = (await listTree(WORKSPACE_ROOT, 12)).filter((entry) => !entry.dir);
      let added = 0;
      for (const entry of entries.slice(0, MAX_ZIP_FILES)) {
        try {
          const text = await readTextFile(entry.path);
          if (text.length > MAX_ZIP_FILE_BYTES) {
            continue;
          }
          zip.file(relPath(entry.path), text);
          added += 1;
        } catch {
          // binary or unreadable: skipped, this workspace is text-first by design
        }
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'solara-project.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus(`exported ${added} files`);
    } catch (err) {
      setStatus(`export failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

  const importZip = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setStatus('importing…');
    try {
      // A different project replaces this one wholesale: processes from the old
      // project must not keep running against files that no longer exist.
      await closeProjectBridge();
      projectStore.bumpGeneration();
      const zip = await JSZip.loadAsync(file);
      let count = 0;
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || count >= MAX_ZIP_FILES || /(^|\/)(node_modules|\.git)\//.test(entry.name)) {
          continue;
        }
        const text = await entry.async('string');
        if (text.length > MAX_ZIP_FILE_BYTES) {
          continue;
        }
        try {
          await projectStore.queue(() => projectStore.saveFileContent(`/workspace/${entry.name.replace(/^\/+/, '')}`, text));
          count += 1;
        } catch {
          // unsafe path inside the archive (e.g. ../) — skipped, not fatal
        }
      }
      await refreshTree();
      await autoSaver.flush();
      setStatus(`imported ${count} files`);
    } catch (err) {
      setStatus(`import failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

  const resetProject = async () => {
    if (!window.confirm('Delete every file in this workspace? The container is reset and unsaved work is lost.')) {
      return;
    }
    setStatus('resetting…');
    try {
      await closeProjectBridge();
      const container = await getContainer();
      const entries = await container.fs.readdir('/home/project');
      for (const name of entries) {
        await container.fs.rm(`/home/project/${name}`, { recursive: true, force: true });
      }
      await clearProject();
      projectStore.bumpGeneration();
      await projectStore.refresh();
      await bootWorkspace();
      interactiveShell.dispose();
      setEvents([]);
      setIssues([]);
      await refreshTree();
      setStatus('workspace reset');
    } catch (err) {
      setStatus(`reset failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

  const openFile = async (path: string) => {
    try {
      setViewing({ path, text: (await readTextFile(path)).slice(0, 200_000), dirty: false });
    } catch (err) {
      setViewing({ path, text: `unreadable (binary?): ${String((err as Error)?.message ?? err)}`, dirty: false });
    }
  };

  const saveViewing = async () => {
    if (!viewing) {
      return;
    }
    try {
      await projectStore.queue(() => projectStore.saveFileContent(viewing.path, viewing.text));
      await autoSaver.flush();
      setViewing({ ...viewing, dirty: false });
      setStatus(`saved ${relPath(viewing.path)}`);
    } catch (err) {
      setStatus(`save failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

  const runInTerminal = async (command: string) => {
    setTab('terminal');
    await new Promise((r) => setTimeout(r, 120));
    interactiveShell.write(`\r\n\x1b[36m$\x1b[0m ${command}\r\n`);
    const result = await runShell(command, {
      onOutput: (chunk) => interactiveShell.write(chunk),
      timeoutMs: 120_000,
    });
    interactiveShell.write(`\x1b[90m[exit ${result.exitCode}]\x1b[0m\r\n`);
    autoSaver.schedule();
    await refreshTree();
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[560px] flex-col border-l border-zinc-800 bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-zinc-100">Sandbox</p>
            <p className="truncate text-[11px] text-zinc-500">
              WebContainer · /bin/jsh + project MCP · {model || 'no model'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {blocked ? (
          <div className="m-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200">
            <p className="font-semibold">Sandbox unavailable</p>
            <p className="mt-1 text-amber-200/80">{blocked}</p>
            <a
              href={window.location.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-cyan-300 underline"
            >
              Open Solara in a new tab
            </a>
          </div>
        ) : (
          <>
            <nav className="flex items-center gap-1 border-b border-zinc-800 px-3 py-2 text-xs">
              {(['activity', 'files', 'terminal', 'preview'] as Tab[]).map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setTab(name)}
                  className={`rounded-lg px-2.5 py-1 capitalize transition-colors ${
                    tab === name ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {name}
                  {name === 'preview' && previews.length > 0 && (
                    <span className="ml-1 text-[9px] text-cyan-400">{previews.length}</span>
                  )}
                  {name === 'activity' && issues.length > 0 && (
                    <span className="ml-1 rounded bg-rose-500/20 px-1 text-[9px] text-rose-300">{issues.length}</span>
                  )}
                </button>
              ))}
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
                <input
                  type="checkbox"
                  className="accent-cyan-500"
                  checked={autoApprove}
                  onChange={(event) => setAutoApprove(event.target.checked)}
                />
                auto-approve
              </label>
            </nav>

            {approval && (
              <div className="border-b border-rose-500/40 bg-rose-500/10 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-300">
                  approve {approval.tool.replace('project_', '').replace('_', ' ')}?
                </p>
                <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/50 p-2 font-mono text-[11px] text-rose-100">
                  {approval.detail}
                </pre>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => answer(true)}
                    className="rounded-lg bg-rose-500/80 px-3 py-1 text-[11px] font-bold text-white hover:bg-rose-500"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => answer(false)}
                    className="rounded-lg bg-zinc-800 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
              {tab === 'activity' && (
                <div className="space-y-1.5 p-3">
                  {issues.length > 0 && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2">
                      <p className="text-[10px] uppercase tracking-wide text-rose-300">preview reported</p>
                      {issues.map((line, index) => (
                        <p key={`${index}-${line}`} className="mt-1 font-mono text-[10px] text-rose-200/80">
                          {line}
                        </p>
                      ))}
                    </div>
                  )}
                  {events.length === 0 && (
                    <p className="p-2 text-xs text-zinc-600">
                      No activity yet. Start with something concrete — &quot;scaffold a Vite + React counter app, then
                      visit the preview&quot;. The agent plans, writes, runs and checks its own work before it is
                      allowed to say it is done.
                    </p>
                  )}
                  {events.map((event, index) => (
                    <ActivityRow key={`${index}-${event.kind}`} event={event} />
                  ))}
                </div>
              )}

              {tab === 'files' && (
                <div className="p-3">
                  <div className="mb-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void refreshTree()}
                      disabled={treeBusy}
                      className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                      title="Re-read the project from disk. The list also updates itself after every tool call."
                    >
                      <RefreshCw className={`h-3 w-3 ${treeBusy ? 'animate-spin' : ''}`} />{' '}
                      {treeBusy ? 'reading…' : 'refresh'}
                    </button>
                    <button
                      type="button"
                      onClick={exportZip}
                      className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
                    >
                      <Download className="h-3 w-3" /> export .zip
                    </button>
                    <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700">
                      <Upload className="h-3 w-3" /> import .zip
                      <input
                        type="file"
                        accept=".zip"
                        className="hidden"
                        onChange={(event) => void importZip(event.target.files?.[0])}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void resetProject()}
                      className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20"
                      title="Delete every file in this workspace and start a fresh project."
                    >
                      <Trash2 className="h-3 w-3" /> reset
                    </button>
                  </div>
                  {treeNote && <p className="mb-1.5 font-mono text-[10px] text-zinc-600">{treeNote}</p>}
                  <ul className="space-y-0.5 font-mono text-[11px]">
                    {tree.map((entry) => {
                      const locked =
                        (entry.dir ? projectStore.isFolderLocked(entry.path) : projectStore.isFileLocked(entry.path))
                          .locked;
                      return (
                        <li key={entry.path} className="group flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => (entry.dir ? setTab('terminal') : void openFile(entry.path))}
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-zinc-900"
                          >
                            {entry.dir ? (
                              <Folder className="h-3 w-3 shrink-0 text-cyan-400" />
                            ) : (
                              <FileIcon className="h-3 w-3 shrink-0 text-zinc-500" />
                            )}
                            <span className={entry.dir ? 'truncate text-zinc-300' : 'truncate text-zinc-400'}>
                              {relPath(entry.path)}
                            </span>
                            {locked && <Lock className="h-2.5 w-2.5 shrink-0 text-amber-400" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              projectStore.toggleLock(entry.path, entry.dir);
                              setLocks(projectStore.lockedSummary());
                            }}
                            className="rounded px-1 text-[10px] text-zinc-600 opacity-0 hover:text-amber-300 group-hover:opacity-100"
                            title={locked ? 'Unlock: allow the agent to change this' : 'Lock: forbid the agent from changing this'}
                          >
                            {locked ? 'unlock' : 'lock'}
                          </button>
                        </li>
                      );
                    })}
                    {tree.length === 0 && <li className="px-1.5 text-zinc-600">(empty workspace)</li>}
                  </ul>
                  {(locks.files.length > 0 || locks.folders.length > 0) && (
                    <p className="mt-2 text-[10px] text-amber-300/80">
                      {locks.files.length + locks.folders.length} path(s) locked — the agent&apos;s writes to them are
                      refused with an error it can read.
                    </p>
                  )}
                  {viewing && (
                    <div className="mt-3 rounded-lg border border-zinc-800 bg-black/40">
                      <div className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1">
                        <span className="truncate font-mono text-[10px] text-zinc-500">{relPath(viewing.path)}</span>
                        {viewing.dirty && <span className="text-[9px] text-amber-400">unsaved</span>}
                        <button
                          type="button"
                          onClick={() => void saveViewing()}
                          disabled={!viewing.dirty}
                          className="ml-auto flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
                        >
                          <Save className="h-2.5 w-2.5" /> save
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewing(null)}
                          className="text-zinc-600 hover:text-zinc-300"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <textarea
                        value={viewing.text}
                        onChange={(event) => setViewing({ ...viewing, text: event.target.value, dirty: true })}
                        spellCheck={false}
                        className="h-72 w-full resize-y bg-transparent p-2 font-mono text-[11px] text-zinc-300 focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              )}

              {tab === 'terminal' && (
                <div className="flex h-full min-h-[320px] flex-col">
                  <div className="flex flex-wrap gap-1.5 border-b border-zinc-800 px-2 py-1.5">
                    {['ls', 'cat package.json', 'npm install', 'node --version'].map((command) => (
                      <button
                        key={command}
                        type="button"
                        onClick={() => void runInTerminal(command)}
                        className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                      >
                        {command}
                      </button>
                    ))}
                    <span className="ml-auto text-[10px] text-zinc-600">type below · real shell</span>
                  </div>
                  <div ref={shellHostRef} className="min-h-[300px] w-full flex-1 bg-[#09090b] p-2" />
                </div>
              )}

              {/* Error forwarding only happens while the page is actually loaded, so keep a
                  1px invisible copy mounted when you are on another tab — otherwise the agent
                  fixes a page it never saw run and "it works" is a guess. */}
              {activePreview && tab !== 'preview' && (
                <iframe
                  title="Sandbox preview (watching)"
                  src={activePreview}
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none absolute h-px w-px opacity-0"
                  sandbox="allow-scripts allow-same-origin"
                />
              )}

              {tab === 'preview' && (
                <div className="flex h-full flex-col p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <select
                      value={previewPort}
                      onChange={(event) => setPreviewPort(event.target.value)}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200"
                    >
                      {(previews.length ? previews : [{ port: Number(previewPort) || 5173, url: '', ready: false }]).map(
                        (entry) => (
                          <option key={entry.port} value={String(entry.port)}>
                            :{entry.port}
                          </option>
                        ),
                      )}
                    </select>
                    <input
                      value={previewPort}
                      onChange={(event) => setPreviewPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
                      className="w-16 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200"
                      title="Port to adopt. Any port the agent opens is picked up automatically."
                    />
                    <button
                      type="button"
                      onClick={startPreview}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-cyan-500"
                    >
                      <Play className="h-3 w-3" /> serve
                    </button>
                    <button
                      type="button"
                      disabled={!activePreview || bigPreview}
                      onClick={() => setBigPreview(true)}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
                      title="Enlarge the preview to fill the window. It stays inside this tab, which is what keeps it alive."
                    >
                      fullscreen
                    </button>
                    <button
                      type="button"
                      disabled={snapshotBusy}
                      onClick={() => void openStandalone(true)}
                      className="rounded-lg border border-cyan-800/60 bg-cyan-950/40 px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-40"
                      title="Build in the container and snapshot dist/ into one self-contained .html you can open anywhere."
                    >
                      {snapshotBusy && snapshotPhase === 'build' ? 'building…' : 'build + open'}
                    </button>
                    {snapshot && snapshotUrl && (
                      <a
                        href={snapshotUrl}
                        download="preview-standalone.html"
                        className="self-center text-[11px] text-zinc-400 underline hover:text-zinc-200"
                      >
                        save .html
                      </a>
                    )}
                    {activePreview && (
                      <a
                        href={activePreview}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate self-center text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-300"
                        title="Only answers while THIS tab is alive and holding the container."
                      >
                        raw URL
                      </a>
                    )}
                  </div>
                  {snapshotNote && <p className="mb-2 text-[11px] text-zinc-500">{snapshotNote}</p>}
                  {activePreview && !bigPreview ? (
                    <iframe
                      title="Sandbox preview"
                      src={activePreview}
                      className="min-h-[360px] w-full flex-1 rounded-lg border border-zinc-800 bg-white"
                      // allow-same-origin is required, not optional: without it the framed
                      // preview gets an opaque origin, so WebContainer cannot register its
                      // service worker and StackBlitz answers "Enable Storage Partitioning"
                      // instead of the page (measured). The origin it is same-origin with is
                      // the container's own preview host, never this page's.
                      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads"
                    />
                  ) : activePreview ? (
                    <div className="fixed inset-0 z-50 flex flex-col bg-black">
                      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
                        <span className="truncate font-mono text-[11px] text-zinc-500">{activePreview}</span>
                        <span className="shrink-0 text-[11px] text-zinc-600">container preview · Esc to return</span>
                        <button
                          type="button"
                          onClick={() => setBigPreview(false)}
                          className="ml-auto shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
                        >
                          close
                        </button>
                      </div>
                      <iframe
                        title="Sandbox preview (fullscreen)"
                        src={activePreview}
                        className="w-full flex-1 bg-white"
                        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-600">
                      No preview yet. Any server the agent starts on a port is picked up here automatically; or press
                      serve to run <span className="font-mono">npx vite</span> in the project. The iframe loads the
                      container&apos;s own origin, never this page&apos;s.
                    </p>
                  )}
                </div>
              )}
            </div>

            <footer className="border-t border-zinc-800 p-3">
              {!toolsOk && (
                <p className="mb-2 rounded-lg bg-amber-500/10 p-2 text-[11px] text-amber-300">
                  The {providerId} provider path in Solara does not use OpenAI-style tool calls, so the agent loop is
                  disabled. Switch to OpenRouter, Groq, NVIDIA, Z.AI or a custom endpoint.
                </p>
              )}
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void runTask();
                  }
                }}
                rows={2}
                placeholder="Ask the sandbox to build or test something… (Ctrl/Cmd+Enter to run)"
                className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                  max tokens
                  <input
                    type="number"
                    min={MIN_TOKENS}
                    max={MAX_TOKENS}
                    step={1024}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value.replace(/\D/g, ''))}
                    onBlur={() => setMaxTokens(String(clampTokens(maxTokens)))}
                    className="w-16 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300"
                    title={`Tokens the model may spend on ONE answer (${MIN_TOKENS}–${MAX_TOKENS.toLocaleString()}). A file write carries the whole file in that answer.`}
                  />
                </label>
                <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                  tool calls
                  <input
                    type="number"
                    min={MIN_ROUNDS}
                    max={MAX_ROUNDS}
                    value={rounds}
                    onChange={(event) => setRounds(event.target.value.replace(/\D/g, ''))}
                    onBlur={() => setRounds(String(saveRounds(rounds)))}
                    className="w-10 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300"
                    title={`How many tool calls the agent may make before it must answer (${MIN_ROUNDS}–${MAX_ROUNDS}, default ${DEFAULT_ROUNDS}). Each step is one request to your provider.`}
                  />
                </label>
                <button
                  type="button"
                  disabled={running || !prompt.trim() || !apiKey || !model || !baseUrl || !toolsOk}
                  onClick={() => void runTask()}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  {running ? 'running' : 'run task'}
                </button>
                {running && (
                  <button
                    type="button"
                    onClick={stopTask}
                    title="Interrupt everything the agent is doing: the model request, the command it is running, and the approval prompt if it is parked on one."
                    className="flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
                  >
                    <Square className="h-2.5 w-2.5" /> stop
                  </button>
                )}
                {status && <span className="truncate text-[11px] text-zinc-500">{status}</span>}
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function ActivityRow({ event }: { event: AgentEvent }) {
  if (event.kind === 'round') {
    return (
      <p className="px-1.5 pt-2 text-[10px] uppercase tracking-wide text-zinc-600">
        round {event.round} of {event.limit}
      </p>
    );
  }
  if (event.kind === 'text') {
    return (
      <p className="whitespace-pre-wrap rounded-lg bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-300">
        {event.text}
      </p>
    );
  }
  if (event.kind === 'error') {
    return <p className="rounded-lg bg-rose-500/10 p-2 text-[11px] text-rose-300">{event.text}</p>;
  }
  if (event.kind === 'gate') {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200">
        <p className="flex items-center gap-1 font-semibold">
          <RotateCcw className="h-3 w-3" /> completion gate: not done yet
        </p>
        <ul className="mt-1 space-y-0.5 text-amber-200/80">
          {event.problems.map((problem) => (
            <li key={problem}>· {problem}</li>
          ))}
        </ul>
        <p className="mt-1 text-amber-200/60">next: {event.next}</p>
      </div>
    );
  }
  if (event.kind === 'log' || event.kind === 'denied') {
    return (
      <p className="px-1.5 text-[11px] text-zinc-500">
        {event.kind === 'denied' ? `rejected: ${event.detail}` : event.text}
      </p>
    );
  }
  return (
    <details className="group rounded-lg border border-zinc-800 bg-black/30">
      <summary className="cursor-pointer list-none px-2 py-1.5 font-mono text-[11px] text-zinc-300">
        <span className="text-zinc-600">▸ </span>
        <span className={event.ok ? 'text-cyan-400' : 'text-rose-400'}>{event.tool}</span>{' '}
        <span className="text-zinc-500">{event.detail.slice(0, 160)}</span>
        {event.ok && <Check className="ml-1 inline h-2.5 w-2.5 text-emerald-500" />}
      </summary>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-zinc-800 p-2 font-mono text-[10px] text-zinc-400">
        {event.output}
      </pre>
    </details>
  );
}
