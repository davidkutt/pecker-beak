// `beak score <run> <round>` (plan.md §6): combine checks.json and judge.json into scorecard.json (evidence)
// and scorecard.md (what the writer reads). pass = every hard check passes AND every [must] criterion passes
// AND score >= pass_threshold. Holdout inputs count, but the writer only sees whether they passed.
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { roundDigest } from './checks.mjs';
import { ROUND_FILES, allCriteria, holdoutLabel, loadRun, parseRound, roundDir } from './run.mjs';
import { BeakError, command, plural, readJson, relPath, writeJson, writeText } from './util.mjs';

const USAGE = 'Usage: beak score <run> <round>';
const MAX_TOP_ISSUES = 3;

/**
 * Read checks.json and judge.json and make sure scripts wrote them for the files as they are now.
 * Throws BeakError naming the step to run again.
 */
export function readEvidence({ run, round }) {
  const dir = roundDir(run.dir, round);
  const digest = roundDigest(run.dir, round, run.inputs);
  const load = (file, generator, step) => {
    const full = path.join(dir, file);
    const again = `run beak ${step} ${run.id} ${round}`;
    if (!fs.existsSync(full)) throw new BeakError(`round ${round} has no ${file}: ${again}`);
    let data;
    try {
      data = readJson(full);
    } catch {
      throw new BeakError(`round ${round}: ${file} is not valid JSON; only beak ${step} writes it: ${again}`);
    }
    if (data.generator !== generator || data.run !== run.id || data.round !== round) {
      throw new BeakError(`round ${round}: ${file} was not written by beak ${step} for this round; only scripts write evidence: ${again}`);
    }
    if (data.digest !== digest) {
      throw new BeakError(`round ${round}: the prompt or an output changed after beak ${step} ran: ${again}`);
    }
    return data;
  };
  const checks = load(ROUND_FILES.checks, 'beak check', 'check');
  const judge = load(ROUND_FILES.judge, 'beak judge', 'judge');
  const want = allCriteria(run).map((c) => c.id).join(',');
  if (judge.criteria.map((c) => c.id).join(',') !== want) {
    throw new BeakError(`round ${round}: judge.json does not cover the run's current criteria (did /refine add some?): run beak judge ${run.id} ${round}`);
  }
  return { checks, judge };
}

/** A criterion whose text the writer may not see: it applies only to holdout inputs. */
export function hiddenCriterion(c, inputs) {
  return Array.isArray(c.inputs) && c.inputs.length > 0 && c.inputs.every((id) => inputs.find((i) => i.id === id)?.holdout);
}

/** Build scorecard.json from verified evidence. */
export function scoreRound({ run, round, checks, judge, threshold }) {
  const criteria = allCriteria(run);
  const isHoldout = (id) => Boolean(run.inputs.find((i) => i.id === id)?.holdout);
  const hardResults = [
    ...checks.prompt.map((r) => ({ ...r, where: 'prompt', holdout: false })),
    ...checks.outputs.flatMap((o) => o.results.map((r) => ({ ...r, where: o.input, holdout: o.holdout }))),
  ];
  const hardPassed = hardResults.filter((r) => r.pass).length;
  const byId = new Map(judge.criteria.map((c) => [c.id, c]));
  const musts = criteria.filter((c) => c.must);
  const mustPassed = musts.filter((c) => byId.get(c.id).pass).length;
  const critPassed = criteria.filter((c) => byId.get(c.id).pass).length;

  const hard = { passed: hardPassed, total: hardResults.length, pass: hardPassed === hardResults.length };
  const must = { passed: mustPassed, total: musts.length, pass: mustPassed === musts.length };
  const scoreOk = judge.score >= threshold;
  const reasons = [];
  if (!hard.pass) reasons.push(`${plural(hard.total - hard.passed, 'hard check')} failed`);
  const failedMusts = musts.filter((c) => !byId.get(c.id).pass).map((c) => c.id);
  if (failedMusts.length) reasons.push(`[must] ${failedMusts.length === 1 ? 'criterion' : 'criteria'} ${failedMusts.join(', ')} failed`);
  if (!scoreOk) reasons.push(`score ${judge.score} is below ${threshold}`);

  const failingChecks = hardResults
    .filter((r) => !r.pass)
    .map(({ where, holdout, check, value, sources, detail }) => ({ where, holdout, check, value, sources, detail }));
  const failingCriteria = criteria
    .filter((c) => !byId.get(c.id).pass)
    .map((c) => {
      const failed = byId.get(c.id).failed_inputs;
      return {
        id: c.id,
        must: c.must,
        text: c.text,
        hidden: hiddenCriterion(c, run.inputs),
        sources: c.sources,
        failed_inputs: failed.filter((id) => !isHoldout(id)),
        holdout_failures: failed.filter(isHoldout).length,
        fixes: judge.verdicts.filter((v) => v.criterion === c.id && !v.pass && !v.holdout && v.fix).map((v) => ({ input: v.input, fix: v.fix })),
      };
    });
  const holdoutResults = hardResults.filter((r) => r.holdout);
  const holdoutVerdicts = judge.verdicts.filter((v) => v.holdout);
  return {
    generator: 'beak score',
    run: run.id,
    round,
    pass: hard.pass && must.pass && scoreOk,
    score: judge.score,
    threshold,
    reasons,
    hard,
    must,
    criteria: { passed: critPassed, total: criteria.length },
    failing_checks: failingChecks,
    failing_criteria: failingCriteria,
    top_issues: topIssues({ failingChecks, failingCriteria, score: judge.score, threshold }),
    judge_top_issues: judge.top_issues,
    holdout: {
      inputs: run.inputs.filter((i) => i.holdout).length,
      checks: { passed: holdoutResults.filter((r) => r.pass).length, total: holdoutResults.length },
      verdicts: { passed: holdoutVerdicts.filter((v) => v.pass).length, total: holdoutVerdicts.length },
    },
  };
}

