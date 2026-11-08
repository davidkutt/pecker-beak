// `beak review [draft]` and `beak status` (plan.md §5, §9). Reports only; they never change a file.
// Their output follows the writer-view rules: holdout inputs show pass or fail, nothing more.
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { approvedPrompts } from './out.mjs';
import { BATCHES_DIR, BATCH_FILE, counts } from './batch.mjs';
import { compareSources, describeStale, refreshHint, staleList } from './stale.mjs';
import { unifiedDiff } from './diff.mjs';
import { draftChecks, draftRun, editedAfterLoop, findDraft, listDrafts } from './drafts.mjs';
import { loadLibrary } from './library.mjs';
import { FINAL_FILE, formatRounds, loopStatus } from './loop.mjs';
import { RUN_FILES, RUN_ID_RE, loadRun, outputPath } from './run.mjs';
import { BeakError, command, fenced, plural, readDoc, readJson, relPath } from './util.mjs';

const RECENT_RUNS = 10;

function draftLine(d) {
  const s = d.data;
  const edited = editedAfterLoop(d) ? ', edited after the loop' : '';
  return `${d.rel}  score ${s.score ?? '?'} ${s.pass ? 'PASS' : 'FAIL'}, stop ${s.stop ?? '?'}, run ${s.run}${edited}`;
}

/** Other versions of the blocks a draft was made from: [{ ref, used, now }] (now: null when the block is gone). */
export function staleSources(library, sources = []) {
  return compareSources(library, sources)
    .filter((c) => c.state === 'changed' || c.state === 'missing')
    .map(({ ref, used, now }) => ({ ref, used, now }));
}

/** The review report for one draft, as lines. */
export function reviewReport({ config, draft }) {
  const d = draft.data;
  const run = draftRun(config, draft);
  const library = loadLibrary(config.dirs.library, { root: config.root });
  const out = [`# Review: ${d.task} / ${d.variant}`, ''];
  out.push(`- draft: ${draft.rel} (status: ${d.status})`);
  out.push(`- consumer: ${d.consumer}; language: ${d.language ?? 'not set'}; runtime variables: ${(d.runtime_vars ?? []).map((v) => `{{${v}}}`).join(', ') || 'none'}`);
  out.push(`- run ${d.run}, round ${d.round}: score ${d.score}, ${d.pass ? 'PASS' : 'FAIL'}, stop: ${d.stop}`);
  out.push(`- sources: ${(d.sources ?? []).join(', ')}`);

  const edited = editedAfterLoop(draft);
  const checks = draftChecks(draft, run);
  const failed = checks.filter((r) => !r.pass);
  out.push(`- edited after the loop: ${edited ? 'yes' : 'no'}${edited || failed.length ? `; prompt hard checks now: ${failed.length ? `${failed.length} FAIL` : `all ${checks.length} pass`}` : ''}`);
  for (const r of failed) out.push(`  - FAIL ${r.check}${r.value !== null ? ` "${r.value}"` : ''}: ${r.detail}`);
  if (d.library_changed) out.push('- warning: the library changed during the run');
  const stale = staleSources(library, d.sources);
  if (stale.length) out.push(`- newer blocks since the run: ${stale.map((s) => `${s.ref} v${s.used} → ${s.now === null ? 'gone' : `v${s.now}`}`).join(', ')} (compose again to use them)`);

  if (!run) {
    out.push('', `The run folder runs/${d.run}/ is not here (runs/ is not committed), so there is no scorecard to show.`);
  } else {
    const status = loopStatus(run);
    out.push('', '## Rounds', '', ...formatRounds(status.states).map((l) => `    ${l}`));
    const sc = status.states.find((s) => s.round === d.round)?.scorecard;
    if (sc) {
      out.push('', `## Still failing in round ${d.round}`, '');
      if (!sc.failing_criteria.length && !sc.failing_checks.length) out.push('Nothing: every check and criterion passed.');
      for (const c of sc.failing_criteria) {
        const where = [...c.failed_inputs, ...(c.holdout_failures ? [plural(c.holdout_failures, 'holdout input')] : [])].join(', ');
        out.push(`- ${c.id}${c.must ? ' [must]' : ''} ${c.hidden ? '(a criterion for a holdout input)' : c.text} (${c.sources.join(', ')}): failed on ${where}`);
        for (const f of c.fixes) out.push(`  - judge's fix for ${f.input}: ${f.fix}`);
      }
      for (const r of sc.failing_checks.filter((x) => !x.holdout)) out.push(`- hard check on ${r.where}: ${r.check}${r.value !== null ? ` ${r.value}` : ''} (${r.detail})`);
      const hidden = sc.failing_checks.filter((x) => x.holdout).length;
      if (hidden) out.push(`- ${plural(hidden, 'hard check')} failed on holdout inputs`);
      if (sc.judge_top_issues?.length) {
        out.push('', "## Judge's top issues", '');
        for (const t of sc.judge_top_issues) out.push(`- ${t}`);
      }
    }
    const visible = run.inputs.find((i) => !i.holdout);
    const sample = visible ? outputPath(run.dir, d.round, visible) : null;
    if (sample && fs.existsSync(sample)) {
      out.push('', `## Sample output (${visible.id}, round ${d.round})`, '', fenced(fs.readFileSync(sample, 'utf8')));
    }
  }

  const task = library.byType.task.get(d.task);
  const goldenRel = task?.frontmatter?.golden;
  out.push('', '## Diff against the golden prompt', '');
  if (!goldenRel) out.push(`No golden prompt for task ${d.task} yet (approve with --golden to set one).`);
  else if (!fs.existsSync(path.resolve(config.root, goldenRel))) out.push(`The golden prompt ${goldenRel} is missing.`);
  else {
    const goldenText = fs.readFileSync(path.resolve(config.root, goldenRel), 'utf8');
    const golden = readDoc(goldenText)?.body ?? goldenText.trim();
    const diff = unifiedDiff(golden, draft.body, { from: goldenRel, to: draft.rel });
    out.push(diff ? fenced(diff, 'diff') : 'Identical to the golden prompt.');
  }
  return out;
}

