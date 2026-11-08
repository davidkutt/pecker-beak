// `beak bundle key=value…` (plan.md §4 "Merging rules", §6): pick the run's blocks, merge their checks and
// criteria into rubric.json, and write runs/<run-id>/ with bundle.md, rubric.json, meta.json and inputs.json.
import fs from 'node:fs';
import path from 'node:path';
import { SLUG_RE, findRoot, loadConfig, selectModels } from './config.mjs';
import { BLOCK_TYPES, CHECK_KEYS, isTodo } from './blocks.mjs';
import { findPhrase } from './checks.mjs';
import { loadLibrary } from './library.mjs';
import { formatFindings, lint } from './lint.mjs';
import { RUN_FILES, libraryHash, roundDir } from './run.mjs';
import { BeakError, command, fenced, localStamp, parseArgs, plural, readDoc, relPath, writeJson, writeText } from './util.mjs';

export const BUNDLE_KEYS = Object.freeze(['task', 'customer', 'industry', 'tone', 'scenario', 'context', 'tester', 'judge']);
/** Order of blocks in bundle.md, rubric.json and meta.json. Context blocks come last. */
export const BLOCK_ORDER = Object.freeze(['task', 'customer', 'industry', 'tone', 'scenario', 'context']);
/** Single-value fields (language): the most specific block wins. */
export const PRECEDENCE = Object.freeze(['scenario', 'customer', 'industry', 'tone', 'task']);

const USAGE = 'Usage: beak bundle task=<id> [customer=<id>] [industry=<id>] [tone=<id>] [scenario=<id>] [context=<id>,<id>] [tester=<model>] [judge=<model>]';

// ---------------------------------------------------------------------------------------------------------
// Which blocks a run uses

/**
 * Pick the run's blocks from the library. A customer implies its industry and default tone unless they are
 * given; without a customer or tone, the task's default_tone is used. `values` are the command-line slugs.
 * Returns { picked: [{ role, block, via }], problems, warnings }, picked in BLOCK_ORDER.
 * `via` says why a block is in the run: "argument", "customer acme-pharma" or "task cold-email".
 */
export function resolveBlocks(library, values, { libraryPath = 'library' } = {}) {
  const problems = [];
  const warnings = [];
  const picked = [];
  const pick = (role, id, via) => {
    const block = library.byType[role].get(id);
    if (!block) {
      problems.push(`${role} "${id}" not found: there is no ${libraryPath}/${BLOCK_TYPES[role]}/${id}.md`);
      return null;
    }
    picked.push({ role, block, via });
    return block;
  };
  // A reference field on a block: skipped with a warning while it is still a TODO.
  const implied = (from, key, role) => {
    const value = from?.frontmatter?.[key];
    if (value === undefined) return undefined;
    if (isTodo(value)) {
      warnings.push(`${from.type} ${from.id} has no ${key} yet (${String(value).trim()}); pass ${role}=… to choose one`);
      return undefined;
    }
    return typeof value === 'string' && SLUG_RE.test(value) ? value : undefined;
  };

  const task = pick('task', values.task, 'argument');
  const customer = values.customer ? pick('customer', values.customer, 'argument') : null;

  if (values.industry) pick('industry', values.industry, 'argument');
  else {
    const id = implied(customer, 'industry', 'industry');
    if (id) pick('industry', id, `customer ${customer.id}`);
  }

  if (values.tone) pick('tone', values.tone, 'argument');
  else {
    const fromCustomer = implied(customer, 'default_tone', 'tone');
    const fromTask = fromCustomer ? undefined : implied(task, 'default_tone', 'tone');
    if (fromCustomer) pick('tone', fromCustomer, `customer ${customer.id}`);
    else if (fromTask) pick('tone', fromTask, `task ${task.id}`);
    else if (task) warnings.push('no tone: pass tone=… or give the customer or task a default_tone');
  }

  if (values.scenario) pick('scenario', values.scenario, 'argument');
  const contexts = values.context ? [...new Set(values.context.split(','))] : [];
  for (const id of contexts) pick('context', id, 'argument');

  picked.sort((a, b) => BLOCK_ORDER.indexOf(a.role) - BLOCK_ORDER.indexOf(b.role));
  return { picked, problems, warnings };
}

