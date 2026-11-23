// Path jail for every sandbox filesystem and shell entry point.
// The whole container filesystem is virtual, so the jail's job is to keep
// tool arguments inside /workspace and to make "../" style escapes a hard,
// boring error instead of a surprising success.
export const WORKSPACE_ROOT = '/workspace';

export function safePath(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('unsafe path: empty');
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('unsafe path: control characters');
  }
  // Relative paths are resolved against /workspace; absolute paths are only
  // accepted when they already point inside it (models write both styles).
  const abs = raw.startsWith('/') ? raw : `${WORKSPACE_ROOT}/${raw}`;
  const parts = abs.split('/').filter(Boolean);
  if (parts[0] !== 'workspace') {
    throw new Error(`unsafe path: ${raw}`);
  }
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '.') {
      continue;
    }
    if (seg === '..') {
      throw new Error(`unsafe path: ${raw}`);
    }
    if (seg === 'workspace') {
      if (out.length === 0) {
        out.push(seg);
      }
      continue;
    }
    out.push(seg);
  }
  const joined = `/${out.join('/')}`;
  return joined === '/workspace' ? WORKSPACE_ROOT : joined;
}

/** '/workspace/a/b.ts' -> 'a/b.ts' (for display only; never for fs calls). */
export function relPath(abs: string): string {
  return abs.replace(/^\/workspace\/?/, '') || '.';
}

export function parentOf(absPath: string): string {
  const idx = absPath.lastIndexOf('/');
  return idx <= 0 ? WORKSPACE_ROOT : absPath.slice(0, idx);
}
