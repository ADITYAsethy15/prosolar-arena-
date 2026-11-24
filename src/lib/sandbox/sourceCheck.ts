// ============================================================================
// Source checks and precise line patches.
//
// Both are straight ports of bolt.diy's app/lib/runtime/projectFilePatch.ts and
// projectFileValidation.ts, because they encode two lessons that cost real rounds
// to learn:
//
//   1. A file the model "wrote" but that does not parse is worse than a failed
//      write: the agent then runs the project, reads a syntax error from a bundler
//      and has to find the line itself. Validating with a real parser before saving
//      turns that into one message with the line and column.
//   2. Whole-file rewrites for a two-line change lose unrelated code. Line-range
//      patches guarded by a content revision make "the file changed under me"
//      a hard conflict instead of a silent clobber.
// ============================================================================
import { format } from 'prettier/standalone';
import babelPlugin from 'prettier/plugins/babel';
import typescriptPlugin from 'prettier/plugins/typescript';
import estreePlugin from 'prettier/plugins/estree';

/** Stable revision for exact concurrency checks without copying the whole file. */
export async function getFileRevision(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function numberLines(content: string): string[] {
  return content.split(/(?<=\n)/).map((line, index) => `${index + 1}: ${line.replace(/\r?\n$/, '')}`);
}

export function countLines(content: string): number {
  return content.split(/(?<=\n)/).length;
}

export function replaceLines(content: string, { start, end }: { start: number; end: number }, newText: string): string {
  const lines = content.split(/(?<=\n)/);
  if (end < start || end > lines.length) {
    throw new Error(
      `Patch conflict: requested lines ${start} through ${end}, but the file has ${lines.length} numbered lines. Read the file again with numbered: true and select lines within its lineCount, inclusive.`,
    );
  }
  const selected = lines.slice(start - 1, end);
  const lineWithEnding = selected.find((line) => line.endsWith('\n')) ?? lines[start - 2];
  const newline = lineWithEnding?.endsWith('\r\n') ? '\r\n' : '\n';
  const finalEnding = lines[end - 1].match(/\r?\n$/)?.[0] ?? '';
  const replacement = newText
    ? newText.replace(/\r?\n$/, '').replace(/\r?\n/g, newline) + finalEnding
    : '';
  return lines.slice(0, start - 1).join('') + replacement + lines.slice(end).join('');
}

export function replaceText(content: string, oldText: string, newText: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const needle = oldText.replace(/\r\n/g, '\n');
  let start = normalized.indexOf(needle);
  if (start === -1) {
    throw new Error(
      'Patch conflict: oldText was not found. Use project_read_file with numbered: true, then use project_replace_lines with the returned revision and the intended lines.',
    );
  }
  if (normalized.indexOf(needle, start + 1) !== -1) {
    throw new Error('Patch conflict: oldText is ambiguous; it must match exactly once.');
  }
  let end = start + needle.length;
  // Translate the matching range back to the original string before splicing.
  for (const { index } of content.matchAll(/\r\n/g)) {
    if (index >= end) {
      break;
    }
    if (index < start) {
      start++;
    }
    end++;
  }
  const originalMatch = content.slice(start, end);
  const newline = originalMatch.match(/\r?\n/)?.[0];
  const replacement = originalMatch !== oldText && newline ? newText.replace(/\r?\n/g, newline) : newText;
  return content.slice(0, start) + replacement + content.slice(end);
}

/**
 * Parse the file with Prettier's own parser and discard the formatted output.
 * Formatting is deliberately not applied: reformatting a user's file is a change
 * they did not ask for.
 */
export async function validateProjectSource(
  filePath: string,
  content: string,
  { repairJsxMap = false } = {},
): Promise<{ content: string; sourceRepair?: string }> {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filePath)) {
    return { content };
  }
  const typescript = /\.(?:[cm]?ts|tsx)$/i.test(filePath);
  const parse = (source: string) =>
    format(source, {
      filepath: filePath,
      parser: typescript ? 'typescript' : 'babel',
      plugins: [typescript ? typescriptPlugin : babelPlugin, estreePlugin],
    });

  try {
    await parse(content);
    return { content };
  } catch (error) {
    const corrected = /\.tsx$/i.test(filePath) ? fixEarlyJsxMapBrace(content, error) : undefined;
    if (corrected && repairJsxMap) {
      try {
        await parse(corrected);
        return {
          content: corrected,
          sourceRepair: 'Kept the typed array and its .map() call inside the JSX expression.',
        };
      } catch {
        // A repair is only applied if the entire corrected file parses.
      }
    }

    const detail = error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : 'Invalid syntax';
    const flattened =
      !/[\r\n]/.test(content.trim()) &&
      /^\s*import[ \t].*?[ \t]from[ \t]+['"][^'"]+['"][ \t]+(?:import|export|type|interface|const|let|function|class)\b/.test(
        content,
      );
    const hint = corrected
      ? 'Keep the whole .map() inside the JSX expression, as in {([... ] as const).map(item => ...)}.'
      : flattened
        ? 'The source arrived on one line with missing statement separators. Resend complete code with real line breaks between imports and declarations. If a long response is cut off, split it into smaller complete modules.'
        : 'Fix the generated code, preserve real line breaks, and retry.';
    throw new Error(`Syntax check failed for ${filePath}: ${detail}. File was not saved. ${hint}`);
  }
}

/** One known TSX footgun: `{[items] as const}.map(...)` — the brace closes too early. */
function fixEarlyJsxMapBrace(content: string, error: unknown): string | undefined {
  if (!(error instanceof SyntaxError) || !error.message.includes("Did you mean `{'>'}` or `&gt;`?")) {
    return undefined;
  }
  const location = (error as SyntaxError & { loc?: { start?: { line: number; column: number } } }).loc?.start;
  if (!location) {
    return undefined;
  }
  const lines = content.split(/(?<=\n)/);
  const lineIndex = location.line - 1;
  const arrowLine = lines[lineIndex];
  if (!arrowLine || arrowLine[location.column - 1] !== '>') {
    return undefined;
  }
  const arrowPrefix = arrowLine.slice(0, location.column);
  const start = arrowPrefix.trimStart().startsWith('{[') ? lineIndex : lineIndex - 1;
  const prefix = (start === lineIndex ? '' : (lines[start] ?? '')) + arrowPrefix;
  const match =
    /^([ \t]*\{)(\[[^\r\n]*\][ \t]+as[ \t]+const)\}(\.map\([ \t]*(?:\r?\n[ \t]*)?\([^()\r\n]*\)[ \t]*=>)$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const [, opening, receiver, callback] = match;
  lines.splice(start, lineIndex - start + 1, `${opening}(${receiver})${callback}${arrowLine.slice(location.column)}`);
  return lines.join('');
}
