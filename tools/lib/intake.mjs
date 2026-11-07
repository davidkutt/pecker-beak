// Intake helpers (plan.md §8, beak-intake skill).
//   beak find <name…> [type=…]  which existing blocks look like this name, and the slug for a new one
//   beak save <file…>           move staged blocks from library/_intake/ into the library
// The LLM writes block content. These scripts decide where it goes, its version and its date, and refuse
// likely duplicates and changed examples.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SLUG_RE, findRoot, loadConfig } from './config.mjs';
import { BLOCK_TYPES, TYPE_BY_DIR, isValidDate, parseBlock } from './blocks.mjs';
import { loadLibrary } from './library.mjs';
import { compareFindings, formatFindings, lint } from './lint.mjs';
import { rankBlocks, slugify } from './match.mjs';

/** Staging folder inside the library. Folders starting with "_" are never read as blocks. */
export const INTAKE_DIR = '_intake';
const TYPES = Object.keys(BLOCK_TYPES);

/** "customer" or "customers" → "customer"; undefined for anything else. */
export function blockType(word) {
  if (Object.hasOwn(BLOCK_TYPES, word)) return word;
  if (Object.hasOwn(TYPE_BY_DIR, word)) return TYPE_BY_DIR[word];
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// beak find

/**
 * Existing blocks that look like `name` (optionally of one type).
 * Returns { slug, matches: [{ kind: 'exact'|'likely', score, block }], newFile }.
 * `newFile` is where a new block would go: only with a type, and only if no block has that id yet.
 */
export function find({ config, library, name, type }) {
  const slug = slugify(name);
  const matches = rankBlocks(library.blocks, name, { type });
  const taken = type && library.byType[type].has(slug);
  const newFile = type && slug && !taken ? path.join(config.dirs.library, BLOCK_TYPES[type], `${slug}.md`) : null;
  return { slug, matches, newFile };
}

export function formatFind({ slug, matches, newFile }, config) {
  const lines = [`slug: ${slug}`];
  for (const m of matches) lines.push(`${m.kind}: ${describe(m.block, config)}`);
  if (newFile) lines.push(`new: ${relPath(config, newFile)}`);
  else if (!matches.length) lines.push('none: no similar block in the library');
  return lines;
}

/** CLI: beak find <name…> [type=<type>]. */
export async function findCommand(args, io, { cwd = process.cwd(), env = process.env } = {}) {
  const usage = 'Usage: beak find <name…> [type=<type>]\n';
  let type;
  const words = [];
  for (const arg of args) {
    if (arg.startsWith('-')) return usageError(io, 'find', `unknown option ${arg}`, usage);
    const kv = /^([a-z_]+)=(.*)$/.exec(arg);
    if (!kv) {
      words.push(arg);
      continue;
    }
    if (kv[1] !== 'type') return usageError(io, 'find', `unknown key "${kv[1]}" (only type=)`, usage);
    type = blockType(kv[2]);
    if (!type) return usageError(io, 'find', `type must be one of: ${TYPES.join(', ')} (got "${kv[2]}")`, usage);
  }
  const name = words.join(' ').trim();
  if (!name) return usageError(io, 'find', 'give the name to look for, e.g. beak find Acme Pharma type=customer', usage);
  if (!slugify(name)) return usageError(io, 'find', `"${name}" has no letters or digits to make a slug from`, usage);

  const { config } = loadConfig({ root: findRoot(cwd), env });
  const library = loadLibrary(config.dirs.library, { root: config.root });
  for (const line of formatFind(find({ config, library, name, type }), config)) io.out.write(`${line}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// beak save

/**
 * Work out what saving the staged blocks would do, without writing anything.
 * `sources`: [{ file (absolute path), text }]. `today`: YYYY-MM-DD.
 * Returns { items, findings }:
 *   items:    [{ source, target, type, id, action: 'create'|'update'|'unchanged', version, previous, text,
 *               findings }], where `text` is the stamped block and `findings` are its lint findings with
 *               target paths and line numbers (to report after writing)
 *   findings: every problem and warning, with the staged file's path and line numbers (to fix it there)
 * Any finding with level "error" means nothing may be written.
 */
export function planSave({ config, sources, today, allowNew = false, dropExamples = false }) {
  const library = loadLibrary(config.dirs.library, { root: config.root });
  const findings = [];
  const items = [];
  const targets = new Map();

  for (const { file, text } of sources) {
    const source = relPath(config, file);
    const error = (message, line) => findings.push({ file: source, line, level: 'error', message });
    const staged = parseBlock(text, source);
    const fm = staged.frontmatter;
    if (!fm) {
      findings.push(...staged.findings.filter((f) => f.level === 'error'));
      continue;
    }
    const type = typeof fm.type === 'string' ? blockType(fm.type) : undefined;
    if (!type || type !== fm.type) {
      error(`type ${fmt(fm.type)} must be one of: ${TYPES.join(', ')}; it decides which folder the block goes in`, staged.lineOf(['type']) ?? 2);
      continue;
    }
    if (typeof fm.id !== 'string' || !SLUG_RE.test(fm.id)) {
      error(
        `id ${fmt(fm.id)} must be a lowercase slug (a-z, 0-9, single hyphens); it becomes the file name (beak find suggests one)`,
        staged.lineOf(['id']) ?? 2,
      );
      continue;
    }
    if (isInBlockFolder(config, file)) {
      error(`is already in the library; write the proposal to ${relPath(config, intakeDir(config))}/ and save it from there`);
      continue;
    }
    const target = path.join(config.dirs.library, BLOCK_TYPES[type], `${fm.id}.md`);
    if (targets.has(target)) {
      error(`goes to the same file as ${targets.get(target)} (${relPath(config, target)})`);
      continue;
    }
    targets.set(target, source);

    const existing = library.byType[type].get(fm.id);
    let action;
    let version;
    let previous = null;
    if (existing) {
      previous = existing.frontmatter?.version;
      if (!Number.isInteger(previous) || previous < 1) {
        error(`${relPath(config, target)} has no valid version (got ${fmt(previous)}); fix that file by hand first`);
        continue;
      }
      const ignoreStamp = [['version', '0'], ['updated', '-']];
      const before = setFrontmatterFields(fs.readFileSync(existing.path, 'utf8'), ignoreStamp);
      const after = setFrontmatterFields(text, ignoreStamp);
      action = before && after && before.text === after.text ? 'unchanged' : 'update';
      version = action === 'unchanged' ? previous : previous + 1;
    } else {
      action = 'create';
      version = 1;
      if (!allowNew) {
        const like = likeBlocks(library.blocks, type, [fm.id, staged.title?.text]);
        if (like.length) {
          const list = like.map((b) => describe(b, config)).join('; ');
          error(
            `looks like a duplicate of ${list}. If it is the same ${type}, update that file instead (stage it with id: ${like[0].id}). ` +
              `If the user confirms it is a different ${type}, run beak save again with --new`,
            staged.lineOf(['id']),
          );
        }
      }
    }

    // An unchanged block is not written; its old date is only used to validate it.
    const updated = action === 'unchanged' && isValidDate(existing.frontmatter.updated) ? existing.frontmatter.updated : today;
    const stamped = setFrontmatterFields(text, [['version', String(version)], ['updated', String(updated)]]);
    if (!stamped) {
      error('frontmatter could not be read');
      continue;
    }

    if (action === 'update' && !dropExamples) {
      const kept = new Set(parseBlock(stamped.text).examples.map((e) => exampleBody(e.text)));
      for (const ex of existing.examples) {
        if (kept.has(exampleBody(ex.text))) continue;
        error(
          `the example on line ${ex.line} of ${relPath(config, target)} (${preview(ex.text)}) is missing or changed. ` +
            'Examples stay verbatim: copy it back unchanged, or pass --drop-examples if the user asked to remove or replace it',
        );
      }
    }

    items.push({ source: file, target, type, id: fm.id, action, version, previous, text: stamped.text, inserted: stamped.inserted, findings: [] });
  }

  // Validate the staged blocks as if they were already in the library, so references between them resolve.
  const overlay = new Map(items.map((i) => [i.target, i.text]));
  const { findings: linted } = lint({ config, overlay });
  for (const f of linted) {
    const item = items.find((i) => relPath(config, i.target) === f.file);
    if (!item) continue;
    item.findings.push(f);
    findings.push({ ...f, file: relPath(config, item.source), line: sourceLine(f.line, item.inserted) });
  }
  for (const item of items) delete item.inserted;
  return { items, findings: findings.sort(compareFindings) };
}

/** Write planned items and remove their staged files (only those inside library/_intake/). */
export function applySave({ config, items }) {
  for (const item of items) {
    if (item.action !== 'unchanged') {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.writeFileSync(item.target, item.text.endsWith('\n') ? item.text : `${item.text}\n`);
    }
    if (isInside(item.source, intakeDir(config))) fs.rmSync(item.source, { force: true });
  }
}

export function formatItem(item, config, { check = false } = {}) {
  const verb = { create: ['would create', 'created'], update: ['would update', 'updated'], unchanged: ['would leave unchanged', 'unchanged'] };
  const v = item.action === 'update' ? `version ${item.previous} → ${item.version}` : `version ${item.version}`;
  return `${verb[item.action][check ? 0 : 1]} ${relPath(config, item.target)} (${item.type} ${item.id}, ${v})`;
}

/** CLI: beak save <file…> [--check] [--new] [--drop-examples]. Exit 1 if anything is wrong; then nothing is written. */
export async function saveCommand(args, io, { cwd = process.cwd(), env = process.env, today = localDate() } = {}) {
  const usage = 'Usage: beak save <file…> [--check] [--new] [--drop-examples]\n';
  const flags = { '--check': false, '--new': false, '--drop-examples': false };
  const files = [];
  for (const arg of args) {
    if (arg in flags) flags[arg] = true;
    else if (arg.startsWith('-')) return usageError(io, 'save', `unknown option ${arg}`, usage);
    else files.push(arg);
  }
  if (!files.length) return usageError(io, 'save', 'give the staged file(s) to save, e.g. library/_intake/acme-pharma.md', usage);
  const sources = [];
  for (const f of files) {
    const file = path.resolve(cwd, f);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return usageError(io, 'save', `${f}: no such file`, usage);
    sources.push({ file, text: fs.readFileSync(file, 'utf8') });
  }

  const { config } = loadConfig({ root: findRoot(cwd), env });
  const check = flags['--check'];
  const { items, findings } = planSave({ config, sources, today, allowNew: flags['--new'], dropExamples: flags['--drop-examples'] });
  const errors = findings.filter((f) => f.level === 'error').length;
  if (errors) {
    for (const line of formatFindings(findings)) io.out.write(`${line}\n`);
    io.out.write(`not saved: ${errors} error${errors === 1 ? '' : 's'}, nothing written. Fix the staged file${files.length === 1 ? '' : 's'} and run beak save again\n`);
    return 1;
  }
  for (const item of items) io.out.write(`${formatItem(item, config, { check })}\n`);
  if (check) {
    for (const line of formatFindings(findings)) io.out.write(`${line}\n`);
    io.out.write('check: ok, nothing written\n');
    return 0;
  }
  applySave({ config, items });
  for (const line of formatFindings(items.flatMap((i) => i.findings).sort(compareFindings))) io.out.write(`${line}\n`);
  const count = (action) => items.filter((i) => i.action === action).length;
  io.out.write(`saved: ${count('create')} created, ${count('update')} updated, ${count('unchanged')} unchanged\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// Frontmatter stamping

/**
 * Set top-level frontmatter fields in a block's text and keep everything else as it is (comments included).
 * `fields`: [[key, value text]]. A missing field goes on a new line after the previous field in `fields`
 * (the first one after `type:`), or at the end of the frontmatter.
 * Returns { text, inserted } (inserted: line numbers of added lines), or null if the frontmatter is unreadable.
 */
export function setFrontmatterFields(text, fields) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((t, i) => i > 0 && t.trim() === '---');
  if (end === -1) return null;
  let fm = lines.slice(1, end).join('\n');
  const inserted = [];
  let previousKey = 'type';
  for (const [key, value] of fields) {
    const doc = YAML.parseDocument(fm);
    if (doc.errors.length || !YAML.isMap(doc.contents)) return null;
    const pairOf = (k) => doc.contents.items.find((p) => YAML.isScalar(p.key) && p.key.value === k);
    const pair = pairOf(key);
    if (pair) {
      const colon = fm.indexOf(':', pair.key.range[1]);
      const valueEnd = pair.value?.range ? pair.value.range[1] : colon + 1;
      const keepNewline = fm.slice(colon + 1, valueEnd).endsWith('\n') ? '\n' : '';
      fm = `${fm.slice(0, colon + 1)} ${value}${keepNewline}${fm.slice(valueEnd)}`;
    } else {
      const fmLines = fm.split('\n');
      const anchor = pairOf(previousKey);
      let at = fmLines.length - 1;
      if (anchor) {
        const anchorEnd = anchor.value?.range ? anchor.value.range[1] : anchor.key.range[1];
        at = fm.slice(0, Math.max(anchorEnd - 1, 0)).split('\n').length - 1;
      }
      fmLines.splice(at + 1, 0, `${key}: ${value}`);
      fm = fmLines.join('\n');
      const line = at + 3; // frontmatter line i (0-based) is file line i + 2
      for (let k = 0; k < inserted.length; k++) if (inserted[k] >= line) inserted[k]++;
      inserted.push(line);
    }
    previousKey = key;
  }
  return { text: [lines[0], fm, ...lines.slice(end)].join('\n'), inserted: inserted.sort((a, b) => a - b) };
}

/** Today's local date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------------------------------------

function likeBlocks(blocks, type, names) {
  const found = new Map();
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim() || name.includes('TODO:')) continue;
    for (const m of rankBlocks(blocks, name, { type })) if (!found.has(m.block.id)) found.set(m.block.id, m);
  }
  return [...found.values()].sort((a, b) => b.score - a.score || (a.block.id < b.block.id ? -1 : 1)).map((m) => m.block);
}

function describe(block, config) {
  const version = block.frontmatter?.version;
  const title = block.title?.text;
  return `${relPath(config, block.path)} (${block.type} ${block.id}, version ${version ?? '?'}${title ? `, "${title}"` : ''})`;
}

// Example text without code-fence lines, so changing the fence's language tag is not a changed example.
function exampleBody(text) {
  return text
    .split('\n')
    .filter((l) => !/^ {0,3}(`{3,}|~{3,})/.test(l))
    .join('\n')
    .trim();
}

function preview(text) {
  const first = exampleBody(text).split('\n').find((l) => l.trim()) ?? '';
  return `"${first.length > 50 ? `${first.slice(0, 47)}…` : first}"`;
}

function sourceLine(line, inserted) {
  if (line === undefined || inserted.includes(line)) return undefined;
  return line - inserted.filter((l) => l < line).length;
}

function intakeDir(config) {
  return path.join(config.dirs.library, INTAKE_DIR);
}

function isInBlockFolder(config, file) {
  const dir = path.dirname(file);
  return path.dirname(dir) === config.dirs.library && Object.hasOwn(TYPE_BY_DIR, path.basename(dir));
}

function relPath(config, p) {
  return path.relative(config.root, p).split(path.sep).join('/');
}

function isInside(child, parent) {
  const r = path.relative(parent, child);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

function usageError(io, command, message, usage) {
  io.err.write(`beak ${command}: ${message}\n${usage}`);
  return 2;
}

function fmt(v) {
  return v === undefined ? 'nothing' : JSON.stringify(v);
}
