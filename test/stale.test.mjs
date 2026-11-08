// Staleness (M7): approved prompts whose blocks have a newer version are marked, and say how to refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { approveCommand, learnCommand, rejectCommand } from '../tools/lib/approve.mjs';
import { bundleCommand } from '../tools/lib/bundle.mjs';
import { checkCommand } from '../tools/lib/checks.mjs';
import { saveCommand } from '../tools/lib/intake.mjs';
import { judgeCommand } from '../tools/lib/judge.mjs';
import { loadLibrary } from '../tools/lib/library.mjs';
import { finalizeCommand } from '../tools/lib/loop.mjs';
import { statusCommand } from '../tools/lib/review.mjs';
import { scoreCommand } from '../tools/lib/score.mjs';
import { compareSources, parseSource, staleCommand, staleList } from '../tools/lib/stale.mjs';
import { testCommand } from '../tools/lib/tester.mjs';
import { readDoc } from '../tools/lib/util.mjs';
import { NOW, REPO, read, readJsonFile, run, tempRepo, write, writeBlock } from './helpers.mjs';

const ACME = 'out/sales-agent/cold-email/acme-pharma-formal-de.md';
const SAAS = 'out/sales-agent/cold-email/saas-friendly-en.md';
const INDEX = 'out/sales-agent/index.json';
const prompt = (extra = '') =>
  `## Role\n\nDu schreibst für Acme Pharma.\n\n## Context\n\nGenerika.\n\n## Instructions\n\nSchreibe die E-Mail.${extra}\n\n## Constraints\n\nUnterschrift: {{sender_name}}, {{sender_role}}.\n\n## Output format\n\nNur die E-Mail.\n\n## Examples\n\n(keine)\n`;

function setup() {
  const dir = tempRepo({ prefix: 'beak-stale-' });
  const fake = path.join(dir, 'fake');
  write(fake, 'tester/default.md', read(REPO, 'test/fixtures/fake/tester/default.md'));
  write(fake, 'judge/default.json', JSON.stringify({ auto: { score: 88 } }));
  const g = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, env: { BEAK_RUNNER: 'fake', BEAK_FAKE_DIR: fake } };
}

const cli = (ctx, fn, ...args) => run(fn, args, { cwd: ctx.dir, env: ctx.env, now: NOW });
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();

/** Bundle with `args`, score round 0, finalize (forced: the point here is the draft, not the loop) and approve. */
async function approveVariant(ctx, args, { text = prompt(), golden = false } = {}) {
  const b = await cli(ctx, bundleCommand, ...args);
  assert.equal(b.code, 0, b.err);
  const id = b.out.split('\n')[0];
  write(ctx.dir, `runs/${id}/round-0/prompt.md`, text);
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) {
    const r = await cli(ctx, fn, id, '0');
    assert.equal(r.code, 0, r.err);
  }
  const f = await cli(ctx, finalizeCommand, id, '--force');
  assert.equal(f.code, 0, f.err);
  const draft = /draft: (\S+)/.exec(f.out)?.[1] ?? /(drafts\/\S+\.md)/.exec(f.out)[1];
  const a = await cli(ctx, approveCommand, draft, ...(golden ? ['--golden'] : []));
  assert.equal(a.code, 0, a.err);
  return a;
}

const doc = (ctx, rel) => readDoc(read(ctx.dir, rel));

// ---------------------------------------------------------------------------------------------------------

test('parseSource and compareSources: current, changed, gone, ambiguous', () => {
  assert.deepEqual(parseSource('formal-de@2'), { type: null, id: 'formal-de', version: 2 });
  assert.deepEqual(parseSource('tone/formal-de@2'), { type: 'tone', id: 'formal-de', version: 2 });
  assert.equal(parseSource('formal-de'), null);
  assert.equal(parseSource('formal-de@0'), null);

  const dir = tempRepo({ prefix: 'beak-stale-' });
  writeBlock(dir, 'customer', 'saas', { fm: 'language: en\nindustry: saas\ndefault_tone: friendly-en' }); // "saas" is now two blocks
  const library = loadLibrary(path.join(dir, 'library'), { root: dir });
  assert.deepEqual(compareSources(library, ['cold-email@1', 'formal-de@0', 'pharma@2', 'gone-block@1', 'saas@1', 'tone/friendly-en@1', 'nonsense']), [
    { ref: 'cold-email', used: 1, now: 1, state: 'current' },
    { ref: 'pharma', used: 2, now: 1, state: 'changed' },
    { ref: 'gone-block', used: 1, now: null, state: 'missing' },
    { ref: 'saas', used: 1, now: null, state: 'ambiguous', candidates: ['customer/saas', 'industry/saas'] },
    { ref: 'tone/friendly-en', used: 1, now: 1, state: 'current' },
  ]);
  assert.deepEqual(staleList(library, ['pharma@2', 'gone-block@1', 'saas@1']), [
    { block: 'pharma', used: 2, now: 1 },
    { block: 'gone-block', used: 1, now: null },
  ]);
});

