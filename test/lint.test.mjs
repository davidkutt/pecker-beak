import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../tools/lib/config.mjs';
import { formatFindings, lint, summary } from '../tools/lib/lint.mjs';
import { loadLibrary } from '../tools/lib/library.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'tools', 'beak.mjs');
const BROKEN = path.join(REPO, 'test', 'fixtures', 'library-broken');

/** A temp repo with the real beak.config.yaml and a copy of `library`. */
function tempRepo(library) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-lint-'));
  fs.copyFileSync(path.join(REPO, 'beak.config.yaml'), path.join(dir, 'beak.config.yaml'));
  fs.cpSync(library, path.join(dir, 'library'), { recursive: true });
  return dir;
}

function beak(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BEAK_RUNNER: '' } });
}

test('the example library lints clean', () => {
  const { config } = loadConfig({ root: REPO, env: {} });
  const { findings, files } = lint({ config });
  assert.deepEqual(formatFindings(findings), []);
  assert.equal(files, 8);
});

test('the example library has what M1 asks for', () => {
  const { byType } = loadLibrary(path.join(REPO, 'library'), { root: REPO });
  const ids = (type) => [...byType[type].keys()];
  assert.deepEqual(ids('task'), ['cold-email']);
  assert.equal(byType.task.get('cold-email').frontmatter.consumer, 'sales-agent');
  assert.equal(ids('customer').length, 1);
  assert.equal(ids('industry').length, 2);
  assert.deepEqual(ids('tone'), ['formal-de', 'friendly-en']);
  assert.equal(ids('scenario').length, 2);
});

test('beak lint on the repo exits 0', () => {
  const r = beak(REPO, 'lint');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), '8 files checked: 0 errors, 0 warnings');
});

test('broken fixtures fail with clear messages', () => {
  const r = beak(tempRepo(BROKEN), 'lint');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const expected = [
    'library/customers/no-frontmatter.md:1: error: must start with YAML frontmatter',
    'library/customers/wrong-id.md:2: error: id "other-name" must equal the filename "wrong-id.md"',
    'library/customers/wrong-id.md:7: error: industry "aerospace" not found: there is no library/industries/aerospace.md',
    'library/industries/done-when-bad.md:18: warning: "## Examples": write labels exactly as "Good:" or "Bad:"',
    'library/industries/done-when-bad.md:22: error: "## Done when": each criterion must be one list item line',
    'library/industries/done-when-bad.md:23: error: "## Done when": use plain list items, not checkboxes',
    'library/industries/done-when-bad.md:24: error: "## Done when": "(learned 2026-13-01)" needs a date',
    'library/industries/notes.txt: warning: not read: only .md files are blocks',
    'library/misc/: warning: not read: unknown folder',
    'library/scenarios/todo-stub.md:6: warning: TODO left: input: "TODO: ask the user for a sample message"',
    'library/scenarios/todo-stub.md:11: warning: TODO left: TODO: describe the situation.',
    'library/scenarios/wrong-type.md: error: a scenario needs "input"',
    'library/scenarios/wrong-type.md:3: error: type "tone" does not match its folder scenarios/ (expected "scenario")',
    'library/scenarios/wrong-type.md:4: error: version must be a whole number >= 1 (got 0)',
    'library/scenarios/wrong-type.md:5: error: updated must be a date like 2026-11-06 (got "06.11.2026")',
    'library/scenarios/wrong-type.md:6: error: "industry" does not belong in a scenario block (it is a customer field)',
    'library/tasks/bad-task.md:6: error: consumer "marketing-agent" is not declared in beak.config.yaml (consumers: sales-agent, support-agent)',
    'library/tasks/bad-task.md:7: error: output_format must be a non-empty list of section names',
    'library/tasks/bad-task.md:9: error: test_inputs: scenario "missing-scenario" not found',
    'library/tasks/bad-task.md:9: warning: has 2 test inputs; beak.config.yaml loop.test_inputs is 3',
    'library/tasks/bad-task.md:10: error: test_inputs[1] ("inline-one") needs non-empty "input" text',
    'library/tasks/bad-task.md:12: error: golden "out/sales-agent/bad-task/nowhere.md" not found',
    'library/tasks/bad-task.md:13: error: runtime_vars must be a list of names like lead_name',
    'library/tasks/bad-task.md:17: error: checks.output.min_words (300) is larger than max_words (100)',
    'library/tasks/bad-task.md:18: error: checks.output.banned must be a list of non-empty strings',
    'library/tasks/bad-task.md:19: error: unknown check checks.output.maxwords',
    'library/tasks/bad-task.md:21: error: checks.style is not a check scope (use output or prompt)',
    'library/tasks/bad-task.md:34: error: a task needs at least one criterion under "## Done when"',
    'library/tones/bad-yaml.md:4: error: invalid YAML in frontmatter:',
    'library/tones/sections-wrong.md:9: error: text before the first section',
    'library/tones/sections-wrong.md:11: error: section "## must include" must be written "## Must include"',
    'library/tones/sections-wrong.md:17: error: unknown section "## Notes"',
    'library/tones/sections-wrong.md: error: missing section "## Done when"',
  ];
  const lines = r.stdout.trim().split('\n');
  for (const want of expected) assert.ok(lines.some((l) => l.startsWith(want)), `missing: ${want}\n---\n${r.stdout}`);
  assert.ok(!lines.some((l) => l.startsWith('library/tones/ok-tone.md')), 'the valid fixture has no findings');
  assert.match(lines.at(-1), /^9 files checked: \d+ errors, 6 warnings$/);
});

