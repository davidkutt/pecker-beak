// `beak lint [path]` (plan.md §6): block format, ids that must exist, known consumers, TODO: markers.
import fs from 'node:fs';
import path from 'node:path';
import { SLUG_RE, loadConfig } from './config.mjs';
import { BLOCK_TYPES, isTodo } from './blocks.mjs';
import { loadLibrary } from './library.mjs';

/**
 * Lint the library, reporting only files inside `target` (a file or folder; default: the whole library).
 * References are always resolved against the whole library. `overlay` is passed to loadLibrary().
 * Returns { findings, files } with findings sorted by file, line and message.
 */
export function lint({ config, configWarnings = [], target = config.dirs.library, overlay }) {
  const { blocks, byType, findings } = loadLibrary(config.dirs.library, { root: config.root, overlay });
  for (const block of blocks) {
    findings.push(...crossCheck(block, { byType, config }));
    for (const todo of block.todos) {
      findings.push({ file: block.file, line: todo.line, level: 'warning', message: `TODO left: ${shorten(todo.text)}` });
    }
  }
  for (const message of configWarnings) findings.push({ file: path.basename(config.file), level: 'warning', message });

  const inTarget = (file) => file === path.basename(config.file) || isInside(path.join(config.root, file), target);
  return {
    findings: findings.filter((f) => inTarget(f.file.replace(/\/$/, ''))).sort(compareFindings),
    files: blocks.filter((b) => isInside(b.path, target)).length,
  };
}

/** Checks that need the rest of the library or the config. */
export function crossCheck(block, { byType, config }) {
  const fm = block.frontmatter;
  if (!fm) return [];
  const findings = [];
  const add = (level, p, message) => findings.push({ file: block.file, line: block.lineOf(p), level, message });
  const ref = (key, type) => {
    const id = fm[key];
    if (typeof id !== 'string' || isTodo(id) || !SLUG_RE.test(id)) return;
    if (!byType[type].has(id)) {
      add('error', [key], `${key} "${id}" not found: there is no ${config.paths.library}/${BLOCK_TYPES[type]}/${id}.md`);
    }
  };

  if (block.type === 'task') {
    const c = fm.consumer;
    if (typeof c === 'string' && !isTodo(c) && SLUG_RE.test(c) && !config.consumers.includes(c)) {
      add('error', ['consumer'], `consumer "${c}" is not declared in beak.config.yaml (consumers: ${config.consumers.join(', ')})`);
    }
    ref('default_tone', 'tone');
    if (Array.isArray(fm.test_inputs)) {
      fm.test_inputs.forEach((item, i) => {
        if (typeof item === 'string' && SLUG_RE.test(item) && !byType.scenario.has(item)) {
          add('error', ['test_inputs', i], `test_inputs: scenario "${item}" not found: there is no ${config.paths.library}/scenarios/${item}.md`);
        }
      });
      const n = fm.test_inputs.length;
      if (n > 0 && n < config.loop.test_inputs) {
        add('warning', ['test_inputs'], `has ${n} test input${n === 1 ? '' : 's'}; beak.config.yaml loop.test_inputs is ${config.loop.test_inputs}`);
      }
    }
    if (typeof fm.golden === 'string' && fm.golden.trim() && !fs.existsSync(path.resolve(config.root, fm.golden))) {
      add('error', ['golden'], `golden "${fm.golden}" not found (paths are relative to the repo root)`);
    }
  }
  if (block.type === 'customer') {
    ref('industry', 'industry');
    ref('default_tone', 'tone');
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.file}${f.line ? `:${f.line}` : ''}: ${f.level}: ${f.message}`);
}

export function summary(findings, files) {
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.length - errors;
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  return `${n(files, 'file')} checked: ${n(errors, 'error')}, ${n(warnings, 'warning')}`;
}

/** CLI: beak lint [path]. Exit 1 if any error, 2 on bad usage. */
export async function lintCommand(args, io, { cwd = process.cwd(), env = process.env } = {}) {
  const unknown = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (unknown.length || positional.length > 1) {
    io.err.write(`beak lint: ${unknown.length ? `unknown option ${unknown[0]}` : 'give at most one path'}\nUsage: beak lint [path]\n`);
    return 2;
  }
  const { config, warnings } = loadConfig({ env });
  const libraryRel = config.paths.library;
  let target = config.dirs.library;
  if (positional[0]) {
    target = path.resolve(cwd, positional[0]);
    if (!fs.existsSync(target)) {
      io.err.write(`beak lint: ${positional[0]}: no such file or folder\n`);
      return 2;
    }
    if (!isInside(target, config.dirs.library) && !isInside(config.dirs.library, target)) {
      io.err.write(`beak lint: ${positional[0]} is outside the library (${libraryRel}/)\n`);
      return 2;
    }
    if (isInside(config.dirs.library, target)) target = config.dirs.library;
  }
  const { findings, files } = lint({ config, configWarnings: warnings, target });
  for (const line of formatFindings(findings)) io.out.write(`${line}\n`);
  io.out.write(`${summary(findings, files)}\n`);
  return findings.some((f) => f.level === 'error') ? 1 : 0;
}

function isInside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

export function compareFindings(a, b) {
  return cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.level, b.level) || cmp(a.message, b.message);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shorten(text) {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
