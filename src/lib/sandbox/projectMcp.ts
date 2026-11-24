// ============================================================================
// Project MCP server — a real MCP client/server pair, in the browser.
//
// Ported from bolt.diy's app/lib/runtime/projectMcp.ts, which is the piece of that
// project most worth copying: the agent's tools are not ad-hoc functions wired
// straight into the chat loop, they are an MCP server bound to a project, called
// through an in-memory transport by a client. That buys three things a direct
// function call does not:
//
//   * One place that owns "is this call still allowed?" — a *project generation*
//     counter is captured when the bridge is created and re-checked after every
//     await. A tool call that started on project A cannot write into project B
//     because the user reset the workspace mid-call.
//   * Serialised mutations. Read-revision -> patch -> save is atomic with respect
//     to every other mutation, so two tool calls in one round cannot interleave.
//   * A process registry with lifetimes: installs are polled to exit 0 before a
//     dependent command starts, a `run` command is reused instead of duplicated,
//     and the whole registry is killed when the project changes.
//
// Everything below talks to this app's own project store, shell and ripgrep; no
// bolt.diy module is imported.
// ============================================================================
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { projectStore, type FileMap } from './project';
import { listPreviews, readTextFile } from './container';
import { getFileRevision, numberLines, replaceLines, replaceText, validateProjectSource } from './sourceCheck';
import { searchWithRipgrep } from './ripgrep';
import { parseToolArguments, PROJECT_TOOL_NAMES, projectToolDefinitions } from './projectTools';
import { projectRelative, relPath, safePath, WORKSPACE_ROOT } from './path';
import { interactiveShell } from './terminal';
import { runShell, looksLikeDevServer } from './runner';
import { isNotFound, path } from './paths';
import { searchWeb, fetchWeb } from './web';

const MAX_TEXT_BYTES = 256_000;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_PROCESSES = 50;
/** How long a `run`/`test` command waits for an in-flight install before refusing. */
const INSTALL_WAIT_MS = 12_000;

export type ToolResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type ProcessRecord = {
  command: string;
  purpose: 'run' | 'test' | 'install' | 'other';
  output: string;
  exitCode?: number;
  startedAt: number;
  truncated: boolean;
  killed: boolean;
  /** Resolves when the process has exited (or was killed, or was left running). */
  finished: Promise<void>;
  resolveFinished: () => void;
  /** Set once the spawn returned; lets stop kill it out of band. */
  kill?: () => void;
};

const TRUNCATION_MARKER = '[earlier output truncated]\n';

function success(data: unknown): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(error: unknown, details?: Record<string, unknown>): ToolResult {
  const message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
  const text = message.slice(0, 4000);
  return {
    isError: true,
    content: [{ type: 'text' as const, text }],
    ...(details ? { structuredContent: { ...details, error: text } } : {}),
  };
}

/** Write a file whole, with the source check bolt.diy runs before saving. */
async function writeSource(target: { virtual: string; relative: string }, content: string) {
  if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`Content exceeds the ${MAX_TEXT_BYTES}-byte text file limit.`);
  }
  const prepared = await validateProjectSource(target.relative, content, { repairJsxMap: true });
  if (new TextEncoder().encode(prepared.content).byteLength > MAX_TEXT_BYTES) {
    throw new Error('Content exceeds the text file size limit after the JSX syntax correction.');
  }
  return prepared;
}

/**
 * Create the bridge. `options.abortSignal` is the agent turn's signal: a tool that
 * is still running when the user presses stop is cancelled at the next checkpoint.
 */
