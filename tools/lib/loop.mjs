// The quality loop's decisions (plan.md §7), all deterministic:
//   beak loop-status <run>          table of rounds, then CONTINUE or STOP <reason>, and the next step
//   beak finalize <run> [--force]   copy the best round to drafts/<task>/<variant>.md
//   beak refine <run> [rounds=N] [notes…]   more rounds; the notes become a run-only criterion
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { loadLibrary } from './library.mjs';
import { ROUND_FILES, RUN_FILES, libraryHash, listRounds, loadRun, outputPath, readAttempts, recordAttempt, roundDir } from './run.mjs';
import { BeakError, command, parseArgs, plural, readDoc, readJson, relPath, sha256, writeDoc, writeJson, writeText } from './util.mjs';

export const STOP_REASONS = Object.freeze(['pass', 'max_rounds', 'plateau', 'error']);
export const FINAL_FILE = 'final.json';

/** What exists for one round. */
export function roundState(run, round) {
  const dir = roundDir(run.dir, round);
  const file = (k) => path.join(dir, ROUND_FILES[k]);
  const json = (k) => {
    if (!fs.existsSync(file(k))) return null;
    try {
      return readJson(file(k));
    } catch {
      return null;
    }
  };
  const test = json('test');
  return {
    round,
    prompt: fs.existsSync(file('prompt')) && fs.readFileSync(file('prompt'), 'utf8').trim() !== '',
    tested: test?.ok === true,
    checked: fs.existsSync(file('checks')),
    judged: fs.existsSync(file('judge')),
    scorecard: json('scorecardJson'),
    attempts: readAttempts(run.dir, round),
  };
}

/**
 * The run's current segment: rounds after the last /refine (or all rounds), and the last round allowed in it
 * (max_rounds counts round 0; a refine allows `rounds` more after the round it was made after).
 */
export function segment(run) {
  const refinements = run.extra?.refinements ?? [];
  const last = refinements.at(-1);
  if (!last) return { start: 0, lastAllowed: run.meta.loop.max_rounds - 1, refinement: null };
  return { start: last.after_round + 1, lastAllowed: last.after_round + last.rounds, refinement: last };
}

/** plateau: none of the last `patience` scores beats the best score before them by `min_delta` or more. */
export function isPlateau(scores, { min_delta, patience }) {
  if (scores.length < patience + 1) return false;
  const before = Math.max(...scores.slice(0, scores.length - patience));
  const recent = Math.max(...scores.slice(-patience));
  return recent < before + min_delta;
}

/** The stop rule that applies after the last of these scored rounds, or null. */
export function stopRule(scored, seg, loop) {
  const last = scored.at(-1);
  if (last.scorecard.pass) return 'pass';
  if (last.round >= seg.lastAllowed) return 'max_rounds';
  if (isPlateau(scored.map((s) => s.scorecard.score), loop)) return 'plateau';
  return null;
}

/** Two failed runner attempts in a row (a /refine marker breaks the streak). */
export function runnerFailedTwice(attempts) {
  return attempts.length >= 2 && !attempts.at(-1).ok && !attempts.at(-2).ok;
}

/**
 * Decide what happens next. Returns {
 *   states, segment, verdict: 'CONTINUE'|'STOP', reason (STOP only), detail, next, note
 * }.
 */
