// `beak bundle key=value…` (plan.md §4 merging rules, §6): resolve the blocks of one run, merge their rules
// into rubric.json, pick the test inputs, and write runs/<run-id>/ for round 0.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_NAME_RE, SLUG_RE, findRoot, loadConfig, selectModels } from './config.mjs';
import { CHECK_KEYS, NUMBER_CHECKS, isTodo } from './blocks.mjs';
import { loadLibrary } from './library.mjs';
import { formatFindings, lint } from './lint.mjs';
import { rankBlocks } from './match.mjs';
import { containsPhrase } from './text.mjs';

export const BUNDLE_KEYS = Object.freeze(['task', 'customer', 'industry', 'tone', 'scenario', 'context', 'tester', 'judge']);
/** Blocks of a run, most general first. Later blocks win single-value fields (scenario > customer > industry > tone > task). */
export const BUNDLE_ORDER = Object.freeze(['task', 'context', 'tone', 'industry', 'customer', 'scenario']);
/** How the consumer's runtime values appear in a prompt: {{sender_name}}. */
export const placeholder = (name) => `{{${name}}}`;

const LIST_CHECKS = Object.freeze({ output: ['banned', 'required_phrases'], prompt: ['required_sections', 'banned', 'required_phrases'] });
const LABEL = { task: 'Task', context: 'Context', tone: 'Tone', industry: 'Industry', customer: 'Customer', scenario: 'Scenario' };

export class BundleError extends Error {
  constructor(problems, { usage = false } = {}) {
    super(problems.join('\n'));
    this.name = 'BundleError';
    this.problems = problems;
    this.usage = usage;
  }
}

/** key=value arguments → { values, problems }. Values are slugs (model names may contain dots; context is a comma list). */
export function parseBundleArgs(args) {
  const values = {};
  const problems = [];
  for (const arg of args) {
    const kv = /^([a-z]+)=(.*)$/.exec(arg);
    if (!kv) {
      problems.push(`"${arg}" is not key=value (keys: ${BUNDLE_KEYS.join(', ')})`);
      continue;
    }
    const [, key, value] = kv;
    if (!BUNDLE_KEYS.includes(key)) {
      problems.push(`unknown key "${key}" (keys: ${BUNDLE_KEYS.join(', ')})`);
      continue;
    }
    if (key in values) {
      problems.push(`${key} is given twice`);
      continue;
    }
    const ok =
      key === 'tester' || key === 'judge'
        ? MODEL_NAME_RE.test(value)
        : key === 'context'
          ? value.split(',').every((v) => SLUG_RE.test(v))
          : SLUG_RE.test(value);
    if (!ok) {
      problems.push(`${key}=${value}: ${key === 'context' ? 'give block ids separated by commas, no spaces' : 'must be an id (lowercase letters, digits, hyphens)'}`);
      continue;
    }
    values[key] = key === 'context' ? value.split(',') : value;
  }
  if (!('task' in values) && !problems.length) problems.push('task=… is required');
  return { values, problems };
}

/**
 * Which blocks a run uses, and why. Pure: reads only `library` (from loadLibrary).
 * Returns { entries: [{ type, id, block, via }] in BUNDLE_ORDER, variant, problems, warnings }.
 * A customer implies its industry and default tone; the tone falls back to the task's default_tone.
 */
