// Approve, reject and learn (plan.md §9, §10):
//   beak approve <draft> [--golden]   route to out/<consumer>/<task>/<variant>.md, archive, index.json, commit
//   beak reject <draft> --reason "…" [--block <id> --line "…" [--must]] [--check]
//   beak learn <block> --line "…" [--must] [--check]   a Done-when line from feedback (approve, /refine notes)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { REJECTED_DIR, draftChecks, draftRun, editedAfterLoop, findDraft } from './drafts.mjs';
import { applyEdit, planDoneWhen, planGolden, reloadLibrary } from './library-edit.mjs';
import { BeakError, cmp, command, localDate, parseArgs, plural, readDoc, relPath, writeDoc, writeJson, writeText } from './util.mjs';

export const ARCHIVE_DIR = '_archive';
export const INDEX_FILE = 'index.json';

// ---------------------------------------------------------------------------------------------------------
// out/<consumer>/

export function outPath(config, { consumer, task, variant }) {
  return path.join(config.dirs.out, consumer, task, `${variant}.md`);
}

/** Every approved prompt of a consumer (out/<consumer>/<task>/<variant>.md with status: approved), sorted. */
export function approvedPrompts(config, consumer) {
  const root = path.join(config.dirs.out, consumer);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const task of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))) {
    for (const f of fs.readdirSync(path.join(root, task.name)).filter((n) => n.endsWith('.md'))) {
      const file = path.join(root, task.name, f);
      const doc = readDoc(fs.readFileSync(file, 'utf8'));
      if (doc?.data.status === 'approved') out.push({ file, data: doc.data, path: `${task.name}/${f}` });
    }
  }
  return out.sort((a, b) => cmp(a.path, b.path));
}

