// out/<consumer>/ (plan.md §10): where approved prompts live, and the index consumers read.
// Kept apart from approve.mjs so that library commands (beak save, learn) can refresh staleness marks
// without importing the approve command.
import fs from 'node:fs';
import path from 'node:path';
import { cmp, readDoc } from './util.mjs';

export const ARCHIVE_DIR = '_archive';
export const INDEX_FILE = 'index.json';

export function outPath(config, { consumer, task, variant }) {
  return path.join(config.dirs.out, consumer, task, `${variant}.md`);
}

export function indexPath(config, consumer) {
  return path.join(config.dirs.out, consumer, INDEX_FILE);
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
      if (doc?.data.status === 'approved') out.push({ file, data: doc.data, body: doc.body, path: `${task.name}/${f}` });
    }
  }
  return out.sort((a, b) => cmp(a.path, b.path));
}

/**
 * out/<consumer>/index.json (plan §10). Paths are relative to out/<consumer>/. `stale` is true when a block the
 * prompt was made from has a newer version (M7); the prompt stays approved and usable.
 */
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
      stale: Array.isArray(data.stale) && data.stale.length > 0,
      path: p,
    })),
  };
}
