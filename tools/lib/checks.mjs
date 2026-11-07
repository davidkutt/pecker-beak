// Hard (deterministic) checks (plan.md §6 `beak check`): on the generated prompt and on every test output.
// Pure functions first; checkRound() and the CLI at the end.
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { ROUND_FILES, holdoutLabel, loadRun, outputPath, parseRound, roundDir } from './run.mjs';
import { BeakError, command, plural, relPath, sha256, writeJson } from './util.mjs';

const USAGE = 'Usage: beak check <run> <round>';

/** Words: whitespace-separated tokens that contain a letter or digit. */
export function countWords(text) {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

export function countChars(text) {
  return [...text.trim()].length;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a phrase, ignoring case and runs of whitespace. A phrase that starts or ends with a letter or digit
 * must not be part of a longer word there ("heilt" does not match "geheilt").
 * Returns { line, text } of the first match, or null.
 */
export function findPhrase(text, phrase) {
  const p = phrase.trim();
  if (!p) return null;
  const body = p.split(/\s+/).map(escapeRe).join('\\s+');
  const before = /^[\p{L}\p{N}]/u.test(p) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = /[\p{L}\p{N}]$/u.test(p) ? '(?![\\p{L}\\p{N}])' : '';
  const m = new RegExp(`${before}${body}${after}`, 'iu').exec(text);
  if (!m) return null;
  return { line: text.slice(0, m.index).split('\n').length, text: m[0] };
}

/** Lines of `text` outside code fences: [{ text, line }]. */
export function unfencedLines(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((t, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(t);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len && !marker[2].trim()) fence = null;
      return;
    }
    if (marker) {
      fence = { char: marker[1][0], len: marker[1].length };
      return;
    }
    out.push({ text: t, line: i + 1 });
  });
  return out;
}

const normalizeHeading = (s) =>
  s
    .replace(/^\s*(?:\d+[.)]\s*)?/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Markdown headings outside code fences: [{ name, line }]. */
export function headings(text) {
  return unfencedLines(text)
    .map(({ text: t, line }) => {
      const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(t);
      return m ? { name: m[1], line } : null;
    })
    .filter(Boolean);
}

export function findSection(text, name) {
  const want = normalizeHeading(name);
  return headings(text).find((h) => normalizeHeading(h.name) === want) ?? null;
}

/**
 * Unresolved placeholders in a prompt. Allowed: {{name}} for each runtime variable.
 * Reported: any other {{…}} (everywhere), and outside code fences: {name}, [Bracket placeholders] and TODO.
 * Returns [{ text, line, hint }].
 */
export function findPlaceholders(text, runtimeVars = []) {
  const found = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  for (const m of text.matchAll(/\{\{([^{}\n]*)\}\}/g)) {
    const name = m[1];
    if (runtimeVars.includes(name)) continue;
    const trimmed = name.trim();
    const hint = runtimeVars.includes(trimmed)
      ? `write it as {{${trimmed}}}, without spaces`
      : `not a runtime variable (${runtimeVars.length ? runtimeVars.map((v) => `{{${v}}}`).join(', ') : 'this task has none'})`;
    found.push({ text: m[0], line: lineOf(m.index), hint });
  }
  for (const { text: t, line } of unfencedLines(text)) {
    for (const m of t.matchAll(/(?<!\{)\{([a-z][a-z0-9_]*)\}(?!\})/g)) {
      const hint = runtimeVars.includes(m[1]) ? `write it as {{${m[1]}}}` : 'not a runtime variable';
      found.push({ text: m[0], line, hint });
    }
    for (const m of t.matchAll(/\[([^\]\n]{1,60})\](?![([:])/g)) {
      const inner = m[1].trim();
      if (!/^\p{Lu}/u.test(inner) || /^x$/i.test(inner)) continue;
      found.push({ text: m[0], line, hint: 'a bracket placeholder; write the real text or use a runtime variable' });
    }
    for (const m of t.matchAll(/\bTODO\b/g)) found.push({ text: m[0], line, hint: 'unfinished' });
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Run merged checks (from rubric.json) on one text. Returns [{ check, value, sources, pass, detail }].
 * `scope` is "prompt" or "output"; prompts also get the placeholder check.
 */
export function runChecks(text, checks, { scope, runtimeVars = [] } = {}) {
  const results = [];
  const add = (check, item, pass, detail) =>
    results.push({ check, value: item?.value ?? null, sources: item ? (item.sources ?? [item.source]) : [], pass, detail });
  for (const item of checks.required_sections ?? []) {
    const h = findSection(text, item.value);
    add('required_section', item, Boolean(h), h ? `"${h.name}" on line ${h.line}` : `no heading "${item.value}"`);
  }
  for (const item of checks.required_phrases ?? []) {
    const m = findPhrase(text, item.value);
    add('required_phrase', item, Boolean(m), m ? `on line ${m.line}` : `"${item.value}" not found`);
  }
  for (const item of checks.banned ?? []) {
    const m = findPhrase(text, item.value);
    add('banned', item, !m, m ? `"${m.text}" on line ${m.line}` : 'not found');
  }
  const words = countWords(text);
  const chars = countChars(text);
  const limit = (key, actual, unit, ok) => {
    const item = checks[key];
    if (item) add(key, item, ok(actual, item.value), `${actual} ${unit}`);
  };
  limit('max_words', words, 'words', (a, v) => a <= v);
  limit('min_words', words, 'words', (a, v) => a >= v);
  limit('max_chars', chars, 'characters', (a, v) => a <= v);
  limit('min_chars', chars, 'characters', (a, v) => a >= v);
  if (scope === 'prompt') {
    const found = findPlaceholders(text, runtimeVars);
    add(
      'placeholders',
      null,
      found.length === 0,
      found.length ? found.map((f) => `${f.text} on line ${f.line} (${f.hint})`).join('; ') : 'none',
    );
  }
  return results;
}

/** Merged output checks plus a test input's own checks (input_checks): lists unioned, numbers strictest. */
export function combineChecks(base, extra) {
  if (!extra) return base;
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      out[key] ??= [];
      for (const item of value) if (!out[key].some((x) => x.value.toLowerCase() === item.value.toLowerCase())) out[key].push(item);
    } else {
      const cur = out[key];
      if (!cur || (key.startsWith('max_') ? value.value < cur.value : value.value > cur.value)) out[key] = value;
    }
  }
  return out;
}

/**
 * Fingerprint of a round's prompt and outputs. check and judge record it; score refuses evidence whose
 * fingerprint no longer matches the files (the prompt or an output changed after it was checked).
 */
export function roundDigest(dir, round, inputs) {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '\0missing\0');
  const parts = [read(path.join(roundDir(dir, round), ROUND_FILES.prompt))];
  for (const input of inputs) parts.push(input.id, read(outputPath(dir, round, input)));
  return sha256(parts.join('\0'));
}

