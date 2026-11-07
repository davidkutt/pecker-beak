// Review, approve, reject, learn and status (plan §9, §10, §13 M5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { approveCommand, learnCommand, rejectCommand } from '../tools/lib/approve.mjs';
import { bundleCommand } from '../tools/lib/bundle.mjs';
import { checkCommand } from '../tools/lib/checks.mjs';
import { unifiedDiff } from '../tools/lib/diff.mjs';
import { judgeCommand } from '../tools/lib/judge.mjs';
import { insertDoneWhen, normalizeCriterion } from '../tools/lib/library-edit.mjs';
import { lint } from '../tools/lib/lint.mjs';
import { finalizeCommand, refineCommand } from '../tools/lib/loop.mjs';
import { reviewCommand, statusCommand } from '../tools/lib/review.mjs';
import { scoreCommand } from '../tools/lib/score.mjs';
import { testCommand } from '../tools/lib/tester.mjs';
import { readDoc } from '../tools/lib/util.mjs';
import { NOW, REPO, configOf, listFiles, read, readJsonFile, run, tempRepo, write } from './helpers.mjs';

const DRAFT = 'drafts/cold-email/acme-pharma-formal-de.md';
const OUT = 'out/sales-agent/cold-email/acme-pharma-formal-de.md';
const prompt = (extra = '') => `## Role\n\nDu schreibst für Acme Pharma.\n\n## Context\n\nGenerika.\n\n## Instructions\n\nSchreibe die E-Mail.${extra}\n\n## Constraints\n\nUnterschrift: {{sender_name}}, {{sender_role}}.\n\n## Output format\n\nNur die E-Mail.\n\n## Examples\n\n(keine)\n`;

function setup({ git = false, editConfig } = {}) {
  const dir = tempRepo({ prefix: 'beak-approve-', editConfig });
  const fake = path.join(dir, 'fake');
  write(fake, 'tester/default.md', read(REPO, 'test/fixtures/fake/tester/default.md'));
  write(fake, 'judge/default.json', JSON.stringify({ auto: { score: 88 } }));
  if (git) {
    const g = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.name', 'Test');
    g('config', 'user.email', 'test@example.com');
    g('add', '-A');
    g('commit', '-qm', 'init');
  }
  return { dir, env: { BEAK_RUNNER: 'fake', BEAK_FAKE_DIR: fake }, out: '' };
}

async function cli(ctx, fn, ...args) {
  const r = await run(fn, args, { cwd: ctx.dir, env: ctx.env, now: NOW });
  ctx.out += r.out + r.err;
  return r;
}

/** Bundle, run round 0 and finalize: a draft at drafts/cold-email/acme-pharma-formal-de.md. Returns the run id. */
async function makeDraft(ctx, text = prompt()) {
  const b = await cli(ctx, bundleCommand, 'task=cold-email', 'customer=acme-pharma');
  const id = b.out.split('\n')[0];
  write(ctx.dir, `runs/${id}/round-0/prompt.md`, text);
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) assert.equal((await cli(ctx, fn, id, '0')).code, 0);
  assert.equal((await cli(ctx, finalizeCommand, id)).code, 0);
  return id;
}

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();

// ---------------------------------------------------------------------------------------------------------

