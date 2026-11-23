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
  /** Stylesheets that arrived through `import './x.css'` and had to be hoisted out of JS. */
  stylesHoisted: number;
  /** True when something only a bundler can handle was left behind. */
  needsBuild: boolean;
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

const JS_EXT = /\.(?:m?js|cjs)$/;
const STYLE_EXT = /\.css$/;
/** Things a bundler hands back as a URL string (or an object) instead of a module. */
const ASSET_EXT = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|mp3|mp4|webm|wav|ogg|woff2?|ttf|otf|eot)$/i;
/** Syntax a browser cannot parse: only a build step can turn these into what they mean. */
const NEEDS_BUILD = /\.(?:ts|tsx|jsx|vue|svelte|scss|sass|less|styl)$/;

function extOf(path: string): string {
  const clean = path.split('?')[0];
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot);
}

/** `@scope/pkg/dist/x.js` -> { pkg: '@scope/pkg', sub: 'dist/x.js' }. */
function pkgNameOf(spec: string): { pkg: string; sub: string } | null {
  const parts = spec.replace(/^\/+/, '').split('?')[0].split('/');
  if (parts[0]?.startsWith('@') && parts.length > 1) {
    return { pkg: `${parts[0]}/${parts[1]}`, sub: parts.slice(2).join('/') };
  }
  return parts[0] ? { pkg: parts[0], sub: parts.slice(1).join('/') } : null;
}

async function readJson(abs: string, read: SnapshotRead): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await read(abs);
    if (!bytes) {
      return null;
    }
    return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A dependency's entry file, the way a bundler finds it: package.json `exports`, then
 * `module`, then `main`, then index. This is what makes a snapshot of a real project work
 * at all -- `import * as THREE from 'three'` means nothing to a browser, so a page that
 * keeps that specifier runs no script and renders as bare text.
 */
async function resolveBare(
  spec: string,
  workspaceRoot: string,
  read: SnapshotRead,
  want: 'js' | 'css' = 'js',
): Promise<string | null> {
  const named = pkgNameOf(spec);
  if (!named || named.pkg.includes('..') || named.pkg === 'node_modules') {
    return null;
  }
  const dir = `${workspaceRoot}/node_modules/${named.pkg}`;
  const manifest = await readJson(`${dir}/package.json`, read);
  const picks: string[] = [];
  const condition = (value: unknown): string | null => {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const key of want === 'css' ? ['style', 'default'] : ['import', 'default']) {
        const hit = obj[key];
        if (typeof hit === 'string') {
          return hit;
        }
      }
    }
    return null;
  };
  if (manifest) {
    const exports = manifest.exports;
    if (named.sub && exports && typeof exports === 'object') {
      const hit = condition((exports as Record<string, unknown>)[`./${named.sub}`]);
      if (hit) {
        picks.push(hit);
      }
    }
    if (!named.sub && exports) {
      if (typeof exports === 'string') {
        picks.push(exports);
      } else if (typeof exports === 'object') {
        const asMap = exports as Record<string, unknown>;
        const hit = '.' in asMap ? condition(asMap['.']) : condition(asMap);
        if (hit) {
          picks.push(hit);
        }
      }
    }
    if (!named.sub) {
      for (const field of want === 'css' ? ['style', 'main'] : ['module', 'main', 'browser']) {
        const value = manifest[field];
        if (typeof value === 'string') {
          picks.push(value);
        }
      }
    }
  }
  if (named.sub) {
    picks.push(named.sub);
  }
  picks.push(want === 'css' ? 'index.css' : 'index.js');
  for (const raw of picks) {
    const pick = String(raw ?? '').replace(/^\.\//, '').replace(/^\//, '');
    if (!pick || /^https?:/.test(pick)) {
      continue;
    }
    const abs = `${dir}/${pick}`.replace(/\/{2,}/g, '/');
    const ext = extOf(abs);
    if (ext && (want === 'css' ? !STYLE_EXT.test(abs) : !JS_EXT.test(abs))) {
      continue;
    }
    if (await read(abs)) {
      return abs;
    }
  }
  return null;
}