test('learn bumps a block: prompts made from it are marked stale, stay approved, and say how to refresh', async () => {
  const ctx = setup();
  await approveVariant(ctx, ['task=cold-email', 'customer=acme-pharma']);
  const before = doc(ctx, ACME);
  assert.equal(before.data.stale, undefined);
  assert.equal(readJsonFile(ctx.dir, INDEX).prompts[0].stale, false);

  const r = await cli(ctx, learnCommand, 'tone/formal-de', '--line', 'Keine Emojis.');
  assert.equal(r.code, 0, r.err);
  assert.equal(
    r.out,
    [
      'added to library/tones/formal-de.md (version 1 → 2):',
      '  - Keine Emojis. (learned 2026-11-07)',
      `marked stale: ${ACME} v1 (formal-de v1 → v2); refresh it with /compose task=cold-email customer=acme-pharma`,
      `updated ${INDEX}`,
      '',
    ].join('\n'),
  );
  const after = doc(ctx, ACME);
  assert.equal(after.data.status, 'approved', 'consumers keep using a stale prompt');
  assert.deepEqual(after.data.stale, [{ block: 'formal-de', used: 1, now: 2 }]);
  assert.equal(after.body, before.body, 'the prompt itself is untouched');
  assert.deepEqual({ ...after.data, stale: undefined }, { ...before.data, stale: undefined });
  assert.equal(readJsonFile(ctx.dir, INDEX).prompts[0].stale, true);

  // a second bump of the same block updates the mark
  await cli(ctx, learnCommand, 'tone/formal-de', '--line', 'Keine Ausrufezeichen im Betreff.');
  assert.deepEqual(doc(ctx, ACME).data.stale, [{ block: 'formal-de', used: 1, now: 3 }]);

  // approving a fresh version clears it: v2 is current, v1 keeps its mark in the archive
  const a = await approveVariant(ctx, ['task=cold-email', 'customer=acme-pharma'], { text: prompt(' Neu.') });
  assert.match(a.out, /approved out\/sales-agent\/cold-email\/acme-pharma-formal-de\.md \(version 2\)/);
  assert.equal(doc(ctx, ACME).data.stale, undefined);
  assert.deepEqual(doc(ctx, ACME).data.sources, ['cold-email@1', 'acme-pharma@1', 'pharma@1', 'formal-de@3']);
  assert.equal(readJsonFile(ctx.dir, INDEX).prompts[0].stale, false);
  assert.deepEqual(doc(ctx, 'out/sales-agent/cold-email/_archive/acme-pharma-formal-de.v1.md').data.stale, [{ block: 'formal-de', used: 1, now: 3 }]);
});

