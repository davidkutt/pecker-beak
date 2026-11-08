// Batch mode (M9, plan.md §15): one approved golden prompt × a list of customers, industries, scenarios or tones.
// Scripts keep the queue (runs/batches/<id>/batch.json); the Ralph extension (@lnilluv/pi-ralph-loop) drives the
// iterations from the generated runs/batches/<id>/RALPH.md; each item runs the normal quality loop. Drafts go to
// drafts/batch-<id>/. Approval stays human: a sample is reviewed first, then the rest can be approved in one commit.
//
//   beak batch create task=<id> <key>=@<file>|<a,b,…> [key=value…] [sample=0.1]
//   beak batch next <batch>     start (or resume) the next item: bundles its run
//   beak batch done <batch>     the running item's loop stopped: finalize it into drafts/batch-<id>/, tick it off
//   beak batch status <batch>   the queue
//   beak batch gate <batch>     exit 0 only when no item is pending or running (Ralph's acceptance command)
//   beak batch review <batch>   the sample to review by hand, and what bulk approval would take
//   beak batch approve <batch> [--check]   approve the rest, once every sampled draft was approved
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { approveDraft, gitCommit } from './approve.mjs';
import { BUNDLE_KEYS, planBundle, writeRun } from './bundle.mjs';
import { SLUG_RE, findRoot, loadConfig } from './config.mjs';
import { REJECTED_DIR, findDraft } from './drafts.mjs';
import { setFrontmatterFields } from './intake.mjs';
import { loadLibrary } from './library.mjs';
import { FINAL_FILE, finalizeRun, loopStatus } from './loop.mjs';
import { ARCHIVE_DIR } from './out.mjs';
import { loadRun } from './run.mjs';
import { BeakError, cmp, command, localStamp, parseArgs, plural, readDoc, readJson, relPath, writeJson, writeText } from './util.mjs';

export const BATCHES_DIR = 'batches'; // under runs/
export const BATCH_FILE = 'batch.json';
export const TEMPLATE = 'loops/batch/RALPH.md';
export const LIST_KEYS = Object.freeze(['customer', 'industry', 'scenario', 'tone']);
export const DEFAULT_SAMPLE = 0.1;
export const RALPH_MAX_ITERATIONS = 50; // Ralph's own cap (max_iterations 1–50, verified in its source)
const ITERATION_TARGET = 40; // plan for 40 iterations, keep the rest for retries
const MAX_PER_ITERATION = 3; // a Ralph iteration times out after at most 3600 s
const BATCH_ID_RE = /^\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const USAGE = [
  'Usage: beak batch create task=<id> <key>=@<file>|<a,b,…> [key=value…] [sample=0.1]',
  '       beak batch next|done|status|gate|review <batch>',
  '       beak batch approve <batch> [--check]',
].join('\n');

export function batchDir(config, id) {
  return path.join(config.dirs.runs, BATCHES_DIR, id);
}

/** How many items a Ralph iteration handles, and how many iterations to allow. */
export function pacing(n) {
  const itemsPerIteration = Math.max(1, Math.ceil(n / ITERATION_TARGET));
  return { itemsPerIteration, maxIterations: Math.min(RALPH_MAX_ITERATIONS, Math.ceil(n / itemsPerIteration) + 10) };
}

// ---------------------------------------------------------------------------------------------------------
// create

/** "@lists/x.txt" (one id per line, # comments) or "a,b,c" → ids, in order, without duplicates. */
export function readList(source, cwd) {
  let raw;
  if (source.startsWith('@')) {
    const file = path.resolve(cwd, source.slice(1));
    if (!fs.existsSync(file)) throw new BeakError(`list file ${source.slice(1)} not found`, 2);
    raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  } else {
    raw = source.split(',').map((s) => s.trim());
  }
  const ids = [...new Set(raw.filter(Boolean))];
  const bad = ids.filter((id) => !SLUG_RE.test(id));
  if (bad.length) throw new BeakError(`not block ids: ${bad.map((b) => `"${b}"`).join(', ')} (lowercase letters, digits, hyphens)`, 2);
  if (!ids.length) throw new BeakError('the list is empty', 2);
  return ids;
}

