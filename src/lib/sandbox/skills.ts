// ============================================================================
// Microagents, ported from OpenHands as "skills".
//
// OpenHands ships markdown microagents that get appended to the prompt when a task
// matches: a trigger (keyword or task type) plus procedural knowledge — "for this kind
// of work, here is the order that actually works, and here are the traps". It is the
// cheapest quality lever in the whole loop, because it costs prompt tokens only when it
// is relevant and it fixes failures no amount of retrying fixes.
//
// Everything here is written against THIS sandbox: Node only, no Python, no system
// packages, WebContainer ports and preview semantics. A skill that described a Docker
// container would be worse than no skill at all.
// ============================================================================

export type Skill = {
  id: string;
  /** Matched against the user's task, case-insensitively. */
  triggers: RegExp;
  /** One line for the activity log. */
  title: string;
  body: string;
};

export const SKILLS: Skill[] = [
  {
    id: 'three',
    triggers: /\b(three\.?js|webgl|shader|3d|gltf|orbitcontrols|earth|planet|sphere)\b/i,
    title: 'three.js scene',
    body: [
      'THREE.JS HERE: install with `npm i three` (and `@types/three` if TypeScript).',
      'Render into a <canvas> sized to its container, and handle resize — a fixed 800x600 canvas is the usual "it looks broken" report.',
      'The animation loop must be `renderer.setAnimationLoop(...)`, not a bare requestAnimationFrame recursion, so it stops cleanly when the module reloads.',
      'Textures: a remote image URL will fail on a CORS-less texture load in the preview. Prefer procedural materials (MeshStandardMaterial + a light) or make the texture in a canvas.',
      'Lighting that works first try: one DirectionalLight, one AmbientLight, `renderer.toneMapping = THREE.ACESFilmicToneMapping`.',
    ].join('\n'),
  },
  {
    id: 'vite',
    triggers: /\b(vite|react|scaffold|npm create|dev server|preview)\b/i,
    title: 'Vite project',
    body: [
      'VITE HERE: a JSX/TSX file needs the matching extension or a build error is guaranteed. `src/main.jsx` with `document.getElementById("root")`.',
      'There is no npx create-vite template download worth waiting for — write index.html, package.json, vite.config.ts and src/ by hand in ONE batch, then `npm install`, then run.',
      'Scripts must be `"dev": "vite --host 0.0.0.0"` so the WebContainer proxy can reach the port.',
      'After starting the dev server, the preview appears automatically from the port event; do not curl localhost to check it.',
    ].join('\n'),
  },
  {
    id: 'node',
    triggers: /\b(express|api|server|endpoint|node|backend|fetch|route)\b/i,
    title: 'Node server',
    body: [
      'NODE HERE: this sandbox is Node only — no Python, no apt, no native builds that need a compiler.',
      'Bind to 0.0.0.0, not 127.0.0.1, or the preview proxy cannot reach the port.',
      'Use ESM (`import`) if package.json has "type": "module"; mixing forms is the most common instant crash here.',
    ].join('\n'),
  },
  {
    id: 'test',
    triggers: /\b(test|vitest|jest|coverage|assert)\b/i,
    title: 'Tests',
    body: [
      'TESTS HERE: `npm i -D vitest` then `npx vitest run` — one command, exit code 0 is the only pass signal.',
      'Write the smallest assertion that would fail before the fix. A test that passes before the change proves nothing.',
    ].join('\n'),
  },
  {
    id: 'fix',
    triggers: /\b(fix|broken|error|bug|not working|crash|exception|undefined)\b/i,
    title: 'Debugging',
    body: [
      'DEBUGGING HERE: reproduce first with the narrowest command, read the actual error text, then fix the cause. Do not rewrite whole files to "fix" an error you have not read.',
      'A preview exception (an error from the running page) is reported to you as a user message; treat it as authoritative and fix that line.',
    ].join('\n'),
  },
];

/** Skills whose trigger matches this task. Capped so the prompt cannot grow unbounded. */
export function skillsFor(prompt: string, limit = 2): Skill[] {
  const text = String(prompt || '');
  return SKILLS.filter((skill) => skill.triggers.test(text)).slice(0, limit);
}

/** The block appended to the system prompt, or '' when nothing matches. */
export function skillBlock(prompt: string): string {
  const matched = skillsFor(prompt);
  if (matched.length === 0) {
    return '';
  }
  return ['RELEVANT PLAYBOOK(S) FOR THIS TASK:', ...matched.map((skill) => `## ${skill.title}\n${skill.body}`)].join('\n\n');
}