export const reviewCommand = command('review', 'Usage: beak review [draft]', async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  if (args.length > 1 || args.some((a) => a.startsWith('-'))) throw new BeakError('give at most one draft', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  let draft;
  if (args.length) draft = findDraft(config, args[0], cwd);
  else {
    const drafts = listDrafts(config);
    if (!drafts.length) {
      io.out.write('no drafts waiting for review\n');
      return 0;
    }
    if (drafts.length > 1) {
      io.out.write('drafts waiting for review (name one: beak review <draft>):\n');
      for (const d of drafts) io.out.write(`  ${draftLine(d)}\n`);
      return 0;
    }
    draft = findDraft(config, drafts[0].file, cwd);
  }
  for (const line of reviewReport({ config, draft })) io.out.write(`${line}\n`);
  return 0;
});

// ---------------------------------------------------------------------------------------------------------
// status

/** Recent runs, newest first: [{ id, rounds, best, verdict, final }]. */
export function recentRuns(config, limit = RECENT_RUNS) {
  if (!fs.existsSync(config.dirs.runs)) return [];
  const ids = fs
    .readdirSync(config.dirs.runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name) && fs.existsSync(path.join(config.dirs.runs, e.name, RUN_FILES.meta)))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, limit);
  return ids.map((id) => {
    try {
      const run = loadRun(config, id);
      const status = loopStatus(run);
      const scored = status.states.filter((s) => s.scorecard);
      const best = scored.reduce((b, s) => (!b || s.scorecard.score > b.scorecard.score ? s : b), null);
      const finalFile = path.join(run.dir, FINAL_FILE);
      return { id, rounds: status.states.length, best, status, final: fs.existsSync(finalFile) ? readJson(finalFile) : null };
    } catch (err) {
      return { id, error: err.message };
    }
  });
}

export const statusCommand = command('status', 'Usage: beak status', async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  if (args.length) throw new BeakError('takes no arguments', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const drafts = listDrafts(config);
  io.out.write(`Drafts waiting for review (${drafts.length}):\n`);
  for (const d of drafts) io.out.write(`  ${draftLine(d)}\n`);
  if (!drafts.length) io.out.write('  none\n');

  const runs = recentRuns(config);
  io.out.write(`\nRecent runs (${runs.length}):\n`);
  for (const r of runs) {
    if (r.error) {
      io.out.write(`  ${r.id}  broken: ${r.error}\n`);
      continue;
    }
    const best = r.best ? `best ${r.best.scorecard.score} ${r.best.scorecard.pass ? 'PASS' : 'FAIL'} (round ${r.best.round})` : 'no scored round';
    const state = r.status.verdict === 'STOP' ? `STOP ${r.status.reason}` : 'in progress';
    const final = r.final ? `, finalized as ${r.final.draft} (round ${r.final.round})` : r.status.verdict === 'STOP' ? ', not finalized' : '';
    io.out.write(`  ${r.id}  ${plural(r.rounds, 'round')}, ${best}, ${state}${final}\n`);
  }
  if (!runs.length) io.out.write('  none\n');

  const batchRoot = path.join(config.dirs.runs, BATCHES_DIR);
  const batches = fs.existsSync(batchRoot) ? fs.readdirSync(batchRoot).filter((id) => fs.existsSync(path.join(batchRoot, id, BATCH_FILE))).sort().reverse() : [];
  if (batches.length) {
    io.out.write(`\nBatches (${batches.length}):\n`);
    for (const id of batches) {
      try {
        const batch = readJson(path.join(batchRoot, id, BATCH_FILE));
        const c = counts(batch);
        const open = c.pending + c.running;
        io.out.write(`  ${id}  ${batch.items.length} items: ${c.done} done (${c.pass} PASS, ${c.fail} FAIL), ${c.failed} failed, ${open} open${open ? '' : `; review: beak batch review ${id}`}\n`);
      } catch (err) {
        io.out.write(`  ${id}  broken: ${err.message}\n`);
      }
    }
  }

  io.out.write('\nApproved prompts:\n');
  let any = false;
  let unmarked = 0;
  const library = loadLibrary(config.dirs.library, { root: config.root });
  for (const consumer of config.consumers) {
    const prompts = approvedPrompts(config, consumer);
    if (!prompts.length) continue;
    any = true;
    io.out.write(`  ${consumer}: ${plural(prompts.length, 'prompt')} (${relPath(config.root, path.join(config.dirs.out, consumer, 'index.json'))})\n`);
    for (const p of prompts) {
      const stale = staleList(library, p.data.sources);
      if (JSON.stringify(stale) !== JSON.stringify(p.data.stale ?? [])) unmarked++;
      io.out.write(`    ${p.path} v${p.data.version}${stale.length ? `  STALE (${describeStale(stale)}); refresh: ${refreshHint(p.data)}` : ''}\n`);
    }
  }
  if (!any) io.out.write('  none\n');
  if (unmarked) io.out.write(`  (${plural(unmarked, 'stale mark')} out of date: run beak stale to update the files and index.json)\n`);
  return 0;
});