/** Split the create arguments: the one list key (value @file or a,b,…), the fixed bundle arguments, the sample rate. */
export function parseCreateArgs(args) {
  const { values, positional, problems } = parseArgs(args, { keys: [...BUNDLE_KEYS, 'sample'] });
  if (positional.length) problems.push(`unexpected argument "${positional[0]}": use key=value`);
  if (!values.task) problems.push('task= is required');
  // context= takes a comma list of its own; every other comma or @file value is the batch's list.
  const lists = Object.keys(values).filter((k) => k !== 'context' && k !== 'sample' && /^@|,/.test(values[k]));
  const listKey = lists[0];
  if (lists.length > 1) problems.push(`only one key can be a list (got ${lists.join(', ')})`);
  else if (!listKey) problems.push('name the list, e.g. industry=@lists/industries.txt or industry=pharma,saas');
  else if (!LIST_KEYS.includes(listKey)) problems.push(`${listKey}= cannot be a list (lists: ${LIST_KEYS.join(', ')})`);
  let sample = DEFAULT_SAMPLE;
  if (values.sample !== undefined) {
    sample = Number(values.sample);
    if (!(sample > 0 && sample <= 1)) problems.push(`sample must be a share between 0 and 1, e.g. sample=0.1 (got ${values.sample})`);
  }
  const fixed = Object.fromEntries(Object.entries(values).filter(([k]) => k !== listKey && k !== 'sample'));
  return { fixed, listKey, listSource: listKey ? values[listKey] : null, sample, problems };
}

/**
 * Check a batch before anything is written: the task's golden prompt is approved, and every item bundles.
 * Returns { problems, warnings, golden, items: [{ value, variant }] }.
 */
export function planBatch({ config, library, fixed, listKey, ids }) {
  const problems = [];
  const warnings = [];
  const task = library.byType.task.get(fixed.task);
  if (!task) return { problems: [`task "${fixed.task}" not found`], warnings, golden: null, items: [] };
  let golden = null;
  const goldenRel = task.frontmatter?.golden;
  const goldenFile = goldenRel ? path.resolve(config.root, goldenRel) : null;
  const goldenDoc = goldenFile && fs.existsSync(goldenFile) ? readDoc(fs.readFileSync(goldenFile, 'utf8')) : null;
  if (!goldenRel) problems.push(`task ${task.id} has no golden prompt: batch mode starts from an approved one (approve a draft of ${task.id} with --golden first)`);
  else if (goldenDoc?.data.status !== 'approved') problems.push(`the golden prompt ${goldenRel} is missing or not approved`);
  else golden = { file: goldenRel, version: goldenDoc.data.version ?? null };

  const perIteration = pacing(ids.length).itemsPerIteration;
  if (perIteration > MAX_PER_ITERATION) {
    problems.push(`${ids.length} items are too many for one batch (at most ${MAX_PER_ITERATION * ITERATION_TARGET}); split the list`);
  }

  const items = [];
  const variants = new Map();
  for (const value of ids) {
    const plan = planBundle({ config, library, values: { ...fixed, [listKey]: value } });
    for (const p of plan.problems) problems.push(`${listKey}=${value}: ${p}`);
    if (!plan.problems.length) {
      if (variants.has(plan.variant)) problems.push(`${listKey}=${value}: variant ${plan.variant} is already made by ${listKey}=${variants.get(plan.variant)}`);
      variants.set(plan.variant, value);
      items.push({ value, variant: plan.variant });
    }
  }
  return { problems, warnings, golden, items };
}

/** The per-batch RALPH.md: the template with the batch id and the pacing filled in. */
export function renderRalph(template, { id, itemsPerIteration, maxIterations }) {
  const stamped = setFrontmatterFields(template.replaceAll('{{ beak.batch }}', id), [
    ['max_iterations', String(maxIterations)],
    ['items_per_iteration', String(itemsPerIteration)],
  ]);
  if (!stamped) throw new BeakError(`${TEMPLATE}: frontmatter could not be read`);
  return stamped.text;
}

export const OPEN_QUESTIONS = `# Open questions

Blockers this batch cannot solve on its own, one "- " line each. Ralph does not finish the batch while a line
is listed under P0 or P1; a person resolves it (or ticks it off as "- [x] …") and resumes the batch.

## P0

## P1

## Notes
`;

