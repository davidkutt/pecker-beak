import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAKE_DIR, RunnerError, fakeRunner, getRunner, piArgs, runPi } from '../tools/lib/runner.mjs';
import { configOf, tempRepo, write } from './helpers.mjs';

const MODEL = { name: 'deepseek-v4-flash', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };

test('piArgs: the exact isolation flags from docs/pi-notes.md, as separate argv entries', () => {
  assert.deepEqual(piArgs({ systemPromptFile: '/tmp/x/system.md', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }), [
    '-p',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-extensions',
    '--no-mcp',
    '--no-themes',
    '--no-tools',
    '--no-approve',
    '--offline',
    '--system-prompt',
    '/tmp/x/system.md',
    '--append-system-prompt',
    '',
    '--provider',
    'openrouter',
    '--model',
    'deepseek/deepseek-v4-flash',
  ]);
  assert.throws(() => piArgs({ systemPromptFile: '/x', model: 'm' }), /needs systemPromptFile, provider and model/);
});

// A stand-in for pi: reports what it was given, or misbehaves on request (FAKE_PI_MODE).
const FAKE_PI = `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const mode = process.env.FAKE_PI_MODE;
  if (mode === 'fail') { process.stderr.write('Connection error.\\n'); process.exit(1); }
  if (mode === 'empty') process.exit(0);
  if (mode === 'notfound') process.stderr.write('Warning: Model "x/y" not found for provider "openrouter". Using custom model id.\\n');
  if (mode === 'sleep') { setTimeout(() => {}, 60000); return; }
  const system = fs.readFileSync(args[args.indexOf('--system-prompt') + 1], 'utf8');
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()), stdin, system }) + '\\n\\n');
});
`;

function fakePi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-fakepi-'));
  const bin = path.join(dir, 'pi');
  fs.writeFileSync(bin, FAKE_PI, { mode: 0o755 });
  return bin;
}

test('runPi: system prompt from a file, user message on stdin, run from an empty temp dir that is removed afterwards', async () => {
  const bin = fakePi();
  const input = 'Lead: Jonas Berg.\n--not-a-flag "quotes" and \'apostrophes\'';
  const out = await runPi({ system: '# Role\n\nYou are a sales agent.', input, model: MODEL, bin, env: process.env });
  const seen = JSON.parse(out);
  assert.equal(seen.stdin, input);
  assert.equal(seen.system, '# Role\n\nYou are a sales agent.');
  assert.deepEqual(seen.cwdFiles, [], 'the cwd is empty, so pi\'s <cwd> line says nothing about the repo');
  assert.ok(seen.cwd.startsWith(fs.realpathSync(os.tmpdir())) || seen.cwd.startsWith(os.tmpdir()));
  assert.deepEqual(seen.args, piArgs({ systemPromptFile: seen.args[12], provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }));
  assert.ok(!fs.existsSync(seen.cwd), 'the temp dir is cleaned up');
  assert.ok(!out.endsWith('\n'), 'trailing whitespace is trimmed');
});

test('runPi: a non-zero exit, empty stdout, the model-not-found warning, a missing binary and a timeout are failures', async () => {
  const bin = fakePi();
  const call = (mode, extra = {}) => runPi({ system: 's', input: 'i', model: MODEL, bin, env: { ...process.env, FAKE_PI_MODE: mode }, ...extra });
  await assert.rejects(call('fail'), (e) => e instanceof RunnerError && /exited with code 1: Connection error\./.test(e.message));
  await assert.rejects(call('empty'), (e) => e instanceof RunnerError && /printed nothing/.test(e.message));
  await assert.rejects(call('notfound'), (e) => e instanceof RunnerError && /Model "x\/y" not found for provider/.test(e.message));
  await assert.rejects(call('sleep', { timeoutMs: 300 }), (e) => e instanceof RunnerError && /did not finish within/.test(e.message));
  await assert.rejects(
    runPi({ system: 's', input: 'i', model: MODEL, bin: path.join(os.tmpdir(), 'no-such-pi-binary'), env: process.env }),
    (e) => e instanceof RunnerError && /not found: install @earendil-works\/pi-coding-agent/.test(e.message),
  );
});

test('fake runner: the most specific canned file wins; FAIL simulates a runner failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-fake-'));
  write(dir, 'tester/default.md', 'default output\n');
  write(dir, 'tester/round-1.md', 'round 1 output');
  write(dir, 'tester/round-1/a.md', 'round 1, input a');
  write(dir, 'tester/round-2/b.md', 'FAIL: network down');
  const r = fakeRunner({ dir });
  const call = (key) => r.call({ role: 'tester', key, system: 's', input: 'i', model: MODEL });
  assert.equal(await call('round-1/a'), 'round 1, input a');
  assert.equal(await call('round-1/b'), 'round 1 output');
  assert.equal(await call('round-0/a'), 'default output');
  await assert.rejects(call('round-2/b'), (e) => e instanceof RunnerError && /network down/.test(e.message));
  await assert.rejects(r.call({ role: 'judge', key: 'round-0', system: 's', input: 'i', model: MODEL }), /no canned judge response for round-0/);
});

test('fake runner: an "auto" judge file becomes a full reply for the requested pairs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-fake-'));
  write(dir, 'judge/round-0.json', JSON.stringify({ auto: { score: 61, fail: ['C2', 'C1@b'], no_evidence: ['C3'], top_issues: ['x'] } }));
  const pairs = [
    { criterion: 'C1', input: 'a' },
    { criterion: 'C1', input: 'b' },
    { criterion: 'C2', input: 'a' },
    { criterion: 'C3', input: 'a' },
  ];
  const reply = JSON.parse(
    await fakeRunner({ dir }).call({ role: 'judge', key: 'round-0', context: { pairs, outputs: { a: '\nFirst line of a\nmore', b: 'B' } } }),
  );
  assert.equal(reply.score, 61);
  assert.deepEqual(reply.top_issues, ['x']);
  assert.deepEqual(reply.verdicts, [
    { criterion: 'C1', input: 'a', pass: true, evidence: 'First line of a', fix: '' },
    { criterion: 'C1', input: 'b', pass: false, evidence: '', fix: 'Fix C1 for b.' },
    { criterion: 'C2', input: 'a', pass: false, evidence: '', fix: 'Fix C2 for a.' },
    { criterion: 'C3', input: 'a', pass: true, evidence: '', fix: '' },
  ]);
});

test('getRunner: runner: / BEAK_RUNNER pick pi or fake; BEAK_FAKE_DIR moves the canned files', () => {
  const dir = tempRepo();
  assert.equal(getRunner(configOf(dir), {}).name, 'pi');
  const fake = getRunner(configOf(dir, { BEAK_RUNNER: 'fake' }), {});
  assert.equal(fake.name, 'fake');
  assert.equal(fake.dir, FAKE_DIR);
  assert.equal(getRunner(configOf(dir, { BEAK_RUNNER: 'fake' }), { BEAK_FAKE_DIR: 'canned' }).dir, path.join(dir, 'canned'));
});