export function loopStatus(run) {
  const rounds = listRounds(run.dir);
  rounds.forEach((r, i) => {
    if (r !== i) throw new BeakError(`round-${r} exists but round-${i} does not; rounds are numbered 0, 1, 2, … without gaps`);
  });
  const states = rounds.map((r) => roundState(run, r));
  const seg = segment(run);
  const loop = run.meta.loop;
  const id = run.id;
  const write = (n) => {
    const fixes = n === 0 ? 'from bundle.md' : `fixing only the top issues in round-${n - 1}/scorecard.md (targeted edits, no rewrite)`;
    const notes = seg.refinement && n === seg.start && seg.refinement.criteria.length
      ? `, and covering the run-only ${seg.refinement.criteria.length === 1 ? 'criterion' : 'criteria'} ${seg.refinement.criteria.join(', ')} from /refine`
      : '';
    return `write runs/${id}/round-${n}/prompt.md and round-${n}/changes.md, ${fixes}${notes}; then run node tools/beak.mjs test ${id} ${n}`;
  };

  // The first stop rule that fired in the current segment ends the loop.
  const scored = [];
  for (const s of states) {
    if (s.round < seg.start) continue;
    if (!s.scorecard) break;
    scored.push(s);
    const reason = stopRule(scored, seg, loop);
    if (reason) {
      const later = states.filter((x) => x.round > s.round).map((x) => `round-${x.round}`);
      return {
        states,
        segment: seg,
        verdict: 'STOP',
        reason,
        detail: stopDetail(reason, scored, seg, loop),
        next: `node tools/beak.mjs finalize ${id}`,
        note: later.length ? `${later.join(', ')} came after the loop stopped and ${later.length === 1 ? 'is' : 'are'} ignored` : null,
      };
    }
  }

  const go = (next, detail = null) => ({ states, segment: seg, verdict: 'CONTINUE', reason: null, detail, next, note: null });
  if (!states.length) return go(write(0));
  const last = states.at(-1);
  if (last.scorecard) return go(write(last.round + 1), seg.refinement?.after_round === last.round ? 'refined: more rounds were added after this round' : null);

  if (runnerFailedTwice(last.attempts)) {
    const anyScored = states.some((s) => s.scorecard);
    return {
      states,
      segment: seg,
      verdict: 'STOP',
      reason: 'error',
      detail: `the runner failed twice in a row in round ${last.round}: ${last.attempts.at(-1).error}`,
      next: anyScored ? `node tools/beak.mjs finalize ${id}` : 'nothing to finalize: tell the user the runner fails and show the error',
      note: null,
    };
  }
  const failedBefore = (step) => last.attempts.at(-1)?.step === step && !last.attempts.at(-1).ok;
  if (!last.prompt) return go(write(last.round));
  if (!last.tested) return go(`node tools/beak.mjs test ${id} ${last.round}`, failedBefore('test') ? `the last attempt failed: ${last.attempts.at(-1).error}` : null);
  if (!last.checked) return go(`node tools/beak.mjs check ${id} ${last.round}`);
  if (!last.judged) return go(`node tools/beak.mjs judge ${id} ${last.round}`, failedBefore('judge') ? `the last attempt failed: ${last.attempts.at(-1).error}` : null);
  return go(`node tools/beak.mjs score ${id} ${last.round}`);
}

function stopDetail(reason, scored, seg, loop) {
  const last = scored.at(-1);
  if (reason === 'pass') return `round ${last.round} passes (score ${last.scorecard.score}, threshold ${last.scorecard.threshold})`;
  if (reason === 'max_rounds') return `round ${last.round} was the last round allowed (loop.max_rounds ${loop.max_rounds}${seg.refinement ? ', extended by /refine' : ''})`;
  const scores = scored.map((s) => s.scorecard.score);
  const before = Math.max(...scores.slice(0, scores.length - loop.patience));
  return `the score has not improved by ${loop.min_delta} or more over ${before} for ${plural(loop.patience, 'round')} (scores: ${scores.join(', ')})`;
}

/** Fixed-width table of the rounds. */
export function formatRounds(states) {
  const rows = [['round', 'score', 'result', 'hard', 'must', 'criteria']];
  for (const s of states) {
    const c = s.scorecard;
    if (c) rows.push([String(s.round), String(c.score), c.pass ? 'PASS' : 'FAIL', `${c.hard.passed}/${c.hard.total}`, `${c.must.passed}/${c.must.total}`, `${c.criteria.passed}/${c.criteria.total}`]);
    else rows.push([String(s.round), '-', 'incomplete', '', '', '']);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd());
}