/** out/<consumer>/index.json (plan §10). Paths are relative to out/<consumer>/. */
export function buildIndex(config, consumer) {
  return {
    consumer,
    prompts: approvedPrompts(config, consumer).map(({ data, path: p }) => ({
      task: data.task,
      variant: data.variant,
      version: data.version,
      language: data.language ?? null,
      runtime_vars: data.runtime_vars ?? [],
      approved_at: data.approved_at,
      path: p,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------
// git

/**
 * Commit exactly `paths` (added, changed or deleted) with `message`. Other changes in the work tree are left
 * alone. Returns { ok: true } or { ok: false, reason }.
 */
export function gitCommit(root, paths, message) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.error) return { ok: false, reason: 'git is not installed' };
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { ok: false, reason: `${root} is not a git repository` };
  const known = paths.filter((p) => fs.existsSync(path.join(root, p)) || git('ls-files', '--error-unmatch', '--', p).status === 0);
  if (!known.length) return { ok: false, reason: 'nothing to commit' };
  const add = git('add', '-A', '--', ...known);
  if (add.status !== 0) return { ok: false, reason: `git add failed: ${add.stderr.trim()}` };
  const commit = git('commit', '-q', '-m', message, '--', ...known);
  if (commit.status !== 0) return { ok: false, reason: `git commit failed: ${(commit.stderr || commit.stdout).trim()}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------
// approve

/**
 * Approve a draft. Returns a summary. Refuses (BeakError) when the draft is not waiting for review, its
 * consumer is unknown, or its prompt fails a hard check as it is now (out/ only gets prompts that pass them).
 */
export function approveDraft({ config, draft, golden = false, now = new Date() }) {
  const { data, body } = draft;
  if (data.status !== 'needs-review') throw new BeakError(`${draft.rel} has status "${data.status}", not needs-review`);
  if (!config.consumers.includes(data.consumer)) {
    throw new BeakError(`consumer "${data.consumer}" is not in beak.config.yaml (consumers: ${config.consumers.join(', ')})`);
  }
  const run = draftRun(config, draft);
  const edited = editedAfterLoop(draft);
  const failed = draftChecks(draft, run).filter((r) => !r.pass);
  if (failed.length) {
    const list = failed.map((r) => `  ${r.check}${r.value !== null ? ` "${r.value}"` : ''}: ${r.detail}`).join('\n');
    throw new BeakError(`the draft fails ${plural(failed.length, 'hard check')} on its prompt; fix ${draft.rel} and approve again:\n${list}`);
  }

  const today = localDate(now);
  const target = outPath(config, data);
  let version = 1;
  let archived = null;
  let previous = null;
  if (fs.existsSync(target)) {
    previous = readDoc(fs.readFileSync(target, 'utf8'));
    const v = previous?.data.version;
    if (!Number.isInteger(v) || v < 1) throw new BeakError(`${relPath(config.root, target)} has no valid version; fix it by hand first`);
    version = v + 1;
    archived = path.join(path.dirname(target), ARCHIVE_DIR, `${data.variant}.v${v}.md`);
    if (fs.existsSync(archived)) throw new BeakError(`${relPath(config.root, archived)} exists already; the archive never overwrites a version`);
  }

  const goldenRel = relPath(config.root, target);
  const goldenEdit = golden ? planGolden({ config, library: reloadLibrary(config), taskId: data.task, golden: goldenRel, today }) : null;

  // Everything is checked; write.
  if (archived) {
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, writeDoc({ ...previous.data, status: 'archived' }, previous.body));
  }
  const approved = {
    status: 'approved',
    task: data.task,
    variant: data.variant,
    consumer: data.consumer,
    version,
    approved_at: now.toISOString(),
    language: data.language ?? null,
    runtime_vars: data.runtime_vars ?? [],
    sources: data.sources ?? [],
    score: data.score ?? null,
    run: data.run,
    round: data.round ?? null,
    edited_after_loop: edited,
  };
  writeText(target, writeDoc(approved, body));
  const index = buildIndex(config, data.consumer);
  const indexFile = path.join(config.dirs.out, data.consumer, INDEX_FILE);
  writeJson(indexFile, index);
  if (goldenEdit) applyEdit(goldenEdit);
  fs.rmSync(draft.file);
  const taskDir = path.dirname(draft.file);
  if (!fs.readdirSync(taskDir).length) fs.rmdirSync(taskDir);

  const message = `beak: approve ${data.consumer}/${data.task}/${data.variant} v${version}`;
  let commit = null;
  if (config.git.commit_on_approve) {
    const paths = [target, archived, indexFile, draft.file, goldenEdit?.block.path].filter(Boolean).map((p) => relPath(config.root, p));
    commit = gitCommit(config.root, paths, message);
  }
  return { target, version, archived, indexFile, index, goldenEdit, edited, commit, message, run };
}

export const approveCommand = command('approve', 'Usage: beak approve <draft> [--golden]', async (args, io, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) => {
  const { flags, positional, problems } = parseArgs(args, { flags: ['golden'] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length !== 1) throw new BeakError('name one draft, e.g. drafts/cold-email/acme-pharma-formal-de.md', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const draft = findDraft(config, positional[0], cwd);
  const r = approveDraft({ config, draft, golden: Boolean(flags.golden), now });
  const rel = (p) => relPath(config.root, p);
  io.out.write(`approved ${rel(r.target)} (version ${r.version})\n`);
  if (r.archived) io.out.write(`archived version ${r.version - 1}: ${rel(r.archived)}\n`);
  io.out.write(`updated ${rel(r.indexFile)} (${plural(r.index.prompts.length, 'prompt')})\n`);
  if (r.edited) io.out.write('the draft was edited after the loop (edited_after_loop: true); its prompt checks pass\n');
  if (flags.golden) {
    io.out.write(
      r.goldenEdit
        ? `golden: ${rel(r.goldenEdit.block.path)} now points at it (version ${r.goldenEdit.previous} → ${r.goldenEdit.version})\n`
        : `golden: task ${draft.data.task} already points at it\n`,
    );
  }
  if (r.commit?.ok) io.out.write(`committed: ${r.message}\n`);
  else if (r.commit) io.out.write(`warning: not committed (${r.commit.reason}); commit the files above yourself\n`);
  const notes = r.run?.extra?.criteria ?? [];
  if (notes.length) {
    io.out.write('run-only criteria from /refine (offer to make them Done-when lines with beak learn):\n');
    for (const c of notes) io.out.write(`  ${c.id} [must] ${c.text}\n`);
  }
  io.out.write('next: ask the user "Did you change anything that should become a rule?"; turn each answer into a Done-when line with beak learn\n');
  return 0;
});

// ---------------------------------------------------------------------------------------------------------
// reject

/** A free path in drafts/_rejected/: <run>.md, then <run>-2.md, … */
export function rejectedPath(config, draft) {
  const dir = path.join(config.dirs.drafts, REJECTED_DIR);
  let file = path.join(dir, `${draft.data.run}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${draft.data.run}-${n}.md`);
  return file;
}

export function rejectDraft({ config, draft, reason, block, line, must = false, check = false, now = new Date() }) {
  if (draft.data.status !== 'needs-review') throw new BeakError(`${draft.rel} has status "${draft.data.status}", not needs-review`);
  const text = reason.trim();
  if (!text) throw new BeakError('give the reason with --reason "…"', 2);
  const today = localDate(now);
  const edit = block ? planDoneWhen({ config, library: reloadLibrary(config), ref: block, criterion: line, must, today }) : null;
  const target = rejectedPath(config, draft);
  if (!check) {
    const data = { ...draft.data, status: 'rejected', rejected_reason: text };
    if (edit) {
      data.rule_block = `${edit.block.type}/${edit.block.id}`;
      data.rule = edit.line;
    }
    writeText(target, writeDoc(data, draft.body));
    fs.rmSync(draft.file);
    const taskDir = path.dirname(draft.file);
    if (!fs.readdirSync(taskDir).length) fs.rmdirSync(taskDir);
    if (edit) applyEdit(edit);
  }
  return { target, edit };
}

export const rejectCommand = command(
  'reject',
  'Usage: beak reject <draft> --reason "…" [--block <id> --line "…" [--must]] [--check]',
  async (args, io, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) => {
    const { flags, positional, problems } = parseArgs(args, { flags: ['must', 'check'], valueFlags: ['reason', 'block', 'line'] });
    if (problems.length) throw new BeakError(problems[0], 2);
    if (positional.length !== 1) throw new BeakError('name one draft, then --reason "…"', 2);
    if (flags.reason === undefined) throw new BeakError('give the reason with --reason "…"', 2);
    if ((flags.block === undefined) !== (flags.line === undefined)) throw new BeakError('--block and --line go together: the block the rule belongs in, and the rule', 2);
    const { config } = loadConfig({ root: findRoot(cwd), env });
    const draft = findDraft(config, positional[0], cwd);
    const check = Boolean(flags.check);
    const r = rejectDraft({ config, draft, reason: flags.reason, block: flags.block, line: flags.line, must: Boolean(flags.must), check, now });
    const rel = (p) => relPath(config.root, p);
    io.out.write(`${check ? 'would move' : 'rejected: moved'} ${draft.rel} to ${rel(r.target)} (reason recorded)\n`);
    if (r.edit) {
      io.out.write(`${check ? 'would add to' : 'added to'} ${rel(r.edit.block.path)} (version ${r.edit.previous} → ${r.edit.version}):\n  ${r.edit.line}\n`);
    }
    io.out.write(check ? 'check: ok, nothing written\n' : `next: compose the variant again to rerun the loop with the new rule (/compose task=${draft.data.task} …)\n`);
    return 0;
  },
);

// ---------------------------------------------------------------------------------------------------------
// learn

export const learnCommand = command('learn', 'Usage: beak learn <block> --line "…" [--must] [--check]', async (args, io, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) => {
  const { flags, positional, problems } = parseArgs(args, { flags: ['must', 'check'], valueFlags: ['line'] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length !== 1) throw new BeakError('name one block (id or type/id), then --line "…"', 2);
  if (flags.line === undefined) throw new BeakError('give the criterion with --line "…"', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const edit = planDoneWhen({ config, library: reloadLibrary(config), ref: positional[0], criterion: flags.line, must: Boolean(flags.must), today: localDate(now) });
  if (!flags.check) applyEdit(edit);
  io.out.write(`${flags.check ? 'would add to' : 'added to'} ${relPath(config.root, edit.block.path)} (version ${edit.previous} → ${edit.version}):\n  ${edit.line}\n`);
  if (flags.check) io.out.write('check: ok, nothing written\n');
  return 0;
});