test('approve twice: v2 is current, v1 is archived, index.json lists v2, each approve is one commit of its own files', async () => {
  const ctx = setup({ git: true });
  write(ctx.dir, 'notes.txt', 'unrelated work in progress\n');
  const run1 = await makeDraft(ctx);
  let r = await cli(ctx, approveCommand, DRAFT);
  assert.equal(r.code, 0, r.err);
  assert.equal(
    r.out,
    [
      `approved ${OUT} (version 1)`,
      'updated out/sales-agent/index.json (1 prompt)',
      'committed: beak: approve sales-agent/cold-email/acme-pharma-formal-de v1',
      'next: ask the user "Did you change anything that should become a rule?"; turn each answer into a Done-when line with beak learn',
      '',
    ].join('\n'),
  );
  const v1 = readDoc(read(ctx.dir, OUT));
  assert.deepEqual(v1.data, {
    status: 'approved', task: 'cold-email', variant: 'acme-pharma-formal-de', consumer: 'sales-agent', version: 1,
    approved_at: NOW.toISOString(), language: 'de', runtime_vars: ['sender_name', 'sender_role'],
    sources: ['cold-email@1', 'acme-pharma@1', 'pharma@1', 'formal-de@1'], score: 88, run: run1, round: 0, edited_after_loop: false,
  });
  assert.equal(v1.body, prompt().trim());
  assert.ok(!fs.existsSync(path.join(ctx.dir, DRAFT)), 'the draft is gone');
  assert.equal(git(ctx.dir, 'log', '-1', '--format=%s'), 'beak: approve sales-agent/cold-email/acme-pharma-formal-de v1');
  assert.deepEqual(git(ctx.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [OUT, 'out/sales-agent/index.json']);
  assert.match(git(ctx.dir, 'status', '--porcelain'), /\?\? notes\.txt/, 'unrelated files are not committed');

  const run2 = await makeDraft(ctx, prompt(' Höchstens 120 Wörter.'));
  r = await cli(ctx, approveCommand, 'cold-email/acme-pharma-formal-de');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^approved out\/sales-agent\/cold-email\/acme-pharma-formal-de\.md \(version 2\)$/m);
  assert.match(r.out, /^archived version 1: out\/sales-agent\/cold-email\/_archive\/acme-pharma-formal-de\.v1\.md$/m);
  assert.match(r.out, /^committed: beak: approve sales-agent\/cold-email\/acme-pharma-formal-de v2$/m);

  const current = readDoc(read(ctx.dir, OUT));
  assert.equal(current.data.version, 2);
  assert.equal(current.data.run, run2);
  assert.match(current.body, /Höchstens 120 Wörter/);
  const archived = readDoc(read(ctx.dir, 'out/sales-agent/cold-email/_archive/acme-pharma-formal-de.v1.md'));
  assert.equal(archived.data.status, 'archived', 'consumers read only status: approved');
  assert.equal(archived.data.version, 1);
  assert.equal(archived.body, v1.body);
  assert.deepEqual(readJsonFile(ctx.dir, 'out/sales-agent/index.json'), {
    consumer: 'sales-agent',
    prompts: [{ task: 'cold-email', variant: 'acme-pharma-formal-de', version: 2, language: 'de', runtime_vars: ['sender_name', 'sender_role'], approved_at: NOW.toISOString(), path: 'cold-email/acme-pharma-formal-de.md' }],
  });
  assert.deepEqual(git(ctx.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    'out/sales-agent/cold-email/_archive/acme-pharma-formal-de.v1.md', OUT, 'out/sales-agent/index.json',
  ]);
  assert.equal(git(ctx.dir, 'status', '--porcelain', '--', 'out'), '', 'everything in out/ is committed');
});