export function resolveBlocks(library, values) {
  const problems = [];
  const warnings = [];
  const picked = {};
  const pick = (type, id, via) => {
    if (typeof id !== 'string') return null;
    if (isTodo(id)) {
      problems.push(`${via} names ${type} "${id}"; pass ${type}=… or finish that block`);
      return null;
    }
    const block = library.byType[type].get(id);
    if (!block) {
      const like = rankBlocks(library.blocks, id, { type }).map((m) => m.block.id);
      problems.push(`${type} "${id}" not found${via === 'given' ? '' : ` (named by ${via})`}${like.length ? `. Did you mean ${like.join(', ')}?` : ''}`);
      return null;
    }
    return { type, id, block, via };
  };

  picked.task = pick('task', values.task, 'given');
  const task = picked.task?.block.frontmatter;
  picked.customer = values.customer ? pick('customer', values.customer, 'given') : null;
  const customer = picked.customer?.block.frontmatter;
  if (values.industry) picked.industry = pick('industry', values.industry, 'given');
  else if (customer) picked.industry = pick('industry', customer.industry, `customer ${values.customer}`);
  if (values.tone) picked.tone = pick('tone', values.tone, 'given');
  else if (customer) picked.tone = pick('tone', customer.default_tone, `customer ${values.customer}`);
  else if (task?.default_tone) picked.tone = pick('tone', task.default_tone, `task ${values.task} (default_tone)`);
  else if (task) problems.push(`no tone: pass tone=… (task ${values.task} has no default_tone${values.customer ? '' : ' and no customer was given'})`);
  picked.scenario = values.scenario ? pick('scenario', values.scenario, 'given') : null;
  const context = (values.context ?? []).map((id) => pick('context', id, 'given'));

  if (!values.customer && !values.industry) problems.push('give customer=… or industry=…: the variant is named after one of them');
  if (new Set(values.context ?? []).size !== (values.context ?? []).length) problems.push('context lists a block twice');

  const entries = [];
  for (const type of BUNDLE_ORDER) {
    if (type === 'context') entries.push(...context.filter(Boolean));
    else if (picked[type]) entries.push(picked[type]);
  }
  const base = values.customer ?? values.industry;
  const tone = picked.tone?.id;
  const variant = base && tone ? [base, tone, values.scenario].filter(Boolean).join('-') : null;
  return { entries, variant, problems, warnings };
}

/**
 * Merge the rules of a run's blocks (plan.md §4). `entries` in BUNDLE_ORDER; the task is entries[0].
 * Lists are unioned (each item keeps the ids of the blocks it came from), numbers take the strictest value,
 * single-value fields take the most specific block. Returns { rubric, problems, warnings }.
 */
