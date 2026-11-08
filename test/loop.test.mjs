// The quality loop with the fake runner (plan §13 M4): pass→stop, plateau→stop, max_rounds→stop,
// regression→best round wins, runner errors, holdout details never reach the writer, /refine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundleCommand } from '../tools/lib/bundle.mjs';
import { checkCommand } from '../tools/lib/checks.mjs';
import { judgeCommand } from '../tools/lib/judge.mjs';
import { bestRound, finalizeCommand, isPlateau, loopStatusCommand, refineCommand } from '../tools/lib/loop.mjs';
import { scoreCommand } from '../tools/lib/score.mjs';
import { testCommand } from '../tools/lib/tester.mjs';
import { readDoc } from '../tools/lib/util.mjs';
import { NOW, REPO, listFiles, read, readJsonFile, run, tempRepo, write } from './helpers.mjs';

const RUN = '20261107-0930-cold-email-acme-pharma-formal-de';
const GOOD_OUTPUT = read(REPO, 'test/fixtures/fake/tester/default.md');
const PROMPT = `## Role

Du bist der Vertriebsassistent von Acme Pharma GmbH.

## Context

Acme Pharma produziert Generika in Deutschland nach EU-GMP.

## Instructions

Schreibe eine erste E-Mail an den Lead. Die erste Zeile ist "Betreff: …".

## Constraints

Höchstens 180 Wörter, genau eine Frage. Unterschrift: {{sender_name}}, {{sender_role}}, Acme Pharma GmbH.

## Output format

Nur die E-Mail.

## Examples

\`\`\`text
Betreff: Ihre Anfrage zu Metformin 500 mg
\`\`\`
`;

/** A temp repo with a run of the example task and a fake runner folder. */
async function setup({ editConfig } = {}) {
  const dir = tempRepo({ prefix: 'beak-loop-', editConfig });
  const fake = path.join(dir, 'fake');
  write(fake, 'tester/default.md', GOOD_OUTPUT);
  const ctx = { dir, fake, env: { BEAK_RUNNER: 'fake', BEAK_FAKE_DIR: fake }, out: '' };
  const r = await cli(ctx, bundleCommand, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0, r.err);
  return ctx;
}

async function cli(ctx, fn, ...args) {
  const r = await run(fn, args, { cwd: ctx.dir, env: ctx.env, now: NOW });
  ctx.out += r.out + r.err; // everything the writer could see on the terminal
  return r;
}

function writeRound(ctx, n, prompt = PROMPT) {
  write(ctx.dir, `runs/${RUN}/round-${n}/prompt.md`, prompt);
  write(ctx.dir, `runs/${RUN}/round-${n}/changes.md`, n ? `- round ${n}\n` : 'Round 0: first draft from bundle.md.\n');
}

const judgeAs = (ctx, n, auto) => write(ctx.fake, `judge/round-${n}.json`, JSON.stringify({ auto }));

/** test, check, judge and score one round; every step must succeed. */
async function round(ctx, n, { prompt, judge = { score: 90 } } = {}) {
  writeRound(ctx, n, prompt);
  judgeAs(ctx, n, judge);
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) {
    const r = await cli(ctx, fn, RUN, String(n));
    assert.equal(r.code, 0, `${fn.name} round ${n}: ${r.out}${r.err}`);
  }
}

async function status(ctx) {
  const r = await cli(ctx, loopStatusCommand, RUN);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  return { verdict: lines.find((l) => /^(CONTINUE|STOP)\b/.test(l)), next: lines.find((l) => l.startsWith('next: ')), out: r.out };
}

const scorecard = (ctx, n) => readJsonFile(ctx.dir, `runs/${RUN}/round-${n}/scorecard.json`);
const draftFile = 'drafts/cold-email/acme-pharma-formal-de.md';

// ---------------------------------------------------------------------------------------------------------

