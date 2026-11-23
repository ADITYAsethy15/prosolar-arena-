// ============================================================================
// Standalone snapshot of the sandbox workspace.
//
// Why this exists: a WebContainer preview URL is a StackBlitz-hosted proxy that is
// only reachable from the tab that owns the container. Copy it into a bare tab and
// the proxy answers "this is not connected to a project" — there is nothing on the
// host to connect to, so no header or server change can fix it. What DOES travel is
// the workspace itself: it is a pile of files we can already read, so we inline it
// into one document and hand that to a blob: URL. No proxy, no container, opens
// anywhere, and the user can email the file.
//
// Kept free of WebContainer and DOM-node imports on purpose: `read` is injected, so
// the whole resolver is unit-testable against a Map, and the only browser API used is
// DOMParser.
// ============================================================================

export type SnapshotRead = (absPath: string) => Promise<Uint8Array | null>;

export type SnapshotSkip = { ref: string; path: string; reason: string };

export type SnapshotResult = {
  html: string;
  entry: string;
  inlined: string[];
  skipped: SnapshotSkip[];
  bytes: number;
};

/** Per-file and per-document ceilings: a 512 MB tab must survive a fat workspace. */
const MAX_FILE_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 24_000_000;
/** Module graphs are followed this deep, so a barrel file cannot spin the walk forever. */
const MAX_MODULE_DEPTH = 12;

/** Labels are computed from the constants so a message can never claim the wrong number. */
const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;

const MIME: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wasm: 'application/wasm',
  map: 'application/json',
  txt: 'text/plain',
};

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

function isTextual(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml' || mime === 'application/wasm';
}