test('approve --golden sets the task\'s golden path with a version bump; the next review diffs against it', async () => {
  const ctx = setup({ git: true });
  await makeDraft(ctx);
  let r = await cli(ctx, approveCommand, DRAFT, '--golden');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^golden: library\/tasks\/cold-email\.md now points at it \(version 1 → 2\)$/m);
  const task = read(ctx.dir, 'library/tasks/cold-email.md');
  assert.match(task, /^version: 2$/m);
  assert.match(task, /^updated: 2026-11-07$/m);
  assert.match(task, /^golden: out\/sales-agent\/cold-email\/acme-pharma-formal-de\.md\nchecks:$/m, 'golden goes before checks, as in the template');
  assert.deepEqual(lint({ config: configOf(ctx.dir) }).findings.filter((f) => f.level === 'error'), []);
  assert.ok(git(ctx.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes('library/tasks/cold-email.md'));

  const id = await makeDraft(ctx, prompt(' Neu.'));
  assert.match(read(ctx.dir, `runs/${id}/bundle.md`), /## Golden prompt \(structural reference\)/);
  r = await cli(ctx, reviewCommand, DRAFT);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /```diff\n--- out\/sales-agent\/cold-email\/acme-pharma-formal-de\.md\n\+\+\+ drafts\/cold-email\/acme-pharma-formal-de\.md\n@@ -8,7 \+8,7 @@\n/);
  assert.match(r.out, /^-Schreibe die E-Mail\.$/m);
  assert.match(r.out, /^\+Schreibe die E-Mail\. Neu\.$/m);
  r = await cli(ctx, approveCommand, DRAFT, '--golden');
  assert.match(r.out, /^golden: task cold-email already points at it$/m);
});

test('approve: an edited draft is re-checked; a broken one is refused, a fixed one is approved with edited_after_loop', async () => {
  const ctx = setup();
  await makeDraft(ctx);
  const file = path.join(ctx.dir, DRAFT);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('Generika.', 'Generika für [Kundenname].'));
  let r = await cli(ctx, reviewCommand, DRAFT);
  assert.match(r.out, /^- edited after the loop: yes; prompt hard checks now: 1 FAIL$/m);
  assert.match(r.out, /FAIL placeholders: \[Kundenname\] on line \d+/);
  r = await cli(ctx, approveCommand, DRAFT);
  assert.equal(r.code, 1);
  assert.match(r.err, /the draft fails 1 hard check on its prompt; fix drafts\/cold-email\/acme-pharma-formal-de\.md and approve again:\n  placeholders: \[Kundenname\]/);
  assert.ok(!fs.existsSync(path.join(ctx.dir, OUT)), 'nothing was written');

  fs.writeFileSync(file, original.replace('Generika.', 'Generika aus Deutschland.'));
  r = await cli(ctx, approveCommand, DRAFT);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /edited_after_loop: true/);
  assert.match(r.out, /^warning: not committed \(.* is not a git repository\); commit the files above yourself$/m);
  const out = readDoc(read(ctx.dir, OUT));
  assert.equal(out.data.edited_after_loop, true);
  assert.match(out.body, /Generika aus Deutschland\./);
});

test('approve: usage and refusals', async () => {
  const ctx = setup();
  let r = await cli(ctx, approveCommand, 'drafts/nope/x.md');
  assert.equal(r.code, 1);
  assert.match(r.err, /no draft "drafts\/nope\/x\.md"/);
  r = await cli(ctx, approveCommand);
  assert.equal(r.code, 2);
  r = await cli(ctx, approveCommand, DRAFT, '--gold');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --gold/);
  await makeDraft(ctx);
  fs.writeFileSync(path.join(ctx.dir, DRAFT), read(ctx.dir, DRAFT).replace('consumer: sales-agent', 'consumer: billing-agent'));
  r = await cli(ctx, approveCommand, DRAFT);
  assert.equal(r.code, 1);
  assert.match(r.err, /consumer "billing-agent" is not in beak\.config\.yaml/);
  r = await cli(ctx, approveCommand, 'library/tasks/cold-email.md');
  assert.equal(r.code, 1);
  assert.match(r.err, /is not a draft/);
});

test('approve lists the run-only criteria from /refine, so they can become Done-when lines', async () => {
  const ctx = setup();
  const id = await makeDraft(ctx);
  assert.equal((await cli(ctx, refineCommand, id, 'Mention', 'the', 'stock')).code, 0);
  write(ctx.dir, `runs/${id}/round-1/prompt.md`, prompt(' Lager.'));
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) assert.equal((await cli(ctx, fn, id, '1')).code, 0);
  assert.equal((await cli(ctx, finalizeCommand, id)).code, 0);
  const r = await cli(ctx, approveCommand, DRAFT);
  assert.match(r.out, /run-only criteria from \/refine \(offer to make them Done-when lines with beak learn\):\n  R1 \[must\] Mention the stock\n/);
});

test('reject with a rule: the draft moves to drafts/_rejected/ with the reason, the line lands in the block with a version bump', async () => {
  const ctx = setup();
  const id = await makeDraft(ctx);
  const args = [DRAFT, '--reason', 'Too pushy: asks for a call twice', '--block', 'tone/formal-de', '--line', '[must] Asks for at most one thing.'];
  let r = await cli(ctx, rejectCommand, ...args, '--check');
  assert.equal(r.code, 0, r.err);
  assert.equal(
    r.out,
    [
      `would move ${DRAFT} to drafts/_rejected/${id}.md (reason recorded)`,
      'would add to library/tones/formal-de.md (version 1 → 2):',
      '  - [must] Asks for at most one thing. (learned 2026-11-07)',
      'check: ok, nothing written',
      '',
    ].join('\n'),
  );
  assert.ok(fs.existsSync(path.join(ctx.dir, DRAFT)), '--check writes nothing');
  assert.match(read(ctx.dir, 'library/tones/formal-de.md'), /^version: 1$/m);

  r = await cli(ctx, rejectCommand, ...args);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^rejected: moved ${DRAFT} to drafts/_rejected/${id}\\.md \\(reason recorded\\)$`, 'm'));
  const rejected = readDoc(read(ctx.dir, `drafts/_rejected/${id}.md`));
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(rejected.data.rejected_reason, 'Too pushy: asks for a call twice');
  assert.equal(rejected.data.rule_block, 'tone/formal-de');
  assert.equal(rejected.data.rule, '- [must] Asks for at most one thing. (learned 2026-11-07)');
  assert.ok(!fs.existsSync(path.join(ctx.dir, DRAFT)));

  const tone = read(ctx.dir, 'library/tones/formal-de.md');
  assert.match(tone, /^version: 2$/m);
  assert.match(tone, /^updated: 2026-11-07$/m);
  assert.ok(tone.endsWith('- Contains no exclamation marks.\n- [must] Asks for at most one thing. (learned 2026-11-07)\n'), tone);
  assert.deepEqual(lint({ config: configOf(ctx.dir) }).findings, [], 'the library still lints clean');

  // the next run picks the learned criterion up
  const next = await cli(ctx, bundleCommand, 'task=cold-email', 'customer=acme-pharma');
  const rubric = readJsonFile(ctx.dir, `runs/${next.out.split('\n')[0]}/rubric.json`);
  assert.deepEqual(rubric.criteria.find((c) => c.text === 'Asks for at most one thing.'), {
    id: 'C13', text: 'Asks for at most one thing.', must: true, sources: ['formal-de'], learned: '2026-11-07', inputs: null,
  });
});