test('lint output is sorted and stable', () => {
  const dir = tempRepo(BROKEN);
  const a = beak(dir, 'lint').stdout;
  assert.equal(beak(dir, 'lint').stdout, a);
  const lines = a.trim().split('\n').slice(0, -1);
  const files = lines.map((l) => l.split(/:(\d+:)? (error|warning): /)[0]);
  assert.deepEqual(files, [...files].sort());
});

test('linting one file reports only that file, but resolves ids against the whole library', () => {
  const dir = tempRepo(BROKEN);
  const r = beak(path.join(dir, 'library', 'customers'), 'lint', 'wrong-id.md');
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.slice(0, -1).every((l) => l.startsWith('library/customers/wrong-id.md')), r.stdout);
  assert.ok(!r.stdout.includes('default_tone "ok-tone" not found'), 'ok-tone lives in another folder and must resolve');
  assert.equal(lines.at(-1), '1 file checked: 2 errors, 0 warnings');

  const clean = beak(dir, 'lint', 'library/tones/ok-tone.md');
  assert.equal(clean.status, 0, clean.stdout);
});

test('lint path errors are usage errors', () => {
  const r1 = beak(REPO, 'lint', 'nope.md');
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /nope\.md: no such file or folder/);
  const r2 = beak(REPO, 'lint', 'tools');
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /tools is outside the library \(library\/\)/);
  const r3 = beak(REPO, 'lint', '--json');
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /unknown option --json/);
  assert.equal(beak(REPO, 'lint', '.').status, 0, 'the repo root contains the library, so it lints everything');
});

test('config warnings are part of the lint report', () => {
  const dir = tempRepo(path.join(REPO, 'library'));
  fs.appendFileSync(path.join(dir, 'beak.config.yaml'), '\ncolour: blue\n');
  const r = beak(dir, 'lint');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^beak\.config\.yaml: warning: unknown key "colour" is ignored$/m);
});

test('a golden path that exists passes', () => {
  const dir = tempRepo(path.join(REPO, 'library'));
  const task = path.join(dir, 'library', 'tasks', 'cold-email.md');
  fs.writeFileSync(task, fs.readFileSync(task, 'utf8').replace('default_tone: friendly-en', 'default_tone: friendly-en\ngolden: out/golden.md'));
  assert.match(beak(dir, 'lint').stdout, /golden "out\/golden\.md" not found/);
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'golden.md'), 'x');
  assert.equal(beak(dir, 'lint').status, 0);
});

test('summary pluralises', () => {
  assert.equal(summary([], 1), '1 file checked: 0 errors, 0 warnings');
  assert.equal(summary([{ level: 'error' }, { level: 'warning' }], 2), '2 files checked: 1 error, 1 warning');
});
