// ============================================================================
// Confirmation policy, ported from OpenHands' conversation settings.
//
// OpenHands does not have an "auto approve" checkbox; it has a policy object
// (`getConversationConfirmationPolicy` in agent-server-adapter.ts):
//
//   confirmation_mode off  -> { kind: "NeverConfirm" }
//   security_analyzer llm  -> { kind: "ConfirmRisky", threshold: "HIGH", confirm_unknown: true }
//   otherwise              -> { kind: "AlwaysConfirm" }
//
// The difference matters: "AlwaysConfirm" asks about every write and every command,
// which trains people to click approve without reading — the exact failure our single
// checkbox had. "ConfirmRisky" asks only about actions that can damage the workspace or
// the user's machine, and lets ordinary file writes through.
//
// This is the classifier, kept dependency-free and pure so it can be tested directly.
// ============================================================================

export type ConfirmationPolicy = 'never' | 'risky' | 'always';

export const POLICY_KEY = 'solara_sandbox_confirmation_policy';

export function clampPolicy(value: unknown): ConfirmationPolicy {
  return value === 'never' || value === 'always' || value === 'risky' ? value : 'risky';
}

export function getPolicy(): ConfirmationPolicy {
  try {
    return clampPolicy(typeof localStorage === 'undefined' ? null : localStorage.getItem(POLICY_KEY));
  } catch {
    return 'risky';
  }
}

export function savePolicy(value: unknown): ConfirmationPolicy {
  const policy = clampPolicy(value);
  try {
    localStorage.setItem(POLICY_KEY, policy);
  } catch {
    // private mode
  }
  return policy;
}

export type Risk = 'low' | 'medium' | 'high';

/**
 * Commands that can reach outside the project or destroy it. WebContainer is already a
 * jail — there is no host filesystem and no network — so `rm -rf /` is a workspace wipe,
 * not a machine wipe. These are still the ones worth a prompt: they are the actions a
 * user would want to have seen before it happened.
 */
const HIGH_RISK_COMMAND = [
  /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r?)\b/i, // rm -rf, rm -fr, rm -r -f
  /\brm\s+-\w*\s*\/(\s|$)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+--force|push\s+-f)\b/i,
  /\bnpm\s+(publish|unpublish)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|node)\b/i, // pipe-to-shell
  /\bchmod\s+(-R\s+)?777\b/i,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bsudo\b/i,
];

const MEDIUM_RISK_COMMAND = [
  /\bnpm\s+(i|install|ci)\b/i, // network + writes a lot of files
  /\bnpx\s+(-y\s+)?(create|degit|tiged)\b/i,
  /\bgit\s+(checkout|switch|restore)\b/i,
  /\bpnpm\s+(add|i|install)\b/i,
  /\byarn\s+(add|install)\b/i,
];

/** A path the agent should never rewrite without being asked. */
const PROTECTED_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git\//i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)package-lock\.json$/i, // silently regenerating a lockfile is a review event
];

export function pathRisk(path: string): Risk {
  const normalized = String(path || '').replace(/^\/workspace\/?/, '').replace(/^\.\//, '');
  if (!normalized) {
    return 'low';
  }
  if (PROTECTED_PATH.some((pattern) => pattern.test(normalized))) {
    return 'high';
  }
  return 'low';
}

export function commandRisk(command: string): Risk {
  const text = String(command || '');
  if (!text.trim()) {
    return 'low';
  }
  if (HIGH_RISK_COMMAND.some((pattern) => pattern.test(text))) {
    return 'high';
  }
  if (MEDIUM_RISK_COMMAND.some((pattern) => pattern.test(text))) {
    return 'medium';
  }
  return 'low';
}

export function toolRisk(name: string, args: Record<string, unknown>): Risk {
  if (name === 'project_delete_path') {
    const path = String(args.path ?? '');
    return path.includes('*') || path.replace(/^\/workspace\/?/, '').trim() === '' ? 'high' : 'medium';
  }
  if (name === 'project_write_file' || name === 'project_replace_lines' || name === 'project_patch_file') {
    return pathRisk(String(args.path ?? ''));
  }
  if (name === 'project_run_command') {
    return commandRisk(String(args.command ?? ''));
  }
  return 'low';
}

/**
 * The decision itself. `risky` confirms high and medium risk, but never an unknown tool
 * it has no opinion about — an unknown name is inert as far as this harness is concerned
 * (the dispatcher rejects it), and OpenHands' `confirm_unknown: true` exists for a
 * backend that can add tools at runtime, which this one cannot.
 */
export function needsConfirmation(policy: ConfirmationPolicy, risk: Risk): boolean {
  if (policy === 'never') {
    return false;
  }
  if (policy === 'always') {
    return true;
  }
  return risk === 'high';
}