test('stop rules and best round, as pure functions', () => {
  const loop = { min_delta: 3, patience: 2 };
  assert.equal(isPlateau([60, 61], loop), false, 'needs patience + 1 rounds');
  assert.equal(isPlateau([60, 61, 62], loop), true);
  assert.equal(isPlateau([60, 70, 61], loop), false, '70 beat 60 by 3 or more');
  assert.equal(isPlateau([60, 70, 71, 72], loop), true, 'measured against the best before the last two');
  assert.equal(isPlateau([80, 70, 72], loop), true, 'a regression is a plateau too');

  const s = (round, score, pass, criteria = 10) => ({ round, scorecard: { score, pass, criteria: { passed: criteria }, hard: { passed: 5 } } });
  assert.equal(bestRound([s(0, 95, false), s(1, 86, true), s(2, 88, true)]).round, 2, 'highest score among passing rounds');
  assert.equal(bestRound([s(0, 95, false), s(1, 86, true)]).round, 1, 'a passing round beats a higher failing one');
  assert.equal(bestRound([s(0, 80, false), s(1, 70, false), s(2, 72, false)]).round, 0, 'regression: the best round wins, not the last');
  assert.equal(bestRound([s(0, 80, false, 9), s(1, 80, false, 11)]).round, 1, 'ties: more criteria passed');
  assert.equal(bestRound([s(0, 80, false), s(1, 80, false)]).round, 0, 'then the earlier round');
});

test('pass → stop: round 0 passes, finalize writes the draft', async () => {
  const ctx = await setup();
  let st = await status(ctx);
  assert.equal(st.verdict, 'CONTINUE');
  assert.match(st.next, /write runs\/.*\/round-0\/prompt\.md .* from bundle\.md/);

  writeRound(ctx, 0);
  st = await status(ctx);
  assert.equal(st.next, `next: node tools/beak.mjs test ${RUN} 0`);

  await round(ctx, 0);
  const files = listFiles(path.join(ctx.dir, 'runs', RUN, 'round-0'));
  assert.deepEqual(files, [
    'changes.md', 'checks.json', 'holdout/sparse-lead-data.md', 'judge.json', 'outputs/cold-first-contact.md',
    'outputs/trade-fair-follow-up.md', 'prompt.md', 'runner.json', 'scorecard.json', 'scorecard.md', 'test.json',
  ]);
  assert.equal(scorecard(ctx, 0).pass, true);
  st = await status(ctx);
  assert.equal(st.verdict, 'STOP pass');
  assert.equal(st.next, `next: node tools/beak.mjs finalize ${RUN}`);

  const r = await cli(ctx, finalizeCommand, RUN);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^best round: 0 \(score 90, PASS\)$/m);
  assert.match(r.out, /^draft: drafts\/cold-email\/acme-pharma-formal-de\.md \(status: needs-review\)$/m);
  assert.match(r.out, /^sample output: runs\/.*\/round-0\/outputs\/cold-first-contact\.md$/m);
  const draft = readDoc(read(ctx.dir, draftFile));
  assert.deepEqual(draft.data, {
    status: 'needs-review', task: 'cold-email', variant: 'acme-pharma-formal-de', consumer: 'sales-agent', run: RUN, round: 0,
    score: 90, pass: true, stop: 'pass', language: 'de', runtime_vars: ['sender_name', 'sender_role'],
    sources: ['cold-email@1', 'acme-pharma@1', 'pharma@1', 'formal-de@1'], compose: 'task=cold-email customer=acme-pharma', prompt_sha256: draft.data.prompt_sha256, library_changed: false,
  });
  assert.equal(draft.body, PROMPT.trim());
  assert.deepEqual(readJsonFile(ctx.dir, `runs/${RUN}/final.json`), { run: RUN, round: 0, stop: 'pass', draft: draftFile });
});

test('plateau → stop', async () => {
  const ctx = await setup();
  await round(ctx, 0, { judge: { score: 60, fail: ['C2'] } });
  assert.equal((await status(ctx)).verdict, 'CONTINUE');
  await round(ctx, 1, { judge: { score: 61, fail: ['C2'] } });
  const st1 = await status(ctx);
  assert.equal(st1.verdict, 'CONTINUE');
  assert.match(st1.next, /write runs\/.*\/round-2\/prompt\.md and round-2\/changes\.md, fixing only the top issues in round-1\/scorecard\.md/);
  await round(ctx, 2, { judge: { score: 62, fail: ['C2'] } });
  const st = await status(ctx);
  assert.equal(st.verdict, 'STOP plateau');
  assert.match(st.out, /why: the score has not improved by 3 or more over 60 for 2 rounds \(scores: 60, 61, 62\)/);
});