export function createBatch({ config, library, fixed, listKey, ids, sample, now = new Date() }) {
  const planned = planBatch({ config, library, fixed, listKey, ids });
  if (planned.problems.length) throw new BeakError(`no batch created:\n${planned.problems.map((p) => `  ${p}`).join('\n')}`);
  const templateFile = path.join(config.root, TEMPLATE);
  if (!fs.existsSync(templateFile)) throw new BeakError(`${TEMPLATE} is missing`);
  const base = `${localStamp(now)}-${fixed.task}-by-${listKey}`;
  let id = base;
  for (let n = 2; fs.existsSync(batchDir(config, id)); n++) id = `${base}-${n}`;
  const dir = batchDir(config, id);
  const pace = pacing(planned.items.length);
  const batch = {
    batch: id,
    task: fixed.task,
    golden: planned.golden.file,
    golden_version: planned.golden.version,
    key: listKey,
    fixed: Object.fromEntries(Object.entries(fixed).filter(([k]) => k !== 'task')),
    sample_rate: sample,
    sample: null,
    items: planned.items.map(({ value, variant }) => ({ value, variant, status: 'pending', run: null, round: null, score: null, pass: null, stop: null, draft: null, note: null })),
  };
  writeJson(path.join(dir, BATCH_FILE), batch);
  writeText(path.join(dir, 'RALPH.md'), renderRalph(fs.readFileSync(templateFile, 'utf8'), { id, ...pace }));
  writeText(path.join(dir, 'OPEN_QUESTIONS.md'), OPEN_QUESTIONS);
  return { id, dir, batch, pace, warnings: planned.warnings };
}

// ---------------------------------------------------------------------------------------------------------
// the queue

export function loadBatch(config, arg) {
  const id = arg && path.basename(arg.replace(/[\\/]+$/, ''));
  if (!id || !BATCH_ID_RE.test(id)) throw new BeakError('give the batch id (beak batch create printed it)', 2);
  const file = path.join(batchDir(config, id), BATCH_FILE);
  if (!fs.existsSync(file)) throw new BeakError(`no batch "${id}" (looked for ${relPath(config.root, file)})`);
  return { file, batch: readJson(file) };
}

function saveBatch(file, batch) {
  writeJson(file, batch);
}

const position = (batch, item) => `item ${batch.items.indexOf(item) + 1}/${batch.items.length}`;
const label = (batch, item) => `${batch.key}=${item.value}`;

/** Start the next pending item (bundle its run), or report the running one. Returns { kind, item, run, next }. */
export function nextItem({ config, file, batch, now = new Date() }) {
  const running = batch.items.find((i) => i.status === 'running');
  if (running) {
    const run = loadRun(config, running.run);
    const status = loopStatus(run);
    const next = status.verdict === 'STOP' ? `node tools/beak.mjs batch done ${batch.batch}` : status.next;
    return { kind: 'running', item: running, run: running.run, next };
  }
  const library = loadLibrary(config.dirs.library, { root: config.root });
  for (const item of batch.items.filter((i) => i.status === 'pending')) {
    const values = { task: batch.task, ...batch.fixed, [batch.key]: item.value };
    const plan = planBundle({ config, library, values });
    if (plan.problems.length) {
      Object.assign(item, { status: 'failed', note: `could not bundle: ${plan.problems.join('; ')}` });
      saveBatch(file, batch);
      continue;
    }
    const { id: runId } = writeRun({ config, library, plan, now, batch: batch.batch });
    Object.assign(item, { status: 'running', run: runId, variant: plan.variant });
    saveBatch(file, batch);
    const dir = `${relPath(config.root, config.dirs.runs)}/${runId}`;
    const next =
      `read ${dir}/bundle.md (keep the golden prompt's structure, swap the content), write ${dir}/round-0/prompt.md and ${dir}/round-0/changes.md, ` +
      `then node tools/beak.mjs test ${runId} 0 and follow the quality loop; on STOP run node tools/beak.mjs batch done ${batch.batch}`;
    return { kind: 'started', item, run: runId, next };
  }
  return { kind: 'empty', item: null, run: null, next: `node tools/beak.mjs batch gate ${batch.batch}` };
}