/** `<customer|industry>-<tone>[-<scenario>]` (plan §6); "generic" when there is neither customer nor industry. */
export function variantName(picked) {
  const id = (role) => picked.find((p) => p.role === role)?.block.id;
  return [id('customer') ?? id('industry') ?? 'generic', id('tone'), id('scenario')].filter(Boolean).join('-');
}

// ---------------------------------------------------------------------------------------------------------
// Merging (plan §4): lists are unioned with their sources, numbers take the strictest value

/**
 * Merge the checks of one scope (`output` or `prompt`) from several blocks.
 * `entries`: [{ source, checks }] where `checks` is a block's checks.<scope> (may be missing).
 * `base`: an already merged result to add to (it is not changed).
 * Returns { merged, problems }. Lists become [{ value, sources }] (deduplicated, ignoring case);
 * numbers become { value, source } (max_* → the smallest, min_* → the largest). min > max is a problem, and so is
 * a required phrase that contains a banned one (matched like `beak check` does, with findPhrase()).
 */
export function mergeChecks(scope, entries, base = {}) {
  const merged = structuredClone(base);
  for (const { source, checks } of entries) {
    if (!checks || typeof checks !== 'object') continue;
    for (const key of CHECK_KEYS[scope]) {
      const value = checks[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) addList(merged, key, value, source);
      else if (Number.isInteger(value)) addNumber(merged, key, value, source);
    }
  }
  const problems = [];
  for (const unit of ['words', 'chars']) {
    const min = merged[`min_${unit}`];
    const max = merged[`max_${unit}`];
    if (min && max && min.value > max.value) {
      problems.push(
        `${scope} checks conflict: min_${unit} ${min.value} (from ${min.source}) is larger than max_${unit} ${max.value} (from ${max.source})`,
      );
    }
  }
  for (const req of merged.required_phrases ?? []) {
    for (const ban of merged.banned ?? []) {
      if (findPhrase(req.value, ban.value)) {
        problems.push(
          `${scope} checks conflict: required phrase "${req.value}" (from ${req.sources.join(', ')}) contains banned "${ban.value}" (from ${ban.sources.join(', ')})`,
        );
      }
    }
  }
  return { merged: canonical(scope, merged), problems };
}

function addList(merged, key, values, source) {
  const list = (merged[key] ??= []);
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const found = list.find((x) => sameText(x.value, value));
    if (!found) list.push({ value, sources: [source] });
    else if (!found.sources.includes(source)) found.sources.push(source);
  }
}

function addNumber(merged, key, value, source) {
  const current = merged[key];
  const stricter = !current || (key.startsWith('max_') ? value < current.value : value > current.value);
  if (stricter) merged[key] = { value, source };
}

function canonical(scope, merged) {
  const out = {};
  for (const key of CHECK_KEYS[scope]) if (merged[key] !== undefined && !(Array.isArray(merged[key]) && !merged[key].length)) out[key] = merged[key];
  return out;
}

