// Score history (M8): runs in time order with their scores and outcome, approved versions, filters, JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { approveCommand, rejectCommand } from '../tools/lib/approve.mjs';
import { bundleCommand } from '../tools/lib/bundle.mjs';
import { checkCommand } from '../tools/lib/checks.mjs';
import { historyCommand, runDate } from '../tools/lib/history.mjs';
import { judgeCommand } from '../tools/lib/judge.mjs';
import { finalizeCommand } from '../tools/lib/loop.mjs';
import { scoreCommand } from '../tools/lib/score.mjs';
import { testCommand } from '../tools/lib/tester.mjs';
import { NOW, REPO, read, run, tempRepo, write } from './helpers.mjs';

const ID = '20261107-0930-cold-email-acme-pharma-formal-de';
const prompt = `## Role\n\nDu schreibst für Acme Pharma.\n\n## Context\n\nGenerika.\n\n## Instructions\n\nSchreibe die E-Mail.\n\n## Constraints\n\nUnterschrift: {{sender_name}}, {{sender_role}}.\n\n## Output format\n\nNur die E-Mail.\n\n## Examples\n\n(keine)\n`;

function setup() {
  const dir = tempRepo({ prefix: 'beak-history-' });
  const g = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, env: {} };
}

/** A fake runner folder whose judge gives `scores[n]` in round n. */
function fakeScores(ctx, name, scores) {
  const fake = path.join(ctx.dir, 'fake', name);
  write(fake, 'tester/default.md', read(REPO, 'test/fixtures/fake/tester/default.md'));
  scores.forEach((score, n) => write(fake, `judge/round-${n}.json`, JSON.stringify({ auto: { score } })));
  return { BEAK_RUNNER: 'fake', BEAK_FAKE_DIR: fake };
}

const cli = (ctx, env, fn, ...args) => run(fn, args, { cwd: ctx.dir, env, now: NOW });

let fakeCount = 0;

/** Bundle, then play one round per score (with `partial`, the last round only gets `beak test`). Returns the run id. */
async function playRun(ctx, args, scores, { finalize = true, partial = false } = {}) {
  const env = fakeScores(ctx, `run-${++fakeCount}`, scores);
  const b = await cli(ctx, env, bundleCommand, ...args);
  assert.equal(b.code, 0, b.err);
  const id = b.out.split('\n')[0];
  for (let n = 0; n < scores.length; n++) {
    write(ctx.dir, `runs/${id}/round-${n}/prompt.md`, prompt.replace('E-Mail.', `E-Mail (Runde ${n}).`));
    const steps = partial && n === scores.length - 1 ? [testCommand] : [testCommand, checkCommand, judgeCommand, scoreCommand];
    for (const fn of steps) {
      const r = await cli(ctx, env, fn, id, String(n));
      assert.equal(r.code, 0, r.err);
    }
  }
  if (finalize) {
    const f = await cli(ctx, env, finalizeCommand, id);
    assert.equal(f.code, 0, f.err);
  }
  return id;
}

async function history(ctx, ...args) {
  return cli(ctx, {}, historyCommand, ...args);
}

// ---------------------------------------------------------------------------------------------------------

test('runDate reads the local time from a run id', () => {
  assert.equal(runDate(ID), '2026-11-07 09:30');
  assert.equal(runDate('not-a-run'), null);
});