/** The running item's loop stopped: finalize its best round into drafts/batch-<id>/ and tick it off. */
export function doneItem({ config, file, batch }) {
  const item = batch.items.find((i) => i.status === 'running');
  if (!item) throw new BeakError(`no item of batch ${batch.batch} is running; start one with beak batch next ${batch.batch}`);
  const run = loadRun(config, item.run);
  const status = loopStatus(run);
  if (status.verdict !== 'STOP') throw new BeakError(`the loop of ${item.run} has not stopped; next: ${status.next}`);
  const finalFile = path.join(run.dir, FINAL_FILE);
  if (!fs.existsSync(finalFile)) {
    try {
      finalizeRun({ config, run });
    } catch (err) {
      if (!(err instanceof BeakError)) throw err;
      Object.assign(item, { status: 'failed', stop: status.reason, note: err.message });
      saveBatch(file, batch);
      return item;
    }
  }
  const final = readJson(finalFile);
  const scorecard = status.states.find((s) => s.round === final.round)?.scorecard ?? null;
  Object.assign(item, {
    status: 'done',
    round: final.round,
    score: scorecard?.score ?? null,
    pass: scorecard?.pass ?? null,
    stop: final.stop,
    draft: final.draft,
  });
  saveBatch(file, batch);
  return item;
}

export function counts(batch) {
  const c = { pending: 0, running: 0, done: 0, failed: 0, pass: 0, fail: 0 };
  for (const i of batch.items) {
    c[i.status]++;
    if (i.status === 'done') c[i.pass ? 'pass' : 'fail']++;
  }
  return c;
}

export function gate(batch) {
  const c = counts(batch);
  const finished = c.done + c.failed;
  if (!c.pending && !c.running) return { pass: true, line: `complete: ${finished} of ${batch.items.length} items finished (${c.pass} PASS, ${c.fail} FAIL, ${c.failed} without a draft)` };
  return { pass: false, line: `not complete: ${c.pending} pending, ${c.running} running, ${finished} of ${batch.items.length} finished` };
}

export function statusLines(config, batch) {
  const rows = [['#', batch.key, 'variant', 'status', 'result']];
  batch.items.forEach((i, n) => {
    let result = '';
    if (i.status === 'done') result = `${i.score} ${i.pass ? 'PASS' : 'FAIL'} → ${i.draft}`;
    else if (i.status === 'running') result = `run ${i.run}`;
    else if (i.status === 'failed') result = i.note ?? '';
    rows.push([String(n + 1), i.value, i.variant ?? '', i.status, result]);
  });
  const widths = rows[0].map((_, k) => Math.max(...rows.map((r) => r[k].length)));
  const c = counts(batch);
  return [
    `batch ${batch.batch}: task ${batch.task} by ${batch.key}, golden ${batch.golden}${batch.golden_version ? ` (v${batch.golden_version})` : ''}`,
    ...rows.map((r) => `  ${r.map((v, k) => (k === r.length - 1 ? v : v.padEnd(widths[k]))).join('  ')}`.trimEnd()),
    `${plural(batch.items.length, 'item')}: ${c.done} done (${c.pass} PASS, ${c.fail} FAIL), ${c.failed} failed, ${c.running} running, ${c.pending} pending`,
  ];
}

// ---------------------------------------------------------------------------------------------------------
// review and bulk approval (human only)

/** Where an item's draft is now: 'waiting' (in drafts/), 'approved' (in out/), 'rejected', or 'none'. */
export function draftState(config, item) {
  if (!item.draft || !item.run) return 'none';
  const draft = path.join(config.root, item.draft);
  if (fs.existsSync(draft) && readDoc(fs.readFileSync(draft, 'utf8'))?.data.run === item.run) return 'waiting';
  const rejectedDir = path.join(config.dirs.drafts, REJECTED_DIR);
  if (fs.existsSync(rejectedDir)) {
    for (const f of fs.readdirSync(rejectedDir).filter((n) => n.endsWith('.md'))) {
      if (readDoc(fs.readFileSync(path.join(rejectedDir, f), 'utf8'))?.data.run === item.run) return 'rejected';
    }
  }
  for (const consumer of config.consumers) {
    const root = path.join(config.dirs.out, consumer);
    if (!fs.existsSync(root)) continue;
    for (const task of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const dir of [path.join(root, task.name), path.join(root, task.name, ARCHIVE_DIR)].filter((d) => fs.existsSync(d))) {
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
          if (readDoc(fs.readFileSync(path.join(dir, f), 'utf8'))?.data.run === item.run) return 'approved';
        }
      }
    }
  }
  return 'none';
}

/**
 * Pick the sample once (deterministic: the PASS drafts ordered by a hash of batch id and variant, the first
 * ceil(rate × n), at least one) and classify every item. Returns { sample, fails, rest, failed, changed }.
 */
