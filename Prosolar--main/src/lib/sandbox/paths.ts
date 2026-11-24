// Small path helpers and error predicates shared by the tool layer.
// (`path` here is a POSIX-only, no-disk shim — the container filesystem is not the
// host filesystem, so `node:path` would be the wrong dependency on the browser side.)

export const path = {
  dirname(value: string): string {
    const idx = value.lastIndexOf('/');
    return idx <= 0 ? '.' : value.slice(0, idx);
  },
  basename(value: string): string {
    const idx = value.lastIndexOf('/');
    return idx === -1 ? value : value.slice(idx + 1);
  },
  extname(value: string): string {
    const base = path.basename(value);
    const idx = base.lastIndexOf('.');
    return idx <= 0 ? '' : base.slice(idx);
  },
  join(...parts: string[]): string {
    return parts
      .filter(Boolean)
      .join('/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/$/, '');
  },
  normalize(value: string): string {
    const out: string[] = [];
    for (const segment of value.split('/')) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        if (out.length === 0) {
          out.push('..');
        } else if (out[out.length - 1] === '..') {
          out.push('..');
        } else {
          out.pop();
        }
        continue;
      }
      out.push(segment);
    }
    return (value.startsWith('/') ? '/' : '') + out.join('/');
  },
  isAbsolute(value: string): boolean {
    return value.startsWith('/');
  },
  relative(from: string, to: string): string {
    const fromParts = from.split('/').filter(Boolean);
    const toParts = to.split('/').filter(Boolean);
    while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
      fromParts.shift();
      toParts.shift();
    }
    return [...fromParts.map(() => '..'), ...toParts].join('/');
  },
};

/** True for any ENOENT-shaped error from WebContainer's fs. */
export function isNotFound(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT') ||
    (error instanceof Error && /ENOENT|no such file/i.test(error.message))
  );
}