export function mergeRubric(entries) {
  const problems = [];
  const warnings = [];
  const taskEntry = entries.find((e) => e.type === 'task');
  const task = taskEntry?.block.frontmatter ?? {};

  const checks = {};
  for (const scope of Object.keys(CHECK_KEYS)) {
    const merged = {};
    for (const key of LIST_CHECKS[scope]) {
      const items = new Map();
      const add = (value, source) => {
        const item = items.get(value) ?? { value, sources: [] };
        if (!item.sources.includes(source)) item.sources.push(source);
        items.set(value, item);
      };
      if (scope === 'prompt' && key === 'required_sections' && taskEntry) for (const s of task.output_format ?? []) add(s, taskEntry.id);
      for (const e of entries) for (const v of e.block.frontmatter?.checks?.[scope]?.[key] ?? []) add(v, e.id);
      merged[key] = [...items.values()];
    }
    for (const key of NUMBER_CHECKS) {
      const set = entries
        .map((e) => ({ value: e.block.frontmatter?.checks?.[scope]?.[key], source: e.id }))
        .filter((s) => Number.isInteger(s.value));
      if (!set.length) {
        merged[key] = null;
        continue;
      }
      const best = key.startsWith('max_') ? Math.min(...set.map((s) => s.value)) : Math.max(...set.map((s) => s.value));
      merged[key] = { value: best, sources: set.filter((s) => s.value === best).map((s) => s.source) };
    }
    for (const unit of ['words', 'chars']) {
      const min = merged[`min_${unit}`];
      const max = merged[`max_${unit}`];
      if (min && max && min.value > max.value) {
        problems.push(
          `checks.${scope}: min_${unit} ${min.value} (${min.sources.join(', ')}) is larger than max_${unit} ${max.value} (${max.sources.join(', ')})`,
        );
      }
    }
    for (const req of merged.required_phrases) {
      for (const ban of merged.banned) {
        if (containsPhrase(req.value, ban.value)) {
          problems.push(`checks.${scope}: "${req.value}" is required by ${req.sources.join(', ')} but contains "${ban.value}", banned by ${ban.sources.join(', ')}`);
        }
      }
    }
    checks[scope] = merged;
  }

  const criteria = [];
  const byText = new Map();
  for (const e of entries) {
    for (const d of e.block.doneWhen) {
      const known = byText.get(d.criterion);
      if (known) {
        if (!known.sources.includes(e.id)) known.sources.push(e.id);
        known.must ||= d.must;
        known.learned ??= d.learned;
        continue;
      }
      const c = { id: `c${criteria.length + 1}`, text: d.criterion, must: d.must, learned: d.learned, sources: [e.id] };
      criteria.push(c);
      byText.set(d.criterion, c);
    }
  }

  // Single-value fields: the most specific block wins.
  const languages = entries
    .filter((e) => typeof e.block.frontmatter?.language === 'string' && !isTodo(e.block.frontmatter.language))
    .map((e) => ({ value: e.block.frontmatter.language, source: e.id, type: e.type }));
  const language = languages.at(-1) ?? null;
  const distinct = [...new Set(languages.map((l) => l.value))];
  if (distinct.length > 1) {
    warnings.push(
      `the blocks disagree on language (${languages.map((l) => `${l.value}: ${l.type} ${l.source}`).join(', ')}); ` +
        `using ${language.value} from ${language.type} ${language.source} (most specific wins, plan §4; see §14 Q3)`,
    );
  }

  const rubric = {
    language: language ? { value: language.value, source: language.source } : null,
    output_format: task.output_format ?? [],
    runtime_vars: task.runtime_vars ?? [],
    checks,
    criteria,
  };
  return { rubric, problems, warnings };
}

/**
 * The test inputs of a run: the scenario of the variant first (if any), then the task's test_inputs, up to
 * loop.test_inputs. The last loop.holdout of them are holdout (judged, but hidden from the writer); at least one
 * input always stays visible. Returns { inputs, warnings }.
 */
export function selectInputs({ library, taskEntry, scenarioEntry, loop }) {
  const warnings = [];
  const candidates = [];
  const fromScenario = (block) => ({
    id: block.id,
    source: { type: 'scenario', id: block.id, version: block.frontmatter?.version ?? null },
    input: block.frontmatter?.input ?? null,
    notes: block.frontmatter?.notes ?? null,
    criteria: block.doneWhen.map((d, i) => ({ id: `${block.id}.c${i + 1}`, text: d.criterion, must: d.must, learned: d.learned })),
  });
  if (scenarioEntry) candidates.push(fromScenario(scenarioEntry.block));
  for (const item of taskEntry.block.frontmatter.test_inputs ?? []) {
    if (typeof item === 'string') {
      const block = library.byType.scenario.get(item);
      if (block) candidates.push(fromScenario(block));
    } else {
      candidates.push({ id: item.id, source: { type: 'task', id: taskEntry.id, version: taskEntry.block.frontmatter.version }, input: item.input, notes: null, criteria: [] });
    }
  }
  const seen = new Set();
  const unique = candidates.filter((c) => !seen.has(c.id) && seen.add(c.id));
  const inputs = unique.slice(0, loop.test_inputs);
  if (inputs.length < loop.test_inputs) {
    warnings.push(`only ${inputs.length} test input${inputs.length === 1 ? '' : 's'} (loop.test_inputs is ${loop.test_inputs}); add scenarios to task ${taskEntry.id}`);
  }
  const holdout = Math.min(loop.holdout, Math.max(0, inputs.length - 1));
  if (holdout < loop.holdout) warnings.push(`${holdout} holdout input${holdout === 1 ? '' : 's'} instead of ${loop.holdout}: the writer needs at least one visible input`);
  inputs.forEach((input, i) => (input.holdout = i >= inputs.length - holdout));
  return { inputs, warnings };
}

