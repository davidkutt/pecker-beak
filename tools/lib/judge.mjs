// `beak judge <run> <round>` (plan.md §6, §7): a fresh runner call with tools/prompts/judge.md, the criteria,
// the prompt and the outputs. The reply must be strict JSON (validated here, one retry when it is not).
// A pass without a verbatim evidence quote from the output counts as a fail.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, loadConfig } from './config.mjs';
import { requireTested, roundDigest } from './checks.mjs';
import { ROUND_FILES, allCriteria, clearAfter, loadRun, outputPath, parseRound, recordAttempt, roundDir } from './run.mjs';
import { RunnerError, getRunner } from './runner.mjs';
import { BeakError, command, fenced, plural, relPath, writeJson } from './util.mjs';

const USAGE = 'Usage: beak judge <run> <round>';
export const JUDGE_PROMPT = fileURLToPath(new URL('../prompts/judge.md', import.meta.url));
const MAX_TOP_ISSUES = 3;

/** The (criterion, input) pairs the judge must give verdicts for, in criterion order. */
export function judgePairs(criteria, inputs) {
  const pairs = [];
  for (const c of criteria) {
    for (const input of inputs) if (c.inputs === null || c.inputs === undefined || c.inputs.includes(input.id)) pairs.push({ criterion: c.id, input: input.id });
  }
  return pairs;
}

/** The judge's user message. Holdout inputs are not marked: the judge grades every output the same way. */
export function buildJudgeMessage({ criteria, inputs, prompt, outputs, pairs }) {
  const out = ['# Criteria', ''];
  for (const c of criteria) {
    const scope = c.inputs ? ` (only for input ${c.inputs.join(', ')})` : '';
    out.push(`- ${c.id}${c.must ? ' [must]' : ''}${scope}: ${c.text}`);
  }
  out.push('', '# System prompt the agent ran with', '', fenced(prompt, 'markdown'), '', '# Test inputs and outputs', '');
  for (const input of inputs) {
    out.push(`## Input: ${input.id}`, '');
    if (input.notes) out.push(`What a good response does: ${input.notes}`, '');
    out.push('User message:', '', fenced(input.input), '', 'Agent output:', '', fenced(outputs[input.id]), '');
  }
  out.push('# Verdicts to give', '', `Give exactly one verdict for each of these ${pairs.length} pairs (criterion, input):`, '');
  for (const p of pairs) out.push(`- ${p.criterion}, ${p.input}`);
  out.push('', 'Reply with the JSON object only.');
  return out.join('\n');
}

/** Parse a judge reply: the JSON object, optionally inside a code fence or surrounded by text. */
export function extractJson(text) {
  const t = text.trim().replace(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i, '$1');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end < start) return { error: 'the reply contains no JSON object' };
  try {
    return { value: JSON.parse(t.slice(start, end + 1)) };
  } catch (err) {
    return { error: `the reply is not valid JSON (${err.message})` };
  }
}

/**
 * Check a parsed reply against the schema and the expected pairs. Returns a list of problems (empty = valid).
 * Schema: { verdicts: [{ criterion, input, pass: boolean, evidence: string, fix: string }], score: 0–100,
 * top_issues: at most 3 strings }, with exactly one verdict per expected pair.
 */