function describeCheck(r) {
  const what = {
    required_section: `missing section "${r.value}"`,
    required_phrase: `must contain "${r.value}"`,
    banned: `contains banned "${r.value}"`,
    max_words: `at most ${r.value} words`,
    min_words: `at least ${r.value} words`,
    max_chars: `at most ${r.value} characters`,
    min_chars: `at least ${r.value} characters`,
    placeholders: 'unresolved placeholders',
  }[r.check];
  return what ?? r.check;
}

/**
 * The writer's top issues, from visible evidence only: failing prompt checks, failing output checks,
 * failing [must] criteria, other failing criteria, then criteria that failed only on holdout inputs
 * (named, no details). At most 3.
 */
export function topIssues({ failingChecks, failingCriteria, score, threshold }) {
  const issues = [];
  const prompt = failingChecks.filter((r) => r.where === 'prompt');
  if (prompt.length) issues.push(`The prompt fails hard checks: ${prompt.map((r) => `${describeCheck(r)} (${r.detail})`).join('; ')}.`);
  const groups = new Map();
  for (const r of failingChecks.filter((x) => x.where !== 'prompt' && !x.holdout)) {
    const key = `${r.check}\0${r.value}`;
    if (!groups.has(key)) groups.set(key, { r, where: [] });
    groups.get(key).where.push(`${r.where}: ${r.detail}`);
  }
  for (const { r, where } of groups.values()) {
    issues.push(`Outputs break the hard check "${describeCheck(r)}" (${r.sources.join(', ')}): ${where.join('; ')}.`);
  }
  const hiddenChecks = new Map();
  for (const r of failingChecks.filter((x) => x.holdout)) {
    const key = `${r.check}\0${r.value}`;
    if (!groups.has(key) && !hiddenChecks.has(key)) hiddenChecks.set(key, r);
  }
  for (const r of hiddenChecks.values()) {
    issues.push(`A holdout output breaks the hard check "${describeCheck(r)}" (${r.sources.join(', ')}); details hidden.`);
  }
  const visible = failingCriteria.filter((c) => c.failed_inputs.length);
  const ordered = [...visible.filter((c) => c.must), ...visible.filter((c) => !c.must)];
  for (const c of ordered) {
    const fix = c.fixes[0]?.fix;
    issues.push(`${c.id}${c.must ? ' [must]' : ''} "${c.text}" failed on ${c.failed_inputs.join(', ')}.${fix ? ` Judge's fix: ${fix}` : ''}`);
  }
  for (const c of failingCriteria.filter((x) => !x.failed_inputs.length)) {
    const text = c.hidden ? 'a criterion for a holdout input' : `"${c.text}"`;
    issues.push(`${c.id}${c.must ? ' [must]' : ''} ${text} failed on ${plural(c.holdout_failures, 'holdout input')} only (details hidden). Make the prompt's instruction for it more general and explicit.`);
  }
  if (!issues.length && score < threshold) {
    issues.push(`Every check and criterion passed, but the judge's score is ${score} (needs ${threshold}). Make the prompt's instructions more concrete where the visible outputs are weakest.`);
  }
  return issues.slice(0, MAX_TOP_ISSUES);
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function shorten(text, n = 70) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** scorecard.md: the writer's view. Never contains holdout inputs, outputs, evidence or fixes. */
export function renderScorecard({ scorecard: s, run, checks, judge }) {
  const label = (id) => holdoutLabel(run.inputs, id);
  const out = [`# Scorecard: round ${s.round}`, ''];
  out.push(
    `**${s.pass ? 'PASS' : 'FAIL'}**: score ${s.score} (needs ${s.threshold}) · hard checks ${s.hard.passed}/${s.hard.total} · [must] criteria ${s.must.passed}/${s.must.total} · criteria ${s.criteria.passed}/${s.criteria.total}`,
    '',
  );
  if (!s.pass) out.push(`Why it fails: ${s.reasons.join('; ')}.`, '');
  out.push('## Top issues', '');
  if (s.top_issues.length) {
    out.push('Fix these, and only these, with targeted edits in the next round:', '');
    s.top_issues.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  } else out.push('None.');
  out.push('', '## Hard checks', '');
  const promptFails = checks.prompt.filter((r) => !r.pass);
  out.push(promptFails.length ? `- prompt: ${promptFails.map((r) => `FAIL ${describeCheck(r)} (${r.detail})`).join('; ')}` : `- prompt: all ${checks.prompt.length} passed`);
  for (const o of checks.outputs) {
    const fails = o.results.filter((r) => !r.pass);
    if (o.holdout) out.push(`- ${label(o.input)}: ${fails.length ? 'FAIL' : 'passed'} (details hidden)`);
    else out.push(fails.length ? `- ${o.input}: ${fails.map((r) => `FAIL ${describeCheck(r)} (${r.detail})`).join('; ')}` : `- ${o.input}: all ${o.results.length} passed`);
  }
  out.push('', '## Criteria', '');
  const columns = run.inputs.map((i) => (i.holdout ? label(i.id) : i.id));
  out.push(`| Criterion | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`);
  for (const c of allCriteria(run)) {
    const text = hiddenCriterion(c, run.inputs) ? '(a criterion for a holdout input)' : shorten(c.text);
    const cells = run.inputs.map((i) => {
      const v = judge.verdicts.find((x) => x.criterion === c.id && x.input === i.id);
      return v ? (v.pass ? 'pass' : 'FAIL') : '–';
    });
    out.push(`| ${cell(`${c.id}${c.must ? ' [must]' : ''} ${text}`)} | ${cells.join(' | ')} |`);
  }
  const feedback = judge.verdicts.filter((v) => !v.pass && !v.holdout);
  if (feedback.length) {
    out.push('', '## Judge feedback on failing criteria (visible inputs)', '');
    for (const v of feedback) {
      const quote = v.evidence ? ` Evidence: "${shorten(v.evidence, 160)}".` : '';
      out.push(`- ${v.criterion} on ${v.input}:${quote}${v.fix ? ` Fix: ${v.fix}` : ''}`);
    }
  }
  if (s.holdout.inputs) {
    out.push(
      '',
      `Holdout: ${plural(s.holdout.inputs, 'input')}, hard checks ${s.holdout.checks.passed}/${s.holdout.checks.total}, verdicts ${s.holdout.verdicts.passed}/${s.holdout.verdicts.total} passed. You only see pass or fail for them; do not guess their content.`,
    );
  }
  return `${out.join('\n')}\n`;
}

export const scoreCommand = command('score', USAGE, async (args, io, { cwd = process.cwd(), env = process.env } = {}) => {
  if (args.length !== 2) throw new BeakError('give the run id and the round number', 2);
  const round = parseRound(args[1]);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, args[0], cwd);
  const { checks, judge } = readEvidence({ run, round });
  const threshold = run.meta.loop?.pass_threshold ?? config.loop.pass_threshold;
  const scorecard = scoreRound({ run, round, checks, judge, threshold });
  const dir = roundDir(run.dir, round);
  writeJson(path.join(dir, ROUND_FILES.scorecardJson), scorecard);
  writeText(path.join(dir, ROUND_FILES.scorecardMd), renderScorecard({ scorecard, run, checks, judge }));
  io.out.write(
    `round ${round}: ${scorecard.pass ? 'PASS' : 'FAIL'} (score ${scorecard.score}/${threshold}, hard checks ${scorecard.hard.passed}/${scorecard.hard.total}, [must] ${scorecard.must.passed}/${scorecard.must.total})\n`,
  );
  io.out.write(`wrote ${relPath(config.root, path.join(dir, ROUND_FILES.scorecardMd))}\n`);
  io.out.write(`next: node tools/beak.mjs loop-status ${run.id}\n`);
  return 0;
});