test('beak stale: reports, marks after a hand edit, writes nothing with --check, and is idempotent', async () => {
  const ctx = setup();
  await approveVariant(ctx, ['task=cold-email', 'customer=acme-pharma']);
  await approveVariant(ctx, ['task=cold-email', 'industry=saas']);

  let r = await cli(ctx, staleCommand);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [`${ACME} v1: current`, `${SAAS} v1: current`, '2 approved prompts: 0 stale, 2 current', 'marks are up to date', ''].join('\n'));

  // a hand edit that bumps the customer, then a deleted industry
  const customer = path.join(ctx.dir, 'library/customers/acme-pharma.md');
  fs.writeFileSync(customer, fs.readFileSync(customer, 'utf8').replace('version: 1', 'version: 2'));
  fs.rmSync(path.join(ctx.dir, 'library/industries/saas.md'));

  r = await cli(ctx, staleCommand, '--check');
  assert.equal(
    r.out,
    [
      `${ACME} v1: stale (acme-pharma v1 → v2)`,
      '  refresh: /compose task=cold-email customer=acme-pharma',
      `${SAAS} v1: stale (saas v1 → gone)`,
      '  refresh: /compose task=cold-email industry=saas',
      '2 approved prompts: 2 stale, 0 current',
      'check: 2 marks out of date, nothing written (run beak stale to update them)',
      '',
    ].join('\n'),
  );
  assert.equal(doc(ctx, ACME).data.stale, undefined, '--check writes nothing');

  const s = await cli(ctx, statusCommand);
  assert.match(s.out, /^ {4}cold-email\/acme-pharma-formal-de\.md v1 {2}STALE \(acme-pharma v1 → v2\); refresh: \/compose task=cold-email customer=acme-pharma$/m);
  assert.match(s.out, /^ {2}\(2 stale marks out of date: run beak stale to update the files and index\.json\)$/m);

  r = await cli(ctx, staleCommand);
  assert.match(r.out, /^updated out\/sales-agent\/cold-email\/acme-pharma-formal-de\.md$/m);
  assert.match(r.out, /^updated out\/sales-agent\/cold-email\/saas-friendly-en\.md$/m);
  assert.match(r.out, /^updated out\/sales-agent\/index\.json$/m);
  assert.deepEqual(doc(ctx, SAAS).data.stale, [{ block: 'saas', used: 1, now: null }]);
  assert.deepEqual(readJsonFile(ctx.dir, INDEX).prompts.map((p) => p.stale), [true, true]);
  assert.doesNotMatch((await cli(ctx, statusCommand)).out, /marks out of date/);

  r = await cli(ctx, staleCommand);
  assert.match(r.out, /marks are up to date\n$/);
});

test('approve --golden: the golden prompt is current with the bumped task; other variants of the task go stale', async () => {
  const ctx = setup();
  await approveVariant(ctx, ['task=cold-email', 'industry=saas']);
  const a = await approveVariant(ctx, ['task=cold-email', 'customer=acme-pharma'], { golden: true });
  assert.match(a.out, /^golden: library\/tasks\/cold-email\.md now points at it \(version 1 → 2\)$/m);
  assert.match(a.out, new RegExp(`^marked stale: ${SAAS} v1 \\(cold-email v1 → v2\\); refresh it with /compose task=cold-email industry=saas$`, 'm'));
  assert.deepEqual(doc(ctx, ACME).data.sources, ['cold-email@2', 'acme-pharma@1', 'pharma@1', 'formal-de@1']);
  assert.equal(doc(ctx, ACME).data.stale, undefined, 'not stale because of its own golden pointer');
  assert.deepEqual(readJsonFile(ctx.dir, INDEX).prompts.map((p) => [p.variant, p.stale]), [['acme-pharma-formal-de', false], ['saas-friendly-en', true]]);
  const committed = git(ctx.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  assert.ok(committed.includes(SAAS), 'the new mark is part of the approve commit');
  assert.equal(git(ctx.dir, 'status', '--porcelain', '--', 'out'), '');
});

test('beak save (an intake update) and beak reject with a rule refresh the marks too', async () => {
  const ctx = setup();
  await approveVariant(ctx, ['task=cold-email', 'customer=acme-pharma']);

  const pharma = read(ctx.dir, 'library/industries/pharma.md');
  write(ctx.dir, 'library/_intake/pharma.md', pharma.replace('- Mentioning patients or patient cases.', '- Mentioning patients or patient cases.\n- Prices.'));
  let r = await cli(ctx, saveCommand, 'library/_intake/pharma.md');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^marked stale: ${ACME} v1 \\(pharma v1 → v2\\); refresh it with /compose task=cold-email customer=acme-pharma$`, 'm'));

  // a draft for another variant, rejected with a rule for the customer
  const b = await cli(ctx, bundleCommand, 'task=cold-email', 'customer=acme-pharma', 'tone=friendly-en');
  const id = b.out.split('\n')[0];
  write(ctx.dir, `runs/${id}/round-0/prompt.md`, prompt());
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) await cli(ctx, fn, id, '0');
  await cli(ctx, finalizeCommand, id, '--force');
  r = await cli(ctx, rejectCommand, 'drafts/cold-email/acme-pharma-friendly-en.md', '--reason', 'zu locker', '--block', 'customer/acme-pharma', '--line', 'Immer per Sie.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^marked stale: ${ACME} v1 \\(acme-pharma v1 → v2, pharma v1 → v2\\); refresh it with /compose task=cold-email customer=acme-pharma$`, 'm'));
  assert.match(r.out, /^next: compose the variant again to rerun the loop with the new rule \(\/compose task=cold-email customer=acme-pharma tone=friendly-en\)$/m);
});
