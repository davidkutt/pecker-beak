// M6 acceptance: a newcomer can follow the README. The "Try it without a model" shell block and the consumer
// snippet run here exactly as the README prints them, in a scratch copy of the repo, with the fake runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, read } from './helpers.mjs';

const README = read(REPO, 'README.md');

/** The first ```<lang> block after a heading. */
function blockAfter(heading, lang) {
  const at = README.indexOf(heading);
  assert.ok(at !== -1, `README has no "${heading}"`);
  const m = new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```').exec(README.slice(at));
  assert.ok(m, `no \`\`\`${lang} block after "${heading}"`);
  return m[1];
}

/** A scratch clone-like copy: what a newcomer has after `git clone` and `npm install`. */
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-readme-'));
  for (const p of ['beak.config.yaml', 'package.json', 'library', 'tools', 'docs/examples', 'test/fixtures/fake', '.gitignore']) {
    fs.cpSync(path.join(REPO, p), path.join(dir, p), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Newcomer');
  git('config', 'user.email', 'newcomer@example.com');
  git('add', '-A');
  git('commit', '-qm', 'clone');
  return dir;
}

test('README: every documented script and slash command exists', async () => {
  const { COMMANDS } = await import('../tools/beak.mjs');
  for (const c of COMMANDS) assert.ok(README.includes(c.name), `README should mention beak ${c.name}`);
  for (const f of fs.readdirSync(path.join(REPO, '.pi', 'prompts'))) {
    assert.ok(README.includes(`/${f.replace(/\.md$/, '')}`), `README should mention /${f.replace(/\.md$/, '')}`);
  }
});

test('README: "Try it without a model" runs end to end, and the consumer snippet reads the result', () => {
  const dir = scratchRepo();
  const shell = blockAfter('## Try it without a model', 'bash');
  const r = spawnSync('bash', ['-e', '-c', shell], { cwd: dir, encoding: 'utf8', env: { ...process.env, BEAK_RUNNER: '', BEAK_FAKE_DIR: '' } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^STOP pass$/m);
  assert.match(r.stdout, /^draft: drafts\/cold-email\/acme-pharma-formal-de\.md \(status: needs-review\)$/m);
  assert.match(r.stdout, /^approved out\/sales-agent\/cold-email\/acme-pharma-formal-de\.md \(version 1\)$/m);
  assert.match(r.stdout, /^committed: beak: approve sales-agent\/cold-email\/acme-pharma-formal-de v1$/m);
  assert.match(r.stdout, /Approved prompts:\n  sales-agent: 1 prompt/);

  const snippet = blockAfter('## How a consumer agent reads', 'js');
  fs.writeFileSync(path.join(dir, 'consumer.mjs'), `${snippet}\nprocess.stdout.write(system);\n`);
  const c = spawnSync(process.execPath, ['consumer.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^## Role\n/);
  assert.match(c.stdout, /Markus Lehmann, Key Account Manager Kliniken/);
  assert.ok(!c.stdout.includes('{{'), 'every runtime variable is filled');
});

test('the example round-0 prompt passes every hard check of the example run', async () => {
  const { runChecks } = await import('../tools/lib/checks.mjs');
  const text = read(REPO, 'docs/examples/round-0-prompt.md');
  const sections = ['Role', 'Context', 'Instructions', 'Constraints', 'Output format', 'Examples'].map((value) => ({ value, sources: ['cold-email'] }));
  const results = runChecks(text, { required_sections: sections }, { scope: 'prompt', runtimeVars: ['sender_name', 'sender_role'] });
  assert.deepEqual(results.filter((x) => !x.pass), []);
});
