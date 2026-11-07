// Run folders (plan.md §6): runs/<run-id>/ with bundle.md, rubric.json, meta.json, inputs.json and round-N/.
import fs from 'node:fs';
import path from 'node:path';
import { BeakError, readJson, relPath, sha256 } from './util.mjs';

export const RUN_ID_RE = /^\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** File names inside a run folder. */
export const RUN_FILES = Object.freeze({
  bundle: 'bundle.md',
  rubric: 'rubric.json',
  meta: 'meta.json',
  inputs: 'inputs.json', // every test input with its text; holdout inputs too, so the writer does not read it
  extra: 'rubric_extra.json', // run-only criteria from /refine
});

/** File names inside round-N/. */
export const ROUND_FILES = Object.freeze({
  prompt: 'prompt.md',
  changes: 'changes.md',
  outputs: 'outputs', // visible test outputs
  holdout: 'holdout', // holdout outputs: judged, never shown to the writer
  test: 'test.json',
  checks: 'checks.json',
  judge: 'judge.json',
  scorecardJson: 'scorecard.json',
  scorecardMd: 'scorecard.md',
  runner: 'runner.json', // every runner attempt of this round, for the `error` stop rule
});

export function roundDir(dir, n) {
  return path.join(dir, `round-${n}`);
}

/** Round numbers that have a folder, ascending. */
export function listRounds(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^round-(0|[1-9]\d*)$/.test(e.name))
    .map((e) => Number(e.name.slice('round-'.length)))
    .sort((a, b) => a - b);
}

/** "3" → 3. Throws a usage error for anything that is not a whole number >= 0. */
export function parseRound(arg) {
  if (typeof arg !== 'string' || !/^(0|[1-9]\d*)$/.test(arg)) {
    throw new BeakError(`round must be a whole number >= 0 (got ${arg === undefined ? 'nothing' : JSON.stringify(arg)})`, 2);
  }
  return Number(arg);
}

/**
 * Find a run from a run id or a path to its folder (runs/<id>, runs/<id>/, an absolute path).
 * Returns { id, dir }. Throws BeakError if there is no such run.
 */
export function findRun(config, arg, cwd = process.cwd()) {
  if (!arg) throw new BeakError('give the run id (beak bundle printed it; beak status lists recent runs)', 2);
  const candidates = [path.join(config.dirs.runs, arg), path.resolve(cwd, arg)];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, RUN_FILES.meta))) return { id: path.basename(dir), dir };
  }
  throw new BeakError(`no run "${arg}" (looked for ${relPath(config.root, path.join(config.dirs.runs, arg))}/${RUN_FILES.meta})`);
}

/** Load a run's script-written files. */
export function loadRun(config, arg, cwd) {
  const { id, dir } = findRun(config, arg, cwd);
  const read = (name, fallback) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      if (fallback !== undefined) return fallback;
      throw new BeakError(`${relPath(config.root, file)} is missing; this run folder was not made by beak bundle`);
    }
    try {
      return readJson(file);
    } catch (err) {
      throw new BeakError(`${relPath(config.root, file)} is not valid JSON (${err.message})`);
    }
  };
  return {
    id,
    dir,
    meta: read(RUN_FILES.meta),
    rubric: read(RUN_FILES.rubric),
    inputs: read(RUN_FILES.inputs).inputs,
    extra: read(RUN_FILES.extra, { criteria: [], refinements: [] }),
  };
}

/** Rubric criteria plus the run-only criteria from /refine. */
export function allCriteria(run) {
  return [...run.rubric.criteria, ...(run.extra?.criteria ?? [])];
}

/**
 * Hash of every block file the library loader reads (sorted by path), so `finalize` can tell whether the
 * library changed during a run. `library` comes from loadLibrary().
 */
export function libraryHash(config, library) {
  const parts = library.blocks
    .map((b) => [relPath(config.root, b.path), fs.readFileSync(b.path, 'utf8')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, text]) => `${p}\0${text}\0`);
  return sha256(parts.join(''));
}

/** Which test inputs a writer may see. Holdout inputs are labelled "holdout-1", "holdout-2", … in writer views. */
export function holdoutLabel(inputs, id) {
  const holdouts = inputs.filter((i) => i.holdout);
  const k = holdouts.findIndex((i) => i.id === id);
  return k === -1 ? id : `holdout-${k + 1}`;
}

/** Where the output of one test input is written. */
export function outputPath(dir, round, input) {
  return path.join(roundDir(dir, round), input.holdout ? ROUND_FILES.holdout : ROUND_FILES.outputs, `${input.id}.md`);
}
