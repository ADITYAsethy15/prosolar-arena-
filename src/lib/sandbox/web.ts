// ============================================================================
// Web research from inside the agent loop.
//
// Two constraints shape this file:
//   * The sandbox has no egress (measured: every external host fails), so the
//     fetch has to be relayed by the page.
//   * Solara keeps the Tavily key in localStorage and never on the server, so the
//     key travels with the request instead of being read from an env var.
//
// If no Tavily key is configured the search tool fails with a sentence that says
// exactly what to do, rather than a 502 from a proxy the user cannot see.
// ============================================================================
import { STORAGE_KEYS } from '../storage';

function tavilyKey(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.API_KEYS);
    if (!raw) {
      return '';
    }
    const parsed = JSON.parse(raw) as { tavily?: string };
    return typeof parsed?.tavily === 'string' ? parsed.tavily.trim() : '';
  } catch {
    return '';
  }
}

export type WebSource = { id: number; title: string; url: string; content?: string; score?: number };

export async function searchWeb(query: string, limit = 5): Promise<{ query: string; sources: WebSource[] }> {
  const key = tavilyKey();
  if (!key) {
    throw new Error(
      'No Tavily API key is configured, so web_search is unavailable. Ask the user to add one in Settings, or answer from the project files alone.',
    );
  }
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, tavilyKey: key, results: Math.max(1, Math.min(10, limit)), depth: 'basic' }),
  });
  const body = (await response.json().catch(() => ({}))) as { sources?: WebSource[]; error?: string; query?: string };
  if (!response.ok) {
    throw new Error(body.error || `Web search failed (${response.status}).`);
  }
  return { query: body.query ?? query, sources: (body.sources ?? []).slice(0, limit) };
}

/**
 * Readable text of a page. There is no readability backend in this app, so this
 * uses a CORS proxy-free path: the page is fetched through the same server route
 * when configured, otherwise the model gets a clear "not available" instead of a
 * silently empty tool result it would treat as "the page says nothing".
 */
export async function fetchWeb(url: string): Promise<{ url: string; title: string; text: string }> {
  const key = tavilyKey();
  const response = await fetch('/api/fetch-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, tavilyKey: key }),
  });
  const body = (await response.json().catch(() => ({}))) as { title?: string; text?: string; error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Web fetch failed (${response.status}).`);
  }
  return { url, title: body.title ?? url, text: (body.text ?? '').slice(0, 40_000) };
}
