// ============================================================================
// Conversation condensation, ported from OpenHands' condenser.
//
// Theirs is a settings section with several strategies; the mechanism that matters is
// simple: once a conversation outgrows its window, summarise the middle and keep the
// head (system + original ask) and the tail (recent turns) verbatim. Every round resends
// the whole history, so an un-condensed thread is a per-round cost that grows with age.
//
// This version is deliberately deterministic — no extra model request, which on a
// 3-request budget would defeat the purpose. It keeps every decided fact (files touched,
// commands run, failures) as a terse one-line-per-event digest, which is what a coding
// agent actually needs from its own past.
// ============================================================================

/** Tool results smaller than this are worth keeping verbatim. */
const KEEP_BODY_CHARS = 700;
/** Digest lines are capped so the digest itself cannot become the problem. */
const MAX_DIGEST_CHARS = 4_000;

export type HistoryTurn = { role: string; content: string };

function clip(text: string, limit: number): string {
  const value = String(text ?? '');
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n…[${value.length - limit} chars omitted]`;
}

/**
 * Condense the middle of a conversation into a digest.
 *
 * Keeps `headCount` leading turns and `tailCount` trailing turns untouched, and replaces
 * everything between them with one user-role digest. Returns the original array when
 * there is nothing to do (short conversation, or nothing condenseable in the middle).
 */
export function condense(
  turns: HistoryTurn[],
  options: { headCount?: number; tailCount?: number; maxChars?: number } = {},
): HistoryTurn[] {
  const headCount = Math.max(0, options.headCount ?? 1);
  const tailCount = Math.max(1, options.tailCount ?? 6);
  const maxChars = Math.max(1_000, options.maxChars ?? 6_000);

  if (turns.length <= headCount + tailCount + 1) {
    return turns;
  }

  const head = turns.slice(0, headCount);
  const middle = turns.slice(headCount, turns.length - tailCount);
  const tail = turns.slice(turns.length - tailCount);

  const total = turns.reduce((sum, turn) => sum + String(turn.content ?? '').length, 0);
  const middleChars = middle.reduce((sum, turn) => sum + String(turn.content ?? '').length, 0);
  if (total <= maxChars || middleChars === 0) {
    return turns;
  }

  const lines: string[] = [];
  let used = 0;
  for (const turn of middle) {
    const content = String(turn.content ?? '');
    // Everything short stays: that is where decisions live ("switched to ESM", "port 5173").
    if (content.length <= KEEP_BODY_CHARS) {
      if (used + content.length > MAX_DIGEST_CHARS) {
        continue;
      }
      lines.push(`[${turn.role}] ${content}`);
      used += content.length;
      continue;
    }
    const firstLine = content.split('\n').find((line) => line.trim()) ?? '';
    const line = `[${turn.role}] ${clip(firstLine, 200)} …(${content.length} chars, condensed)`;
    if (used + line.length > MAX_DIGEST_CHARS) {
      continue;
    }
    lines.push(line);
    used += line.length;
  }

  const digest: HistoryTurn = {
    role: 'user',
    content: [
      'CONDENSED HISTORY — earlier turns of this conversation, summarised by the harness:',
      ...lines,
      `(${middle.length} turn(s) condensed. Ask again or re-read a file if a detail is missing.)`,
    ].join('\n'),
  };

  return [...head, digest, ...tail];
}
