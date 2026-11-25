// ============================================================================
// Stuck detection, ported from OpenHands (their conversations run with
// `stuck_detection: true` by default — see agent-server-adapter.ts).
//
// The condition that matters on a small request budget is the simplest one: the agent
// does the same thing over and over. Observed in a real session here: round after round
// of `project_list_paths` / `project_read_file package.json` until the budget was gone,
// with nothing written. Waiting for the request budget to expire is the worst possible
// response — it spends every remaining request on the same no-op.
//
// This module is deliberately narrow: it looks at the repeated-call pattern and returns
// the corrective text to inject, or null. It does not count rounds, gate completion, or
// know about tokens; those are the loop's job.
// ============================================================================

export type CallSignature = { name: string; args: Record<string, unknown> };

/** A stable key for "the same call": name plus arguments, key order independent. */
export function signatureOf(name: string, args: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, normalize(inner)]),
      );
    }
    return value;
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(normalize(args));
  } catch {
    serialized = '{}';
  }
  return `${name}|${serialized}`.slice(0, 2_000);
}

/** The same exact call this many times in a row is a loop, not a retry. */
export const REPEAT_LIMIT = 2;

export type StuckVerdict = {
  /** What kind of loop this is, for the log line. */
  kind: 'repeated-call' | 'repeated-failure' | 'read-only';
  /** Text appended to the conversation as the next user message. */
  message: string;
  note: string;
};

/**
 * @param history every executed call in this task, oldest first, each with its outcome
 * @param consecutiveReads read-only tool calls since the last write or run
 */
export function detectStuck(history: Array<CallSignature & { failed?: boolean }>, consecutiveReads: number): StuckVerdict | null {
  if (history.length >= REPEAT_LIMIT) {
    const recent = history.slice(-REPEAT_LIMIT);
    const first = signatureOf(recent[0].name, recent[0].args);
    const allSame = recent.every((entry) => signatureOf(entry.name, entry.args) === first);
    if (allSame) {
      const failed = recent.every((entry) => entry.failed);
      return {
        kind: failed ? 'repeated-failure' : 'repeated-call',
        note: failed
          ? `${recent[0].name} failed ${REPEAT_LIMIT} times in a row with identical arguments`
          : `${recent[0].name} was called ${REPEAT_LIMIT} times in a row with identical arguments`,
        message: [
          `You have repeated the exact same call (${recent[0].name}) ${REPEAT_LIMIT} times with identical arguments.`,
          'It will produce the same result. Change something:',
          '- If you already have what you need from it, use it and move on to the edit.',
          '- If it failed, the arguments are wrong — diagnose the error instead of resending.',
          '- If you are looking for a file, the workspace listing is in your system prompt; do not list it again.',
        ].join('\n'),
      };
    }
  }
  if (consecutiveReads >= 4) {
    return {
      kind: 'read-only',
      note: `${consecutiveReads} read-only calls with no write or run`,
      message: [
        `You have made ${consecutiveReads} read-only calls without writing or running anything.`,
        'The user asked for a change, not an inspection. Write the code now: emit the writes and the first run in ONE response.',
      ].join('\n'),
    };
  }
  return null;
}
