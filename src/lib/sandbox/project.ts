import { getContainer } from './container';

const PACKAGE_JSON = {
  name: 'solara-sandbox',
  private: true,
  version: '0.0.0',
  type: 'module',
};

const README = [
  '# Solara sandbox',
  '',
  'This workspace is a WebContainer: Node.js running in your browser tab.',
  '',
  '- Nothing here is stored on the Solara server, and nothing survives clearing site data.',
  '- `npm install` fetches through StackBlitz\u2019s registry proxy, so it needs a network connection.',
  '- Only Node.js is available \u2014 no Python, no system packages, no persistent disk.',
  '- `package.json` sets `"type": "module"`, so use `import` in `.js` files (or `require` in a `.cjs` file).',
  '- The shell already starts inside the workspace: run `cat proof.txt`, not `cat /workspace/proof.txt`.',
  '- Same rule inside your code: `fs.readFileSync(\'index.html\')`, not `\'/workspace/index.html\'` — that path does not exist at runtime.',
  '',
].join('\n');

/** Idempotent workspace bootstrap: /workspace, package.json, README.md. */
export async function ensureWorkspace(): Promise<void> {
  const container = await getContainer();
  await container.fs.mkdir('/workspace', { recursive: true });
  try {
    await container.fs.readFile('/workspace/package.json', 'utf8');
  } catch {
    await container.fs.writeFile(
      '/workspace/package.json',
      `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`,
      'utf8',
    );
  }
  try {
    await container.fs.readFile('/workspace/README.md', 'utf8');
  } catch {
    await container.fs.writeFile('/workspace/README.md', README, 'utf8');
  }
}