export async function createProjectBridge() {
  const boundGeneration = projectStore.generation;
  const processes = new Map<string, ProcessRecord>();
  const revisionsReadByModel = new Map<string, string>();
  const server = new McpServer({ name: 'solara-project', version: '1.0.0' });

  const assertCurrent = () => {
    if (projectStore.generation !== boundGeneration) {
      throw new Error('The active project changed before this tool could finish.');
    }
  };

  const stopAllProcesses = () => {
    for (const record of processes.values()) {
      if (record.exitCode === undefined) {
        record.killed = true;
        record.exitCode = -1;
        record.resolveFinished();
      }
    }
    processes.clear();
  };

  const resolveProjectPath = (input: unknown, allowRoot = false) => {
    const relative = projectRelative(input);
    if (!allowRoot && relative === '.') {
      throw new Error('A non-root project path is required.');
    }
    return {
      relative,
      virtual: relative === '.' ? WORKSPACE_ROOT : safePath(relative),
    };
  };

  const assertUnlocked = (virtual: string, folder = false) => {
    const lock = folder ? projectStore.isFolderLocked(virtual) : projectStore.isFileLocked(virtual);
    if (lock.locked) {
      throw new Error(`The path is locked${lock.lockedBy ? ` by ${lock.lockedBy}` : ''}: ${relPath(virtual)}`);
    }
    let dir = virtual;
    while (dir.startsWith(`${WORKSPACE_ROOT}/`)) {
      dir = dir.slice(0, dir.lastIndexOf('/')) || WORKSPACE_ROOT;
      const parentLock = projectStore.isFolderLocked(dir);
      if (parentLock.locked) {
        throw new Error(`The path is locked${parentLock.lockedBy ? ` by ${parentLock.lockedBy}` : ''}: ${relPath(dir)}`);
      }
    }
  };

  const readTracked = async (target: { virtual: string; relative: string }) => {
    await projectStore.ensureLoaded();
    const tracked = projectStore.files[target.virtual];
    if (tracked?.type === 'file') {
      if (tracked.isBinary) {
        throw new Error(`${target.relative} is a binary file and cannot be read as text.`);
      }
      return tracked.content;
    }
    if (tracked?.type === 'folder') {
      throw new Error(`${target.relative} is a directory. Use project_list_paths.`);
    }
    // Not tracked yet (fresh import, file written outside the store): read through.
    const content = await readTextFile(target.virtual);
    if (new TextEncoder().encode(content).byteLength > MAX_TEXT_BYTES) {
      throw new Error(`File exceeds the ${MAX_TEXT_BYTES}-byte text limit.`);
    }
    projectStore.files[target.virtual] = {
      type: 'file',
      content,
      isBinary: false,
      size: content.length,
    };
    return content;
  };

  // --- files ---------------------------------------------------------------

  server.registerTool(
    'project_read_file',
    projectToolDefinitions.project_read_file,
    async ({ path: input, numbered }) => {
      try {
        const target = resolveProjectPath(input);
        await projectStore.drain();
        assertCurrent();
        const content = await readTracked(target);
        assertCurrent();
        const revision = await getFileRevision(content);
        revisionsReadByModel.set(target.relative, revision);
        const rows = numberLines(content);
        return success({
          path: target.relative,
          revision,
          ...(numbered
            ? { lineCount: rows.length, content: rows.join('\n') }
            : { lineCount: rows.length, content }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'project_write_file',
    projectToolDefinitions.project_write_file,
    async ({ path: input, content, overwrite }) => {
      try {
        const target = resolveProjectPath(input);
        const result = await projectStore.queue(async () => {
          assertCurrent();
          const current = projectStore.files[target.virtual];
          if (current?.type === 'folder') {
            throw new Error('The target path is a directory.');
          }
          const exists = Boolean(current) || (await projectStore.onDisk(target.virtual));
          if (exists && overwrite === false) {
            throw new Error('File already exists. Set overwrite to true to replace it.');
          }
          assertUnlocked(target.virtual);
          if (current?.type === 'file' && current.content === content) {
            return { created: false, changed: false, sourceRepair: undefined as string | undefined };
          }
          let prepared: { content: string; sourceRepair?: string };
          try {
            prepared = await writeSource(target, content);
          } catch (error) {
            if (!exists) {
              // bolt.diy reports the path so the agent re-creates it with valid source
              // instead of retrying a patch against a file that was never saved.
              throw Object.assign(error as Error, { retryCreatePath: target.relative });
            }
            throw error;
          }
          if (current?.type === 'file') {
            await projectStore.saveFileContent(target.virtual, prepared.content);
          } else {
            await projectStore.createFile(target.virtual, prepared.content);
          }
          revisionsReadByModel.delete(target.relative);
          return { created: !exists, changed: true, sourceRepair: prepared.sourceRepair };
        });
        return success({
          path: target.relative,
          written: true,
          created: result.created,
          changed: result.changed,
          generation: boundGeneration,
          ...(result.sourceRepair ? { sourceRepair: result.sourceRepair } : {}),
        });
      } catch (error) {
        const retryCreatePath = (error as { retryCreatePath?: string }).retryCreatePath;
        return failure(error, retryCreatePath ? { retryCreatePath } : undefined);
      }
    },
  );

  const patch = async (
    input: {
      path: string;
      expectedContent?: string;
      expectedRevision?: string;
      lineRange?: { start: number; end: number };
      oldText?: string;
      newText: string;
    },
    signal?: AbortSignal,
  ) => {
    try {
      const target = resolveProjectPath(input.path);
      return await projectStore.queue(async () => {
        if (signal?.aborted) {
          throw new DOMException('Tool call was cancelled.', 'AbortError');
        }
        assertCurrent();
        const content = await readTracked(target);
        const revisionToCheck = input.expectedRevision ?? revisionsReadByModel.get(target.relative);
        if (input.expectedContent === undefined && revisionToCheck === undefined) {
          throw new Error('Read the file first, then supply its revision as expectedRevision.');
        }
        if (
          (revisionToCheck !== undefined && (await getFileRevision(content)) !== revisionToCheck) ||
          (input.expectedContent !== undefined && content !== input.expectedContent)
        ) {
          throw new Error(
            'Patch conflict: the file changed or expectedContent was copied incorrectly. Read the file again and use its revision as expectedRevision; do not repeat the stale patch.',
          );
        }
        const updated = input.lineRange
          ? replaceLines(content, input.lineRange, input.newText)
          : replaceText(content, input.oldText!, input.newText);
        if (new TextEncoder().encode(updated).byteLength > MAX_TEXT_BYTES) {
          throw new Error('Patched file exceeds the text file size limit.');
        }
        assertCurrent();
        const changed = updated !== content;
        if (changed) {
          await validateProjectSource(target.relative, updated);
          await projectStore.saveFileContent(target.virtual, updated);
          revisionsReadByModel.delete(target.relative);
        }
        return success({ path: target.relative, patched: true, changed, generation: boundGeneration });
      });
    } catch (error) {
      if (isNotFound(error)) {
        return failure(
          new Error(
            'The target file does not exist. Create it with project_write_file and supply the complete file as content.',
          ),
        );
      }
      return failure(error);
    }
  };

  server.registerTool('project_patch_file', projectToolDefinitions.project_patch_file, (input, extra) =>
    patch(input as Parameters<typeof patch>[0], extra.signal),
  );

  server.registerTool(
    'project_replace_lines',
    projectToolDefinitions.project_replace_lines,
    ({ path: input, startLine, endLine, expectedRevision, newText }, extra) =>
      patch(
        { path: input, lineRange: { start: startLine, end: endLine }, expectedRevision, newText },
        extra.signal,
      ),
  );

  server.registerTool('project_create_directory', projectToolDefinitions.project_create_directory, async ({ path: input }) => {
    try {
      const target = resolveProjectPath(input);
      if (/(?:^|\/)node_modules(?:\/|$)/.test(target.relative)) {
        return failure(
          new Error(
            'The package manager creates node_modules. Install project dependencies with project_run_command and purpose "install".',
          ),
        );
      }
      await projectStore.queue(async () => {
        assertCurrent();
        assertUnlocked(target.virtual, true);
        await projectStore.createFolder(target.virtual);
      });
      return success({ path: target.relative, created: true, generation: boundGeneration });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool(
    'project_delete_path',
    projectToolDefinitions.project_delete_path,
    async ({ path: input, recursive }) => {
      try {
        const target = resolveProjectPath(input, true);
        await projectStore.queue(async () => {
          assertCurrent();
          const current = projectStore.files[target.virtual];
          if (!current) {
            throw new Error(`Path does not exist: ${target.relative}`);
          }
          assertUnlocked(target.virtual, current.type === 'folder');
          if (current.type === 'folder') {
            if (!recursive) {
              throw new Error('Deleting a directory requires recursive: true.');
            }
            for (const [entryPath] of Object.entries(projectStore.files)) {
              if (entryPath === target.virtual || entryPath.startsWith(`${target.virtual}/`)) {
                assertUnlocked(entryPath, projectStore.files[entryPath]?.type === 'folder');
              }
            }
            await projectStore.deleteFolder(target.virtual);
          } else {
            await projectStore.deleteFile(target.virtual);
          }
        });
        return success({ path: target.relative, deleted: true, generation: boundGeneration });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // --- discovery ------------------------------------------------------------

  server.registerTool(
    'project_list_paths',
    projectToolDefinitions.project_list_paths,
    async ({ path: prefix = '', limit = 500 }) => {
      try {
        const relative = prefix ? resolveProjectPath(prefix, true).relative : '.';
        const safePrefix = relative === '.' ? '' : relative;
        if (/(?:^|\/)node_modules(?:\/|$)/.test(relative)) {
          return success({
            entries: [],
            truncated: false,
            note: 'Project discovery skips generated node_modules files. Use package.json or the project lockfile for dependency information.',
          });
        }
        await projectStore.ensureLoaded();
        await projectStore.drain();
        assertCurrent();
        const entries = Object.entries(projectStore.files).flatMap(([entryPath, entry]) => {
          if (!entry || !entryPath.startsWith(`${WORKSPACE_ROOT}/`)) {
            return [];
          }
          const entryRelative = entryPath.slice(`${WORKSPACE_ROOT}/`.length);
          return entryRelative.startsWith(safePrefix) && !/(?:^|\/)node_modules(?:\/|$)/.test(entryRelative)
            ? [{ path: entryRelative, type: entry.type }]
            : [];
        });
        // Directories first, then files, both alphabetical: a model reading a long
        // list finds the shape of a project faster than in insertion order.
        entries.sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || a.path.localeCompare(b.path));
        return success({ entries: entries.slice(0, limit), truncated: entries.length > limit });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'project_search_content',
    projectToolDefinitions.project_search_content,
    async ({ query, path: input = '.', limit = 50 }, extra) => {
      try {
        const relative = input ? resolveProjectPath(input, true).relative : '.';
        await projectStore.ensureLoaded();
        await projectStore.drain();
        assertCurrent();
        const result = await searchWithRipgrep({
          query,
          path: relative,
          limit,
          files: projectStore.files as FileMap,
          projectRoot: WORKSPACE_ROOT,
          signal: extra.signal,
        });
        assertCurrent();
        return success(result);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'project_find_related_files',
    projectToolDefinitions.project_find_related_files,
    async ({ path: input, limit = 20 }) => {
      try {
        const target = resolveProjectPath(input);
        await projectStore.ensureLoaded();
        await projectStore.drain();
        assertCurrent();
        const source = projectStore.files[target.virtual];
        if (source?.type !== 'file') {
          throw new Error(`File does not exist: ${target.relative}`);
        }
        const parent = path.dirname(target.relative);
        const sourceName = path.basename(target.relative);
        const sourceStem = sourceName.slice(0, sourceName.length - path.extname(sourceName).length);
        const related = Object.entries(projectStore.files)
          .filter(
            ([candidatePath, candidate]) =>
              candidate?.type === 'file' &&
              candidatePath !== target.virtual &&
              candidatePath.startsWith(`${WORKSPACE_ROOT}/`) &&
              !/(?:^|\/)node_modules(?:\/|$)/.test(candidatePath),
          )
          .map(([candidatePath]) => {
            const relative = candidatePath.slice(`${WORKSPACE_ROOT}/`.length);
            const reasons: string[] = [];
            if (path.dirname(relative) === parent) {
              reasons.push('same directory');
            }
            const candidateName = path.basename(relative);
            const candidateStem = candidateName.slice(0, candidateName.length - path.extname(candidateName).length);
            if (sourceStem && candidateStem.toLowerCase() === sourceStem.toLowerCase()) {
              reasons.push('same filename stem');
            }
            return {
              path: relative,
              reasons,
              score: (reasons.includes('same filename stem') ? 2 : 0) + (reasons.includes('same directory') ? 1 : 0),
            };
          })
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
          .slice(0, limit)
          .map(({ path: relatedPath, reasons }) => ({ path: relatedPath, reasons }));
        return success({ source: target.relative, related, truncated: related.length === limit });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // --- commands -------------------------------------------------------------

  const processResult = (processId: string, record: ProcessRecord, reused = false): ToolResult => {
    const failed = record.exitCode !== undefined && record.exitCode !== 0;
    const missingCommand = record.exitCode === 127 ? /command not found:\s*([\w./@-]+)/i.exec(record.output)?.[1] : undefined;
    const data = {
      processId,
      command: record.command,
      purpose: record.purpose,
      output: record.output,
      status: record.exitCode === undefined ? 'running' : 'exited',
      exitCode: record.exitCode ?? null,
      outputStream: 'combined',
      truncated: record.truncated,
      killed: record.killed,
      elapsedMs: Date.now() - record.startedAt,
      previewReady: listPreviews().length > 0,
      ...(reused ? { reused: true } : {}),
      ...(failed
        ? {
            isError: true,
            error: missingCommand
              ? `Command not found: ${missingCommand} (exit code 127). If it is a project dependency, finish installing dependencies and retry ${record.command}.`
              : record.killed
                ? 'The command was stopped before it finished.'
                : `Command exited with code ${record.exitCode}.`,
          }
        : {}),
    };
    return { ...success(data), ...(failed ? { isError: true } : {}) };
  };

  const waitForExit = async (record: ProcessRecord, timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        record.finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const appendOutput = (record: ProcessRecord, chunk: string) => {
    const previous = record.output.startsWith(TRUNCATION_MARKER)
      ? record.output.slice(TRUNCATION_MARKER.length)
      : record.output;
    const joined = previous + chunk;
    record.truncated ||= joined.length > MAX_OUTPUT_CHARS;
    record.output = record.truncated
      ? `${TRUNCATION_MARKER}${joined.slice(-(MAX_OUTPUT_CHARS - TRUNCATION_MARKER.length))}`
      : joined;
  };

  server.registerTool(
    'project_run_command',
    projectToolDefinitions.project_run_command,
    async ({ command, purpose = 'other' }, extra) => {
      try {
        const normalized = (value: string) =>
          value.trim().replace(/^cd\s+(?:\/home\/project|['"]\/home\/project['"])\s*&&\s*/, '');

        // Reuse a live `run` process with the same command instead of starting a
        // second dev server on the same port, which fails and looks like a bug.
        if (purpose === 'run') {
          const existing = [...processes.entries()].find(
            ([, record]) =>
              record.purpose === 'run' &&
              record.exitCode === undefined &&
              normalized(record.command) === normalized(command),
          );
          if (existing) {
            return processResult(existing[0], existing[1], true);
          }
        }

        // Gate a dependent command on an install that has not finished yet.
        if (purpose === 'run' || purpose === 'test') {
          for (const [installProcessId, install] of processes.entries()) {
            if (install.purpose !== 'install' || install.exitCode !== undefined) {
              continue;
            }
            await waitForExit(install, INSTALL_WAIT_MS);
            assertCurrent();
            if (install.exitCode === undefined) {
              return success({
                command,
                purpose,
                status: 'waiting-for-install',
                installProcessId,
                note: 'This command has not started. Poll installProcessId with project_get_process_output, then retry this command after the install exits with code 0.',
              });
            }
            if (install.exitCode !== 0) {
              return failure(
                new Error(
                  'Dependency installation failed before this command could start. Inspect the install output and fix it before retrying.',
                ),
                { command, purpose, installProcessId },
              );
            }
          }
        }

        while (processes.size >= MAX_PROCESSES) {
          const completed = [...processes.entries()].find(([, record]) => record.exitCode !== undefined);
          if (!completed) {
            throw new Error('Too many project processes are active. Stop one and retry.');
          }
          processes.delete(completed[0]);
        }

        let resolveFinished: () => void = () => {};
        const finished = new Promise<void>((resolve) => {
          resolveFinished = resolve;
        });
        let processId = `p-${Math.random().toString(36).slice(2, 10)}`;
        while (processes.has(processId)) {
          processId = `p-${Math.random().toString(36).slice(2, 10)}`;
        }
        const record: ProcessRecord = {
          command,
          purpose,
          output: '',
          startedAt: Date.now(),
          truncated: false,
          killed: false,
          finished,
          resolveFinished,
        };
        processes.set(processId, record);

        projectStore.requestTerminal();
        interactiveShell.write(`\r\n\x1b[36m$\x1b[0m ${command}\r\n`);

        // `run` is a dev server: it must answer "started", not "exited in 300s".
        const isServer = purpose === 'run' || looksLikeDevServer(command);
        const result = await runShell(command, {
          signal: extra.signal,
          background: isServer,
          timeoutMs: isServer ? 600_000 : purpose === 'install' ? 300_000 : undefined,
          onOutput: (chunk) => {
            appendOutput(record, chunk);
            interactiveShell.write(chunk);
          },
        });

        if (result.exitCode !== 0 || result.timedOut) {
          projectStore.writeToTerminal(`\x1b[90m[exit ${result.exitCode}]\x1b[0m\r\n`);
        }
        record.exitCode = result.exitCode;
        record.killed = result.exitCode === 130;
        record.resolveFinished();
        record.kill = undefined;

        if (isServer && result.exitCode === 0) {
          // A backgrounded server is "running" from the registry's point of view: it
          // has not exited, and a later `run` with the same command reuses it.
          record.exitCode = undefined;
          return processResult(processId, record);
        }
        return processResult(processId, record);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'project_get_process_output',
    projectToolDefinitions.project_get_process_output,
    async ({ processId }) => {
      const record = processes.get(processId);
      if (!record) {
        return failure(
          new Error(`Unknown process: ${processId}. Copy the exact processId from the project_run_command result.`),
        );
      }
      await waitForExit(record, 1_000);
      assertCurrent();
      return processResult(processId, record);
    },
  );

  server.registerTool(
    'project_stop_process',
    projectToolDefinitions.project_stop_process,
    async ({ processId }) => {
      const record = processes.get(processId);
      if (!record) {
        return failure(
          new Error(`Unknown process: ${processId}. Copy the exact processId from the project_run_command result.`),
        );
      }
      if (record.exitCode === undefined) {
        record.killed = true;
        try {
          record.kill?.();
        } catch {
          // the process may already be gone
        }
        // A dev server left in "running" state owns a port; the registry entry is
        // closed here so a later `run` starts a fresh one instead of reusing a dead id.
        record.exitCode = 130;
        record.resolveFinished();
      }
      await waitForExit(record, 1_500);
      return success({ processId, stopped: true, command: record.command, purpose: record.purpose });
    },
  );

  // --- web ------------------------------------------------------------------
  // Routed through this app's own server: the sandbox has no egress, and the Tavily
  // key lives in localStorage, so the request must be relayed by the page.

  server.registerTool(
    'web_search',
    {
      description: 'Search the public web and return sourced result snippets.',
      inputSchema: z.strictObject({
        query: z.string().min(1).max(1000),
        limit: z.number().int().min(1).max(10).optional(),
      }),
    },
    async ({ query, limit = 5 }) => {
      try {
        return success(await searchWeb(query, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'web_fetch',
    {
      description: 'Fetch readable public content at a URL.',
      inputSchema: z.strictObject({ url: z.string().min(1).max(2048) }),
    },
    async ({ url }) => {
      try {
        return success(await fetchWeb(url));
      } catch (error) {
        return failure(error);
      }
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'solara-project-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let closed = false;
  return {
    generation: boundGeneration,
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
      if (closed) {
        throw new Error('Project bridge is closed.');
      }
      if (!PROJECT_TOOL_NAMES.includes(name as (typeof PROJECT_TOOL_NAMES)[number])) {
        throw new Error(`Unknown project tool: ${name}`);
      }
      assertCurrent();
      const result = (await client.callTool({ name, arguments: args }, undefined, { signal })) as ToolResult;
      assertCurrent();
      return result;
    },
    async close() {
      closed = true;
      stopAllProcesses();
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

export type ProjectBridge = Awaited<ReturnType<typeof createProjectBridge>>;

let sharedBridge: { generation: number; promise: Promise<ProjectBridge> } | undefined;

/**
 * One bridge per project generation, created lazily and closed when the project is
 * replaced. Concurrent tool calls in the same round share it (and therefore share
 * the process registry, which is what makes reuse work).
 */
export async function callProjectTool(
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; generation?: number } = {},
): Promise<ToolResult> {
  const generation = projectStore.generation;
  if (options.generation !== undefined && options.generation !== generation) {
    throw new Error('The active project changed before this tool could start.');
  }
  if (sharedBridge?.generation !== generation) {
    const previous = sharedBridge;
    const promise = (async () => {
      const old = await previous?.promise.catch(() => undefined);
      await old?.close();
      return createProjectBridge();
    })();
    sharedBridge = { generation, promise };
  }
  const connection = sharedBridge;
  const bridge = await connection.promise.catch((error) => {
    if (sharedBridge === connection) {
      sharedBridge = undefined;
    }
    throw error;
  });
  return bridge.callTool(name, args, options.signal);
}

export async function closeProjectBridge(): Promise<void> {
  const connection = sharedBridge;
  sharedBridge = undefined;
  const bridge = await connection?.promise.catch(() => undefined);
  await bridge?.close();
}

/** Called by the panel when the workspace is reset/imported: kills processes, new bridge. */
export async function resetProjectRuntime(): Promise<void> {
  await closeProjectBridge();
  projectStore.bumpGeneration();
}

export { projectToolDefinitions, parseToolArguments, PROJECT_TOOL_NAMES };
