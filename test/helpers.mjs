// Shared test helpers (not a test file: npm test runs test/**/*.test.mjs only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../tools/lib/config.mjs';

export const REPO = fileURLToPath(new URL('..', import.meta.url));

/** A temp repo with the real beak.config.yaml (optionally edited as text) and a copy of the example library. */
export function tempRepo({ prefix = 'beak-', editConfig } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let config = fs.readFileSync(path.join(REPO, 'beak.config.yaml'), 'utf8');
  if (editConfig) config = editConfig(config);
  fs.writeFileSync(path.join(dir, 'beak.config.yaml'), config);
  fs.cpSync(path.join(REPO, 'library'), path.join(dir, 'library'), { recursive: true });
  return dir;
}

export function configOf(dir, env = {}) {
  return loadConfig({ root: dir, env }).config;
}

/** Run a command function in-process. Returns { code, out, err }. */
export async function run(commandFn, args, opts = {}) {
  let out = '';
  let err = '';
  const io = { out: { write: (s) => (out += s) }, err: { write: (s) => (err += s) } };
  const code = await commandFn(args, io, { env: {}, ...opts });
  return { code, out, err };
}

export function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

export function readJsonFile(dir, rel) {
  return JSON.parse(read(dir, rel));
}

export function write(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Every file under `dir` (relative paths, sorted). */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** A fixed local time, so run ids are predictable: 2026-11-07 09:30. */
export const NOW = new Date(2026, 10, 7, 9, 30);

/** A minimal valid block. `fm`: extra frontmatter lines; `done`: Done-when lines. */
export function blockText(type, id, { fm = '', done = ['- Does the thing.'], title = id, examples = '' } = {}) {
  return `---\nid: ${id}\ntype: ${type}\nversion: 1\nupdated: 2026-11-06\n${fm ? `${fm.trim()}\n` : ''}---\n\n# ${title}\n\n## Purpose\n\nA test block.\n\n## Must include\n\n## Avoid\n\n## Examples\n\n${examples}\n\n## Done when\n\n${done.join('\n')}\n`;
}

export const FOLDER = { task: 'tasks', scenario: 'scenarios', customer: 'customers', industry: 'industries', tone: 'tones', context: 'context' };

export function writeBlock(dir, type, id, opts) {
  return write(dir, `library/${FOLDER[type]}/${id}.md`, blockText(type, id, opts));
}