test('reject without a rule, twice for one run, and the refusals', async () => {
  const ctx = setup();
  const id = await makeDraft(ctx);
  let r = await cli(ctx, rejectCommand, DRAFT, '--reason', 'Not now');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /add/);
  assert.deepEqual(listFiles(path.join(ctx.dir, 'drafts')), [`_rejected/${id}.md`]);
  // finalize the same run again and reject again: a new file, nothing overwritten
  assert.equal((await cli(ctx, finalizeCommand, id)).code, 0);
  r = await cli(ctx, rejectCommand, DRAFT, '--reason', 'Still not');
  assert.deepEqual(listFiles(path.join(ctx.dir, 'drafts')), [`_rejected/${id}-2.md`, `_rejected/${id}.md`]);

  assert.equal((await cli(ctx, finalizeCommand, id)).code, 0);
  for (const [args, code, message] of [
    [[DRAFT], 2, /give the reason with --reason/],
    [[DRAFT, '--reason', 'x', '--block', 'formal-de'], 2, /--block and --line go together/],
    [[DRAFT, '--reason', '  '], 2, /give the reason/],
    [[DRAFT, '--reason', 'x', '--block', 'tone/casual', '--line', 'y'], 1, /there is no tone "casual"/],
    [[DRAFT, '--reason', 'x', '--block', 'shape/x', '--line', 'y'], 2, /"shape" is not a block type/],
    [[DRAFT, '--reason', 'x', '--block', 'formal-de', '--line', 'Contains no exclamation marks.'], 1, /tone\/formal-de already has this criterion \(line \d+\)/],
    [[`drafts/_rejected/${id}.md`, '--reason', 'x'], 1, /is not a draft|was rejected already/],
  ]) {
    r = await cli(ctx, rejectCommand, ...args);
    assert.equal(r.code, code, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, message);
  }
  assert.ok(fs.existsSync(path.join(ctx.dir, DRAFT)), 'a refused reject leaves the draft');
});