test('max_rounds → stop', async () => {
  const ctx = await setup();
  for (const [n, score] of [[0, 50], [1, 60], [2, 70]]) {
    await round(ctx, n, { judge: { score, fail: ['C7'] } });
    assert.equal((await status(ctx)).verdict, 'CONTINUE', `after round ${n}`);
  }
  await round(ctx, 3, { judge: { score: 80, fail: ['C7'] } });
  const st = await status(ctx);
  assert.equal(st.verdict, 'STOP max_rounds');
  assert.match(st.out, /why: round 3 was the last round allowed \(loop.max_rounds 4\)/);
  // a round written after STOP changes nothing
  writeRound(ctx, 4);
  assert.equal((await status(ctx)).verdict, 'STOP max_rounds');
  assert.match((await status(ctx)).out, /note: round-4 came after the loop stopped and is ignored/);
});

test('regression → the best round wins, not the last', async () => {
  const ctx = await setup();
  await round(ctx, 0, { judge: { score: 80, fail: ['C7'] } });
  await round(ctx, 1, { prompt: `${PROMPT}\nround 1\n`, judge: { score: 70, fail: ['C7', 'C4'] } });
  await round(ctx, 2, { prompt: `${PROMPT}\nround 2\n`, judge: { score: 72, fail: ['C7'] } });
  assert.equal((await status(ctx)).verdict, 'STOP plateau');
  const r = await cli(ctx, finalizeCommand, RUN);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^best round: 0 \(score 80, FAIL\)$/m);
  assert.match(r.out, /still failing in that round:\n  C7 Uses supply reliability/);
  const draft = readDoc(read(ctx.dir, draftFile));
  assert.equal(draft.data.round, 0);
  assert.equal(draft.body, PROMPT.trim(), 'the draft is round 0\'s prompt');
});

test('a failing hard check fails the round even when the judge is happy, and becomes a top issue', async () => {
  const ctx = await setup();
  write(ctx.fake, 'tester/round-0/cold-first-contact.md', `Hallo Frau Weber,\n\n${GOOD_OUTPUT}`);
  await round(ctx, 0, { prompt: PROMPT.replace('## Examples', '## Beispiele'), judge: { score: 95 } });
  const sc = scorecard(ctx, 0);
  assert.equal(sc.pass, false);
  assert.deepEqual(sc.reasons, ['2 hard checks failed']);
  assert.match(sc.top_issues[0], /^The prompt fails hard checks: missing section "Examples" \(no heading "Examples"\)\.$/);
  assert.match(sc.top_issues[1], /^Outputs break the hard check "contains banned "Hallo"" \(formal-de\): cold-first-contact: "Hallo" on line 1\.$/);
  const md = read(ctx.dir, `runs/${RUN}/round-0/scorecard.md`);
  assert.match(md, /^\*\*FAIL\*\*: score 95 \(needs 85\)/m);
  assert.match(md, /^- cold-first-contact: FAIL contains banned "Hallo" \("Hallo" on line 1\)$/m);
});

test('runner failures: a retry is allowed once, two in a row stop the loop with error', async () => {
  const ctx = await setup();
  await round(ctx, 0, { judge: { score: 60, fail: ['C2'] } });
  writeRound(ctx, 1);
  write(ctx.fake, 'tester/round-1/trade-fair-follow-up.md', 'FAIL: Connection error.');
  let r = await cli(ctx, testCommand, RUN, '1');
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL trade-fair-follow-up: fake runner: Connection error\./m);
  let st = await status(ctx);
  assert.equal(st.verdict, 'CONTINUE');
  assert.equal(st.next, `next: node tools/beak.mjs test ${RUN} 1`);
  assert.match(st.out, /why: the last attempt failed: trade-fair-follow-up: fake runner: Connection error\./);

  r = await cli(ctx, testCommand, RUN, '1');
  assert.equal(r.code, 1);
  st = await status(ctx);
  assert.equal(st.verdict, 'STOP error');
  assert.match(st.out, /why: the runner failed twice in a row in round 1/);
  r = await cli(ctx, finalizeCommand, RUN);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^stop: error/m);
  assert.match(r.out, /^best round: 0 /m);
});