test('history: every run with its scores and outcome, in time order, and the approved versions', async () => {
  const ctx = setup();
  await playRun(ctx, ['task=cold-email', 'customer=acme-pharma'], [60, 78, 90]);
  assert.equal((await cli(ctx, {}, approveCommand, 'drafts/cold-email/acme-pharma-formal-de.md')).code, 0);
  await playRun(ctx, ['task=cold-email', 'customer=acme-pharma'], [60, 61, 62]); // plateau
  assert.equal((await cli(ctx, {}, rejectCommand, 'drafts/cold-email/acme-pharma-formal-de.md', '--reason', 'zu lang')).code, 0);
  await playRun(ctx, ['task=cold-email', 'customer=acme-pharma'], [90]);
  assert.equal((await cli(ctx, {}, approveCommand, 'drafts/cold-email/acme-pharma-formal-de.md')).code, 0);
  await playRun(ctx, ['task=cold-email', 'customer=acme-pharma', 'tone=friendly-en'], [90]); // waits for review
  await playRun(ctx, ['task=cold-email', 'industry=saas'], [70], { finalize: false, partial: true }); // in progress

  const r = await history(ctx);
  assert.equal(r.code, 0, r.err);
  assert.equal(
    r.out,
    [
      'cold-email / acme-pharma-formal-de (sales-agent)',
      `  2026-11-07 09:30  ${ID}`,
      '      rounds 60 → 78 → 90, best 90 PASS (round 2), STOP pass → approved v1 (superseded)',
      `  2026-11-07 09:30  ${ID}-2`,
      '      rounds 60 → 61 → 62, best 62 FAIL (round 2), STOP plateau → rejected: "zu lang"',
      `  2026-11-07 09:30  ${ID}-3`,
      '      rounds 90, best 90 PASS (round 0), STOP pass → approved v2 (current)',
      '  approved: v1 90 (2026-11-07) → v2 90 (2026-11-07, current)',
      '',
      'cold-email / acme-pharma-friendly-en',
      '  2026-11-07 09:30  20261107-0930-cold-email-acme-pharma-friendly-en',
      '      rounds 90, best 90 PASS (round 0), STOP pass → draft waiting for review',
      '',
      'cold-email / saas-friendly-en',
      '  2026-11-07 09:30  20261107-0930-cold-email-saas-friendly-en',
      '      rounds - → in progress',
      '',
      '3 variants, 5 runs',
      '',
    ].join('\n'),
  );

  // filters
  const one = await history(ctx, 'cold-email', 'saas-friendly-en');
  assert.match(one.out, /^cold-email \/ saas-friendly-en\n/);
  assert.match(one.out, /\n1 variant, 1 run\n$/);
  assert.match((await history(ctx, 'cold-email')).out, /\n3 variants, 5 runs\n$/);
  assert.equal((await history(ctx, 'cold-mail')).out, 'no history for cold-mail: no runs (runs/ is local), drafts or approved prompts\n');

  // JSON: the same facts, machine-readable
  const json = JSON.parse((await history(ctx, 'cold-email', 'acme-pharma-formal-de', '--json')).out);
  assert.equal(json.groups.length, 1);
  const g = json.groups[0];
  assert.deepEqual(g.runs.map((x) => [x.run, x.rounds.map((y) => y.score), x.best.score, x.reason, x.outcome.kind, x.outcome.version]), [
    [ID, [60, 78, 90], 90, 'pass', 'superseded', 1],
    [`${ID}-2`, [60, 61, 62], 62, 'plateau', 'rejected', null],
    [`${ID}-3`, [90], 90, 'pass', 'approved', 2],
  ]);
  assert.deepEqual(g.approved.map((v) => [v.version, v.score, v.current]), [[1, 90, false], [2, 90, true]]);
});

test('history without runs/ (another machine): scores come from out/ and the rejected drafts', async () => {
  const ctx = setup();
  await playRun(ctx, ['task=cold-email', 'customer=acme-pharma'], [60, 90]);
  await cli(ctx, {}, approveCommand, 'drafts/cold-email/acme-pharma-formal-de.md');
  await playRun(ctx, ['task=cold-email', 'customer=acme-pharma'], [60, 61, 62]);
  await cli(ctx, {}, rejectCommand, 'drafts/cold-email/acme-pharma-formal-de.md', '--reason', 'zu förmlich');
  fs.rmSync(path.join(ctx.dir, 'runs'), { recursive: true });

  const r = await history(ctx);
  assert.equal(
    r.out,
    [
      'cold-email / acme-pharma-formal-de (sales-agent)',
      `  2026-11-07 09:30  ${ID}`,
      '      run folder not here, best 90 (round 1) → approved v1 (current)',
      `  2026-11-07 09:30  ${ID}-2`,
      '      run folder not here, best 62 (round 2) → rejected: "zu förmlich"',
      '  approved: v1 90 (2026-11-07, current)',
      '',
      '1 variant, 2 runs',
      '',
    ].join('\n'),
  );
});

test('history: an empty repo, usage errors', async () => {
  const ctx = setup();
  assert.equal((await history(ctx)).out, 'no history for any task: no runs (runs/ is local), drafts or approved prompts\n');
  for (const args of [['a', 'b', 'c'], ['--csv']]) {
    const r = await history(ctx, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: beak history \[task\] \[variant\] \[--json\]/);
  }
});