export const loopStatusCommand = command('loop-status', 'Usage: beak loop-status <run>', async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  if (args.length !== 1) throw new BeakError('give the run id', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, args[0], cwd);
  const status = loopStatus(run);
  io.out.write(`run ${run.id} (rounds ${status.segment.start}–${status.segment.lastAllowed} allowed)\n`);
  for (const line of formatRounds(status.states)) io.out.write(`${line}\n`);
  io.out.write(`${status.verdict}${status.reason ? ` ${status.reason}` : ''}\n`);
  if (status.detail) io.out.write(`why: ${status.detail}\n`);
  if (status.note) io.out.write(`note: ${status.note}\n`);
  io.out.write(`next: ${status.next}\n`);
  return 0;
});

// ---------------------------------------------------------------------------------------------------------
// finalize

/** Best round: the highest score among passing rounds, else the highest score; ties go to more criteria and checks passed, then the earlier round. */
export function bestRound(scored) {
  const passing = scored.filter((s) => s.scorecard.pass);
  const pool = passing.length ? passing : scored;
  return [...pool].sort(
    (a, b) =>
      b.scorecard.score - a.scorecard.score ||
      b.scorecard.criteria.passed - a.scorecard.criteria.passed ||
      b.scorecard.hard.passed - a.scorecard.hard.passed ||
      a.round - b.round,
  )[0];
}

export function draftPath(config, meta) {
  return path.join(config.dirs.drafts, meta.task, `${meta.variant}.md`);
}

/** Copy the best round to drafts/. Returns a summary for the CLI. */
export function finalizeRun({ config, run, force = false }) {
  const status = loopStatus(run);
  if (status.verdict !== 'STOP' && !force) {
    throw new BeakError(`the loop has not stopped (CONTINUE; next: ${status.next}). Finalize after STOP, or with --force if the user wants to stop now`);
  }
  const allScored = status.states.filter((s) => s.scorecard);
  const inSegment = allScored.filter((s) => s.round >= status.segment.start);
  const pool = inSegment.length ? inSegment : allScored;
  if (!pool.length) throw new BeakError('no round has a scorecard yet; there is nothing to finalize');
  const best = bestRound(pool);
  const prompt = fs.readFileSync(path.join(roundDir(run.dir, best.round), ROUND_FILES.prompt), 'utf8').replace(/\s+$/, '');
  const library = loadLibrary(config.dirs.library, { root: config.root });
  const libraryChanged = libraryHash(config, library) !== run.meta.library_hash;
  const file = draftPath(config, run.meta);
  const previous = fs.existsSync(file) ? readDoc(fs.readFileSync(file, 'utf8'))?.data ?? null : null;
  const stop = status.verdict === 'STOP' ? status.reason : 'forced';
  const data = {
    status: 'needs-review',
    task: run.meta.task,
    variant: run.meta.variant,
    consumer: run.meta.consumer,
    run: run.id,
    round: best.round,
    score: best.scorecard.score,
    pass: best.scorecard.pass,
    stop,
    language: run.meta.language?.value ?? null,
    runtime_vars: run.meta.runtime_vars,
    sources: run.meta.blocks.map((b) => `${b.id}@${b.version}`),
    prompt_sha256: sha256(prompt),
    library_changed: libraryChanged,
  };
  writeText(file, writeDoc(data, prompt));
  writeJson(path.join(run.dir, FINAL_FILE), { run: run.id, round: best.round, stop, draft: relPath(config.root, file) });
  const visible = run.inputs.find((i) => !i.holdout);
  return {
    status,
    best,
    file,
    previous: previous && previous.run !== run.id ? previous : null,
    libraryChanged,
    sample: visible ? outputPath(run.dir, best.round, visible) : null,
    stop,
  };
}