export function validateJudgeReply(value, pairs) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['the reply must be a JSON object'];
  for (const key of Object.keys(value)) if (!['verdicts', 'score', 'top_issues'].includes(key)) errors.push(`unknown field "${key}"`);
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    errors.push('"score" must be a number from 0 to 100');
  }
  if (!Array.isArray(value.top_issues) || value.top_issues.some((t) => typeof t !== 'string')) {
    errors.push('"top_issues" must be a list of strings');
  } else if (value.top_issues.length > MAX_TOP_ISSUES) {
    errors.push(`"top_issues" has ${value.top_issues.length} entries; at most ${MAX_TOP_ISSUES}`);
  }
  if (!Array.isArray(value.verdicts)) return [...errors, '"verdicts" must be a list'];
  const expected = new Set(pairs.map((p) => `${p.criterion}\0${p.input}`));
  const seen = new Set();
  value.verdicts.forEach((v, i) => {
    const at = `verdicts[${i}]`;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return errors.push(`${at} must be an object`);
    for (const key of Object.keys(v)) if (!['criterion', 'input', 'pass', 'evidence', 'fix'].includes(key)) errors.push(`${at} has an unknown field "${key}"`);
    if (typeof v.pass !== 'boolean') errors.push(`${at}.pass must be true or false`);
    if (typeof v.evidence !== 'string') errors.push(`${at}.evidence must be a string`);
    if (typeof v.fix !== 'string') errors.push(`${at}.fix must be a string`);
    const key = `${v.criterion}\0${v.input}`;
    if (!expected.has(key)) errors.push(`${at}: (${v.criterion}, ${v.input}) is not one of the pairs to judge`);
    else if (seen.has(key)) errors.push(`${at}: (${v.criterion}, ${v.input}) is judged twice`);
    seen.add(key);
  });
  const missing = pairs.filter((p) => !seen.has(`${p.criterion}\0${p.input}`));
  if (missing.length) {
    const list = missing.slice(0, 5).map((p) => `(${p.criterion}, ${p.input})`).join(', ');
    errors.push(`missing verdicts for ${plural(missing.length, 'pair')}: ${list}${missing.length > 5 ? ', …' : ''}`);
  }
  return errors;
}

