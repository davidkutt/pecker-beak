// Small helpers shared by the run, loop and review commands (M3–M5).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** Path relative to `root`, with forward slashes. */
export function relPath(root, p) {
  return path.relative(root, p).split(path.sep).join('/') || '.';
}

/** True if `child` is `parent` or inside it. */
export function isInside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

export function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** JSON with two-space indent and a final newline. Key order is the order the caller built the object in. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

/** Today's local date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local time as yyyymmdd-hhmm (run ids, plan §6). */
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Split a Markdown file with YAML frontmatter (drafts, approved prompts) into { data, body }.
 * Returns null if there is no readable frontmatter.
 */
export function readDoc(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((t, i) => i > 0 && t.trim() === '---');
  if (end === -1) return null;
  let data;
  try {
    data = YAML.parse(lines.slice(1, end).join('\n')) ?? {};
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '') };
}

/** The inverse of readDoc(). Keys keep the order of `data`. */
export function writeDoc(data, body) {
  const fm = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n\n${body.replace(/\s+$/, '')}\n`;
}

/** A code fence long enough for `text` (which may contain backticks itself). */
export function fenced(text, info = 'text') {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${info}\n${text.replace(/\s+$/, '')}\n${fence}`;
}

/**
 * Split CLI args into `key=value` pairs, flags (--x) and positional words.
 * Returns { values, flags, positional, problems }. `keys`/`flags` list what is allowed.
 */
export function parseArgs(args, { keys = [], flags = [], valueFlags = [] } = {}) {
  const values = {};
  const flagSet = {};
  const positional = [];
  const problems = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.includes(name)) {
        if (i + 1 >= args.length) problems.push(`${arg} needs a value`);
        else flagSet[name] = args[++i];
      } else if (flags.includes(name)) {
        flagSet[name] = true;
      } else {
        problems.push(`unknown option ${arg}`);
      }
      continue;
    }
    const kv = /^([a-z_]+)=(.*)$/s.exec(arg);
    if (kv && keys.includes(kv[1])) {
      if (kv[1] in values) problems.push(`${kv[1]}= is given twice`);
      values[kv[1]] = kv[2];
      continue;
    }
    if (kv && keys.length) {
      problems.push(`unknown key "${kv[1]}" (keys: ${keys.join(', ')})`);
      continue;
    }
    positional.push(arg);
  }
  return { values, flags: flagSet, positional, problems };
}

export function usageError(io, command, message, usage) {
  io.err.write(`beak ${command}: ${message}\n${usage.endsWith('\n') ? usage : `${usage}\n`}`);
  return 2;
}

export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/** An expected failure: printed as "beak <command>: <message>" with exit code `code` (1 failure, 2 usage). */
export class BeakError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'BeakError';
    this.code = code;
  }
}

/**
 * Wrap a command body so a BeakError becomes its message on stderr and an exit code.
 * `fn(args, io, opts)` returns an exit code. Usage errors (code 2) also print `usage`.
 */
export function command(name, usage, fn) {
  return async (args, io, opts = {}) => {
    try {
      return await fn(args, io, opts);
    } catch (err) {
      if (!(err instanceof BeakError)) throw err;
      io.err.write(`beak ${name}: ${err.message}\n`);
      if (err.code === 2) io.err.write(`${usage}\n`);
      return err.code;
    }
  };
}
