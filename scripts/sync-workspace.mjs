// Repo-root layout: the app lives at the root, and the zip/archive form lives in a
// subfolder. Render (and every other host) builds from the repo root, so the root IS
// the build. This script exists so the two layouts cannot drift: if someone edits the
// app in the subfolder, `npm install` copies it up rather than letting the deployed
// code silently diverge from the archive.
//
// It is deliberately a no-op when there is no subfolder, so it cannot break a build.
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const candidates = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^Prosolar--main$/i.test(entry.name))
  .map((entry) => entry.name);

if (candidates.length === 0) {
  process.exit(0);
}

const source = join(root, candidates[0]);
const skip = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
let copied = 0;

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) {
      continue;
    }
    const from = join(dir, entry.name);
    const to = join(root, relative(source, from));
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      walk(from);
    } else if (!existsSync(to) || statSync(to).mtimeMs < statSync(from).mtimeMs) {
      copyFileSync(from, to);
      copied += 1;
    }
  }
};

walk(source);
console.log(`[sync-workspace] ${candidates[0]} → repo root: ${copied} file(s) updated`);