export const finalizeCommand = command('finalize', 'Usage: beak finalize <run> [--force]', async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  const { flags, positional, problems } = parseArgs(args, { flags: ['force'] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length !== 1) throw new BeakError('give the run id', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, positional[0], cwd);
  const r = finalizeRun({ config, run, force: Boolean(flags.force) });
  for (const line of formatRounds(r.status.states)) io.out.write(`${line}\n`);
  io.out.write(`stop: ${r.stop}${r.status.detail ? ` (${r.status.detail})` : ''}\n`);
  io.out.write(`best round: ${r.best.round} (score ${r.best.scorecard.score}, ${r.best.scorecard.pass ? 'PASS' : 'FAIL'})\n`);
  const failing = r.best.scorecard.failing_criteria;
  if (failing.length) {
    io.out.write('still failing in that round:\n');
    for (const c of failing) {
      const where = [...c.failed_inputs, ...(c.holdout_failures ? [plural(c.holdout_failures, 'holdout input')] : [])].join(', ');
      io.out.write(`  ${c.id}${c.must ? ' [must]' : ''} ${c.hidden ? '(a criterion for a holdout input)' : c.text} (${where})\n`);
    }
  }
  for (const c of r.best.scorecard.failing_checks.filter((x) => !x.holdout)) io.out.write(`  hard check ${c.check} ${c.value ?? ''} on ${c.where}: ${c.detail}\n`);
  const holdoutChecks = r.best.scorecard.failing_checks.filter((x) => x.holdout).length;
  if (holdoutChecks) io.out.write(`  ${plural(holdoutChecks, 'hard check')} failed on holdout inputs\n`);
  if (r.sample) io.out.write(`sample output: ${relPath(config.root, r.sample)}\n`);
  io.out.write(`draft: ${relPath(config.root, r.file)} (status: needs-review)\n`);
  if (r.previous) io.out.write(`note: this replaces the draft from run ${r.previous.run}\n`);
  if (r.libraryChanged) io.out.write('warning: the library changed during this run; the draft may not match the current blocks (library_changed: true)\n');
  io.out.write('next: show the user this summary; /review, /approve or /reject is their call\n');
  return 0;
});

// ---------------------------------------------------------------------------------------------------------
// refine

/** Record a /refine: up to `rounds` more rounds and, if there are notes, a run-only [must] criterion. */
export function refineRun({ run, rounds, notes }) {
  const status = loopStatus(run);
  if (status.verdict !== 'STOP') {
    throw new BeakError(`the loop is still running (next: ${status.next}); refine a run after it stopped`);
  }
  const scored = status.states.filter((s) => s.scorecard);
  if (!scored.length) throw new BeakError('no round has a scorecard yet; there is nothing to refine');
  const after = scored.at(-1).round;
  const extra = structuredClone(run.extra ?? { criteria: [], refinements: [] });
  extra.criteria ??= [];
  extra.refinements ??= [];
  const added = [];
  const text = notes.trim();
  if (text) {
    const criterion = { id: `R${extra.criteria.length + 1}`, text, must: true, sources: ['refine'], learned: null, inputs: null };
    extra.criteria.push(criterion);
    added.push(criterion);
  }
  extra.refinements.push({ after_round: after, rounds, criteria: added.map((c) => c.id), notes: text || null });
  const last = status.states.at(-1);
  if (!last.scorecard && last.round > after) recordAttempt(run.dir, last.round, { step: 'refine', ok: true });
  writeJson(path.join(run.dir, RUN_FILES.extra), { run: run.id, criteria: extra.criteria, refinements: extra.refinements });
  return { after, rounds, added };
}

export const refineCommand = command('refine', 'Usage: beak refine <run> [rounds=N] [notes…]', async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  const { values, positional, problems } = parseArgs(args, { keys: ['rounds'] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (!positional.length) throw new BeakError('give the run id, then optional notes', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, positional[0], cwd);
  let rounds = run.meta.loop.max_rounds;
  if (values.rounds !== undefined) {
    if (!/^[1-9]\d*$/.test(values.rounds)) throw new BeakError(`rounds must be a whole number >= 1 (got "${values.rounds}")`, 2);
    rounds = Number(values.rounds);
  }
  const r = refineRun({ run, rounds, notes: positional.slice(1).join(' ') });
  for (const c of r.added) io.out.write(`added ${c.id} [must] ${c.text} (a criterion for this run only)\n`);
  io.out.write(`allowed: up to ${plural(r.rounds, 'more round')} after round ${r.after} (rounds ${r.after + 1}–${r.after + r.rounds})\n`);
  io.out.write(`next: node tools/beak.mjs loop-status ${run.id}\n`);
  return 0;
});