test('learn: a Done-when line for any block; ids shared by two types need type/id', async () => {
  const ctx = setup();
  let r = await cli(ctx, learnCommand, 'acme-pharma', '--line', '- Names the product strength.', '--check');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^would add to library\/customers\/acme-pharma\.md \(version 1 → 2\):\n  - Names the product strength\. \(learned 2026-11-07\)\ncheck: ok, nothing written\n$/);
  r = await cli(ctx, learnCommand, 'acme-pharma', '--line', 'Names the product strength.', '--must');
  assert.match(read(ctx.dir, 'library/customers/acme-pharma.md'), /- \[must\] Names the product strength\. \(learned 2026-11-07\)\n$/);

  write(ctx.dir, 'library/customers/pharma.md', read(ctx.dir, 'library/customers/acme-pharma.md').replace('id: acme-pharma', 'id: pharma'));
  r = await cli(ctx, learnCommand, 'pharma', '--line', 'x');
  assert.equal(r.code, 2);
  assert.match(r.err, /"pharma" is the id of several blocks \(customer\/pharma, industry\/pharma\); write type\/id/);
  r = await cli(ctx, learnCommand, 'industries/pharma', '--line', 'Avoids patient stories.');
  assert.equal(r.code, 0, r.err);
  assert.match(read(ctx.dir, 'library/industries/pharma.md'), /- Avoids patient stories\. \(learned 2026-11-07\)\n$/);
});