export function reviewPlan({ config, batch }) {
  const pass = batch.items.filter((i) => i.status === 'done' && i.pass && i.draft);
  let changed = false;
  if (!batch.sample && pass.length && !batch.items.some((i) => i.status === 'pending' || i.status === 'running')) {
    const n = Math.max(1, Math.ceil(batch.sample_rate * pass.length));
    const hash = (i) => crypto.createHash('sha256').update(`${batch.batch}/${i.variant}`).digest('hex');
    batch.sample = [...pass].sort((a, b) => cmp(hash(a), hash(b))).slice(0, n).map((i) => i.variant);
    changed = true;
  }
  const inSample = (i) => (batch.sample ?? []).includes(i.variant);
  const withState = (i) => ({ item: i, state: draftState(config, i) });
  return {
    sample: pass.filter(inSample).map(withState),
    fails: batch.items.filter((i) => i.status === 'done' && !i.pass && i.draft).map(withState),
    rest: pass.filter((i) => !inSample(i)).map(withState),
    failed: batch.items.filter((i) => i.status === 'failed'),
    changed,
  };
}

/** Approve the PASS drafts outside the sample, in one commit, once every sampled draft was approved by hand. */
export function bulkApprove({ config, batch, check = false, now = new Date() }) {
  const c = counts(batch);
  if (c.pending || c.running) throw new BeakError(`the batch is not finished (${c.pending} pending, ${c.running} running)`);
  if (!batch.sample) throw new BeakError(`no sample chosen yet: run beak batch review ${batch.batch} and review the sample first`);
  const plan = reviewPlan({ config, batch });
  const rejected = plan.sample.filter((s) => s.state === 'rejected');
  if (rejected.length) {
    throw new BeakError(
      `a sampled draft was rejected (${rejected.map((s) => s.item.variant).join(', ')}): review every draft of this batch individually; bulk approval is off for it`,
    );
  }
  const open = plan.sample.filter((s) => s.state !== 'approved');
  if (open.length) throw new BeakError(`review and approve the sample first: ${open.map((s) => s.item.draft).join(', ')}`);
  const targets = plan.rest.filter((s) => s.state === 'waiting');
  const results = [];
  const paths = [];
  for (const { item } of targets) {
    if (check) {
      results.push({ item, ok: true, target: null });
      continue;
    }
    try {
      const r = approveDraft({ config, draft: findDraft(config, item.draft, config.root), now, commit: false });
      results.push({ item, ok: true, target: r.target, version: r.version });
      paths.push(...r.paths);
    } catch (err) {
      if (!(err instanceof BeakError)) throw err;
      results.push({ item, ok: false, error: err.message });
    }
  }
  const approved = results.filter((r) => r.ok && r.target).length;
  const message = `beak: approve batch ${batch.batch} (${plural(approved, 'prompt')})`;
  let commit = null;
  if (!check && approved && config.git.commit_on_approve) commit = gitCommit(config.root, [...new Set(paths)], message);
  return { results, fails: plan.fails, failed: plan.failed, commit, message };
}

// ---------------------------------------------------------------------------------------------------------
// CLI

