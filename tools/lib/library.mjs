// Reads every block under library/<type-folder>/*.md (plan.md §3, §4).
// Folders starting with "_" (e.g. _templates) and dotfiles are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_TYPES, TYPE_BY_DIR, parseBlock, validateBlock } from './blocks.mjs';

/**
 * Load and check all blocks. Never throws for content problems.
 * `overlay` (Map: absolute file path → text) loads those files as if they were on disk, replacing a file
 * that is: `beak save` uses it to validate staged blocks in the context of the library before writing them.
 * Returns { blocks, byType, findings }:
 *   blocks:  parsed blocks (see parseBlock) with `path`, `type` and `id` taken from folder and filename
 *   byType:  { task: Map(id → block), … } keyed by filename, which is how other blocks refer to them
 *   findings: parse, frontmatter and placement problems, file paths relative to `root`
 */
export function loadLibrary(libraryDir, { root, overlay = new Map() }) {
  const rel = (p) => path.relative(root, p).split(path.sep).join('/') || '.';
  const findings = [];
  const blocks = [];
  const byType = Object.fromEntries(Object.keys(BLOCK_TYPES).map((t) => [t, new Map()]));

  if (!fs.existsSync(libraryDir) || !fs.statSync(libraryDir).isDirectory()) {
    findings.push({ file: rel(libraryDir), level: 'error', message: 'library folder not found' });
    return { blocks, byType, findings };
  }

  for (const entry of withOverlay(libraryDir, listDir(libraryDir), overlay, true)) {
    const full = path.join(libraryDir, entry.name);
    if (!entry.isDirectory()) {
      findings.push({
        file: rel(full),
        level: 'warning',
        message: `not read: blocks go in a type folder (${Object.values(BLOCK_TYPES).join(', ')})`,
      });
      continue;
    }
    if (entry.name.startsWith('_')) continue;
    const type = TYPE_BY_DIR[entry.name];
    if (!type) {
      findings.push({
        file: `${rel(full)}/`,
        level: 'warning',
        message: `not read: unknown folder (block folders are: ${Object.values(BLOCK_TYPES).join(', ')})`,
      });
      continue;
    }
    const onDisk = fs.existsSync(full) ? listDir(full) : [];
    for (const f of withOverlay(full, onDisk, overlay, false)) {
      const file = path.join(full, f.name);
      if (f.isDirectory()) {
        findings.push({ file: `${rel(file)}/`, level: 'warning', message: `not read: subfolders are ignored, move its files into ${rel(full)}/` });
        continue;
      }
      if (!f.name.endsWith('.md')) {
        findings.push({ file: rel(file), level: 'warning', message: 'not read: only .md files are blocks' });
        continue;
      }
      const id = f.name.slice(0, -'.md'.length);
      const block = parseBlock(overlay.get(file) ?? fs.readFileSync(file, 'utf8'), rel(file));
      block.path = file;
      block.type = type;
      block.id = id;
      block.findings.push(...validateBlock(block, { expectedType: type, expectedId: id }));
      findings.push(...block.findings);
      blocks.push(block);
      byType[type].set(id, block);
    }
  }
  return { blocks, byType, findings };
}

// Adds the overlay's files (or, for the library folder, their type folders) that are not on disk yet.
function withOverlay(dir, entries, overlay, folders) {
  const names = new Set(entries.map((e) => e.name));
  const extra = [];
  for (const file of overlay.keys()) {
    const rel = path.relative(dir, file).split(path.sep);
    if (rel[0] === '..' || path.isAbsolute(rel[0]) || rel.length !== (folders ? 2 : 1)) continue;
    if (names.has(rel[0])) continue;
    names.add(rel[0]);
    extra.push({ name: rel[0], isDirectory: () => folders });
  }
  return [...entries, ...extra].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Sorted, without dotfiles, so results never depend on filesystem order.
function listDir(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
