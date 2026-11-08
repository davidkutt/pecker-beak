// Staleness (M7, plan.md §15): an approved prompt is stale when a block it was made from has a newer version
// or is gone from the library. Scripts mark it: `stale:` in the prompt's frontmatter and `"stale": true` in
// out/<consumer>/index.json. The prompt keeps `status: approved`, so consumers go on using it until a new
// version is approved. Every script that changes a block's version refreshes the marks; `beak stale` does it
// by hand (after a git pull or a hand edit).
import fs from 'node:fs';
import { findRoot, loadConfig } from './config.mjs';
import { loadLibrary } from './library.mjs';
import { approvedPrompts, buildIndex, indexPath } from './out.mjs';
import { BeakError, command, parseArgs, plural, relPath, writeDoc, writeJson } from './util.mjs';

/** "formal-de@2" or "tone/formal-de@2" → { type, id, version }; null if it is neither. */
export function parseSource(s) {
  const m = typeof s === 'string' ? /^(?:([a-z]+)\/)?([a-z0-9]+(?:-[a-z0-9]+)*)@([1-9]\d*)$/.exec(s) : null;
  return m ? { type: m[1] ?? null, id: m[2], version: Number(m[3]) } : null;
}

/**
 * Compare a prompt's sources ("id@version") with the library.
 * Returns [{ ref, used, now, state }] with state 'current', 'changed' (another version now), 'missing' (no such
 * block any more) or 'ambiguous' (several blocks have that id; the source does not say which). Unreadable
 * entries are skipped.
 */
export function compareSources(library, sources = []) {
  const out = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    const src = parseSource(s);
    if (!src) continue;
    const ref = src.type ? `${src.type}/${src.id}` : src.id;
    const found = src.type ? [library.byType[src.type]?.get(src.id)].filter(Boolean) : library.blocks.filter((b) => b.id === src.id);
    if (found.length > 1) {
      out.push({ ref, used: src.version, now: null, state: 'ambiguous', candidates: found.map((b) => `${b.type}/${b.id}`) });
      continue;
    }
    const now = found.length ? found[0].frontmatter?.version : undefined;
    if (!found.length) out.push({ ref, used: src.version, now: null, state: 'missing' });
    else if (!Number.isInteger(now)) out.push({ ref, used: src.version, now: null, state: 'ambiguous', candidates: [] });
    else out.push({ ref, used: src.version, now, state: now === src.version ? 'current' : 'changed' });
  }
  return out;
}

/** The `stale:` list for a prompt: [{ block, used, now }] (now: null when the block is gone). */
export function staleList(library, sources) {
  return compareSources(library, sources)
    .filter((c) => c.state === 'changed' || c.state === 'missing')
    .map(({ ref, used, now }) => ({ block: ref, used, now }));
}

/**
 * Recompute the marks of every approved prompt of every configured consumer, and write the ones that changed
 * (unless write is false). index.json is rewritten when its content would change.
 * Returns { prompts: [{ consumer, file, path, data, stale, ambiguous, changed, was }], written: [files] }.
 */
export function refreshStale({ config, library = loadLibrary(config.dirs.library, { root: config.root }), write = true }) {
  const prompts = [];
  const written = [];
  for (const consumer of config.consumers) {
    const list = approvedPrompts(config, consumer);
    for (const p of list) {
      const compared = compareSources(library, p.data.sources);
      const stale = staleList(library, p.data.sources);
      const was = Array.isArray(p.data.stale) ? p.data.stale : [];
      const changed = JSON.stringify(was) !== JSON.stringify(stale);
      if (changed && write) {
        const data = { ...p.data };
        delete data.stale;
        if (stale.length) data.stale = stale;
        fs.writeFileSync(p.file, writeDoc(data, p.body));
        written.push(p.file);
      }
      prompts.push({ consumer, file: p.file, path: p.path, data: p.data, stale, ambiguous: compared.filter((c) => c.state === 'ambiguous'), changed, was });
    }
    const index = indexPath(config, consumer);
    if (write && (list.length || fs.existsSync(index))) {
      const want = buildIndex(config, consumer);
      const have = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : null;
      if (have !== `${JSON.stringify(want, null, 2)}\n`) {
        writeJson(index, want);
        written.push(index);
      }
    }
  }
  return { prompts, written };
}

export function describeStale(stale) {
  return stale.map((s) => `${s.block} v${s.used} → ${s.now === null ? 'gone' : `v${s.now}`}`).join(', ');
}

/** How to make a fresh version of an approved prompt: the /compose arguments its run used. */
export function refreshHint(data) {
  return data.compose ? `/compose ${data.compose}` : `/compose task=${data.task} … (the arguments of run ${data.run}; variant ${data.variant})`;
}

/**
 * Lines for the prompts whose marks a script just changed, for the output of beak save / learn / reject /
 * approve. Empty when nothing changed.
 */
export function staleChangeLines(config, report) {
  const lines = [];
  for (const p of report.prompts.filter((x) => x.changed)) {
    const rel = relPath(config.root, p.file);
    if (p.stale.length) lines.push(`marked stale: ${rel} v${p.data.version} (${describeStale(p.stale)}); refresh it with ${refreshHint(p.data)}`);
    else lines.push(`no longer stale: ${rel} v${p.data.version}`);
  }
  for (const f of report.written.filter((f) => f.endsWith('index.json'))) lines.push(`updated ${relPath(config.root, f)}`);
  return lines;
}

/** Refresh the marks after a library change and print what changed. Returns the files written. */
export function refreshAndReport(config, io) {
  const report = refreshStale({ config });
  for (const line of staleChangeLines(config, report)) io.out.write(`${line}\n`);
  return report.written;
}

export const staleCommand = command('stale', 'Usage: beak stale [--check]', async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  const { flags, positional, problems } = parseArgs(args, { flags: ['check'] });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length) throw new BeakError('takes no arguments besides --check', 2);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const check = Boolean(flags.check);
  const report = refreshStale({ config, write: !check });
  for (const p of report.prompts) {
    const rel = relPath(config.root, p.file);
    io.out.write(`${rel} v${p.data.version}: ${p.stale.length ? `stale (${describeStale(p.stale)})` : 'current'}\n`);
    if (p.stale.length) io.out.write(`  refresh: ${refreshHint(p.data)}\n`);
    for (const a of p.ambiguous) {
      io.out.write(`  cannot tell for ${a.ref}@${a.used}: ${a.candidates.length ? `several blocks have this id (${a.candidates.join(', ')})` : 'the block has no valid version'}\n`);
    }
  }
  const staleCount = report.prompts.filter((p) => p.stale.length).length;
  io.out.write(`${plural(report.prompts.length, 'approved prompt')}: ${staleCount} stale, ${report.prompts.length - staleCount} current\n`);
  if (check) {
    const pending = report.prompts.filter((p) => p.changed);
    io.out.write(pending.length ? `check: ${plural(pending.length, 'mark')} out of date, nothing written (run beak stale to update them)\n` : 'check: marks are up to date, nothing written\n');
  } else {
    for (const f of report.written) io.out.write(`updated ${relPath(config.root, f)}\n`);
    if (!report.written.length) io.out.write('marks are up to date\n');
  }
  return 0;
});
