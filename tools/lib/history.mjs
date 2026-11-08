// Score history (M8, plan.md §15): `beak history [task] [variant] [--json]`. Per task and variant, every run in
// time order with its round scores, best round and stop reason, and what became of it (approved vN, rejected,
// waiting as a draft, …), plus the approved versions. Reads runs/ (local), drafts/ and out/ (committed, so the
// approved scores are there even where runs/ is not). Reports only; writes nothing. Scores only: nothing about
// holdout inputs beyond what the scorecards already count.
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { REJECTED_DIR, listDrafts } from './drafts.mjs';
import { FINAL_FILE, loopStatus } from './loop.mjs';
import { ARCHIVE_DIR } from './out.mjs';
import { RUN_FILES, RUN_ID_RE, loadRun } from './run.mjs';
import { BeakError, cmp, command, parseArgs, plural, readDoc, readJson } from './util.mjs';

const USAGE = 'Usage: beak history [task] [variant] [--json]';

/** "20261107-0930-…" → "2026-11-07 09:30" (local time, as in the run id). */
export function runDate(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}

/** An ISO timestamp as local "YYYY-MM-DD". */
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every approved and archived prompt: [{ consumer, task, variant, version, score, run, round, approved_at, current, stale }]. */
function outRecords(config) {
  const out = [];
  if (!fs.existsSync(config.dirs.out)) return out;
  for (const consumer of config.consumers) {
    const root = path.join(config.dirs.out, consumer);
    if (!fs.existsSync(root)) continue;
    for (const task of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))) {
      const dirs = [path.join(root, task.name), path.join(root, task.name, ARCHIVE_DIR)];
      for (const dir of dirs.filter((d) => fs.existsSync(d))) {
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
          const doc = readDoc(fs.readFileSync(path.join(dir, f), 'utf8'));
          const d = doc?.data;
          if (!d || (d.status !== 'approved' && d.status !== 'archived') || typeof d.run !== 'string') continue;
          out.push({
            consumer,
            task: d.task,
            variant: d.variant,
            version: d.version,
            score: d.score ?? null,
            run: d.run,
            round: d.round ?? null,
            approved_at: d.approved_at ?? null,
            current: d.status === 'approved',
            stale: Array.isArray(d.stale) && d.stale.length > 0,
          });
        }
      }
    }
  }
  return out;
}

/** Rejected drafts: [{ task, variant, run, round, score, reason }]. */
function rejectedRecords(config) {
  const dir = path.join(config.dirs.drafts, REJECTED_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => readDoc(fs.readFileSync(path.join(dir, n), 'utf8'))?.data)
    .filter((d) => d && typeof d.run === 'string')
    .map((d) => ({ task: d.task, variant: d.variant, run: d.run, round: d.round ?? null, score: d.score ?? null, reason: d.rejected_reason ?? null }));
}

/** Local run folders: [{ id, task, variant, rounds: [{ round, score, pass }], verdict, reason, final, error }]. */
function runRecords(config) {
  if (!fs.existsSync(config.dirs.runs)) return [];
  const ids = fs
    .readdirSync(config.dirs.runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name) && fs.existsSync(path.join(config.dirs.runs, e.name, RUN_FILES.meta)))
    .map((e) => e.name);
  return ids.map((id) => {
    try {
      const run = loadRun(config, id);
      const status = loopStatus(run);
      const finalFile = path.join(run.dir, FINAL_FILE);
      return {
        id,
        task: run.meta.task,
        variant: run.meta.variant,
        rounds: status.states.map((s) => ({ round: s.round, score: s.scorecard?.score ?? null, pass: s.scorecard ? s.scorecard.pass : null })),
        verdict: status.verdict,
        reason: status.reason,
        final: fs.existsSync(finalFile) ? readJson(finalFile) : null,
        error: null,
      };
    } catch (err) {
      let meta = {};
      try {
        meta = readJson(path.join(config.dirs.runs, id, RUN_FILES.meta));
      } catch {
        // unreadable meta: the run is listed with its id only
      }
      return { id, task: meta.task ?? null, variant: meta.variant ?? null, rounds: [], verdict: null, reason: null, final: null, error: err.message };
    }
  });
}

/**
 * The history, grouped by task and variant (sorted), each run in time order.
 * Returns [{ task, variant, consumers, runs: [{ run, date, local, rounds, best, verdict, reason, outcome }], approved: [...] }].
 * `outcome`: { kind: 'approved' (current version) | 'superseded' (an older approved version) | 'rejected' | 'draft' |
 *   'finalized' (its draft was replaced by a later one) | 'stopped' (not finalized) | 'in-progress' | 'broken', version, reason }.
 */
