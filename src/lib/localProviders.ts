// ============================================================================
// Which plain-HTTP base URLs are allowed, and why.
//
// The rule that blocked `http://<laptop-ip>:8080/v1` was "https, except loopback". It was
// written for a real reason — an API key travelling in plaintext over a network — but it
// also made the single most common local setup impossible: a model server (Ollama, LM
// Studio, llama.cpp, vLLM, Jan) on the same machine, reached at a LAN address rather than
// 127.0.0.1.
//
// So the rule is now explicit and narrow instead of implicit and absolute:
//
//   1. `https:`                      always allowed.
//   2. `http:` to loopback           allowed. Never leaves the machine.
//   3. `http:` to a private address  allowed (RFC1918, IPv6 ULA/link-local, .local,
//                                    bare hostname, .localhost) — this is the laptop
//                                    case, and the traffic does not cross the internet.
//   4. `http:` to anything else      refused, with an error that names the escape hatch
//                                    (an https tunnel + the LAN-only switch).
//
// `SOLARA_ALLOW_LAN_HTTP=1` (or a per-request `allowLanHttp`) lifts rule 4. It exists for
// people tunnelling a local server through a plain-http hostname; it is off by default
// because turning it on silently would make every key sent to any http host sniffable.
//
// This module is shared by the browser (URL validation) and by server.ts (the proxy), so
// the message a user sees and the rule the server enforces cannot drift.
// ============================================================================

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function hostOf(raw: string): string {
  try {
    return new URL(String(raw)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

export function isLoopbackHost(host: string): boolean {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(value) || value.endsWith('.localhost') || value === '::1';
}

/** RFC1918 IPv4 plus the other ranges that never route on the public internet. */
export function isPrivateIPv4(host: string): boolean {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const [a, b] = parts.map(Number);
  if (parts.some((part) => Number(part) > 255)) {
    return false;
  }
  return (
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a === 127 // loopback range
  );
}

/** IPv6 unique-local (fc00::/7) and link-local (fe80::/10). */
export function isPrivateIPv6(host: string): boolean {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!value.includes(':')) {
    return false;
  }
  return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value === '::1';
}

/**
 * A DNS name that only resolves on a local network: `.local` (mDNS/Bonjour),
 * `.lan`, `.home`, `.internal`, `.localdomain`, or a bare single-label hostname like
 * `mylaptop` — all of which are unreachable from the public internet.
 */
export function isLocalName(host: string): boolean {
  const value = String(host || '').toLowerCase();
  if (!value || value.includes(':')) {
    return false;
  }
  if (/\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(value)) {
    return true;
  }
  return !value.includes('.'); // bare hostname, e.g. "mylaptop" or "gpu-box"
}

export type HttpVerdict = {
  allowed: boolean;
  /** Where the host falls: this is what the UI shows next to the field. */
  scope: 'https' | 'loopback' | 'private' | 'unknown';
  /** Human-readable reason, safe to show verbatim. */
  reason: string;
};

/**
 * @param raw the base URL the user typed
 * @param opts.allowLanHttp explicit opt-in for plain http to a non-private host
 */
export function checkBaseUrl(raw: string, opts: { allowLanHttp?: boolean } = {}): HttpVerdict {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { allowed: false, scope: 'unknown', reason: 'Enter a complete base URL, e.g. http://192.168.1.20:8080/v1.' };
  }
  if (url.protocol === 'https:') {
    return { allowed: true, scope: 'https', reason: 'Encrypted in transit.' };
  }
  if (url.protocol !== 'http:') {
    return { allowed: false, scope: 'unknown', reason: `Only http and https URLs are supported (got ${url.protocol}).` };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host)) {
    return {
      allowed: true,
      scope: 'loopback',
      reason: 'Plain http to this machine is fine — the request never leaves it.',
    };
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host) || isLocalName(host)) {
    return {
      allowed: true,
      scope: 'private',
      reason: 'Plain http to a private address is allowed. Your key travels unencrypted on your own network — okay on a home LAN, not on public Wi-Fi.',
    };
  }
  if (opts.allowLanHttp) {
    return {
      allowed: true,
      scope: 'private',
      reason: 'Plain http to a public host is allowed because the LAN-only switch is on. Your API key and prompts are readable by anything on the path.',
    };
  }
  return {
    allowed: false,
    scope: 'unknown',
    reason:
      'Refused: plain http to a public address would send your API key in the clear. Use https, or turn on "allow plain http to any host" for a tunnelled local server.',
  };
}