export const batchCommand = command('batch', USAGE, async (args, io, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) => {
  const [sub, ...rest] = args;
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const out = (line = '') => io.out.write(`${line}\n`);
  const rel = (p) => relPath(config.root, p);

  if (sub === 'create') {
    const { fixed, listKey, listSource, sample, problems } = parseCreateArgs(rest);
    if (problems.length) throw new BeakError(problems[0], 2);
    const ids = readList(listSource, cwd);
    const library = loadLibrary(config.dirs.library, { root: config.root });
    const r = createBatch({ config, library, fixed, listKey, ids, sample, now });
    out(r.id);
    out(`created ${rel(r.dir)}/: ${BATCH_FILE} (${plural(r.batch.items.length, 'item')}), RALPH.md, OPEN_QUESTIONS.md`);
    out(`golden: ${r.batch.golden}${r.batch.golden_version ? ` (v${r.batch.golden_version})` : ''}`);
    out(`pacing: ${plural(r.pace.itemsPerIteration, 'item')} per Ralph iteration, at most ${r.pace.maxIterations} iterations`);
    for (const w of r.warnings) out(`warning: ${w}`);
    out(`next: in pi, run /ralph --path ${rel(r.dir)}`);
    return 0;
  }

  if (!['next', 'done', 'status', 'gate', 'review', 'approve'].includes(sub)) {
    throw new BeakError(sub ? `unknown subcommand "${sub}"` : 'name a subcommand', 2);
  }
  const { flags, positional, problems } = parseArgs(rest, { flags: sub === 'approve' ? ['check'] : [] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length !== 1) throw new BeakError('give the batch id', 2);
  const { file, batch } = loadBatch(config, positional[0]);

  if (sub === 'next') {
    const r = nextItem({ config, file, batch, now });
    for (const i of batch.items.filter((x) => x.status === 'failed' && x.note?.startsWith('could not bundle'))) out(`skipped ${position(batch, i)} (${label(batch, i)}): ${i.note}`);
    if (r.kind === 'empty') {
      out(`queue empty: ${gate(batch).line}`);
    } else {
      out(`${position(batch, r.item)}: ${label(batch, r.item)} → variant ${r.item.variant}${r.kind === 'running' ? ' (still running)' : ''}`);
      out(`run: ${r.run}`);
    }
    out(`next: ${r.next}`);
    return 0;
  }
  if (sub === 'done') {
    const item = doneItem({ config, file, batch });
    const left = batch.items.filter((i) => i.status === 'pending').length;
    if (item.status === 'failed') out(`${position(batch, item)} failed (${label(batch, item)}, stop ${item.stop}): ${item.note}`);
    else out(`${position(batch, item)} done (${label(batch, item)}): ${item.variant} score ${item.score} ${item.pass ? 'PASS' : 'FAIL'} (round ${item.round}, stop ${item.stop}) → ${item.draft}`);
    out(`${plural(left, 'item')} left`);
    out(`next: node tools/beak.mjs batch next ${batch.batch}`);
    return 0;
  }
  if (sub === 'status') {
    for (const line of statusLines(config, batch)) out(line);
    return 0;
  }
  if (sub === 'gate') {
    const g = gate(batch);
    out(g.line);
    return g.pass ? 0 : 1;
  }
  if (sub === 'review') {
    const plan = reviewPlan({ config, batch });
    if (plan.changed) saveBatch(file, batch);
    const c = counts(batch);
    if (c.pending || c.running) {
      out(`the batch is not finished yet (${c.pending} pending, ${c.running} running); the sample is chosen once it is`);
      return 0;
    }
    const line = (s) => `  ${s.item.draft}  score ${s.item.score}  ${s.state}`;
    out(`batch ${batch.batch}: ${c.done} drafts (${c.pass} PASS, ${c.fail} FAIL), ${c.failed} items without a draft`);
    out(`1. Review the sample yourself (${Math.round(batch.sample_rate * 100)}% of the PASS drafts): /review, then /approve or /reject each`);
    for (const s of plan.sample) out(line(s));
    if (!plan.sample.length) out('  none');
    out('2. Always review individually (FAIL, never bulk-approved):');
    for (const s of plan.fails) out(line(s));
    if (!plan.fails.length) out('  none');
    for (const i of plan.failed) out(`   no draft: ${label(batch, i)} (${i.note})`);
    const waiting = plan.rest.filter((s) => s.state === 'waiting').length;
    out(`3. Then: beak batch approve ${batch.batch} approves the other ${plural(waiting, 'PASS draft')} in one commit, if every sampled draft was approved (a rejected one turns bulk approval off)`);
    return 0;
  }
  // approve
  const check = Boolean(flags.check);
  const r = bulkApprove({ config, batch, check, now });
  for (const x of r.results) {
    if (!x.ok) out(`not approved: ${x.item.draft}: ${x.error}`);
    else if (check) out(`would approve ${x.item.draft}`);
    else out(`approved ${rel(x.target)} (version ${x.version})`);
  }
  if (!r.results.length) out('nothing to approve: no PASS draft outside the sample is waiting');
  for (const s of r.fails) out(`left for individual review (FAIL): ${s.item.draft} (${s.state})`);
  if (r.commit?.ok) out(`committed: ${r.message}`);
  else if (r.commit) out(`warning: not committed (${r.commit.reason}); commit out/ yourself`);
  if (check) out('check: ok, nothing written');
  return r.results.some((x) => !x.ok) ? 1 : 0;
});