/** Read a round's test.json and make sure every output exists. Throws BeakError otherwise. */
export function requireTested(config, run, round) {
  const dir = roundDir(run.dir, round);
  const testFile = path.join(dir, ROUND_FILES.test);
  if (!fs.existsSync(testFile)) throw new BeakError(`round ${round} has no test outputs yet: run beak test ${run.id} ${round} first`);
  const test = JSON.parse(fs.readFileSync(testFile, 'utf8'));
  if (!test.ok) throw new BeakError(`round ${round}: the last beak test failed; run beak test ${run.id} ${round} again`);
  const prompt = path.join(dir, ROUND_FILES.prompt);
  if (!fs.existsSync(prompt) || sha256(fs.readFileSync(prompt, 'utf8')) !== test.prompt_sha256) {
    throw new BeakError(`round ${round}: prompt.md changed after beak test, so the outputs are from another prompt; run beak test ${run.id} ${round} again`);
  }
  for (const input of run.inputs) {
    if (!fs.existsSync(outputPath(run.dir, round, input))) {
      throw new BeakError(`round ${round}: ${relPath(config.root, outputPath(run.dir, round, input))} is missing; run beak test ${run.id} ${round} again`);
    }
  }
  return test;
}

/** All hard checks of one round. Returns the checks.json object. */
export function checkRound({ config, run, round }) {
  requireTested(config, run, round);
  const dir = roundDir(run.dir, round);
  const prompt = fs.readFileSync(path.join(dir, ROUND_FILES.prompt), 'utf8');
  const { rubric } = run;
  const promptResults = runChecks(prompt, rubric.checks.prompt, { scope: 'prompt', runtimeVars: rubric.runtime_vars });
  const outputs = run.inputs.map((input) => {
    const text = fs.readFileSync(outputPath(run.dir, round, input), 'utf8');
    const checks = combineChecks(rubric.checks.output, rubric.input_checks?.[input.id]);
    return { input: input.id, holdout: input.holdout, results: runChecks(text, checks, { scope: 'output' }) };
  });
  const all = [...promptResults, ...outputs.flatMap((o) => o.results)];
  const passed = all.filter((r) => r.pass).length;
  return {
    generator: 'beak check',
    run: run.id,
    round,
    digest: roundDigest(run.dir, round, run.inputs),
    prompt: promptResults,
    outputs,
    passed,
    total: all.length,
    pass: passed === all.length,
  };
}

export const checkCommand = command('check', USAGE, async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  if (args.length !== 2) throw new BeakError('give the run id and the round number', 2);
  const round = parseRound(args[1]);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, args[0], cwd);
  const result = checkRound({ config, run, round });
  const file = path.join(roundDir(run.dir, round), ROUND_FILES.checks);
  writeJson(file, result);
  const failedPrompt = result.prompt.filter((r) => !r.pass);
  io.out.write(`prompt: ${failedPrompt.length ? `${plural(failedPrompt.length, 'check')} failed` : 'all checks passed'}\n`);
  for (const r of failedPrompt) io.out.write(`  FAIL ${r.check}${r.value ? ` "${r.value}"` : ''}: ${r.detail}\n`);
  for (const o of result.outputs) {
    const failed = o.results.filter((r) => !r.pass);
    if (o.holdout) {
      io.out.write(`${holdoutLabel(run.inputs, o.input)}: ${failed.length ? 'failed' : 'passed'}\n`);
      continue;
    }
    io.out.write(`${o.input}: ${failed.length ? `${plural(failed.length, 'check')} failed` : 'all checks passed'}\n`);
    for (const r of failed) io.out.write(`  FAIL ${r.check}${r.value !== null ? ` ${r.value}` : ''}: ${r.detail}\n`);
  }
  io.out.write(`wrote ${relPath(config.root, file)}: ${result.passed}/${result.total} passed\n`);
  io.out.write(`next: node tools/beak.mjs judge ${run.id} ${round}\n`);
  return 0;
});