test('judge: an invalid reply is retried once; invalid twice is a runner failure', async () => {
  const ctx = await setup();
  writeRound(ctx, 0);
  write(ctx.fake, 'judge/round-0.json', 'Sure! Here is my verdict: everything passes.');
  write(ctx.fake, 'judge/round-0/attempt-2.json', JSON.stringify({ auto: { score: 88 } }));
  assert.equal((await cli(ctx, testCommand, RUN, '0')).code, 0);
  let r = await cli(ctx, judgeCommand, RUN, '0');
  assert.equal(r.code, 0, r.err);
  const judge = readJsonFile(ctx.dir, `runs/${RUN}/round-0/judge.json`);
  assert.equal(judge.score, 88);
  assert.equal(judge.raw.length, 2, 'both replies are kept as evidence');

  fs.rmSync(path.join(ctx.fake, 'judge', 'round-0'), { recursive: true });
  r = await cli(ctx, judgeCommand, RUN, '0');
  assert.equal(r.code, 1);
  assert.match(r.err, /the judge's reply was invalid twice: the reply contains no JSON object/);
  const attempts = readJsonFile(ctx.dir, `runs/${RUN}/round-0/runner.json`).attempts;
  assert.deepEqual(attempts.map((a) => `${a.step}:${a.ok}`), ['test:true', 'judge:true', 'judge:false']);
  assert.equal(attempts[2].raw.length, 2);
  r = await cli(ctx, judgeCommand, RUN, '0');
  assert.equal(r.code, 1);
  assert.equal((await status(ctx)).verdict, 'STOP error');
});

test('judge: a pass without a verbatim quote is a fail; several samples vote', async () => {
  const ctx = await setup({ editConfig: (c) => c.replace('judge_samples: 1', 'judge_samples: 3') });
  writeRound(ctx, 0);
  write(ctx.fake, 'judge/round-0/sample-1.json', JSON.stringify({ auto: { score: 80, no_evidence: ['C1@cold-first-contact'] } }));
  write(ctx.fake, 'judge/round-0/sample-2.json', JSON.stringify({ auto: { score: 90, no_evidence: ['C1@cold-first-contact'] } }));
  write(ctx.fake, 'judge/round-0/sample-3.json', JSON.stringify({ auto: { score: 86, fail: ['C2'] } }));
  for (const fn of [testCommand, checkCommand, judgeCommand, scoreCommand]) assert.equal((await cli(ctx, fn, RUN, '0')).code, 0);
  const judge = readJsonFile(ctx.dir, `runs/${RUN}/round-0/judge.json`);
  assert.equal(judge.samples, 3);
  assert.equal(judge.score, 86, 'median');
  const v = (c, i) => judge.verdicts.find((x) => x.criterion === c && x.input === i);
  assert.equal(v('C1', 'cold-first-contact').pass, false, 'two samples passed it without evidence');
  assert.equal(v('C1', 'cold-first-contact').votes, '1/3');
  assert.equal(v('C2', 'cold-first-contact').pass, true, 'one sample of three failed it');
  assert.equal(scorecard(ctx, 0).pass, false);
  assert.deepEqual(scorecard(ctx, 0).reasons, ['[must] criterion C1 failed']);
});

test('score refuses evidence that scripts did not write or that no longer matches the files', async () => {
  const ctx = await setup();
  writeRound(ctx, 0);
  judgeAs(ctx, 0, { score: 90 });
  for (const fn of [testCommand, checkCommand, judgeCommand]) assert.equal((await cli(ctx, fn, RUN, '0')).code, 0);

  const judgeFile = path.join(ctx.dir, 'runs', RUN, 'round-0', 'judge.json');
  const real = fs.readFileSync(judgeFile, 'utf8');
  fs.writeFileSync(judgeFile, JSON.stringify({ score: 100, criteria: [], verdicts: [] }));
  let r = await cli(ctx, scoreCommand, RUN, '0');
  assert.equal(r.code, 1);
  assert.match(r.err, /judge\.json was not written by beak judge for this round; only scripts write evidence/);
  fs.writeFileSync(judgeFile, real);

  write(ctx.dir, `runs/${RUN}/round-0/outputs/cold-first-contact.md`, 'An edited output.');
  r = await cli(ctx, scoreCommand, RUN, '0');
  assert.equal(r.code, 1);
  assert.match(r.err, /the prompt or an output changed after beak check ran: run beak check/);
  assert.equal((await cli(ctx, testCommand, RUN, '0')).code, 0);
  for (const fn of [checkCommand, judgeCommand]) assert.equal((await cli(ctx, fn, RUN, '0')).code, 0);

  // a prompt edited after beak test: the outputs no longer belong to it
  write(ctx.dir, `runs/${RUN}/round-0/prompt.md`, `${PROMPT}\nOne more line.\n`);
  for (const fn of [checkCommand, judgeCommand]) {
    r = await cli(ctx, fn, RUN, '0');
    assert.equal(r.code, 1);
    assert.match(r.err, /prompt\.md changed after beak test, so the outputs are from another prompt; run beak test/);
  }
  r = await cli(ctx, scoreCommand, RUN, '0');
  assert.equal(r.code, 1);
  assert.match(r.err, /changed after beak check ran/);

  // test refuses a scored round
  writeRound(ctx, 0);
  assert.equal((await cli(ctx, scoreCommand, RUN, '0')).code, 0);
  r = await cli(ctx, testCommand, RUN, '0');
  assert.equal(r.code, 1);
  assert.match(r.err, /round 0 is already scored; a new prompt goes into round-1\//);
  r = await cli(ctx, testCommand, RUN, '1');
  assert.equal(r.code, 1);
  assert.match(r.err, /round-1\/prompt\.md is missing or empty/);
  r = await cli(ctx, testCommand, RUN, 'one');
  assert.equal(r.code, 2);
});

test('holdout details never appear in what the writer sees', async () => {
  const ctx = await setup();
  const MARK = 'HOLDOUT-OUTPUT-7731';
  write(ctx.fake, 'tester/round-0/sparse-lead-data.md', `Betreff: Ihre Apotheke\n\nSehr geehrter Herr Berg,\n\n${MARK}\n\nMit freundlichen Grüßen`);
  write(ctx.fake, 'tester/round-1/sparse-lead-data.md', `Subject: x\n\n${MARK} ${'word '.repeat(200)}`);
  await round(ctx, 0, { judge: { score: 70, fail: ['C4@sparse-lead-data', 'C2@cold-first-contact'] } });
  await round(ctx, 1, { judge: { score: 72, fail: ['C5@sparse-lead-data'] } });
  await cli(ctx, finalizeCommand, RUN, '--force');

  const seen = [
    ctx.out,
    read(ctx.dir, `runs/${RUN}/bundle.md`),
    ...[0, 1].flatMap((n) => [
      read(ctx.dir, `runs/${RUN}/round-${n}/scorecard.md`),
      ...listFiles(path.join(ctx.dir, 'runs', RUN, `round-${n}`, 'outputs')).map((f) => read(ctx.dir, `runs/${RUN}/round-${n}/outputs/${f}`)),
    ]),
  ].join('\n');
  for (const secret of ['Jonas Berg', 'Apotheke am Markt', 'sparse-lead-data', MARK, 'Fix C4 for']) {
    assert.ok(!seen.includes(secret), `the writer must not see "${secret}"`);
  }
  // …but pass/fail for the holdout is there, and the judge saw the holdout output
  const md0 = read(ctx.dir, `runs/${RUN}/round-0/scorecard.md`);
  assert.match(md0, /\| C4 It refers to at least one specific detail from the input\. \| pass \| pass \| FAIL \|/);
  assert.match(md0, /C4 "It refers to at least one specific detail from the input\." failed on 1 holdout input only \(details hidden\)/);
  assert.match(read(ctx.dir, `runs/${RUN}/round-1/scorecard.md`), /- holdout-1: FAIL \(details hidden\)/);
  assert.ok(readJsonFile(ctx.dir, `runs/${RUN}/round-0/judge.json`).verdicts.some((v) => v.input === 'sparse-lead-data'));
  assert.ok(fs.readFileSync(path.join(ctx.dir, 'runs', RUN, 'round-0', 'holdout', 'sparse-lead-data.md'), 'utf8').includes(MARK));
});

test('a criterion that applies only to a holdout input is not shown with its text', async () => {
  const ctx = await setup({ editConfig: (c) => c.replace('holdout: 1 ', 'holdout: 2 ') });
  writeRound(ctx, 0);
  await round(ctx, 0, { judge: { score: 70, fail: ['C15'] } });
  const md = read(ctx.dir, `runs/${RUN}/round-0/scorecard.md`);
  assert.ok(!md.includes('trade fair') && !md.includes('trade-fair-follow-up'), md);
  assert.match(md, /\| C15 \[must\] \(a criterion for a holdout input\) \| – \| FAIL \| – \|/);
  assert.match(md, /C15 \[must\] a criterion for a holdout input failed on 1 holdout input only/);
  assert.ok(!read(ctx.dir, `runs/${RUN}/bundle.md`).includes('Refers to the conversation at the trade fair'));
});

test('refine: notes become a run-only [must] criterion and more rounds are allowed', async () => {
  const ctx = await setup();
  await round(ctx, 0);
  let r = await cli(ctx, refineCommand, RUN, 'Mention', 'the', 'three-month', 'stock');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^added R1 \[must\] Mention the three-month stock \(a criterion for this run only\)$/m);
  assert.match(r.out, /^allowed: up to 4 more rounds after round 0 \(rounds 1–4\)$/m);
  assert.deepEqual(readJsonFile(ctx.dir, `runs/${RUN}/rubric_extra.json`), {
    run: RUN,
    criteria: [{ id: 'R1', text: 'Mention the three-month stock', must: true, sources: ['refine'], learned: null, inputs: null }],
    refinements: [{ after_round: 0, rounds: 4, criteria: ['R1'], notes: 'Mention the three-month stock' }],
  });
  let st = await status(ctx);
  assert.equal(st.verdict, 'CONTINUE');
  assert.match(st.next, /round-1\/prompt\.md .*and covering the run-only criterion R1 from \/refine/);

  // scoring round 0 again would miss R1
  assert.equal((await cli(ctx, scoreCommand, RUN, '0')).code, 1);

  await round(ctx, 1, { prompt: `${PROMPT}\nLagerbestand: drei Monate.\n`, judge: { score: 91, fail: ['R1@trade-fair-follow-up'] } });
  const judge = readJsonFile(ctx.dir, `runs/${RUN}/round-1/judge.json`);
  assert.ok(judge.criteria.some((c) => c.id === 'R1'));
  assert.equal(scorecard(ctx, 1).pass, false);
  assert.deepEqual(scorecard(ctx, 1).reasons, ['[must] criterion R1 failed']);
  await round(ctx, 2, { prompt: `${PROMPT}\nLagerbestand: drei Monate, immer.\n`, judge: { score: 89 } });
  st = await status(ctx);
  assert.equal(st.verdict, 'STOP pass');
  r = await cli(ctx, finalizeCommand, RUN);
  assert.match(r.out, /^best round: 2 /m, 'round 0 scored higher, but it was judged without R1');

  r = await cli(ctx, refineCommand, RUN, 'rounds=2');
  assert.match(r.out, /^allowed: up to 2 more rounds after round 2 \(rounds 3–4\)$/m);
  assert.doesNotMatch(r.out, /added/);
  r = await cli(ctx, refineCommand, RUN, 'more');
  assert.equal(r.code, 1);
  assert.match(r.err, /the loop is still running/);
});

test('finalize: only after STOP unless --force; warns when the library changed during the run', async () => {
  const ctx = await setup();
  await round(ctx, 0, { judge: { score: 60, fail: ['C2'] } });
  let r = await cli(ctx, finalizeCommand, RUN);
  assert.equal(r.code, 1);
  assert.match(r.err, /the loop has not stopped \(CONTINUE; next: write runs\/.*round-1\/prompt\.md/);

  fs.appendFileSync(path.join(ctx.dir, 'library/tones/formal-de.md'), '- Keine Emojis.\n');
  r = await cli(ctx, finalizeCommand, RUN, '--force');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^stop: forced$/m);
  assert.match(r.out, /^warning: the library changed during this run/m);
  const draft = readDoc(read(ctx.dir, draftFile)).data;
  assert.equal(draft.stop, 'forced');
  assert.equal(draft.library_changed, true);
});