/** Run id: <yyyymmdd-hhmm>-<task>-<variant>, local time. */
export function runId(now, task, variant) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${task}-${variant}`;
}

/**
 * Resolve, merge and render everything for one run, without writing. Throws BundleError with every problem.
 * Returns { run (the id; writeRun may add -2, -3, …), render(runId) → { file name → content }, warnings }.
 */
export function planBundle({ config, values, now }) {
  const { blocks, byType } = loadLibrary(config.dirs.library, { root: config.root });
  const library = { blocks, byType };
  const { entries, variant, problems, warnings } = resolveBlocks(library, values);
  const models = selectModels(config, { ...(values.tester && { tester: values.tester }), ...(values.judge && { judge: values.judge }) });
  problems.push(...models.problems);
  if (problems.length) throw new BundleError(problems);

  // Every file the run depends on must lint without errors; TODOs only warn.
  const { findings } = lint({ config });
  const checkFiles = (list) => {
    const files = new Set(list.map((e) => e.block.file));
    const relevant = findings.filter((f) => files.has(f.file));
    const errors = relevant.filter((f) => f.level === 'error');
    if (errors.length) throw new BundleError(['the blocks of this run have errors (fix them, then bundle again):', ...formatFindings(errors).map((l) => `  ${l}`)]);
    for (const f of relevant) warnings.push(`${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}`);
  };
  checkFiles(entries);

  const taskEntry = entries.find((e) => e.type === 'task');
  const scenarioEntry = entries.find((e) => e.type === 'scenario');
  const picked = selectInputs({ library, taskEntry, scenarioEntry, loop: config.loop });
  warnings.push(...picked.warnings);
  const inputBlocks = picked.inputs
    .filter((i) => i.source.type === 'scenario' && i.id !== scenarioEntry?.id)
    .map((i) => ({ type: 'scenario', id: i.id, block: byType.scenario.get(i.id), via: `task ${taskEntry.id} (test_inputs)` }));
  checkFiles(inputBlocks);
  const used = [...entries, ...inputBlocks];

  const merged = mergeRubric(entries);
  warnings.push(...merged.warnings);
  if (merged.problems.length) throw new BundleError(['the blocks of this run contradict each other:', ...merged.problems.map((p) => `  ${p}`)]);

  const task = taskEntry.block.frontmatter;
  let golden = null;
  if (typeof task.golden === 'string' && task.golden.trim()) {
    const file = path.resolve(config.root, task.golden);
    const text = fs.readFileSync(file, 'utf8');
    golden = { file: relPath(config, file), sha256: sha256(text), body: stripFrontmatter(text) };
  }

  const blockRecords = used.map((e) => {
    const text = fs.readFileSync(e.block.path);
    return {
      type: e.type,
      id: e.id,
      version: e.block.frontmatter.version,
      file: e.block.file,
      sha256: sha256(text),
      role: entries.includes(e) ? 'bundle' : 'test-input',
      via: e.via,
    };
  });
  const libraryHash = sha256(
    [...blockRecords]
      .sort((a, b) => (a.file < b.file ? -1 : 1))
      .map((b) => `${b.file}\t${b.sha256}\n`)
      .join(''),
  );

  const run = runId(now, taskEntry.id, variant);
  const meta = {
    run,
    task: taskEntry.id,
    variant,
    consumer: task.consumer,
    language: merged.rubric.language,
    args: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
    models: models.roles,
    blocks: blockRecords,
    library_hash: libraryHash,
    golden: golden && { file: golden.file, sha256: golden.sha256 },
    loop: config.loop,
  };
  const inputs = { inputs: picked.inputs };
  return {
    run,
    warnings,
    render: (finalRun) => ({
      'bundle.md': renderBundle({ run: finalRun, config, entries, rubric: merged.rubric, inputs: picked.inputs, golden, meta }),
      'rubric.json': toJson(merged.rubric),
      'meta.json': toJson({ ...meta, run: finalRun }),
      'inputs.json': toJson(inputs),
    }),
  };
}

/** Write the run folder (with an empty round-0/). Adds -2, -3, … if the id is taken. Returns the run id. */
export function writeRun({ config, plan }) {
  fs.mkdirSync(config.dirs.runs, { recursive: true });
  let run = plan.run;
  for (let n = 2; ; n++) {
    try {
      fs.mkdirSync(path.join(config.dirs.runs, run));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || n > 99) throw err;
      run = `${plan.run}-${n}`;
    }
  }
  const dir = path.join(config.dirs.runs, run);
  for (const [name, content] of Object.entries(plan.render(run))) fs.writeFileSync(path.join(dir, name), content);
  fs.mkdirSync(path.join(dir, 'round-0'));
  return run;
}

/** CLI: beak bundle key=value…  Prints the run id on stdout; warnings and problems go to stderr. */
export async function bundleCommand(args, io, { cwd = process.cwd(), env = process.env, now = new Date() } = {}) {
  const { values, problems } = parseBundleArgs(args);
  if (problems.length) {
    io.err.write(`${problems.map((p) => `beak bundle: ${p}`).join('\n')}\nUsage: beak bundle task=… [customer=…] [industry=…] [tone=…] [scenario=…] [context=a,b] [tester=…] [judge=…]\n`);
    return 2;
  }
  const { config } = loadConfig({ root: findRoot(cwd), env });
  let plan;
  try {
    plan = planBundle({ config, values, now });
  } catch (err) {
    if (!(err instanceof BundleError)) throw err;
    io.err.write(`${err.problems.map((p) => `beak bundle: ${p}`).join('\n')}\n`);
    return 1;
  }
  for (const w of plan.warnings) io.err.write(`beak bundle: warning: ${w}\n`);
  io.out.write(`${writeRun({ config, plan })}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// bundle.md