function sameText(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Union the "## Done when" criteria of the picked blocks, then add the criteria of scenario test inputs,
 * which apply only to that input's output. Ids are C1, C2, … in this order.
 * Returns [{ id, text, must, sources, learned, inputs }] (inputs: null = every output).
 */
export function mergeCriteria(picked, scenarioInputs = []) {
  const list = [];
  const add = (item, source, inputs) => {
    const found = list.find((c) => sameText(c.text, item.criterion));
    if (found) {
      if (found.inputs === null) return addSource(found, source, item);
      if (inputs === null) found.inputs = null;
      else for (const id of inputs) if (!found.inputs.includes(id)) found.inputs.push(id);
      return addSource(found, source, item);
    }
    list.push({ text: item.criterion, must: item.must, sources: [source], learned: item.learned ?? null, inputs });
  };
  for (const { block } of picked) for (const item of block.doneWhen) add(item, block.id, null);
  for (const { input, block } of scenarioInputs) for (const item of block.doneWhen) add(item, block.id, [input.id]);
  return list.map((c, i) => ({ id: `C${i + 1}`, ...c }));
}

function addSource(found, source, item) {
  if (!found.sources.includes(source)) found.sources.push(source);
  found.must ||= item.must;
  found.learned ??= item.learned ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Test inputs

/**
 * The run's test inputs: the scenario's own input when the run names a scenario, otherwise the first
 * `loop.test_inputs` entries of the task's test_inputs. The last `loop.holdout` inputs are holdout inputs
 * (at least one input stays visible to the writer).
 * Returns { inputs: [{ id, input, notes, source, holdout }], scenarioInputs: [{ input, block }], problems, warnings }.
 */
export function selectTestInputs({ task, scenario, library, loop }) {
  const problems = [];
  const warnings = [];
  const inputs = [];
  const scenarioInputs = [];
  const fromScenario = (block) => {
    const input = { id: block.id, input: block.frontmatter.input, notes: block.frontmatter.notes ?? null, source: 'scenario', holdout: false };
    inputs.push(input);
    return input;
  };
  if (scenario) {
    fromScenario(scenario);
    warnings.push(
      `scenario ${scenario.id}: the run is tested on that scenario's input only (1 test input, no holdout; loop.test_inputs is ${loop.test_inputs})`,
    );
  } else {
    const all = Array.isArray(task.frontmatter.test_inputs) ? task.frontmatter.test_inputs : [];
    if (all.length > loop.test_inputs) {
      warnings.push(`task ${task.id} has ${all.length} test inputs; this run uses the first ${loop.test_inputs} (loop.test_inputs)`);
    }
    for (const item of all.slice(0, loop.test_inputs)) {
      if (typeof item === 'string') {
        const block = library.byType.scenario.get(item);
        if (!block) problems.push(`test input "${item}" of task ${task.id} is not a scenario in the library`);
        else scenarioInputs.push({ input: fromScenario(block), block });
      } else if (item && typeof item === 'object') {
        inputs.push({ id: item.id, input: item.input, notes: null, source: 'task', holdout: false });
      }
    }
  }
  if (!inputs.length && !problems.length) problems.push(`task ${task.id} has no test inputs`);
  const holdout = Math.min(loop.holdout, Math.max(inputs.length - 1, 0));
  if (holdout < loop.holdout && !scenario && inputs.length) {
    warnings.push(`only ${plural(holdout, 'holdout input')} (loop.holdout is ${loop.holdout}): the writer must see at least one input`);
  }
  for (const input of inputs.slice(inputs.length - holdout)) input.holdout = true;
  return { inputs, scenarioInputs, problems, warnings };
}

/** The run's language: the first block in PRECEDENCE order that sets one. Returns { value, source } or null. */
export function resolveLanguage(picked) {
  for (const role of PRECEDENCE) {
    for (const { block } of picked.filter((p) => p.role === role)) {
      const value = block.frontmatter?.language;
      if (typeof value === 'string' && !isTodo(value)) return { value, source: block.id };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// The whole plan for a run

/**
 * Everything `beak bundle` decides, without writing anything.
 * Returns { problems, warnings, picked, variant, task, consumer, language, rubric, inputs, golden, models, args }.
 */
export function planBundle({ config, library, values }) {
  const problems = [];
  const warnings = [];
  for (const [key, value] of Object.entries(values)) {
    if (key === 'tester' || key === 'judge') continue; // model names, checked by selectModels()
    const ids = key === 'context' ? value.split(',') : [value];
    for (const id of ids) {
      if (!SLUG_RE.test(id)) problems.push(`${key}=${value}: "${id}" is not an id (lowercase letters, digits and hyphens)`);
    }
  }
  if (problems.length) return { problems, warnings };

  const { roles: models, problems: modelProblems } = selectModels(
    config,
    Object.fromEntries(['tester', 'judge'].filter((r) => values[r] !== undefined).map((r) => [r, values[r]])),
  );
  problems.push(...modelProblems);

  const resolved = resolveBlocks(library, values, { libraryPath: config.paths.library });
  problems.push(...resolved.problems);
  warnings.push(...resolved.warnings);
  if (problems.length) return { problems, warnings };
  const { picked } = resolved;

  // The run's blocks must lint clean; their warnings (TODOs) are passed on.
  const files = new Set(picked.map((p) => p.block.file));
  const findings = lint({ config }).findings.filter((f) => files.has(f.file));
  const errors = findings.filter((f) => f.level === 'error');
  if (errors.length) {
    problems.push(`these blocks have lint errors; fix them first (beak lint):\n${formatFindings(errors).map((l) => `  ${l}`).join('\n')}`);
    return { problems, warnings };
  }
  warnings.push(...formatFindings(findings));

  const block = (role) => picked.find((p) => p.role === role)?.block;
  const task = block('task');
  const scenario = block('scenario');
  const fm = task.frontmatter;

  const tests = selectTestInputs({ task, scenario, library, loop: config.loop });
  problems.push(...tests.problems);
  warnings.push(...tests.warnings);

  // Checks: the task's output_format sections are required sections of the prompt.
  const promptEntries = [
    { source: task.id, checks: { required_sections: fm.output_format } },
    ...picked.map((p) => ({ source: p.block.id, checks: p.block.frontmatter.checks?.prompt })),
  ];
  const prompt = mergeChecks('prompt', promptEntries);
  const output = mergeChecks('output', picked.map((p) => ({ source: p.block.id, checks: p.block.frontmatter.checks?.output })));
  problems.push(...prompt.problems, ...output.problems);
  const inputChecks = {};
  for (const { input, block: sc } of tests.scenarioInputs) {
    const own = sc.frontmatter.checks?.output;
    if (!own) continue;
    const merged = mergeChecks('output', [{ source: sc.id, checks: own }], output.merged);
    problems.push(...merged.problems.map((p) => `test input ${input.id}: ${p}`));
    const extra = mergeChecks('output', [{ source: sc.id, checks: own }]).merged;
    if (Object.keys(extra).length) inputChecks[input.id] = extra;
  }

  const language = resolveLanguage(picked);
  if (!language) warnings.push('no block sets a language; the writer has to pick one');
  const tone = block('tone');
  if (language && typeof tone?.frontmatter.language === 'string' && tone.frontmatter.language !== language.value) {
    warnings.push(`language is ${language.value} (from ${language.source}), but tone ${tone.id} is ${tone.frontmatter.language}`);
  }

  let golden = null;
  if (typeof fm.golden === 'string' && fm.golden.trim()) {
    const file = path.resolve(config.root, fm.golden);
    if (!fs.existsSync(file)) problems.push(`task ${task.id}: golden "${fm.golden}" not found`);
    else {
      const text = fs.readFileSync(file, 'utf8');
      golden = { path: fm.golden, text: readDoc(text)?.body ?? text.trim() };
    }
  }

  const rubric = {
    runtime_vars: fm.runtime_vars ?? [],
    checks: { prompt: prompt.merged, output: output.merged },
    input_checks: inputChecks,
    criteria: mergeCriteria(picked, tests.scenarioInputs),
  };
  const args = Object.fromEntries(BUNDLE_KEYS.filter((k) => values[k] !== undefined).map((k) => [k, values[k]]));
  return {
    problems,
    warnings,
    picked,
    variant: variantName(picked),
    task,
    consumer: fm.consumer,
    language,
    rubric,
    inputs: tests.inputs,
    golden,
    models,
    args,
  };
}

/** A run id that is not taken yet: <yyyymmdd-hhmm>-<task>-<variant>, then -2, -3, … */
export function newRunId(config, plan, now) {
  const base = `${localStamp(now)}-${plan.task.id}-${plan.variant}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(config.dirs.runs, id)); n++) id = `${base}-${n}`;
  return id;
}

/** Write the run folder for a plan from planBundle(). Returns { id, dir }. `batch`: the batch id of a batch run (M9). */
export function writeRun({ config, library, plan, now = new Date(), batch = null }) {
  const id = newRunId(config, plan, now);
  const dir = path.join(config.dirs.runs, id);
  const meta = {
    run: id,
    task: plan.task.id,
    variant: plan.variant,
    consumer: plan.consumer,
    args: plan.args,
    blocks: plan.picked.map(({ role, block, via }) => ({
      type: role,
      id: block.id,
      version: block.frontmatter.version,
      path: relPath(config.root, block.path),
      via,
    })),
    language: plan.language,
    output_format: plan.task.frontmatter.output_format,
    runtime_vars: plan.rubric.runtime_vars,
    golden: plan.golden?.path ?? null,
    test_inputs: plan.inputs.map(({ id: inputId, source, holdout }) => ({ id: inputId, source, holdout })),
    models: plan.models,
    loop: { ...config.loop },
    library_hash: libraryHash(config, library),
    ...(batch ? { batch } : {}),
  };
  fs.mkdirSync(roundDir(dir, 0), { recursive: true });
  writeJson(path.join(dir, RUN_FILES.meta), meta);
  writeJson(path.join(dir, RUN_FILES.rubric), { run: id, ...plan.rubric });
  writeJson(path.join(dir, RUN_FILES.inputs), { run: id, inputs: plan.inputs });
  writeText(path.join(dir, RUN_FILES.bundle), renderBundle({ id, plan, meta }));
  return { id, dir };
}

// ---------------------------------------------------------------------------------------------------------
// bundle.md: what the writer reads

/** Human-readable descriptions of merged checks, one line each. */
export function describeChecks(checks, scope) {
  const lines = [];
  const src = (x) => `(${(x.sources ?? [x.source]).join(', ')})`;
  for (const s of checks.required_sections ?? []) lines.push(`has a section headed "${s.value}" ${src(s)}`);
  for (const s of checks.required_phrases ?? []) lines.push(`contains "${s.value}" ${src(s)}`);
  for (const s of checks.banned ?? []) lines.push(`never contains "${s.value}" ${src(s)}`);
  const n = (key, text) => checks[key] && lines.push(`${text.replace('#', checks[key].value)} ${src(checks[key])}`);
  n('max_words', 'at most # words');
  n('min_words', 'at least # words');
  n('max_chars', 'at most # characters');
  n('min_chars', 'at least # characters');
  if (scope === 'prompt') lines.push('no placeholders except the runtime variables, and no TODO (always on)');
  return lines;
}

export function criterionLine(c) {
  return `${c.id}${c.must ? ' [must]' : ''} ${c.text} (${c.sources.join(', ')})`;
}

export function renderBundle({ id, plan, meta }) {
  const { task, rubric } = plan;
  const vars = rubric.runtime_vars;
  const visible = plan.inputs.filter((i) => !i.holdout);
  const hidden = plan.inputs.length - visible.length;
  const out = [];
  out.push(`# Bundle: ${task.id} / ${plan.variant}`, '');
  out.push(`- Run: ${id}`);
  out.push(`- Task: ${task.id} v${task.frontmatter.version}, for the consumer agent ${plan.consumer}`);
  out.push(`- Blocks: ${meta.blocks.map((b) => `${b.type} ${b.id} v${b.version}${b.via === 'argument' ? '' : ` (via ${b.via})`}`).join('; ')}`);
  out.push(`- Language: ${plan.language ? `${plan.language.value} (from ${plan.language.source})` : 'not set'}`);
  out.push(`- Models: tester ${plan.models.tester.name}, judge ${plan.models.judge.name}`);
  out.push('');
  out.push('## What to write', '');
  out.push(`Write \`round-0/prompt.md\` in this run folder: the system prompt for ${plan.consumer}, and \`round-0/changes.md\` ("first draft").`);
  out.push('');
  out.push(`- Sections, in this order, each as a Markdown heading: ${task.frontmatter.output_format.join(', ')}.`);
  out.push(`- Language: ${plan.language?.value ?? 'ask the user'}.`);
  out.push(
    vars.length
      ? `- Placeholders: only ${vars.map((v) => `{{${v}}}`).join(', ')}, written exactly like that. The consumer fills them at runtime. Any other placeholder fails a hard check.`
      : '- Placeholders: none. The prompt must be complete as it is.',
  );
  out.push('- Copy examples verbatim from the blocks below.');
  if (plan.golden) out.push(`- A golden prompt exists (${plan.golden.path}, below): keep its structure, swap the content.`);
  out.push('');
  out.push('## Hard checks', '', 'Checked by `beak check`, not by the judge.', '');
  out.push('The prompt:');
  for (const l of describeChecks(rubric.checks.prompt, 'prompt')) out.push(`- ${l}`);
  out.push('', 'Every output of the consumer agent:');
  const outputLines = describeChecks(rubric.checks.output, 'output');
  for (const l of outputLines.length ? outputLines : ['(no hard checks)']) out.push(`- ${l}`);
  out.push('', '## Judge criteria', '', 'The judge checks every output against these. `[must]` criteria block a pass.', '');
  for (const c of rubric.criteria.filter((x) => x.inputs === null)) out.push(`- ${criterionLine(c)}`);
  out.push('', '## Test inputs', '');
  out.push('Each test input is sent to the consumer agent as the user message, with your prompt as the system prompt.', '');
  for (const input of visible) {
    out.push(`### ${input.id}`, '', fenced(input.input), '');
    if (input.notes) out.push(`What a good response does: ${input.notes}`, '');
    const own = rubric.criteria.filter((c) => c.inputs?.includes(input.id));
    if (own.length) {
      out.push('Criteria for this input only:');
      for (const c of own) out.push(`- ${criterionLine(c)}`);
      out.push('');
    }
    const checks = rubric.input_checks[input.id];
    if (checks) {
      out.push('Hard checks for this input only:');
      for (const l of describeChecks(checks, 'output')) out.push(`- ${l}`);
      out.push('');
    }
  }
  if (hidden) {
    out.push(
      `${plural(hidden, 'more input is', 'more inputs are')} held out: judged like the others, but you only see whether it passed. Do not guess or tune for it.`,
      '',
    );
  }
  if (plan.golden) out.push('## Golden prompt (structural reference)', '', fenced(plan.golden.text, 'markdown'), '');
  out.push('## Blocks', '');
  for (const { role, block } of plan.picked) {
    out.push(`### ${role} ${block.id} v${block.frontmatter.version}${block.title ? `: ${block.title.text}` : ''}`, '');
    if (role === 'scenario') {
      out.push('Input:', '', fenced(block.frontmatter.input), '');
      if (block.frontmatter.notes) out.push(`Notes: ${block.frontmatter.notes}`, '');
    }
    for (const section of block.sections) {
      const lines = trimLines(section.lines.map((l) => l.text));
      out.push(`#### ${section.name}`, '', ...(lines.length ? lines : ['(empty)']), '');
    }
  }
  return out.join('\n');
}

function trimLines(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

// ---------------------------------------------------------------------------------------------------------
// CLI

export const bundleCommand = command('bundle', USAGE, async (args, io, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) => {
  const { values, positional, problems } = parseArgs(args, { keys: BUNDLE_KEYS });
  if (problems.length) throw new BeakError(problems[0], 2);
  if (positional.length) throw new BeakError(`unexpected argument "${positional[0]}": use key=value, e.g. task=cold-email`, 2);
  if (!values.task) throw new BeakError('task= is required, e.g. beak bundle task=cold-email customer=acme-pharma', 2);

  const { config } = loadConfig({ root: findRoot(cwd), env });
  const library = loadLibrary(config.dirs.library, { root: config.root });
  const plan = planBundle({ config, library, values });
  if (plan.problems.length) {
    for (const p of plan.problems) io.err.write(`beak bundle: ${p}\n`);
    io.err.write('no run created\n');
    return 1;
  }
  const { id, dir } = writeRun({ config, library, plan, now });
  const rel = relPath(config.root, dir);
  io.out.write(`${id}\n`);
  io.out.write(`created ${rel}/: ${RUN_FILES.bundle}, ${RUN_FILES.rubric}, ${RUN_FILES.meta}, ${RUN_FILES.inputs}\n`);
  for (const w of plan.warnings) io.out.write(`warning: ${w}\n`);
  io.out.write(`next: read ${rel}/${RUN_FILES.bundle}, then write ${rel}/round-0/prompt.md and ${rel}/round-0/changes.md\n`);
  return 0;
});
