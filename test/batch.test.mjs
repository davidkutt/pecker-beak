// Batch mode (M9): the queue scripts, the RALPH.md they generate for the Ralph extension, sample review and
// bulk approval. The Ralph extension itself is not loaded here (tests never call pi); docs/pi-notes.md records
// the smoke test of the generated RALPH.md against the real extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { approveCommand, rejectCommand } from '../tools/lib/approve.mjs';
import { OPEN_QUESTIONS, TEMPLATE, batchCommand, pacing, parseCreateArgs, readList, renderRalph } from '../tools/lib/batch.mjs';
import { bundleCommand } from '../tools/lib/bundle.mjs';
import { checkCommand } from '../tools/lib/checks.mjs';
import { judgeCommand } from '../tools/lib/judge.mjs';
import { finalizeCommand } from '../tools/lib/loop.mjs';
import { statusCommand } from '../tools/lib/review.mjs';
import { scoreCommand } from '../tools/lib/score.mjs';
import { testCommand } from '../tools/lib/tester.mjs';
import { readDoc } from '../tools/lib/util.mjs';
import { NOW, REPO, listFiles, read, readJsonFile, run, tempRepo, write, writeBlock } from './helpers.mjs';

const prompt = `## Role\n\nDu schreibst E-Mails.\n\n## Context\n\nKontext.\n\n## Instructions\n\nSchreibe die E-Mail.\n\n## Constraints\n\nUnterschrift: {{sender_name}}, {{sender_role}}.\n\n## Output format\n\nNur die E-Mail.\n\n## Examples\n\n(keine)\n`;

// ---------------------------------------------------------------------------------------------------------
// setup: a git repo whose task cold-email has an approved golden prompt, plus two more industries

function fakeDir(dir, name, { score = 90, tester } = {}) {
  const fake = path.join(dir, 'fake', name);
  write(fake, 'tester/default.md', tester ?? read(REPO, 'test/fixtures/fake/tester/default.md'));
  write(fake, 'judge/default.json', JSON.stringify({ auto: { score } }));
  return { BEAK_RUNNER: 'fake', BEAK_FAKE_DIR: fake };
}

async function setup({ maxRounds = 1 } = {}) {
  const dir = tempRepo({ prefix: 'beak-batch-', editConfig: (c) => c.replace(/max_rounds: \d+/, `max_rounds: ${maxRounds}`) });
  fs.cpSync(path.join(REPO, 'loops'), path.join(dir, 'loops'), { recursive: true });
  writeBlock(dir, 'industry', 'logistics');
  writeBlock(dir, 'industry', 'retail');
  const g = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const ctx = { dir, env: fakeDir(dir, 'pass') };
  const b = await cli(ctx, ctx.env, bundleCommand, 'task=cold-email', 'customer=acme-pharma');
  const id = b.out.split('\n')[0];
  await playRound(ctx, ctx.env, id, 0);
  assert.equal((await cli(ctx, ctx.env, finalizeCommand, id)).code, 0);
  const a = await cli(ctx, ctx.env, approveCommand, 'drafts/cold-email/acme-pharma-formal-de.md', '--golden');
  assert.equal(a.code, 0, a.err);
  return ctx;
}

const cli = (ctx, env, fn, ...args) => run(fn, args, { cwd: ctx.dir, env, now: NOW });
const batch = (ctx, ...args) => cli(ctx, ctx.env, batchCommand, ...args);
const batchJson = (ctx, id) => readJsonFile(ctx.dir, `runs/batches/${id}/batch.json`);

async function playRound(ctx, env, runId, n) {
  write(ctx.dir, `runs/${runId}/round-${n}/prompt.md`, prompt);
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) {
    const r = await cli(ctx, env, fn, runId, String(n));
    assert.equal(r.code, 0, `${fn.name} ${runId} ${n}: ${r.err}`);
  }
}

/** What Ralph's agent does for one item: batch next, round 0 (one round is all the loop allows here), batch done. */
async function playItem(ctx, id, env = ctx.env) {
  const next = await batch(ctx, 'next', id);
  assert.equal(next.code, 0, next.err);
  const runId = /^run: (\S+)$/m.exec(next.out)[1];
  await playRound(ctx, env, runId, 0);
  const done = await batch(ctx, 'done', id);
  assert.equal(done.code, 0, done.err);
  return { runId, next: next.out, done: done.out };
}

// ---------------------------------------------------------------------------------------------------------