/** What the writer reads to draft round 0. Rules first (merged, with sources), then the blocks, verbatim. */
export function renderBundle({ run, config, entries, rubric, inputs, golden, meta }) {
  const runDir = `${relPath(config, config.dirs.runs)}/${run}`;
  const out = [];
  const push = (...lines) => out.push(...lines);
  const code = (s) => `\`${s}\``;
  const taskEntry = entries.find((e) => e.type === 'task');
  const task = taskEntry.block.frontmatter;

  push(`# Bundle: ${taskEntry.id} for ${meta.variant}`, '');
  push(`Run ${code(run)}. Write the prompt to ${code(`${runDir}/round-0/prompt.md`)}.`, '');
  push(
    'Blocks are listed from general to specific. Where they disagree, the later block wins (scenario > customer > industry > tone > task). ' +
      'Lines with `TODO:` are unknowns: leave them out of the prompt and invent nothing in their place.',
    '',
  );

  push('## Run', '');
  push(`- Task: ${code(taskEntry.id)} v${task.version}, for the consumer agent ${code(task.consumer)}`);
  for (const e of entries.filter((x) => x.type !== 'task')) {
    push(`- ${LABEL[e.type]}: ${code(e.id)} v${e.block.frontmatter.version}${e.via === 'given' ? '' : ` (from ${e.via})`}`);
  }
  if (rubric.language) push(`- Language: ${code(rubric.language.value)} (from ${rubric.language.source}). Write the whole prompt in this language.`);
  push(`- Prompt sections, in this order: ${rubric.output_format.join(', ')}`);
  push(
    rubric.runtime_vars.length
      ? `- Placeholders: ${rubric.runtime_vars.map((v) => code(placeholder(v))).join(', ')}. The consumer fills these in at runtime. No other placeholders are allowed.`
      : '- Placeholders: none. The prompt must not contain any.',
  );
  const holdout = inputs.filter((i) => i.holdout).length;
  push(`- Test inputs: ${inputs.length}${holdout ? `, ${holdout} of them holdout (judged, never shown to you)` : ''}`);
  push(`- Golden prompt: ${golden ? `${code(golden.file)}, below. Keep its structure, swap the content.` : 'none'}`, '');

  push('## Hard checks', '', 'Scripts check these in every round.', '');
  for (const [scope, title] of [
    ['output', 'On what the consumer agent writes:'],
    ['prompt', 'On the prompt itself:'],
  ]) {
    const lines = checkLines(rubric.checks[scope], scope);
    if (scope === 'prompt') lines.push(`- No placeholders other than ${rubric.runtime_vars.length ? rubric.runtime_vars.map((v) => placeholder(v)).join(', ') : '(none allowed)'}`);
    push(title, ...(lines.length ? lines : ['- none']), '');
  }

  push('## Criteria', '', 'The judge checks every output against these. A failed `[must]` blocks the pass.', '');
  for (const c of rubric.criteria) push(`- ${c.id}${c.must ? ' [must]' : ''} ${c.text} (${c.sources.join(', ')})`);
  if (!rubric.criteria.length) push('- none');
  push('');

  push('## Blocks', '');
  for (const e of entries) {
    const b = e.block;
    push(`### ${LABEL[e.type]} ${code(e.id)} v${b.frontmatter.version}${b.title ? `: ${b.title.text}` : ''}`, '');
    if (e.type === 'scenario') {
      push('#### Sample input', '', ...fenced(b.frontmatter.input.replace(/\n$/, '')), '');
      if (b.frontmatter.notes) push('#### What a good response does', '', b.frontmatter.notes, '');
    }
    for (const s of b.sections) {
      if (s.name === 'Done when') continue; // merged into Criteria above
      const lines = trimBlank(s.lines.map((l) => l.text));
      if (!lines.length) continue;
      push(`#### ${s.name}`, '', ...lines, '');
    }
  }

  if (golden) push('## Golden prompt', '', `From ${code(golden.file)}. Keep this structure; replace the content with this bundle's.`, '', ...fenced(golden.body), '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function checkLines(c, scope) {
  const lines = [];
  const src = (item) => ` (${item.sources.join(', ')})`;
  if (scope === 'prompt' && c.required_sections.length) {
    lines.push(`- Sections: ${c.required_sections.map((s) => s.value).join(', ')}${src({ sources: [...new Set(c.required_sections.flatMap((s) => s.sources))] })}`);
  }
  for (const item of c.required_phrases) lines.push(`- Must contain: "${item.value}"${src(item)}`);
  for (const item of c.banned) lines.push(`- Must never contain: "${item.value}"${src(item)}`);
  const words = { max_words: 'At most %d words', min_words: 'At least %d words', max_chars: 'At most %d characters', min_chars: 'At least %d characters' };
  for (const key of NUMBER_CHECKS) if (c[key]) lines.push(`- ${words[key].replace('%d', c[key].value)}${src(c[key])}`);
  return lines;
}

// A code fence longer than any backtick run inside, so the text stays verbatim.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return [fence, text, fence];
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

function stripFrontmatter(text) {
  const t = text.replace(/\r\n?/g, '\n');
  if (!t.startsWith('---\n')) return t.trim();
  const end = t.indexOf('\n---', 4);
  return end === -1 ? t.trim() : t.slice(t.indexOf('\n', end + 1) + 1).trim();
}

/** JSON with keys sorted at every level, two-space indent, trailing newline: identical input → identical bytes. */
export function toJson(value) {
  const sort = (v) =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function sha256(data) {
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

function relPath(config, p) {
  return path.relative(config.root, p).split(path.sep).join('/');
}