function normalize(s) {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Is the evidence a verbatim quote from the output? Ignores case, whitespace and quote/dash styles; "…" or
 * "..." may join several quoted passages, each of which must be in the output.
 */
export function evidenceFound(output, evidence) {
  if (typeof evidence !== 'string') return false;
  const e = normalize(evidence).replace(/^["']+|["']+$/g, '').trim();
  if (!e) return false;
  const fragments = e.split(/\s*\.\.\.\s*/).map((f) => f.replace(/^["']+|["']+$/g, '').trim()).filter(Boolean);
  if (!fragments.length) return false;
  const o = normalize(output);
  return fragments.every((f) => o.includes(f));
}

/**
 * Combine one or more valid judge replies. Each verdict counts as a pass only with evidence found in the
 * output; with several samples, a pair passes when more than half of them say so (majority vote).
 * Returns { score, top_issues, criteria, verdicts }.
 */
export function aggregateSamples({ samples, pairs, criteria, inputs, outputs }) {
  const n = samples.length;
  const holdout = new Map(inputs.map((i) => [i.id, i.holdout]));
  const verdicts = pairs.map((p) => {
    const votes = samples.map((s) => {
      const v = s.verdicts.find((x) => x.criterion === p.criterion && x.input === p.input);
      const found = v.pass ? evidenceFound(outputs[p.input], v.evidence) : null;
      return { ...v, found, effective: v.pass && found };
    });
    const yes = votes.filter((v) => v.effective).length;
    const pass = yes * 2 > n;
    const pick = votes.find((v) => v.effective === pass);
    const passWithoutEvidence = votes.some((v) => v.pass && !v.found);
    return {
      criterion: p.criterion,
      input: p.input,
      holdout: holdout.get(p.input),
      pass,
      votes: `${yes}/${n}`,
      evidence: pick.evidence,
      evidence_found: pick.found,
      fix: pass ? pick.fix : pick.fix || (passWithoutEvidence ? 'The judge passed this without a verbatim quote from the output, so it counts as a fail.' : ''),
    };
  });
  const scores = samples.map((s) => s.score).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const score = Math.round(n % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2);
  const closest = samples.reduce((best, s) => (Math.abs(s.score - score) < Math.abs(best.score - score) ? s : best), samples[0]);
  const summary = criteria.map((c) => {
    const mine = verdicts.filter((v) => v.criterion === c.id);
    const failed = mine.filter((v) => !v.pass).map((v) => v.input);
    return { id: c.id, must: c.must, pass: failed.length === 0, failed_inputs: failed };
  });
  return { score, top_issues: closest.top_issues, criteria: summary, verdicts };
}

/**
 * Judge one round. Returns { ok: true, judge } or { ok: false, error }. Every outcome is recorded in
 * round-N/runner.json for the `error` stop rule.
 */
export async function judgeRound({ config, run, round, runner }) {
  requireTested(config, run, round);
  const dir = roundDir(run.dir, round);
  if (fs.existsSync(path.join(dir, ROUND_FILES.scorecardJson))) {
    throw new BeakError(`round ${round} is already scored; a new prompt goes into round-${round + 1}/`);
  }
  const prompt = fs.readFileSync(path.join(dir, ROUND_FILES.prompt), 'utf8');
  const outputs = Object.fromEntries(run.inputs.map((i) => [i.id, fs.readFileSync(outputPath(run.dir, round, i), 'utf8')]));
  const criteria = allCriteria(run);
  const pairs = judgePairs(criteria, run.inputs);
  const system = fs.readFileSync(JUDGE_PROMPT, 'utf8');
  const message = buildJudgeMessage({ criteria, inputs: run.inputs, prompt, outputs, pairs });
  const model = run.meta.models.judge;
  const n = run.meta.loop?.judge_samples ?? config.loop.judge_samples;

  const sample = async (k) => {
    const key = n > 1 ? `round-${round}/sample-${k}` : `round-${round}`;
    const raw = [];
    let input = message;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = await runner.call({ role: 'judge', key: attempt === 1 ? key : `${key}/attempt-2`, system, input, model, context: { pairs, outputs } });
      raw.push(reply);
      const parsed = extractJson(reply);
      const errors = parsed.error ? [parsed.error] : validateJudgeReply(parsed.value, pairs);
      if (!errors.length) return { value: parsed.value, raw };
      if (attempt === 2) {
        const err = new RunnerError(`the judge's reply was invalid twice: ${errors.slice(0, 3).join('; ')}`);
        err.raw = raw;
        throw err;
      }
      input = `${message}\n\n# Your previous reply was invalid\n\n${errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}\n\nReply again, with one JSON object of exactly the required shape and nothing else.`;
    }
    throw new Error('unreachable');
  };

  let results;
  try {
    results = await Promise.all(Array.from({ length: n }, (_, i) => sample(i + 1)));
  } catch (err) {
    if (!(err instanceof RunnerError)) throw err;
    recordAttempt(run.dir, round, { step: 'judge', ok: false, error: err.message, ...(err.raw ? { raw: err.raw.map((r) => r.slice(0, 2000)) } : {}) });
    return { ok: false, error: err.message };
  }
  clearAfter(run.dir, round, 'judge');
  const agg = aggregateSamples({ samples: results.map((r) => r.value), pairs, criteria, inputs: run.inputs, outputs });
  const judge = {
    generator: 'beak judge',
    run: run.id,
    round,
    judge: model,
    runner: runner.name,
    digest: roundDigest(run.dir, round, run.inputs),
    samples: n,
    score: agg.score,
    top_issues: agg.top_issues,
    criteria: agg.criteria,
    verdicts: agg.verdicts,
    raw: results.flatMap((r) => r.raw),
  };
  writeJson(path.join(dir, ROUND_FILES.judge), judge);
  recordAttempt(run.dir, round, { step: 'judge', ok: true });
  return { ok: true, judge };
}

export const judgeCommand = command('judge', USAGE, async (args, io, { cwd = process.cwd(), env = process.env, runner } = {}) => {
  if (args.length !== 2) throw new BeakError('give the run id and the round number', 2);
  const round = parseRound(args[1]);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, args[0], cwd);
  const result = await judgeRound({ config, run, round, runner: runner ?? getRunner(config, env) });
  if (!result.ok) {
    io.err.write(`beak judge: ${result.error}\nrun beak loop-status ${run.id} to see what to do\n`);
    return 1;
  }
  const { judge } = result;
  const visible = judge.criteria.map((c) => {
    const failedVisible = c.failed_inputs.filter((id) => !run.inputs.find((i) => i.id === id)?.holdout);
    const failedHoldout = c.failed_inputs.length - failedVisible.length;
    return { ...c, failedVisible, failedHoldout };
  });
  const failing = visible.filter((c) => !c.pass);
  io.out.write(`score ${judge.score}; ${judge.criteria.length - failing.length}/${judge.criteria.length} criteria passed on every output\n`);
  for (const c of failing) {
    const where = [...c.failedVisible, ...(c.failedHoldout ? [plural(c.failedHoldout, 'holdout input')] : [])].join(', ');
    io.out.write(`  FAIL ${c.id}${c.must ? ' [must]' : ''}: ${where}\n`);
  }
  io.out.write(`wrote ${relPath(config.root, path.join(roundDir(run.dir, round), ROUND_FILES.judge))}\n`);
  io.out.write(`next: node tools/beak.mjs score ${run.id} ${round}\n`);
  return 0;
});