test('pacing, readList and parseCreateArgs', () => {
  assert.deepEqual(pacing(1), { itemsPerIteration: 1, maxIterations: 11 });
  assert.deepEqual(pacing(40), { itemsPerIteration: 1, maxIterations: 50 });
  assert.deepEqual(pacing(41), { itemsPerIteration: 2, maxIterations: 31 });
  assert.deepEqual(pacing(120), { itemsPerIteration: 3, maxIterations: 50 });

  const dir = tempRepo({ prefix: 'beak-batch-' });
  write(dir, 'list.txt', 'pharma\n# a comment\n\nsaas  # trailing comment\npharma\n');
  assert.deepEqual(readList('@list.txt', dir), ['pharma', 'saas']);
  assert.deepEqual(readList('pharma, saas', dir), ['pharma', 'saas']);
  assert.throws(() => readList('@missing.txt', dir), /list file missing\.txt not found/);
  assert.throws(() => readList('Pharma Co', dir), /not block ids: "Pharma Co"/);

  let p = parseCreateArgs(['task=cold-email', 'industry=@list.txt', 'tone=formal-de', 'context=a,b', 'sample=0.25']);
  assert.deepEqual(p, { fixed: { task: 'cold-email', tone: 'formal-de', context: 'a,b' }, listKey: 'industry', listSource: '@list.txt', sample: 0.25, problems: [] });
  assert.match(parseCreateArgs(['task=cold-email', 'tone=formal-de']).problems[0], /^name the list/);
  assert.match(parseCreateArgs(['task=cold-email', 'industry=a,b', 'tone=c,d']).problems[0], /^only one key can be a list/);
  assert.match(parseCreateArgs(['task=a,b']).problems[0], /^task= cannot be a list/);
  assert.match(parseCreateArgs(['task=x', 'industry=a,b', 'sample=2']).problems[0], /^sample must be a share between 0 and 1/);
});

test('the template becomes a valid RALPH.md: batch id filled in, guardrails keep the library and out/ out of reach', () => {
  const text = renderRalph(read(REPO, TEMPLATE), { id: '20261107-0930-cold-email-by-industry', itemsPerIteration: 2, maxIterations: 31 });
  assert.ok(!text.includes('{{ beak.'), 'every {{ beak.batch }} is replaced');
  const fm = YAML.parse(text.split('\n---\n')[0].slice(4));
  assert.equal(fm.max_iterations, 31);
  assert.equal(fm.items_per_iteration, 2);
  assert.ok(fm.max_iterations >= 1 && fm.max_iterations <= 50, "within Ralph's 1–50");
  assert.equal(fm.timeout, 3600);
  assert.equal(fm.completion_promise, 'BATCH_DONE');
  assert.equal(fm.completion_gate, 'required');
  assert.equal(fm.stop_on_error, false);
  assert.deepEqual(fm.commands.map((c) => [c.name, c.run, Boolean(c.acceptance)]), [
    ['queue', 'node tools/beak.mjs batch status 20261107-0930-cold-email-by-industry', false],
    ['gate', 'node tools/beak.mjs batch gate 20261107-0930-cold-email-by-industry', true],
  ]);
  for (const c of fm.commands) assert.ok(c.timeout <= fm.timeout);
  assert.match(text, /<promise>BATCH_DONE<\/promise>/);

  // Ralph tests each bash command against the allowlist as ^(?:pattern)$ (src/ralph.ts findAllowedCommandPattern).
  const allowed = (cmd) => fm.guardrails.shell_policy.allow.some((p) => new RegExp(`^(?:${p})$`).test(cmd));
  const id = '20261107-0930-cold-email-by-industry';
  const runId = '20261107-0931-cold-email-saas-friendly-en';
  for (const cmd of [
    ...fm.commands.map((c) => c.run),
    `node tools/beak.mjs batch next ${id}`,
    `node tools/beak.mjs batch done ${id}`,
    `node tools/beak.mjs test ${runId} 0`,
    `node tools/beak.mjs check ${runId} 12`,
    `node tools/beak.mjs judge ${runId} 3`,
    `node tools/beak.mjs score ${runId} 1`,
    `node tools/beak.mjs loop-status ${runId}`,
    `node tools/beak.mjs finalize ${runId}`,
  ]) {
    assert.ok(allowed(cmd), `allowed: ${cmd}`);
  }
  for (const cmd of [
    `node tools/beak.mjs batch approve ${id}`,
    `node tools/beak.mjs approve drafts/batch-${id}/saas-friendly-en.md`,
    'node tools/beak.mjs learn tone/formal-de --line x',
    'node tools/beak.mjs save library/_intake/x.md',
    'node tools/beak.mjs stale',
    `node tools/beak.mjs batch next ${id}; rm -rf library`,
    `node tools/beak.mjs batch next ${id} && git push`,
    `node tools/beak.mjs test ${runId} 0 | tee out/x`,
    `node tools/beak.mjs test $(rm -rf library) 0`,
    `node tools/beak.mjs finalize ${runId} --force`,
    'git commit -am x',
    'rm -rf library',
    'cat inputs.json',
  ]) {
    assert.ok(!allowed(cmd), `blocked: ${cmd}`);
  }
  for (const p of ['library/**', 'out/**', 'drafts/**', 'beak.config.yaml', 'runs/batches/*/RALPH.md', 'runs/batches/*/batch.json', 'runs/*/round-*/holdout/**']) {
    assert.ok(fm.guardrails.protected_files.includes(p), `protected: ${p}`);
  }
  assert.ok(!fm.guardrails.protected_files.some((p) => p === 'runs/**' || p === 'runs/batches/**'), 'round prompts, RALPH_PROGRESS.md and OPEN_QUESTIONS.md stay writable');
});

