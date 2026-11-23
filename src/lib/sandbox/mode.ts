// ============================================================================
// Run mode (chat | agent) and the tool-call budget, shared by the composer
// toggle in App.tsx and the sandbox panel. Everything about this knob lives
// here so App.tsx keeps a handful of additive lines instead of new logic.
//
// Why it is a control and not a constant: one chat message is exactly ONE
// provider request, but an agent task costs one per round. Measured against a
// live 20-requests-per-day free key, the old fixed ceiling of 12 meant a single
// ordinary task ("add a test and make it pass") could eat over half a day's
// quota, and there was no way to spend less or ask for more.
// ============================================================================

export type RunMode = 'chat' | 'agent';

const MODE_KEY = 'solara_run_mode';
export const ROUNDS_KEY = 'solara_agent_rounds';

/**
 * 1  — the model gets one batch of tool calls and must then answer. Costs a single
 *      request, which is the right setting on a 20/day free key.
 * 12 — what this app shipped with: enough for "scaffold, install, run, fix once".
 * 24 — the default now. A real Vite project is not one edit: install, write 4-6
 *      files, run the build, read the error, fix it, rebuild. At 12 that sequence ran
 *      out of budget mid-task and the "answer" was a tool call, which is the second
 *      worst failure after a blank preview — the model was cut off while working.
 * 60 — ceiling. Each round is separately capped at 120s by SANDBOX_TURN_TIMEOUT_MS,
 *      so 60 rounds is up to two hours of browser time and three days of a 20/day
 *      free key. That is deliberate, not careless: **stop** works now (it kills the
 *      running command and parks nothing), and every round is visible in the transcript,
 *      so the cost of a runaway is a button press rather than a stalled tab.
 */
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 60;
export const DEFAULT_ROUNDS = 24;

export function clampRounds(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROUNDS;
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, n));
}

function read(key: string, fallback = ''): string {
  try {
    return typeof localStorage === 'undefined' ? fallback : localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function getRounds(): number {
  const raw = read(ROUNDS_KEY);
  return raw ? clampRounds(raw) : DEFAULT_ROUNDS;
}

export function saveRounds(value: unknown): number {
  const n = clampRounds(value);
  try {
    localStorage.setItem(ROUNDS_KEY, String(n));
  } catch {
    // private mode: the value still applies for this task
  }
  publish();
  return n;
}

export function getMode(): RunMode {
  return read(MODE_KEY) === 'agent' ? 'agent' : 'chat';
}

export function saveMode(mode: RunMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
  publish();
}

// --- same-tab pub/sub: three separate components must agree on two persisted
// numbers, and a store would be a bigger change to this app than this is.
type Handler = () => void;
const subs = new Set<Handler>();
function publish(): void {
  for (const handler of [...subs]) {
    try {
      handler();
    } catch {
      // a broken listener must not stop the others
    }
  }
}
export function subscribe(handler: Handler): () => void {
  subs.add(handler);
  return () => {
    subs.delete(handler);
  };
}

// --- task bus: the composer hands a prompt to the panel, the panel hands the
// answer back so it can join the chat transcript like any other reply.
export type AgentResult = { text: string; roundsUsed: number; roundsAllowed: number };

const taskSubs = new Set<(text: string) => void>();
export function onAgentTask(handler: (text: string) => void): () => void {
  taskSubs.add(handler);
  return () => {
    taskSubs.delete(handler);
  };
}
export function requestAgentTask(text: string): void {
  for (const handler of [...taskSubs]) {
    handler(text);
  }
}

const resultSubs = new Set<(result: AgentResult) => void>();
export function onAgentResult(handler: (result: AgentResult) => void): () => void {
  resultSubs.add(handler);
  return () => {
    resultSubs.delete(handler);
  };
}
export function reportAgentResult(result: AgentResult): void {
  for (const handler of [...resultSubs]) {
    handler(result);
  }
}
