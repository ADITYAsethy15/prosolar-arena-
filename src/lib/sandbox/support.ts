// ============================================================================
// Sandbox capability detection (WebContainers).
// Deliberately imports NOTHING from @webcontainer/api: this module must be
// loadable on every page load, including when the sandbox is unavailable.
// ============================================================================

/**
 * Returns null when the in-browser sandbox can boot, otherwise a short
 * human-readable sentence for the disabled toggle. The checks are ordered from
 * "most likely to be the real cause in an embedded preview" downward, because a
 * wrong order would report the wrong reason and send the next debugger hunting
 * for headers that are already correct.
 */
export function sandboxUnavailableReason(): string | null {
  if (typeof window === 'undefined') {
    return 'The sandbox needs a browser runtime.';
  }
  if (!window.isSecureContext) {
    return 'The sandbox needs HTTPS (a secure context).';
  }
  if (window.self !== window.top) {
    return 'The sandbox cannot start inside an embedded preview frame — open Solara in a new tab.';
  }
  if (!window.crossOriginIsolated) {
    return 'This page is not cross-origin isolated, so SharedArrayBuffer is unavailable (COOP/COEP headers).';
  }
  try {
    if (typeof SharedArrayBuffer !== 'function') {
      throw new Error('missing');
    }
    new SharedArrayBuffer(8);
  } catch {
    return 'SharedArrayBuffer is disabled in this browser.';
  }
  if (typeof WebAssembly === 'undefined') {
    return 'WebAssembly is unavailable in this browser.';
  }
  return null;
}

/**
 * The sandbox agent loop speaks the OpenAI-compatible /chat/completions
 * contract (tools + tool_calls). The gemini provider path in this app uses a
 * different payload shape, so it is excluded rather than half-supported.
 * A model that ignores the tools array still degrades to plain prose — tool
 * execution is only ever reachable from a parsed tool_calls array, never from
 * text, so an unsupported model cannot trigger a command by hallucinating one.
 */
const PROVIDERS_WITHOUT_TOOLS = new Set(['gemini']);

export function providerSupportsTools(providerId: string): boolean {
  return !PROVIDERS_WITHOUT_TOOLS.has(providerId);
}