test('OPEN_QUESTIONS.md starts with empty P0 and P1 sections, so Ralph can finish', () => {
  assert.match(OPEN_QUESTIONS, /^## P0\n\n## P1\n\n## Notes\n$/m);
  assert.ok(!/^\s*[-*+] /m.test(OPEN_QUESTIONS), 'no list item that Ralph would count as an open question');
});

test('a batch end to end: create, next/done per item, gate, review the sample, bulk approve in one commit', async () => {
  const ctx = await setup();
  write(ctx.dir, 'lists/industries.txt', 'pharma\nsaas\nlogistics\nretail\n');
  let r = await batch(ctx, 'create', 'task=cold-email', 'industry=@lists/industries.txt', 'sample=0.34');
  assert.equal(r.code, 0, r.err);
  const id = '20261107-0930-cold-email-by-industry';
  assert.equal(
    r.out,
    [
      id,
      `created runs/batches/${id}/: batch.json (4 items), RALPH.md, OPEN_QUESTIONS.md`,
      'golden: out/sales-agent/cold-email/acme-pharma-formal-de.md (v1)',
      'pacing: 1 item per Ralph iteration, at most 14 iterations',
      `next: in pi, run /ralph --path runs/batches/${id}`,
      '',
    ].join('\n'),
  );
  assert.deepEqual(listFiles(path.join(ctx.dir, 'runs/batches', id)), ['OPEN_QUESTIONS.md', 'RALPH.md', 'batch.json']);
  assert.deepEqual(batchJson(ctx, id).items.map((i) => [i.value, i.variant, i.status]), [
    ['pharma', 'pharma-friendly-en', 'pending'],
    ['saas', 'saas-friendly-en', 'pending'],
    ['logistics', 'logistics-friendly-en', 'pending'],
    ['retail', 'retail-friendly-en', 'pending'],
  ]);

  // item 1: next starts it, next again names the same run, done refuses before STOP
  r = await batch(ctx, 'next', id);
  assert.match(r.out, /^item 1\/4: industry=pharma → variant pharma-friendly-en\nrun: 20261107-0930-cold-email-pharma-friendly-en\nnext: read runs\/20261107-0930-cold-email-pharma-friendly-en\/bundle\.md/);
  assert.equal(readJsonFile(ctx.dir, 'runs/20261107-0930-cold-email-pharma-friendly-en/meta.json').batch, id);
  r = await batch(ctx, 'next', id);
  assert.match(r.out, /^item 1\/4: industry=pharma → variant pharma-friendly-en \(still running\)\nrun: 20261107-0930-cold-email-pharma-friendly-en\nnext: write runs\//);
  r = await batch(ctx, 'done', id);
  assert.equal(r.code, 1);
  assert.match(r.err, /the loop of 20261107-0930-cold-email-pharma-friendly-en has not stopped/);
  await playRound(ctx, ctx.env, '20261107-0930-cold-email-pharma-friendly-en', 0);
  r = await batch(ctx, 'done', id);
  assert.equal(
    r.out,
    `item 1/4 done (industry=pharma): pharma-friendly-en score 90 PASS (round 0, stop pass) → drafts/batch-${id}/pharma-friendly-en.md\n3 items left\nnext: node tools/beak.mjs batch next ${id}\n`,
  );
  assert.equal((await batch(ctx, 'gate', id)).code, 1);

  // items 2–4: saas passes, logistics fails (score 60, one round allowed), retail passes
  await playItem(ctx, id);
  const fail = await playItem(ctx, id, fakeDir(ctx.dir, 'low', { score: 60 }));
  assert.match(fail.done, /^item 3\/4 done \(industry=logistics\): logistics-friendly-en score 60 FAIL \(round 0, stop max_rounds\)/);
  await playItem(ctx, id);
  r = await batch(ctx, 'next', id);
  assert.equal(r.out, `queue empty: complete: 4 of 4 items finished (3 PASS, 1 FAIL, 0 without a draft)\nnext: node tools/beak.mjs batch gate ${id}\n`);
  r = await batch(ctx, 'gate', id);
  assert.equal(r.code, 0);

  // the drafts are in drafts/batch-<id>/, visible to status
  assert.deepEqual(listFiles(path.join(ctx.dir, 'drafts', `batch-${id}`)), ['logistics-friendly-en.md', 'pharma-friendly-en.md', 'retail-friendly-en.md', 'saas-friendly-en.md']);
  const s = await cli(ctx, ctx.env, statusCommand);
  assert.match(s.out, /^Drafts waiting for review \(4\):$/m);
  assert.match(s.out, new RegExp(`^  ${id}  4 items: 4 done \\(3 PASS, 1 FAIL\\), 0 failed, 0 open; review: beak batch review ${id}$`, 'm'));

  // review: a stable sample of ceil(0.34 × 3) = 2 PASS drafts; the FAIL draft is always reviewed by hand
  r = await batch(ctx, 'review', id);
  const sample = batchJson(ctx, id).sample;
  assert.equal(sample.length, 2);
  assert.ok(!sample.includes('logistics-friendly-en'));
  assert.equal((await batch(ctx, 'review', id)).out, r.out, 'the sample does not change');
  assert.match(r.out, /^2\. Always review individually \(FAIL, never bulk-approved\):\n {2}drafts\/batch-[^/]+\/logistics-friendly-en\.md {2}score 60 {2}waiting$/m);
  assert.match(r.out, /approves the other 1 PASS draft in one commit/);

  // bulk approval waits for the sample
  r = await batch(ctx, 'approve', id);
  assert.equal(r.code, 1);
  assert.match(r.err, /^beak batch: review and approve the sample first: /);
  for (const variant of sample) assert.equal((await cli(ctx, ctx.env, approveCommand, `drafts/batch-${id}/${variant}.md`)).code, 0);

  r = await batch(ctx, 'approve', id, '--check');
  assert.match(r.out, /^would approve drafts\/batch-[^\n]+\.md\nleft for individual review \(FAIL\): drafts\/batch-[^\n]+\/logistics-friendly-en\.md \(waiting\)\ncheck: ok, nothing written\n$/);
  const before = spawnSync('git', ['-C', ctx.dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  r = await batch(ctx, 'approve', id);
  assert.equal(r.code, 0, r.err);
  const rest = ['pharma-friendly-en', 'saas-friendly-en', 'retail-friendly-en'].find((v) => !sample.includes(v));
  assert.match(r.out, new RegExp(`^approved out/sales-agent/cold-email/${rest}\\.md \\(version 1\\)$`, 'm'));
  assert.match(r.out, new RegExp(`^committed: beak: approve batch ${id} \\(1 prompt\\)$`, 'm'));
  const git = (...args) => spawnSync('git', ['-C', ctx.dir, ...args], { encoding: 'utf8' }).stdout.trim();
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), Number(before) + 1, 'one commit for the bulk approval');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [`out/sales-agent/cold-email/${rest}.md`, 'out/sales-agent/index.json']);
  assert.ok(fs.existsSync(path.join(ctx.dir, `drafts/batch-${id}/logistics-friendly-en.md`)), 'the FAIL draft still waits');
  assert.equal(readDoc(read(ctx.dir, `out/sales-agent/cold-email/${rest}.md`)).data.status, 'approved');
  assert.deepEqual(readJsonFile(ctx.dir, 'out/sales-agent/index.json').prompts.map((p) => p.variant).sort(), ['acme-pharma-formal-de', ...sample, rest].sort());
});

test('a rejected sample turns bulk approval off', async () => {
  const ctx = await setup();
  await batch(ctx, 'create', 'task=cold-email', 'industry=pharma,saas', 'sample=0.5');
  const id = '20261107-0930-cold-email-by-industry';
  await playItem(ctx, id);
  await playItem(ctx, id);
  await batch(ctx, 'review', id);
  const [sampled] = batchJson(ctx, id).sample;
  const rej = await cli(ctx, ctx.env, rejectCommand, `drafts/batch-${id}/${sampled}.md`, '--reason', 'zu förmlich');
  assert.equal(rej.code, 0, rej.err);
  const r = await batch(ctx, 'approve', id);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`a sampled draft was rejected \\(${sampled}\\): review every draft of this batch individually`));
});

