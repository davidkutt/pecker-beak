// Drafts (plan.md §9): drafts/<task>/<variant>.md, written by `beak finalize`, waiting for review.
import fs from 'node:fs';
import path from 'node:path';
import { runChecks } from './checks.mjs';
import { RUN_FILES, loadRun } from './run.mjs';
import { BeakError, cmp, readDoc, relPath, sha256 } from './util.mjs';

export const REJECTED_DIR = '_rejected';

/** Every draft waiting for review (drafts/<task>/<variant>.md, not drafts/_rejected/), sorted by path. */
export function listDrafts(config) {
  const root = config.dirs.drafts;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const task of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))) {
    for (const f of fs.readdirSync(path.join(root, task.name)).filter((n) => n.endsWith('.md')).sort()) {
      const file = path.join(root, task.name, f);
      const doc = readDoc(fs.readFileSync(file, 'utf8'));
      if (doc) out.push({ file, rel: relPath(config.root, file), ...doc });
    }
  }
  return out.sort((a, b) => cmp(a.rel, b.rel));
}

/**
 * A draft from a path (drafts/cold-email/acme-pharma-formal-de.md) or "<task>/<variant>".
 * Returns { file, rel, data, body }. Throws BeakError if it does not exist or is not a draft.
 */
export function findDraft(config, arg, cwd = process.cwd()) {
  if (!arg) throw new BeakError('name the draft, e.g. drafts/cold-email/acme-pharma-formal-de.md (beak status lists them)', 2);
  const withMd = arg.endsWith('.md') ? arg : `${arg}.md`;
  const candidates = [path.resolve(cwd, arg), path.resolve(cwd, withMd), path.join(config.dirs.drafts, withMd)];
  const file = candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) throw new BeakError(`no draft "${arg}" (drafts are drafts/<task>/<variant>.md; beak status lists them)`);
  const rel = path.relative(config.dirs.drafts, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 2) {
    throw new BeakError(`${relPath(config.root, file)} is not a draft: drafts are drafts/<task>/<variant>.md`);
  }
  if (rel.startsWith(`${REJECTED_DIR}${path.sep}`)) throw new BeakError(`${relPath(config.root, file)} was rejected already`);
  const doc = readDoc(fs.readFileSync(file, 'utf8'));
  if (!doc) throw new BeakError(`${relPath(config.root, file)} has no readable frontmatter; it was not written by beak finalize`);
  for (const key of ['task', 'variant', 'consumer', 'run']) {
    if (typeof doc.data[key] !== 'string' || !doc.data[key]) throw new BeakError(`${relPath(config.root, file)}: frontmatter has no "${key}"`);
  }
  return { file, rel: relPath(config.root, file), ...doc };
}

/** The draft's run, or null when runs/<run>/ is not here (runs/ is not committed). */
export function draftRun(config, draft) {
  const dir = path.join(config.dirs.runs, draft.data.run);
  if (!fs.existsSync(path.join(dir, RUN_FILES.meta))) return null;
  try {
    return loadRun(config, draft.data.run);
  } catch {
    return null;
  }
}

/** Was the draft's prompt changed after the loop? (Its text no longer matches prompt_sha256.) */
export function editedAfterLoop(draft) {
  return typeof draft.data.prompt_sha256 === 'string' && sha256(draft.body) !== draft.data.prompt_sha256;
}

/**
 * The prompt's hard checks, run again on the draft as it is now: the run's prompt checks when the run is
 * here, else only the placeholder check with the draft's runtime_vars.
 */
export function draftChecks(draft, run) {
  const checks = run?.rubric.checks.prompt ?? {};
  const runtimeVars = run?.rubric.runtime_vars ?? draft.data.runtime_vars ?? [];
  return runChecks(draft.body, checks, { scope: 'prompt', runtimeVars });
}