test('insertDoneWhen and normalizeCriterion', () => {
  const block = read(REPO, 'library/industries/saas.md');
  assert.ok(insertDoneWhen(block, '- X.').endsWith('- [must] Mentions no certifications or integrations that the input or context does not state.\n- X.\n'));
  const empty = block.replace(/## Done when[\s\S]*$/, '## Done when\n');
  assert.ok(insertDoneWhen(empty, '- X.').endsWith('## Done when\n\n- X.\n'));
  assert.deepEqual(normalizeCriterion('- [must] One CTA. (learned 2026-01-01)'), { text: 'One CTA.', must: true });
  assert.deepEqual(normalizeCriterion('One CTA.', true), { text: 'One CTA.', must: true });
  assert.throws(() => normalizeCriterion('  - '), /empty/);
  assert.throws(() => normalizeCriterion('a\nb'), /one line/);
});

test('review and status: report only, holdout details stay hidden', async () => {
  const ctx = setup({ editConfig: (c) => c.replace('max_rounds: 4', 'max_rounds: 1') });
  let r = await cli(ctx, reviewCommand);
  assert.equal(r.out, 'no drafts waiting for review\n');
  const fake = ctx.env.BEAK_FAKE_DIR;
  write(fake, 'judge/round-0.json', JSON.stringify({ auto: { score: 80, fail: ['C7@sparse-lead-data', 'C2@cold-first-contact'] } }));
  const id = await makeDraft(ctx);
  const before = listFiles(ctx.dir).map((f) => [f, read(ctx.dir, f)]);
  r = await cli(ctx, reviewCommand);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith('# Review: cold-email / acme-pharma-formal-de\n'));
  assert.match(r.out, new RegExp(`^- run ${id}, round 0: score 80, FAIL, stop: max_rounds$`, 'm'));
  assert.match(r.out, /^- C2 \[must\] The email contains exactly one call to action\. \(cold-email\): failed on cold-first-contact$/m);
  assert.match(r.out, /^  - judge's fix for cold-first-contact: Fix C2 for cold-first-contact\.$/m);
  assert.match(r.out, /^- C7 Uses supply reliability, not price or efficacy, as the main argument\. \(acme-pharma\): failed on 1 holdout input$/m);
  assert.match(r.out, /## Sample output \(cold-first-contact, round 0\)/);
  assert.match(r.out, /No golden prompt for task cold-email yet/);
  assert.ok(!r.out.includes('sparse-lead-data') && !r.out.includes('Jonas Berg'), 'no holdout details in the review');
  assert.deepEqual(listFiles(ctx.dir).map((f) => [f, read(ctx.dir, f)]), before, 'review changes nothing');

  r = await cli(ctx, statusCommand);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Drafts waiting for review \(1\):\n  drafts\/cold-email\/acme-pharma-formal-de\.md  score 80 FAIL, stop max_rounds, run /m);
  assert.match(r.out, new RegExp(`^  ${id}  1 round, best 80 FAIL \\(round 0\\), STOP max_rounds, finalized as ${DRAFT} \\(round 0\\)$`, 'm'));
  assert.match(r.out, /Approved prompts:\n  none\n$/);
  assert.equal((await cli(ctx, approveCommand, DRAFT)).code, 0);
  r = await cli(ctx, statusCommand);
  assert.match(r.out, /Approved prompts:\n  sales-agent: 1 prompt \(out\/sales-agent\/index\.json\)\n    cold-email\/acme-pharma-formal-de\.md v1\n$/);

  // a run folder that is gone (runs/ is not committed) still allows a review
  await makeDraft(ctx);
  fs.rmSync(path.join(ctx.dir, 'runs'), { recursive: true });
  r = await cli(ctx, reviewCommand, DRAFT);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /The run folder runs\/.* is not here/);
});

test('review lists several drafts and names newer block versions', async () => {
  const ctx = setup();
  await makeDraft(ctx);
  const b = await cli(ctx, bundleCommand, 'task=cold-email', 'industry=saas');
  const id = b.out.split('\n')[0];
  write(ctx.dir, `runs/${id}/round-0/prompt.md`, prompt());
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) await cli(ctx, fn, id, '0');
  await cli(ctx, finalizeCommand, id);
  let r = await cli(ctx, reviewCommand);
  assert.match(r.out, /^drafts waiting for review \(name one: beak review <draft>\):\n  drafts\/cold-email\/acme-pharma-formal-de\.md .*\n  drafts\/cold-email\/saas-friendly-en\.md /);
  await cli(ctx, learnCommand, 'formal-de', '--line', 'Uses short paragraphs.');
  r = await cli(ctx, reviewCommand, DRAFT);
  assert.match(r.out, /^- newer blocks since the run: formal-de v1 → v2 \(compose again to use them\)$/m);
});

test('unifiedDiff', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
  assert.equal(unifiedDiff('a\nb\nc', 'a\nB\nc', { from: 'x', to: 'y' }), '--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
  const long = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const changed = [...long];
  changed[2] = 'X';
  changed[17] = 'Y';
  const d = unifiedDiff(long.join('\n'), changed.join('\n'));
  assert.equal((d.match(/^@@/gm) ?? []).length, 2, 'distant changes get separate hunks');
  assert.match(d, /^@@ -1,6 \+1,6 @@$/m);
  assert.match(d, /^@@ -15,6 \+15,6 @@$/m);
});