export function buildHistory(config, { task, variant } = {}) {
  const runs = runRecords(config);
  const approved = outRecords(config);
  const rejected = rejectedRecords(config);
  const drafts = listDrafts(config).map((d) => ({ task: d.data.task, variant: d.data.variant, run: d.data.run, round: d.data.round ?? null, score: d.data.score ?? null }));

  const byRun = new Map();
  const entry = (id, t, v) => {
    if (!byRun.has(id)) byRun.set(id, { run: id, task: t, variant: v, local: null, approved: null, rejected: null, draft: null });
    return byRun.get(id);
  };
  for (const r of runs) entry(r.id, r.task, r.variant).local = r;
  for (const a of approved) {
    const e = entry(a.run, a.task, a.variant);
    if (!e.approved || a.version > e.approved.version) e.approved = a;
  }
  for (const r of rejected) entry(r.run, r.task, r.variant).rejected = r;
  for (const d of drafts) entry(d.run, d.task, d.variant).draft = d;

  const groups = new Map();
  for (const e of byRun.values()) {
    if (task && e.task !== task) continue;
    if (variant && e.variant !== variant) continue;
    const key = `${e.task ?? '?'}\0${e.variant ?? '?'}`;
    if (!groups.has(key)) groups.set(key, { task: e.task, variant: e.variant, runs: [] });
    groups.get(key).runs.push(e);
  }

  return [...groups.values()]
    .sort((a, b) => cmp(a.task ?? '', b.task ?? '') || cmp(a.variant ?? '', b.variant ?? ''))
    .map((g) => {
      const versions = approved
        .filter((a) => a.task === g.task && a.variant === g.variant)
        .sort((a, b) => cmp(a.consumer, b.consumer) || a.version - b.version)
        .map((a) => ({ consumer: a.consumer, version: a.version, score: a.score, run: a.run, round: a.round, approved: localDay(a.approved_at), current: a.current, stale: a.stale }));
      return {
        task: g.task,
        variant: g.variant,
        consumers: [...new Set(versions.map((v) => v.consumer))],
        runs: g.runs.sort((a, b) => cmp(a.run, b.run)).map(runLine),
        approved: versions,
      };
    });
}

function runLine(e) {
  const l = e.local;
  const rounds = l ? l.rounds : null;
  const scored = (rounds ?? []).filter((r) => r.score !== null);
  // The best round as finalize picks it is in final.json; otherwise the highest score so far.
  const finalRound = l?.final?.round;
  let best = null;
  if (scored.length) {
    const pick = scored.find((r) => r.round === finalRound) ?? scored.reduce((b, r) => (r.score > b.score ? r : b));
    best = { round: pick.round, score: pick.score, pass: pick.pass };
  } else {
    const known = e.approved ?? e.rejected ?? e.draft;
    if (known && known.score !== null) best = { round: known.round, score: known.score, pass: null };
  }
  let outcome;
  if (e.approved) outcome = { kind: e.approved.current ? 'approved' : 'superseded', version: e.approved.version, reason: null };
  else if (e.rejected) outcome = { kind: 'rejected', version: null, reason: e.rejected.reason };
  else if (e.draft) outcome = { kind: 'draft', version: null, reason: null };
  else if (l?.error) outcome = { kind: 'broken', version: null, reason: l.error };
  else if (l?.final) outcome = { kind: 'finalized', version: null, reason: null };
  else if (l?.verdict === 'STOP') outcome = { kind: 'stopped', version: null, reason: null };
  else outcome = { kind: 'in-progress', version: null, reason: null };
  return {
    run: e.run,
    date: runDate(e.run),
    local: Boolean(l),
    rounds,
    best,
    verdict: l?.verdict ?? null,
    reason: l?.reason ?? null,
    outcome,
  };
}

const OUTCOME = {
  approved: (o) => `approved v${o.version} (current)`,
  superseded: (o) => `approved v${o.version} (superseded)`,
  rejected: (o) => `rejected${o.reason ? `: "${o.reason}"` : ''}`,
  draft: () => 'draft waiting for review',
  finalized: () => 'finalized; its draft was replaced by a later run',
  stopped: () => 'stopped, not finalized',
  'in-progress': () => 'in progress',
  broken: (o) => `run folder unreadable (${o.reason})`,
};

/** The text report, as lines. */
export function formatHistory(groups) {
  const out = [];
  for (const g of groups) {
    if (out.length) out.push('');
    out.push(`${g.task} / ${g.variant}${g.consumers.length ? ` (${g.consumers.join(', ')})` : ''}`);
    for (const r of g.runs) {
      const rounds = r.rounds
        ? r.rounds.length
          ? `rounds ${r.rounds.map((x) => (x.score === null ? '-' : String(x.score))).join(' → ')}`
          : 'no rounds yet'
        : 'run folder not here';
      const best = r.best ? `best ${r.best.score}${r.best.pass === null ? '' : r.best.pass ? ' PASS' : ' FAIL'}${r.best.round !== null ? ` (round ${r.best.round})` : ''}` : null;
      const stop = r.verdict === 'STOP' ? `STOP ${r.reason}` : null;
      out.push(`  ${r.date ?? '????-??-?? ??:??'}  ${r.run}`);
      out.push(`      ${[rounds, best, stop].filter(Boolean).join(', ')} → ${OUTCOME[r.outcome.kind](r.outcome)}`);
    }
    if (g.approved.length) {
      const multi = g.consumers.length > 1;
      const versions = g.approved.map(
        (v) => `${multi ? `${v.consumer} ` : ''}v${v.version} ${v.score ?? '?'}${v.approved ? ` (${v.approved}${v.current ? ', current' : ''}${v.stale ? ', stale' : ''})` : ''}`,
      );
      out.push(`  approved: ${versions.join(' → ')}`);
    }
  }
  return out;
}

export const historyCommand = command('history', USAGE, async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  const { flags, positional, problems } = parseArgs(args, { flags: ['json'] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length > 2) throw new BeakError('give at most a task and a variant', 2);
  const [task, variant] = positional;
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const groups = buildHistory(config, { task, variant });
  if (flags.json) {
    io.out.write(`${JSON.stringify({ groups }, null, 2)}\n`);
    return 0;
  }
  if (!groups.length) {
    const what = task ? `${task}${variant ? ` / ${variant}` : ''}` : 'any task';
    io.out.write(`no history for ${what}: no runs (runs/ is local), drafts or approved prompts\n`);
    return 0;
  }
  for (const line of formatHistory(groups)) io.out.write(`${line}\n`);
  const runs = groups.reduce((n, g) => n + g.runs.length, 0);
  io.out.write(`\n${plural(groups.length, 'variant')}, ${plural(runs, 'run')}\n`);
  return 0;
});