/** CJS in a browser module throws on load, which looks identical to "the page is blank". */
function looksCommonJs(text: string): boolean {
  return (/\brequire\s*\(/.test(text) || /module\.exports/.test(text)) && !/\bexport\b/.test(text);
}

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
  // `node_modules` is a sibling of the entry only when the entry sits at the workspace root;
  // a dist/index.html still resolves its deps from the workspace, so look there too.
  const wsRoots = root === '/workspace' || root === '/' ? ['/workspace'] : ['/workspace', root];
  const dataUrls = new Map<string, string>();
  const injectedStyles: string[] = [];
  const styleKeys = new Set<string>();
  const inFlight = new Set<string>();
  let total = entryHtml.length;

  const fail = (ref: string, path: string, reason: string): null => {
    if (!skipped.some((s) => s.ref === ref && s.path === path)) {
      skipped.push({ ref, path, reason });
    }
    return null;
  };

  /**
   * Which names an import statement introduces. Needed because a specifier is only the tail of
   * the statement: rewriting just `from './x.css'` would leave a dangling `import styles`, which
   * is a syntax error and a blank page. Stubbing needs the whole statement.
   */
  const bindingsOf = (head: string): string[] => {
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(head);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) {
          continue;
        }
        const aliased = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(trimmed);
        const bareName = /([A-Za-z_$][\w$]*)\s*$/.exec(trimmed);
        const name = aliased?.[1] ?? bareName?.[1] ?? '';
        if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'as') {
          names.push(name);
        }
      }
    }
    const single = /(?:^|[\s;])import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*(?:\bfrom\b\s*)?$/.exec(head);
    if (single) {
      names.push(single[1]);
    }
    return [...new Set(names)];
  };

  const looksBare = (spec: string): boolean =>
    !/^[./]/.test(spec) && !/^[\w+.-]+:/.test(spec) && !spec.startsWith('#');

  /**
   * Where a reference actually lives. Bare specifiers go to node_modules (resolved the way a
   * bundler does, via the package's own exports/module/main fields) and NEVER to a path next
   * to the importing file — `three` is not `src/three`, and treating it as one is what made a
   * snapshot of a real project render as nothing but text. Everything else is entry-relative,
   * with the extensionless guesses a bundler makes (`./util` -> ./util.js, ./util/index.js).
   */
  const locate = async (spec: string, fromAbs: string, want: 'js' | 'css'): Promise<string | null> => {
    const clean = spec.split('?')[0];
    if (looksBare(clean)) {
      for (const base of wsRoots) {
        const hit = await resolveBare(clean, base, read, want);
        if (hit) {
          return hit;
        }
      }
      return null;
    }
    const local = resolveRef(clean, relDirOf(fromAbs), root);
    if (!local) {
      return null;
    }
    if (await read(local)) {
      return local;
    }
    const dot = local.lastIndexOf('.');
    const slash = local.lastIndexOf('/');
    if (dot < slash) {
      for (const guess of want === 'css' ? [`${local}.css`, `${local}/index.css`] : [`${local}.js`, `${local}/index.js`, `${local}.mjs`]) {
        if (await read(guess)) {
          return guess;
        }
      }
    }
    return local;
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
    if (NEEDS_BUILD.test(abs)) {
      return fail(ref, abs, 'needs a build step (TypeScript/JSX/SCSS) — snapshot dist/, or build first');
    }
    inFlight.add(abs);
    let out = source;
    // Matches the whole statement, not just its tail: swapping only `from './x.css'` would leave
    // a dangling `import styles`, which is a syntax error and a blank page. The leading class is
    // consumed so a statement at the start of a line is found, and `stmtStart` is located by where
    // the captured keyword text begins, so neighbouring statements on one line survive.
    const specPattern = /(?:^|[;}\n])\s*(import\s+(?:[\w$*{},\s]*?from\s+)?|export\s+(?:\*|\{[\w$*,\s]*\})\s+from\s+)(['"])([^'"\n]+)\2/g;
    const dynamicPattern = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
    type Edit = { start: number; end: number; text: string };
    const edits: Edit[] = [];
    const pushSpan = (edit: Edit) => {
      if (!edits.some((x) => edit.start < x.end && x.start < edit.end)) {
        edits.push(edit);
      }
    };
    const found = [...out.matchAll(specPattern)];
    for (const match of found) {
      const spec = match[3];
      const quote = match[2];
      const keyword = match[1];
      const stmtStart = (match.index ?? 0) + match[0].indexOf(keyword);
      const litEnd = (match.index ?? 0) + match[0].length;
      const litStart = litEnd - spec.length - 2;
      const names = bindingsOf(keyword);
      const stubFor = (value: string) =>
        names.length > 0 ? names.map((name) => `const ${name} = ${value};`).join(' ') : '';
      if (isExternal(spec)) {
        continue;
      }
      const want = STYLE_EXT.test(extOf(spec)) ? 'css' : 'js';
      const childAbs = await locate(spec, abs, want);
      // Rewriting by substring (`out.split(spec).join(url)`) corrupts neighbours: the specifier
      // `three` also occurs inside `'three/examples/…'`, so one replacement mangles the next.
      // Spans collected against the untouched source and applied back to front cannot.
      // Two passes can touch the same source (an import and a `new URL()` on one line), and
      // overlapping spans would splice each other into garbage. Refuse the second one.
      const pushEdit = (edit: Edit) => {
        if (!edits.some((x) => edit.start < x.end && x.start < edit.end)) {
          edits.push(edit);
        }
      };
      /** Replace the quoted specifier only (a resolved import keeps its binding list). */
      const swapSpec = (url: string) => pushEdit({ start: litStart, end: litEnd, text: `${quote}${url}${quote}` });
      /** Replace the entire statement (a hoisted stylesheet, an asset binding, a refused module). */
      const replaceWith = (text: string) => pushEdit({ start: stmtStart, end: litEnd, text });
      if (!childAbs) {
        if (looksBare(spec.split('?')[0])) {
          replaceWith(stubFor('undefined'));
          fail(spec, `/node_modules/${pkgNameOf(spec)?.pkg ?? spec}`, `bare import "${spec}" is not in node_modules — run the install, or snapshot dist/`);
        }
        continue;
      }
      if (NEEDS_BUILD.test(childAbs)) {
        replaceWith(stubFor('{}'));
        fail(spec, childAbs, 'needs a build step (TypeScript/JSX/SCSS) — snapshot dist/, or build first');
        continue;
      }
      // A stylesheet imported from JS is a bundler feature. The module graph cannot carry it,
      // so it is hoisted into a <style> in the document and the import is dropped. Left alone,
      // the page loads and renders as unstyled text — exactly the "only letters" symptom.
      if (STYLE_EXT.test(childAbs)) {
        const css = await readText(childAbs);
        if (css === null) {
          continue;
        }
        if (!styleKeys.has(childAbs)) {
          styleKeys.add(childAbs);
          injectedStyles.push(await rewriteCss(childAbs, css));
        }
        replaceWith(stubFor('{}'));
        if (names.length > 0 && /\.module\.css$/i.test(childAbs)) {
          fail(spec, childAbs, 'CSS module: class names need the bundler, bound to {}');
        }
        if (!inlined.includes(childAbs)) {
          inlined.push(childAbs);
        }
        continue;
      }
      if (ASSET_EXT.test(childAbs)) {
        const url = await dataUrlFor(childAbs, spec);
        if (!url) {
          continue;
        }
        if (names.length === 1) {
          replaceWith(`const ${names[0]} = "${url}";`);
        } else {
          replaceWith(stubFor(`"${url}"`));
        }
        continue;
      }
      const childUrl = await moduleUrl(childAbs, spec, depth + 1);
      if (childUrl) {
        swapSpec(childUrl);
      } else if (names.length > 0) {
        // A dependency we deliberately refuse to inline (CommonJS, too deep, over budget).
        // Stub the bindings so the rest of the page still runs, and say why below.
        replaceWith(stubFor('undefined'));
      }
    }
    // Vite's asset idiom. Inside a data: module `import.meta.url` is the module's own URL, so
    // `new URL('./earth.png', import.meta.url)` resolves to nothing and a texture silently
    // never loads — which in a three.js scene looks like "the page is just letters and a box".
    for (const match of [...out.matchAll(/new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)]) {
      const spec = match[2];
      const litStart = (match.index ?? 0) + match[0].indexOf(match[1]) ;
      const litEnd = litStart + spec.length + 2;
      const abs2 = resolveRef(spec, relDirOf(abs), root);
      if (!abs2) {
        continue;
      }
      const dataUrl = await dataUrlFor(abs2, spec);
      if (dataUrl) {
        pushSpan({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: JSON.stringify(dataUrl) });
      }
      void litStart;
      void litEnd;
    }
    for (const match of [...out.matchAll(dynamicPattern)]) {
      const spec = match[2];
      const quote = match[1];
      if (isExternal(spec)) {
        continue;
      }
      const litEnd = (match.index ?? 0) + match[0].length - 1;
      const litStart = litEnd - spec.length - 2;
      const childAbs = await locate(spec, abs, 'js');
      if (!childAbs) {
        fail(spec, spec, 'dynamic import is not in the workspace');
        continue;
      }
      const childUrl = await moduleUrl(childAbs, spec, depth + 1);
      if (childUrl) {
        edits.push({ start: litStart, end: litEnd, text: `${quote}${childUrl}${quote}` });
      }
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
    }

    // Checked after the splices, or every rewritten `new URL(…, import.meta.url)` would also be
    // reported as unhandled — the text at this point is what the browser will actually run.
    if (/import\.meta\.url/.test(out)) {
      fail(abs, abs, 'import.meta.url left in a module: it points at the snapshot itself, build for exact asset paths');
    }
    if (looksCommonJs(out)) {
      return fail(ref, abs, 'CommonJS module — needs a bundler, nothing was inlined');
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
      const childAbs = await locate(spec, abs, 'css');
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
      const assetAbs = await locate(spec, abs, 'css');
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
  // Not `[style*="url("]`: an attribute-substring selector containing a parenthesis is not
  // matched consistently across engines (jsdom returns zero hits for it, so this path was
  // silently untestable). Filter on the value instead of in the selector.
  for (const el of [...doc.querySelectorAll('[style]')]) {
    const style = el.getAttribute('style');
    if (style && style.includes('url(')) {
      el.setAttribute('style', await rewriteCss(entryAbs, style));
    }
  }

  if (injectedStyles.length > 0) {
    const head = doc.querySelector('head') ?? doc.documentElement;
    const style = doc.createElement('style');
    style.setAttribute('data-snapshot', 'hoisted-from-module-graph');
    style.textContent = injectedStyles.join('\n');
    head.appendChild(style);
  }

  const html = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  return {
    html,
    entry: entryAbs,
    inlined,
    skipped,
    bytes: html.length,
    stylesHoisted: injectedStyles.length,
    // The difference between "blank page" and "here is why": anything only a bundler can
    // handle was left behind on purpose.
    needsBuild: skipped.some((entry) => /build step|CommonJS|CSS module|bare import/.test(entry.reason)),
  };
}

const encoderEncode = (text: string): Uint8Array => new TextEncoder().encode(text);