/** Anything that already stands on its own must be left exactly as it is. */
function isExternal(ref: string): boolean {
  return /^(?:[a-z+.-]+:|\/\/|#|\?)/i.test(ref.trim()) || /^\s*data:/i.test(ref);
}

function relDirOf(absPath: string): string {
  const i = absPath.lastIndexOf('/');
  return i <= 0 ? '/' : absPath.slice(0, i);
}

/**
 * Preview URLs are served from the origin root, so `/src/main.js` means
 * <workspace>/src/main.js while `./util.js` is relative to the importing file.
 */
function resolveRef(ref: string, fromDir: string, root: string): string | null {
  const clean = ref.split('#')[0].split('?')[0].trim();
  if (!clean || clean.endsWith('/')) {
    return null;
  }
  const base = clean.startsWith('/') ? root : fromDir;
  const joined = `${base}/${clean.startsWith('/') ? clean.slice(1) : clean}`.replace(/\/{2,}/g, '/');
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') {
      continue;
    }
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

function toBase64(bytes: Uint8Array): string {
  // btoa needs a binary string; chunked so a 3 MB file cannot blow the argument limit.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const decoder = /* @__PURE__ */ new TextDecoder();

export async function buildStandaloneHtml(
  entryAbs: string,
  entryHtml: string,
  read: SnapshotRead,
): Promise<SnapshotResult> {
  const inlined: string[] = [];
  const skipped: SnapshotSkip[] = [];
  const entryDir = relDirOf(entryAbs);
  // Everything the preview serves lives next to the entry file: /assets/x.png in a stylesheet
  // or an imported module means <entryDir>/assets/x.png, NOT a sibling of whichever file
  // happens to contain the reference (a stylesheet under src/ proved this wrong first try).
  const root = entryDir;
  const dataUrls = new Map<string, string>();
  const inFlight = new Set<string>();
  let total = entryHtml.length;

  const fail = (ref: string, path: string, reason: string): null => {
    if (!skipped.some((s) => s.ref === ref && s.path === path)) {
      skipped.push({ ref, path, reason });
    }
    return null;
  };

  const readText = async (abs: string): Promise<string | null> => {
    const bytes = await read(abs);
    if (!bytes) {
      return null;
    }
    if (bytes.length > MAX_FILE_BYTES) {
      return fail(abs, abs, `over the ${mb(MAX_FILE_BYTES)} per-file limit`);
    }
    if (total + bytes.length > MAX_TOTAL_BYTES) {
      return fail(abs, abs, `snapshot limit of ${mb(MAX_TOTAL_BYTES)} reached`);
    }
    total += bytes.length;
    return decoder.decode(bytes);
  };

  const dataUrlFor = async (abs: string, ref: string): Promise<string | null> => {
    const hit = dataUrls.get(abs);
    if (hit) {
      return hit;
    }
    const bytes = await read(abs);
    if (!bytes) {
      return fail(ref, abs, 'not found in /workspace');
    }
    if (bytes.length > MAX_FILE_BYTES) {
      return fail(ref, abs, `over the ${mb(MAX_FILE_BYTES)} per-file limit`);
    }
    if (total + bytes.length > MAX_TOTAL_BYTES) {
      return fail(ref, abs, `snapshot limit of ${mb(MAX_TOTAL_BYTES)} reached`);
    }
    total += bytes.length;
    const url = `data:${mimeFor(abs)};base64,${toBase64(bytes)}`;
    dataUrls.set(abs, url);
    inlined.push(abs);
    return url;
  };

  /**
   * A module becomes a data: URL, and its own relative specifiers become data: URLs
   * first. Inlining the source into the document instead would re-resolve `./util.js`
   * against the blob URL, and a raw `</script>` inside the source would close the tag.
   */
  const moduleUrl = async (abs: string, ref: string, depth: number): Promise<string | null> => {
    const hit = dataUrls.get(abs);
    if (hit) {
      return hit;
    }
    if (inFlight.has(abs)) {
      return fail(ref, abs, 'circular import (left as-is)');
    }
    if (depth > MAX_MODULE_DEPTH) {
      return fail(ref, abs, `module graph deeper than ${MAX_MODULE_DEPTH}`);
    }
    const source = await readText(abs);
    if (source === null) {
      return skipped.some((s) => s.path === abs) ? null : fail(ref, abs, 'not found in /workspace');
    }
    inFlight.add(abs);
    let out = source;
    const specPattern = /(\bfrom\s*|\bimport\s*|\bexport\s+\*\s+from\s*)(['"])([^'"\n]+)\2/g;
    const found = [...out.matchAll(specPattern)];
    for (const match of found) {
      const spec = match[3];
      if (isExternal(spec)) {
        continue;
      }
      const childAbs = resolveRef(spec, relDirOf(abs), root);
      if (!childAbs) {
        continue;
      }
      const childUrl = await moduleUrl(childAbs, spec, depth + 1);
      if (childUrl) {
        out = out.split(spec).join(childUrl);
      }
    }
    inFlight.delete(abs);
    const url = `data:text/javascript;base64,${toBase64(encoderEncode(out))}`;
    dataUrls.set(abs, url);
    if (!inlined.includes(abs)) {
      inlined.push(abs);
    }
    return url;
  };

  const rewriteCss = async (abs: string, css: string): Promise<string> => {
    let out = css;
    const imports = [...out.matchAll(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1/g)];
    for (const match of imports) {
      const spec = match[2];
      if (isExternal(spec)) {
        continue;
      }
      const childAbs = resolveRef(spec, relDirOf(abs), root);
      const childCss = childAbs ? await readText(childAbs) : null;
      if (childCss) {
        out = out.split(match[0]).join(await rewriteCss(childAbs!, childCss));
      } else {
        fail(spec, childAbs ?? spec, '@import target not found');
      }
    }
    const urls = [...out.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    for (const match of urls) {
      const spec = match[2];
      if (isExternal(spec)) {
        continue;
      }
      const assetAbs = resolveRef(spec, relDirOf(abs), root);
      if (!assetAbs) {
        continue;
      }
      const dataUrl = await dataUrlFor(assetAbs, spec);
      if (dataUrl) {
        out = out.split(match[0]).join(`url("${dataUrl}")`);
      }
    }
    return out;
  };



  const attrToDataUrl = async (el: Element, attr: string) => {
    const ref = el.getAttribute(attr);
    if (!ref || isExternal(ref)) {
      return;
    }
    const abs = resolveRef(ref, entryDir, root);
    if (!abs) {
      return;
    }
    const url = await dataUrlFor(abs, ref);
    if (url) {
      el.setAttribute(attr, url);
    }
  };

  const doc = new DOMParser().parseFromString(entryHtml, 'text/html');

  // Vite/React dev hooks: their clients only exist inside the dev server, so a copy
  // that keeps asking for them spams console errors and delays load for nothing.
  for (const el of [...doc.querySelectorAll('script[src]')]) {
    const ref = el.getAttribute('src') ?? '';
    if (/^\/@(?:vite|react-refresh|client)\b/.test(ref)) {
      el.remove();
      skipped.push({ ref, path: ref, reason: 'dev-server client, stripped' });
    }
  }

  for (const el of [...doc.querySelectorAll('script[type="module"][src]')]) {
    const ref = el.getAttribute('src') ?? '';
    const abs = resolveRef(ref, entryDir, root);
    if (!abs) {
      continue;
    }
    const url = await moduleUrl(abs, ref, 0);
    if (url) {
      el.setAttribute('src', url);
      el.removeAttribute('type');
      el.setAttribute('type', 'module');
    }
  }

  for (const el of [...doc.querySelectorAll('script[src]')]) {
    const ref = el.getAttribute('src') ?? '';
    if (isExternal(ref)) {
      continue;
    }
    const abs = resolveRef(ref, entryDir, root);
    if (!abs) {
      continue;
    }
    const source = await readText(abs);
    if (source === null) {
      continue;
    }
    if (/<\/script/i.test(source)) {
      const url = await dataUrlFor(abs, ref);
      if (url) {
        el.setAttribute('src', url);
      }
      continue;
    }
    const fresh = doc.createElement('script');
    fresh.textContent = source;
    el.replaceWith(fresh);
    if (!inlined.includes(abs)) {
      inlined.push(abs);
    }
  }

  for (const el of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const ref = el.getAttribute('href') ?? '';
    if (isExternal(ref)) {
      continue;
    }
    const abs = resolveRef(ref, entryDir, root);
    if (!abs) {
      continue;
    }
    const css = await readText(abs);
    if (css === null) {
      fail(ref, abs, 'stylesheet not found');
      continue;
    }
    if (/<\/style/i.test(css)) {
      fail(ref, abs, 'stylesheet contains </style');
      continue;
    }
    const style = doc.createElement('style');
    style.textContent = await rewriteCss(abs, css);
    el.replaceWith(style);
    if (!inlined.includes(abs)) {
      inlined.push(abs);
    }
  }

  for (const el of [...doc.querySelectorAll('style')]) {
    if (el.textContent) {
      el.textContent = await rewriteCss(entryAbs, el.textContent);
    }
  }

  for (const selector of ['img[src]', 'source[src]', 'video[src]', 'audio[src]', 'embed[src]', 'track[src]', 'input[src]', 'video[poster]']) {
    for (const el of [...doc.querySelectorAll(selector)]) {
      await attrToDataUrl(el, el.hasAttribute('poster') ? 'poster' : 'src');
    }
  }
  for (const el of [...doc.querySelectorAll('link[rel~="icon"][href], link[rel~="apple-touch-icon"][href]')]) {
    await attrToDataUrl(el, 'href');
  }
  for (const el of [...doc.querySelectorAll('[style*="url("]')]) {
    const style = el.getAttribute('style');
    if (style) {
      el.setAttribute('style', await rewriteCss(entryAbs, style));
    }
  }

  const html = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  return { html, entry: entryAbs, inlined, skipped, bytes: html.length };
}

const encoderEncode = (text: string): Uint8Array => new TextEncoder().encode(text);
