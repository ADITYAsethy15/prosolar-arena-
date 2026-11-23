import { useCallback, useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  Download,
  File as FileIcon,
  Folder,
  Loader2,
  Play,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import { providerSupportsTools, sandboxUnavailableReason } from './support';
import {
  getContainer,
  listTree,
  onPreview,
  readTextFile,
  snapshotWorkspace,
  waitForPreview,
  writeTextFile,
  type FileEntry,
} from './container';
import type { SnapshotResult } from './snapshot';
import { relPath } from './path';
import { ensureWorkspace } from './project';
import { runShell } from './runner';
import {
  resolveApproval,
  runAgentTurn,
  setApprovalSink,
  type AgentEvent,
} from './tools';
import {
  clampRounds,
  getRounds,
  MAX_ROUNDS,
  MIN_ROUNDS,
  onAgentTask,
  reportAgentResult,
  saveRounds,
} from './mode';

const AUTO_KEY = 'solara_sandbox_autoapprove';
const TOKENS_KEY = 'solara_sandbox_maxtokens';
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

type Approval = { id: string; tool: string; detail: string };

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
  const [status, setStatus] = useState<string>('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [treeBusy, setTreeBusy] = useState(false);
  const [treeNote, setTreeNote] = useState('');
  const [viewing, setViewing] = useState<{ path: string; text: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [snapshot, setSnapshot] = useState<SnapshotResult | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotNote, setSnapshotNote] = useState('');
  const [bigPreview, setBigPreview] = useState(false);
  const [previewPort, setPreviewPort] = useState('5173');
  const [autoApprove, setAutoApprove] = useState<boolean>(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_KEY) === '1',
  );
  const [rounds, setRounds] = useState<string>(() => String(getRounds()));
  const [running, setRunning] = useState(false);

  // Some reasoning models are better with a SMALL budget: given 16k they can spend
  // all of it deliberating and return nothing (measured live: reasoning_tokens 16384,
  // finish_reason=length, no tool call), while 1-2k pushes them to call a tool.
  const [maxTokens, setMaxTokens] = useState<string>(
    () => localStorage.getItem(TOKENS_KEY) || '2048',
  );
  const termRef = useRef<{ write: (line: string) => void } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A run touches the filesystem dozens of times; refreshing on every event would hammer
  // WebContainer's fs, so the tool events coalesce into one read a beat later.
  const treeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocked = sandboxUnavailableReason();
  const toolsOk = providerSupportsTools(providerId);

  const refreshTree = useCallback(async () => {
    setTreeBusy(true);
    try {
      const entries = await listTree();
      setTree(entries);
      // Silence was the bug: the click did work, it just never said so, so a refresh that
      // returned the same three files was indistinguishable from a dead button.
      setTreeNote(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      // Keep the old list. Blanketing the pane on a failed read reports an empty workspace
      // that does not exist, which is worse than a stale one.
      setTreeNote(`refresh failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      setTreeBusy(false);
    }
  }, []);

  const log = useCallback((event: AgentEvent) => {
    setEvents((prev) => [...prev.slice(-120), event]);
    if (event.kind === 'tool' || event.kind === 'error' || event.kind === 'denied') {
      if (event.kind !== 'error') {
        termRef.current?.write(`$ ${event.detail}`);
      }
      if (event.kind === 'tool') {
        termRef.current?.write(event.output.slice(0, 4000));
        // Files used to catch up only when the whole task ended, which is why the list looked
        // frozen (and refresh looked broken) during a long run.
        if (treeTimer.current) {
          clearTimeout(treeTimer.current);
        }
        treeTimer.current = setTimeout(() => {
          treeTimer.current = null;
          void refreshTree();
        }, 350);
      } else if (event.kind === 'denied') {
        termRef.current?.write('(rejected by user)');
      } else {
        termRef.current?.write(`error: ${event.text}`);
      }
    }
  }, [refreshTree]);

  useEffect(
    () => () => {
      if (treeTimer.current) {
        clearTimeout(treeTimer.current);
      }
    },
    [],
  );

  // Boot lazily: opening the panel is the user gesture, and an unavailable
  // sandbox must never cost a fetch of the WebContainer runtime.
  useEffect(() => {
    if (!open || blocked) {
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus('starting sandbox…');
      try {
        await getContainer();
        await ensureWorkspace();
        if (!cancelled) {
          setStatus('');
          await refreshTree();
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

  // Approval plumbing: the loop pauses until the card is answered. Removing the
  // sink on close makes anything pending fail closed instead of hanging.
  useEffect(() => {
    if (!open) {
      setApprovalSink(null);
      setApproval(null);
      return;
    }
    setApprovalSink((request) => {
      if (autoApprove) {
        resolveApproval(request.id, true);
        return;
      }
      setApproval(request);
    });
    return () => setApprovalSink(null);
  }, [open, autoApprove]);

  useEffect(() => {
    localStorage.setItem(AUTO_KEY, autoApprove ? '1' : '0');
  }, [autoApprove]);

  // A turn kept running when its panel went away: the loop carried on spending requests with no
  // UI left to read the answer. Closing the panel, or unmounting it, stops it now.
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      setRunning(false);
    }
  }, [open]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const safe = String(Number(maxTokens) || 2048).slice(0, 6);
    localStorage.setItem(TOKENS_KEY, safe);
  }, [maxTokens]);



  // --- terminal (xterm loaded only when that tab is open) ------------------
  useEffect(() => {
    if (!open || tab !== 'terminal' || termRef.current || blocked) {
      return;
    }
    let disposed = false;
    let term: { dispose: () => void } | null = null;
    let resizeCleanup: (() => void) | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !hostRef.current) {
        return;
      }
      const instance = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 12,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        theme: { background: '#09090b', foreground: '#e4e4e7' },
      });
      instance.open(hostRef.current);
      const fit = new FitAddon();
      instance.loadAddon(fit);
      fit.fit();

      const writeLine = (line: string) => {
        for (const part of String(line).split('\n')) {
          instance.writeln(part);
        }
      };
      const promptLine = () => instance.write('\r\n\x1b[1;36m/workspace$\x1b[0m ');
      instance.writeln('sandbox shell — runs in /workspace. Agent commands appear here too.');
      promptLine();

      let buffer = '';
      instance.onData((data) => {
        if (data === '\r') {
          const cmd = buffer.trim();
          buffer = '';
          instance.write('\r\n');
          if (cmd) {
            void run(cmd);
          } else {
            promptLine();
          }
          return;
        }
        if (data === '\x7f' || data === '\b') {
          buffer = buffer.slice(0, -1);
          instance.write('\b \b');
          return;
        }
        if (data === '\u0003') {
          buffer = '';
          instance.write('^C\r\n');
          promptLine();
          return;
        }
        if (data >= ' ') {
          buffer += data;
          instance.write(data);
        }
      });

      const run = async (cmd: string) => {
        const res = await runShell(cmd);
        writeLine(res.output);
        writeLine(`[exit ${res.exitCode}]`);
        promptLine();
      };

      term = { dispose: () => instance.dispose() };
      termRef.current = { write: writeLine };
      const onResize = () => fit.fit();
      window.addEventListener('resize', onResize);
      resizeCleanup = () => window.removeEventListener('resize', onResize);
    })();
    return () => {
      disposed = true;
      resizeCleanup?.();
      term?.dispose();
      termRef.current = null;
    };
  }, [open, tab, blocked]);

  // A snapshot is a blob URL we own, so it must be revoked when replaced, not leaked.
  const openStandalone = async () => {
    setSnapshotBusy(true);
    setSnapshotNote('');
    try {
      const result = await snapshotWorkspace();
      const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html' }));
      if (snapshotUrl) {
        URL.revokeObjectURL(snapshotUrl);
      }
      setSnapshot(result);
      setSnapshotUrl(url);
      const opened = window.open(url, '_blank');
      const parts = [
        `${result.entry.replace('/workspace/', '')} + ${result.inlined.length} file(s) inlined`,
        result.skipped.length ? `${result.skipped.length} left as-is` : 'nothing left dangling',
        `${Math.round(result.bytes / 1024)} KB`,
      ];
      if (!opened) {
        parts.push('popup blocked — use save .html');
      }
      setSnapshotNote(parts.join(' · '));
    } catch (err) {
      setSnapshotNote(String((err as Error)?.message ?? err));
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
    if (approval) {
      resolveApproval(approval.id, ok);
    }
    setApproval(null);
  };

  /**
   * Stop used to be `abortRef.current?.abort()` alone, which only interrupts the in-flight
   * model request: a tool round ran to its own timeout (up to 300s for an install) and an
   * unanswered approval card stayed up forever. That is the report being fixed — "the stop
   * button is not working". All three phases are covered now: the loop checks the signal,
   * askApproval resolves a pending prompt as a rejection on it, runShell kills the process on
   * it. The card itself is cleared by the same signal (askApproval resolves on abort), so it
   * cannot outlive the turn that raised it — and no other turn's prompt is touched.
   */
  const stopTask = () => {
    abortRef.current?.abort();
    setApproval(null);
    setStatus('stopping…');
  };

  // `textOverride` lets the composer's Agent mode drive a task without the user
  // retyping it into this panel.
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
    let stats = { roundsUsed: 0, roundsAllowed: budget };
    setRunning(true);
    setStatus('agent running…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const answer = await runAgentTurn({
        prompt: text,
        history,
        baseUrl,
        apiKey,
        model,
        maxTokens: Number(maxTokens) || undefined,
        maxRounds: budget,
        onStats: (next) => {
          stats = next;
        },
        emit: log,
        signal: controller.signal,
      });
      await refreshTree();
      setStatus('');
      // Hand the result to the chat transcript (App.tsx subscribes) so an agent
      // reply is readable where the question was asked, with its real cost.
      if (answer?.trim()) {
        reportAgentResult({ text: answer.trim(), ...stats });
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

  useEffect(
    () =>
      onAgentTask((text) => {
        void runTaskRef.current(text);
      }),
    [],
  );

  // Adopt any port the agent opened itself, so a backgrounded server shows up without
  // the user having to type a port and press serve.
  useEffect(() => {
    let alive = true;
    const off = onPreview((port, url) => {
      if (!alive) {
        return;
      }
      setPreviewPort(String(port));
      setPreviewUrl((prev) => prev || url);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const startPreview = async () => {
    const port = Number(previewPort) || 5173;
    setStatus(`starting dev server on :${port}…`);
    try {
      const container = await getContainer();
      // Deliberately not awaited: a dev server exits only when it dies.
      void container
        .spawn('npx', ['vite', '--port', String(port), '--host'], {
          cwd: '/workspace',
          env: { FORCE_COLOR: '0' },
        })
        .catch((err: unknown) => setStatus(`spawn failed: ${String((err as Error)?.message ?? err)}`));
      const url = await waitForPreview(port);
      setPreviewUrl(url);
      setStatus('');
    } catch (err) {
      setStatus(String((err as Error)?.message ?? err));
    }
  };

  const exportZip = async () => {
    setStatus('zipping…');
    try {
      const zip = new JSZip();
      const entries = (await listTree('/workspace', 12)).filter((e) => !e.dir);
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
      const a = document.createElement('a');
      a.href = url;
      a.download = 'solara-sandbox.zip';
      a.click();
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
        await writeOrSkip(entry.name, text);
        count += 1;
      }
      await refreshTree();
      setStatus(`imported ${count} files`);
    } catch (err) {
      setStatus(`import failed: ${String((err as Error)?.message ?? err)}`);
    }
  };

  const openFile = async (path: string) => {
    try {
      setViewing({ path, text: (await readTextFile(path)).slice(0, 200_000) });
    } catch (err) {
      setViewing({ path, text: `unreadable (binary?): ${String((err as Error)?.message ?? err)}` });
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[520px] flex-col border-l border-zinc-800 bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-zinc-100">Sandbox</p>
            <p className="truncate text-[11px] text-zinc-500">
              WebContainer · Node.js in this tab · {model || 'no model'}
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
            <nav className="flex gap-1 border-b border-zinc-800 px-3 py-2 text-xs">
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
                </button>
              ))}
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
                <input
                  type="checkbox"
                  className="accent-cyan-500"
                  checked={autoApprove}
                  onChange={(event) => setAutoApprove(event.target.checked)}
                />
                auto-approve (unsafe)
              </label>
            </nav>

            {approval && (
              <div className="border-b border-rose-500/40 bg-rose-500/10 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-300">
                  approve {approval.tool === 'shell' ? 'command' : 'file write'}?
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
                  {events.length === 0 && (
                    <p className="p-2 text-xs text-zinc-600">
                      No activity yet. Give the sandbox a task below — it can write files and run commands
                      here, one approval at a time.
                    </p>
                  )}
                  {events.map((event, index) => (
                    <ActivityRow key={`${index}-${event.kind}`} event={event} />
                  ))}
                </div>
              )}

              {tab === 'files' && (
                <div className="p-3">
                  <div className="mb-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void refreshTree()}
                      disabled={treeBusy}
                      className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                      title="Re-read /workspace from the container. The list also updates itself after every tool call."
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
                  </div>
                  {treeNote && <p className="mb-1.5 font-mono text-[10px] text-zinc-600">{treeNote}</p>}
                  <ul className="space-y-0.5 font-mono text-[11px]">
                    {tree.map((entry) => (
                      <li key={entry.path}>
                        <button
                          type="button"
                          onClick={() => (entry.dir ? setTab('terminal') : void openFile(entry.path))}
                          className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-zinc-900"
                        >
                          {entry.dir ? (
                            <Folder className="h-3 w-3 shrink-0 text-cyan-400" />
                          ) : (
                            <FileIcon className="h-3 w-3 shrink-0 text-zinc-500" />
                          )}
                          <span className={entry.dir ? 'text-zinc-300' : 'text-zinc-400'}>
                            {relPath(entry.path)}
                          </span>
                        </button>
                      </li>
                    ))}
                    {tree.length === 0 && <li className="px-1.5 text-zinc-600">(empty workspace)</li>}
                  </ul>
                  {viewing && (
                    <div className="mt-3 rounded-lg border border-zinc-800 bg-black/40">
                      <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1">
                        <span className="truncate font-mono text-[10px] text-zinc-500">
                          {relPath(viewing.path)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setViewing(null)}
                          className="text-zinc-600 hover:text-zinc-300"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] text-zinc-300">
                        {viewing.text}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {tab === 'terminal' && (
                <div ref={hostRef} className="h-full min-h-[320px] w-full bg-[#09090b] p-2" />
              )}

              {/* Error forwarding only happens while the page is actually loaded, so keep a
                  1px invisible copy mounted when you are on another tab — otherwise the agent
                  fixes a page it never saw run and "it works" is a guess. */}
              {previewUrl && tab !== 'preview' && (
                <iframe
                  title="Sandbox preview (watching)"
                  src={previewUrl}
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none absolute h-px w-px opacity-0"
                  sandbox="allow-scripts allow-same-origin"
                />
              )}

              {tab === 'preview' && (
                <div className="flex h-full flex-col p-3">
                  <div className="mb-2 flex gap-2">
                    <input
                      value={previewPort}
                      onChange={(event) => setPreviewPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
                      className="w-20 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200"
                    />
                    <button
                      type="button"
                      onClick={startPreview}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-cyan-500"
                    >
                      <Play className="h-3 w-3" /> serve /workspace
                    </button>
                    <button
                      type="button"
                      disabled={!previewUrl || bigPreview}
                      onClick={() => setBigPreview(true)}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
                      title="Enlarge the preview to fill the window. It stays inside this tab, which is what keeps it alive."
                    >
                      fullscreen
                    </button>
                    <button
                      type="button"
                      disabled={snapshotBusy}
                      onClick={() => void openStandalone()}
                      className="rounded-lg border border-cyan-800/60 bg-cyan-950/40 px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-40"
                      title="Copy the workspace into one self-contained .html and open THAT in a new tab. The container URL cannot leave this tab; a snapshot can, and you can save it."
                    >
                      {snapshotBusy ? 'bundling\u2026' : 'open standalone'}
                    </button>
                    {snapshot && snapshotUrl && (
                      <a
                        href={snapshotUrl}
                        download="preview-standalone.html"
                        className="self-center text-[11px] text-zinc-400 underline hover:text-zinc-200"
                        title="The same document, saved to disk. Opens anywhere, no sandbox involved."
                      >
                        save .html
                      </a>
                    )}
                    {previewUrl && (
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate self-center text-[11px] text-zinc-500 underline decoration-dotted hover:text-zinc-300"
                        title="Only answers while THIS tab is alive and holding the container: it is a proxy to it, not a URL of your site. For anything else use open standalone."
                      >
                        raw preview URL
                      </a>
                    )}
                  </div>
                  {snapshotNote && (
                    <p className="mt-2 text-[11px] text-zinc-500">{snapshotNote}</p>
                  )}
                  {previewUrl && !bigPreview ? (
                    <iframe
                      title="Sandbox preview"
                      src={previewUrl}
                      className="min-h-[360px] w-full flex-1 rounded-lg border border-zinc-800 bg-white"
                      // allow-same-origin is required, not optional: without it the framed preview gets an
                      // opaque origin, so WebContainer cannot register its service worker and StackBlitz
                      // answers "Enable Storage Partitioning" instead of the page (measured). The origin it
                      // is same-origin with is the container's own preview host, never this page's.
                      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads"
                    />
                  ) : previewUrl ? (
                    <div className="fixed inset-0 z-50 flex flex-col bg-black">
                      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
                        <span className="truncate font-mono text-[11px] text-zinc-500">{previewUrl}</span>
                        <span className="shrink-0 text-[11px] text-zinc-600">container preview \u00b7 Esc to return</span>
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
                        src={previewUrl}
                        className="w-full flex-1 bg-white"
                        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-600">
                      No preview yet. Any server the agent starts on a port is picked up here automatically; or put
                      an <span className="font-mono">index.html</span> in the workspace and press serve. The iframe
                      loads the container&apos;s own origin, never this page&apos;s.
                    </p>
                  )}
                </div>
              )}
            </div>

            <footer className="border-t border-zinc-800 p-3">
              {!toolsOk && (
                <p className="mb-2 rounded-lg bg-amber-500/10 p-2 text-[11px] text-amber-300">
                  The {providerId} provider path in Solara does not use OpenAI-style tool calls, so the agent
                  loop is disabled. Switch to OpenRouter, Groq, NVIDIA, Z.AI or a custom endpoint.
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
              <div className="mt-2 flex items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                  max tokens
                  <input
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value.replace(/\D/g, ''))}
                    className="w-14 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300"
                    title="Per-turn token budget. Lower this if a reasoning model rambles and returns nothing."
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
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        (event.target as HTMLInputElement).blur();
                      }
                    }}
                    className="w-10 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300"
                    title={`How many times the agent may call a tool before it must answer (${MIN_ROUNDS}–${MAX_ROUNDS}). Each call is one request to your provider, so this is the knob that decides how much daily quota one task costs.`}
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
                      title="Interrupt everything the agent is doing right now: the model request, the command it is running (killed, not waited out), and the approval prompt if it is parked on one."
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
                  >
                    stop
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

async function writeOrSkip(name: string, text: string): Promise<void> {
  try {
    await writeTextFile(name.replace(/^\/+/, ''), text);
  } catch {
    // unsafe path inside the archive (e.g. ../) — skipped, not fatal
  }
}

function ActivityRow({ event }: { event: AgentEvent }) {
  if (event.kind === 'round') {
    return <p className="px-1.5 pt-2 text-[10px] uppercase tracking-wide text-zinc-600">round {event.round}</p>;
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
      </summary>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-zinc-800 p-2 font-mono text-[10px] text-zinc-400">
        {event.output}
      </pre>
    </details>
  );
}