test('an item whose runner keeps failing ends without a draft; the batch still completes', async () => {
  const ctx = await setup();
  await batch(ctx, 'create', 'task=cold-email', 'industry=pharma,saas');
  const id = '20261107-0930-cold-email-by-industry';
  const broken = fakeDir(ctx.dir, 'broken', { tester: 'FAIL: no connection' });
  const next = await batch(ctx, 'next', id);
  const runId = /^run: (\S+)$/m.exec(next.out)[1];
  write(ctx.dir, `runs/${runId}/round-0/prompt.md`, prompt);
  for (let k = 0; k < 2; k++) assert.equal((await cli(ctx, broken, testCommand, runId, '0')).code, 1);
  const done = await batch(ctx, 'done', id);
  assert.match(done.out, /^item 1\/2 failed \(industry=pharma, stop error\): no round has a scorecard yet/);
  await playItem(ctx, id);
  assert.equal((await batch(ctx, 'gate', id)).out, 'complete: 2 of 2 items finished (1 PASS, 0 FAIL, 1 without a draft)\n');
  const review = await batch(ctx, 'review', id);
  assert.match(review.out, /^ {3}no draft: industry=pharma \(no round has a scorecard yet/m);
});

test('create refuses without an approved golden prompt, and when an item does not bundle', async () => {
  const dir = tempRepo({ prefix: 'beak-batch-' });
  fs.cpSync(path.join(REPO, 'loops'), path.join(dir, 'loops'), { recursive: true });
  const ctx = { dir, env: {} };
  let r = await batch(ctx, 'create', 'task=cold-email', 'industry=pharma,saas');
  assert.equal(r.code, 1);
  assert.match(r.err, /task cold-email has no golden prompt: batch mode starts from an approved one/);
  assert.ok(!fs.existsSync(path.join(dir, 'runs')), 'nothing written');

  const ok = await setup();
  r = await batch(ok, 'create', 'task=cold-email', 'industry=pharma,sas,aerospace');
  assert.equal(r.code, 1);
  assert.match(r.err, /^ {2}industry=sas: industry "sas" not found: there is no library\/industries\/sas\.md$/m);
  assert.match(r.err, /^ {2}industry=aerospace: industry "aerospace" not found/m);
  assert.ok(!fs.existsSync(path.join(ok.dir, 'runs/batches')), 'nothing written');

  r = await batch(ok, 'create', 'task=cold-email', 'customer=acme-pharma,acme-pharma');
  assert.equal(r.code, 0, 'duplicates in the list are dropped');
  assert.match(r.out, /batch\.json \(1 item\)/);
});

test('batch usage errors', async () => {
  const ctx = await setup();
  for (const [args, message] of [
    [[], /name a subcommand/],
    [['frobnicate'], /unknown subcommand "frobnicate"/],
    [['next'], /give the batch id/],
    [['next', 'nope'], /give the batch id/],
    [['approve', '20261107-0930-x', '--force'], /unknown option --force/],
    [['create', 'task=cold-email'], /name the list/],
  ]) {
    const r = await batch(ctx, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, message);
  }
  const r = await batch(ctx, 'status', '20261107-0930-cold-email-by-nothing');
  assert.equal(r.code, 1);
  assert.match(r.err, /no batch "20261107-0930-cold-email-by-nothing"/);
});

test('beak score --gate: exit 0 only for a run that stopped with a pass', async () => {
  const ctx = await setup({ maxRounds: 2 });
  const b = await cli(ctx, ctx.env, bundleCommand, 'task=cold-email', 'industry=saas');
  const id = b.out.split('\n')[0];
  let r = await cli(ctx, ctx.env, scoreCommand, '--gate', id);
  assert.equal(r.code, 1);
  assert.equal(r.out, `FAIL ${id}: still running, no passing round (scores: none)\n`);
  const low = fakeDir(ctx.dir, 'low', { score: 60 });
  await playRound(ctx, low, id, 0);
  await playRound(ctx, low, id, 1);
  r = await cli(ctx, ctx.env, scoreCommand, '--gate', id);
  assert.equal(r.out, `FAIL ${id}: stopped with max_rounds, no passing round (scores: 60, 60)\n`);

  const b2 = await cli(ctx, ctx.env, bundleCommand, 'task=cold-email', 'industry=pharma');
  const id2 = b2.out.split('\n')[0];
  await playRound(ctx, ctx.env, id2, 0);
  r = await cli(ctx, ctx.env, scoreCommand, '--gate', id2);
  assert.equal(r.code, 0);
  assert.equal(r.out, `PASS ${id2}: round 0 passes (scores: 90)\n`);
});
