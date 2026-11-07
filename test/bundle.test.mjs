import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parseBlock } from '../tools/lib/blocks.mjs';
import { bundleCommand, mergeRubric, parseBundleArgs, resolveBlocks, runId, selectInputs, toJson } from '../tools/lib/bundle.mjs';
import { loadLibrary } from '../tools/lib/library.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date(2026, 10, 7, 9, 30); // local time: 2026-11-07 09:30
const RUN = '20261107-0930-cold-email-acme-pharma-formal-de';

// ---------------------------------------------------------------------------------------------------------
// helpers

/** One parsed block as resolveBlocks returns it. `done` are Done-when lines. */
function entry(type, id, fm = {}, done = []) {
  const text = [
    '---',
    YAML.stringify({ id, type, version: 1, updated: '2026-11-07', ...fm }).trim(),
    '---',
    '',
    '## Purpose',
    '',
    'x.',
    '',
    '## Must include',
    '',
    '## Avoid',
    '',
    '## Examples',
    '',
    '## Done when',
    '',
    ...done.map((d) => `- ${d}`),
    '',
  ].join('\n');
  const block = parseBlock(text, `${id}.md`);
  assert.deepEqual(block.findings, [], `${id}: test block must parse`);
  Object.assign(block, { type, id });
  return { type, id, block, via: 'given' };
}

const TASK_FM = { consumer: 'sales-agent', output_format: ['Role', 'Instructions'], test_inputs: ['s1'] };

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-bundle-'));
  fs.copyFileSync(path.join(REPO, 'beak.config.yaml'), path.join(dir, 'beak.config.yaml'));
  fs.cpSync(path.join(REPO, 'library'), path.join(dir, 'library'), { recursive: true });
  return dir;
}

function edit(dir, rel, fn) {
  const file = path.join(dir, rel);
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
}

async function bundle(dir, ...args) {
  let out = '';
  let err = '';
  const io = { out: { write: (s) => (out += s) }, err: { write: (s) => (err += s) } };
  const code = await bundleCommand(args, io, { cwd: dir, env: {}, now: NOW });
  return { code, out, err };
}

const runFile = (dir, run, name) => fs.readFileSync(path.join(dir, 'runs', run, name), 'utf8');
const runJson = (dir, run, name) => JSON.parse(runFile(dir, run, name));
const exampleLibrary = () => loadLibrary(path.join(REPO, 'library'), { root: REPO });

// ---------------------------------------------------------------------------------------------------------
// merging (plan §4)

test('merge: lists are unioned, each item keeps every block it came from', () => {
  const { rubric, problems } = mergeRubric([
    entry('task', 't', { ...TASK_FM, checks: { output: { banned: ['synergy', 'leverage'] }, prompt: { required_sections: ['Examples'] } } }),
    entry('tone', 'tn', { language: 'en', checks: { output: { banned: ['leverage', 'Cheers'], required_phrases: ['Best regards'] } } }),
    entry('customer', 'cu', { language: 'en', industry: 'i', default_tone: 'tn', checks: { prompt: { required_sections: ['Role', 'Context'] } } }),
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(rubric.checks.output.banned, [
    { value: 'synergy', sources: ['t'] },
    { value: 'leverage', sources: ['t', 'tn'] },
    { value: 'Cheers', sources: ['tn'] },
  ]);
  assert.deepEqual(rubric.checks.output.required_phrases, [{ value: 'Best regards', sources: ['tn'] }]);
  // the task's output_format comes first and counts as required sections of the prompt
  assert.deepEqual(rubric.checks.prompt.required_sections, [
    { value: 'Role', sources: ['t', 'cu'] },
    { value: 'Instructions', sources: ['t'] },
    { value: 'Examples', sources: ['t'] },
    { value: 'Context', sources: ['cu'] },
  ]);
  assert.deepEqual(rubric.checks.prompt.banned, []);
});

test('merge: numbers take the strictest value (min of max_*, max of min_*), per scope', () => {
  const { rubric, problems } = mergeRubric([
    entry('task', 't', { ...TASK_FM, checks: { output: { max_words: 200, min_words: 50 }, prompt: { max_words: 900 } } }),
    entry('tone', 'tn', { language: 'en', checks: { output: { min_words: 80, max_chars: 1500 } } }),
    entry('industry', 'in', { checks: { output: { max_words: 180 } } }),
    entry('customer', 'cu', { language: 'en', industry: 'in', default_tone: 'tn', checks: { output: { max_words: 180 } } }),
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(rubric.checks.output.max_words, { value: 180, sources: ['in', 'cu'] });
  assert.deepEqual(rubric.checks.output.min_words, { value: 80, sources: ['tn'] });
  assert.deepEqual(rubric.checks.output.max_chars, { value: 1500, sources: ['tn'] });
  assert.equal(rubric.checks.output.min_chars, null);
  assert.deepEqual(rubric.checks.prompt.max_words, { value: 900, sources: ['t'] });
});

test('merge: min > max across blocks is an error, and so is a required phrase that contains a banned one', () => {
  const { problems } = mergeRubric([
    entry('task', 't', { ...TASK_FM, checks: { output: { min_words: 200, required_phrases: ['Viele Grüße aus Hamburg'] } } }),
    entry('tone', 'tn', { language: 'de', checks: { output: { banned: ['viele grüße'] } } }),
    entry('customer', 'cu', { language: 'de', industry: 'i', default_tone: 'tn', checks: { output: { max_words: 180 } } }),
  ]);
  assert.deepEqual(problems, [
    'checks.output: min_words 200 (t) is larger than max_words 180 (cu)',
    'checks.output: "Viele Grüße aus Hamburg" is required by t but contains "viele grüße", banned by tn',
  ]);
});

test('merge: a banned word only conflicts with a required phrase that contains it as a whole word', () => {
  const blocks = (banned) => [
    entry('task', 't', { ...TASK_FM, checks: { output: { required_phrases: ['Hallo Herr Weber'] } } }),
    entry('tone', 'tn', { language: 'de', checks: { output: { banned } } }),
  ];
  assert.deepEqual(mergeRubric(blocks(['Hallorenkugeln', 'all', 'Herr  Weber'])).problems, [
    'checks.output: "Hallo Herr Weber" is required by t but contains "Herr  Weber", banned by tn',
  ]);
});

test('merge: single values follow scenario > customer > industry > tone > task', () => {
  const task = entry('task', 't', { ...TASK_FM, language: 'en' });
  const tone = entry('tone', 'tn', { language: 'en' });
  const customer = entry('customer', 'cu', { language: 'de', industry: 'i', default_tone: 'tn' });
  const scenario = entry('scenario', 'sc', { language: 'de-CH', input: 'hi' });

  let r = mergeRubric([task, tone]);
  assert.deepEqual(r.rubric.language, { value: 'en', source: 'tn' });
  assert.deepEqual(r.warnings, []);

  r = mergeRubric([task, tone, customer]);
  assert.deepEqual(r.rubric.language, { value: 'de', source: 'cu' });
  assert.match(r.warnings[0], /^the blocks disagree on language \(en: task t, en: tone tn, de: customer cu\); using de from customer cu/);

  r = mergeRubric([task, tone, customer, scenario]);
  assert.deepEqual(r.rubric.language, { value: 'de-CH', source: 'sc' });
});

test('merge: Done-when lines become criteria with stable ids; duplicates merge their sources and [must]', () => {
  const { rubric } = mergeRubric([
    entry('task', 't', TASK_FM, ['[must] One call to action.', 'Mentions the lead.']),
    entry('tone', 'tn', { language: 'en' }, ['No exclamation marks. (learned 2026-11-01)', 'Mentions the lead.']),
    entry('customer', 'cu', { language: 'en', industry: 'i', default_tone: 'tn' }, ['[must] Mentions the lead.']),
  ]);
  assert.deepEqual(rubric.criteria, [
    { id: 'c1', text: 'One call to action.', must: true, learned: null, sources: ['t'] },
    { id: 'c2', text: 'Mentions the lead.', must: true, learned: null, sources: ['t', 'tn', 'cu'] },
    { id: 'c3', text: 'No exclamation marks.', must: false, learned: '2026-11-01', sources: ['tn'] },
  ]);
});

// ---------------------------------------------------------------------------------------------------------
// which blocks a run uses

test('resolve: a customer brings its industry and default tone; the variant is customer-tone', () => {
  const r = resolveBlocks(exampleLibrary(), { task: 'cold-email', customer: 'acme-pharma' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(
    r.entries.map((e) => `${e.type}:${e.id}:${e.via}`),
    ['task:cold-email:given', 'tone:formal-de:customer acme-pharma', 'industry:pharma:customer acme-pharma', 'customer:acme-pharma:given'],
  );
  assert.equal(r.variant, 'acme-pharma-formal-de');
});

test('resolve: explicit industry and tone win over the customer; a scenario joins the variant name', () => {
  const r = resolveBlocks(exampleLibrary(), { task: 'cold-email', customer: 'acme-pharma', industry: 'saas', tone: 'friendly-en', scenario: 'trade-fair-follow-up' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.entries.map((e) => `${e.type}:${e.id}`), ['task:cold-email', 'tone:friendly-en', 'industry:saas', 'customer:acme-pharma', 'scenario:trade-fair-follow-up']);
  assert.equal(r.variant, 'acme-pharma-friendly-en-trade-fair-follow-up');
});

test('resolve: an industry without a customer takes the task default tone', () => {
  const r = resolveBlocks(exampleLibrary(), { task: 'cold-email', industry: 'saas' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.entries.find((e) => e.type === 'tone').via, 'task cold-email (default_tone)');
  assert.equal(r.variant, 'saas-friendly-en');
});

test('resolve: missing ids, missing customer/industry and missing tone are problems', () => {
  const lib = exampleLibrary();
  assert.deepEqual(resolveBlocks(lib, { task: 'cold-email', customer: 'acme' }).problems, ['customer "acme" not found. Did you mean acme-pharma?']);
  assert.deepEqual(resolveBlocks(lib, { task: 'cold-mail', industry: 'saas' }).problems, ['task "cold-mail" not found. Did you mean cold-email?']);
  assert.deepEqual(resolveBlocks(lib, { task: 'cold-email' }).problems, ['give customer=… or industry=…: the variant is named after one of them']);

  const dir = tempRepo();
  edit(dir, 'library/tasks/cold-email.md', (t) => t.replace('default_tone: friendly-en\n', ''));
  edit(dir, 'library/customers/acme-pharma.md', (t) => t.replace('industry: pharma', 'industry: "TODO: which industry?"'));
  const temp = loadLibrary(path.join(dir, 'library'), { root: dir });
  assert.deepEqual(resolveBlocks(temp, { task: 'cold-email', industry: 'saas' }).problems, [
    'no tone: pass tone=… (task cold-email has no default_tone and no customer was given)',
  ]);
  assert.deepEqual(resolveBlocks(temp, { task: 'cold-email', customer: 'acme-pharma' }).problems, [
    'customer acme-pharma names industry "TODO: which industry?"; pass industry=… or finish that block',
  ]);
});

test('parseBundleArgs: key=value slugs only', () => {
  assert.deepEqual(parseBundleArgs(['task=cold-email', 'context=a,b-c', 'judge=glm-5.3']), {
    values: { task: 'cold-email', context: ['a', 'b-c'], judge: 'glm-5.3' },
    problems: [],
  });
  assert.deepEqual(parseBundleArgs([]).problems, ['task=… is required']);
  assert.deepEqual(parseBundleArgs(['task=a', 'task=b']).problems, ['task is given twice']);
  assert.deepEqual(parseBundleArgs(['task=Cold Email']).problems, ['task=Cold Email: must be an id (lowercase letters, digits, hyphens)']);
  assert.deepEqual(parseBundleArgs(['task=a', 'context=a, b']).problems, ['context=a, b: give block ids separated by commas, no spaces']);
  assert.match(parseBundleArgs(['task=a', 'writer=x']).problems[0], /^unknown key "writer"/);
  assert.match(parseBundleArgs(['cold-email']).problems[0], /^"cold-email" is not key=value/);
});

// ---------------------------------------------------------------------------------------------------------
// test inputs

test('inputs: the task test_inputs up to loop.test_inputs; the last loop.holdout are holdout', () => {
  const lib = exampleLibrary();
  const taskEntry = { type: 'task', id: 'cold-email', block: lib.byType.task.get('cold-email') };
  let r = selectInputs({ library: lib, taskEntry, loop: { test_inputs: 3, holdout: 1 } });
  assert.deepEqual(r.inputs.map((i) => `${i.id}:${i.holdout}`), ['cold-first-contact:false', 'trade-fair-follow-up:false', 'sparse-lead-data:true']);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.inputs[2].source, { type: 'task', id: 'cold-email', version: 1 });
  assert.match(r.inputs[2].input, /^Lead: Jonas Berg/);
  assert.deepEqual(r.inputs[0].criteria[0], { id: 'cold-first-contact.c1', text: 'Does not imply any previous contact.', must: true, learned: null });

  // the variant's scenario goes first and is not repeated
  const scenarioEntry = { type: 'scenario', id: 'trade-fair-follow-up', block: lib.byType.scenario.get('trade-fair-follow-up') };
  r = selectInputs({ library: lib, taskEntry, scenarioEntry, loop: { test_inputs: 3, holdout: 1 } });
  assert.deepEqual(r.inputs.map((i) => i.id), ['trade-fair-follow-up', 'cold-first-contact', 'sparse-lead-data']);

  r = selectInputs({ library: lib, taskEntry, loop: { test_inputs: 2, holdout: 1 } });
  assert.deepEqual(r.inputs.map((i) => `${i.id}:${i.holdout}`), ['cold-first-contact:false', 'trade-fair-follow-up:true']);
});

test('inputs: with too few inputs, at least one stays visible', () => {
  const lib = exampleLibrary();
  const task = parseBlock(fs.readFileSync(path.join(REPO, 'library/tasks/cold-email.md'), 'utf8').replace(/test_inputs:\n(  .*\n)+/, 'test_inputs: [cold-first-contact]\n'));
  const r = selectInputs({ library: lib, taskEntry: { type: 'task', id: 'cold-email', block: task }, loop: { test_inputs: 3, holdout: 1 } });
  assert.deepEqual(r.inputs.map((i) => `${i.id}:${i.holdout}`), ['cold-first-contact:false']);
  assert.deepEqual(r.warnings, [
    'only 1 test input (loop.test_inputs is 3); add scenarios to task cold-email',
    '0 holdout inputs instead of 1: the writer needs at least one visible input',
  ]);
});

// ---------------------------------------------------------------------------------------------------------
// the run folder

test('bundle creates the run folder and prints only the run id', async () => {
  const dir = tempRepo();
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${RUN}\n`);
  assert.equal(r.err, '');
  const runDir = path.join(dir, 'runs', RUN);
  assert.deepEqual(fs.readdirSync(runDir).sort(), ['bundle.md', 'inputs.json', 'meta.json', 'round-0', 'rubric.json']);
  assert.deepEqual(fs.readdirSync(path.join(runDir, 'round-0')), []);
  assert.ok(!fs.existsSync(path.join(REPO, 'runs', RUN)), 'never writes to the repo');
});

test('meta.json records args, models, block versions and hashes', async () => {
  const dir = tempRepo();
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  const meta = runJson(dir, RUN, 'meta.json');
  assert.equal(meta.run, RUN);
  assert.equal(meta.task, 'cold-email');
  assert.equal(meta.variant, 'acme-pharma-formal-de');
  assert.equal(meta.consumer, 'sales-agent');
  assert.deepEqual(meta.language, { value: 'de', source: 'acme-pharma' });
  assert.deepEqual(meta.args, { customer: 'acme-pharma', task: 'cold-email' });
  assert.deepEqual(meta.models, {
    judge: { model: 'deepseek/deepseek-v4-flash', name: 'deepseek-v4-flash', provider: 'openrouter' },
    tester: { model: 'z-ai/glm-5.3', name: 'glm-5.3', provider: 'openrouter' },
  });
  assert.deepEqual(
    meta.blocks.map((b) => `${b.role} ${b.type}:${b.id}@${b.version} ${b.file}`),
    [
      'bundle task:cold-email@1 library/tasks/cold-email.md',
      'bundle tone:formal-de@1 library/tones/formal-de.md',
      'bundle industry:pharma@1 library/industries/pharma.md',
      'bundle customer:acme-pharma@1 library/customers/acme-pharma.md',
      'test-input scenario:cold-first-contact@1 library/scenarios/cold-first-contact.md',
      'test-input scenario:trade-fair-follow-up@1 library/scenarios/trade-fair-follow-up.md',
    ],
  );
  for (const b of meta.blocks) assert.match(b.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(meta.library_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(meta.golden, null);
  assert.equal(meta.loop.max_rounds, 4);
});

test('tester and judge can be picked per run, and may be the same model', async () => {
  const dir = tempRepo();
  const r = await bundle(dir, 'task=cold-email', 'industry=saas', 'tester=deepseek-v4-flash', 'judge=deepseek-v4-flash');
  assert.equal(r.code, 0, r.err);
  const meta = runJson(dir, r.out.trim(), 'meta.json');
  assert.equal(meta.models.tester.name, 'deepseek-v4-flash');
  assert.equal(meta.models.judge.name, 'deepseek-v4-flash');
  assert.deepEqual(meta.args, { industry: 'saas', judge: 'deepseek-v4-flash', task: 'cold-email', tester: 'deepseek-v4-flash' });

  const bad = await bundle(dir, 'task=cold-email', 'industry=saas', 'tester=gpt-9');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /tester=gpt-9 is not a configured model \(choose from: glm-5\.3, deepseek-v4-flash\)/);
});

test('rubric.json and inputs.json hold the merged rules and the chosen test inputs', async () => {
  const dir = tempRepo();
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  const rubric = runJson(dir, RUN, 'rubric.json');
  assert.deepEqual(rubric.checks.output.max_words, { value: 180, sources: ['acme-pharma'] });
  assert.deepEqual(rubric.runtime_vars, ['sender_name', 'sender_role']);
  assert.deepEqual(rubric.output_format, ['Role', 'Context', 'Instructions', 'Constraints', 'Output format', 'Examples']);
  assert.equal(rubric.criteria.length, 12);
  assert.ok(rubric.criteria.every((c, i) => c.id === `c${i + 1}`));
  assert.deepEqual(
    rubric.checks.output.banned.map((b) => b.sources[0]),
    ['cold-email', 'cold-email', 'formal-de', 'formal-de', 'formal-de', 'pharma', 'pharma', 'pharma', 'pharma', 'acme-pharma', 'acme-pharma'],
  );
  const { inputs } = runJson(dir, RUN, 'inputs.json');
  assert.deepEqual(inputs.map((i) => `${i.id}:${i.holdout}`), ['cold-first-contact:false', 'trade-fair-follow-up:false', 'sparse-lead-data:true']);
});

test('bundle.md: rules first, then the blocks from general to specific, examples verbatim, no test inputs', async () => {
  const dir = tempRepo();
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  const md = runFile(dir, RUN, 'bundle.md');
  assert.ok(md.startsWith(`# Bundle: cold-email for acme-pharma-formal-de\n\nRun \`${RUN}\`. Write the prompt to \`runs/${RUN}/round-0/prompt.md\`.`));
  const headings = md.split('\n').filter((l) => /^#{2,3} /.test(l));
  assert.deepEqual(headings, [
    '## Run',
    '## Hard checks',
    '## Criteria',
    '## Blocks',
    '### Task `cold-email` v1: Cold email',
    '### Tone `formal-de` v1: Formell (Deutsch)',
    '### Industry `pharma` v1: Pharma',
    '### Customer `acme-pharma` v1: Acme Pharma (example customer)',
  ]);
  assert.match(md, /^- Language: `de` \(from acme-pharma\)\./m);
  assert.match(md, /^- Placeholders: `\{\{sender_name\}\}`, `\{\{sender_role\}\}`\./m);
  assert.match(md, /^- At most 180 words \(acme-pharma\)$/m);
  assert.match(md, /^- c11 \[must\] Signs off with a person's name, role and "Acme Pharma GmbH", never just "Ihr Acme-Team"\. \(acme-pharma\)$/m);
  assert.match(md, /^- Test inputs: 3, 1 of them holdout/m);

  const { byType } = exampleLibrary();
  for (const ex of byType.customer.get('acme-pharma').examples) assert.ok(md.includes(ex.text), 'customer example verbatim');
  for (const ex of byType.tone.get('formal-de').examples) assert.ok(md.includes(ex.text), 'tone example verbatim');
  assert.ok(!md.includes('Jonas Berg'), 'the holdout input never appears in bundle.md');
  assert.ok(!md.includes('Dr. Anna Weber, Head of Hospital Pharmacy'), 'test inputs are not part of the bundle');
  assert.ok(!md.includes('## Done when') && !md.includes('#### Done when'), 'Done-when lines are merged into Criteria');
});

test('bundle.md shows the variant scenario with its sample input', async () => {
  const dir = tempRepo();
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma', 'scenario=trade-fair-follow-up');
  assert.equal(r.code, 0, r.err);
  const md = runFile(dir, r.out.trim(), 'bundle.md');
  assert.match(md, /^### Scenario `trade-fair-follow-up` v1/m);
  assert.match(md, /^#### Sample input$/m);
  assert.ok(md.includes(loadLibrary(path.join(dir, 'library'), { root: dir }).byType.scenario.get('trade-fair-follow-up').frontmatter.input.trim()));
});

test('the same bundle twice gives identical files under a new run id', async () => {
  const dir = tempRepo();
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.out, `${RUN}-2\n`);
  for (const name of ['bundle.md', 'rubric.json', 'inputs.json', 'meta.json']) {
    assert.equal(runFile(dir, `${RUN}-2`, name), runFile(dir, RUN, name).replaceAll(RUN, `${RUN}-2`), name);
  }
});

test('library_hash covers the blocks of the run, not the rest of the library', async () => {
  const dir = tempRepo();
  const hash = async () => {
    const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
    return runJson(dir, r.out.trim(), 'meta.json').library_hash;
  };
  const before = await hash();
  edit(dir, 'library/industries/saas.md', (t) => t.replace('## Avoid', '## Avoid\n\n- Unrelated edit.'));
  assert.equal(await hash(), before, 'saas is not part of this run');
  edit(dir, 'library/scenarios/cold-first-contact.md', (t) => t.replace('## Avoid', '## Avoid\n\n- A test input changed.'));
  assert.notEqual(await hash(), before, 'a test-input scenario is part of the run');
});

test('a lint error in a block of the run stops the bundle; elsewhere it does not; TODOs warn', async () => {
  const dir = tempRepo();
  edit(dir, 'library/industries/saas.md', (t) => t.replace('version: 1', 'version: 0'));
  let r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0, r.err);

  edit(dir, 'library/tones/formal-de.md', (t) => t.replace('## Avoid', '## Avoid\n\n- TODO: ask about emojis.'));
  r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0);
  assert.match(r.err, /^beak bundle: warning: library\/tones\/formal-de\.md:\d+: TODO left: - TODO: ask about emojis\.$/m);

  r = await bundle(dir, 'task=cold-email', 'industry=saas');
  assert.equal(r.code, 1);
  assert.match(r.err, /^beak bundle: the blocks of this run have errors/m);
  assert.match(r.err, /^beak bundle: {3}library\/industries\/saas\.md:4: error: version must be a whole number >= 1 \(got 0\)$/m);
  assert.ok(!fs.readdirSync(path.join(dir, 'runs')).some((n) => n.includes('saas')), 'no run folder on error');
});

test('contradicting blocks stop the bundle', async () => {
  const dir = tempRepo();
  edit(dir, 'library/tones/formal-de.md', (t) => t.replace('banned: ["Hallo", "Liebe Grüße", "Viele Grüße"]', 'banned: ["Hallo"]\n    min_words: 250'));
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 1);
  assert.match(r.err, /^beak bundle: {3}checks\.output: min_words 250 \(formal-de\) is larger than max_words 180 \(acme-pharma\)$/m);
  assert.ok(!fs.existsSync(path.join(dir, 'runs')));
});

test('a golden prompt is copied into bundle.md as the structural reference', async () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, 'out', 'sales-agent', 'cold-email'), { recursive: true });
  const golden = '---\nstatus: approved\nversion: 2\n---\n\n## Role\n\nYou write cold emails.\n\n## Examples\n\n```text\nHi.\n```\n';
  fs.writeFileSync(path.join(dir, 'out/sales-agent/cold-email/saas-friendly-en.md'), golden);
  edit(dir, 'library/tasks/cold-email.md', (t) => t.replace('default_tone: friendly-en', 'default_tone: friendly-en\ngolden: out/sales-agent/cold-email/saas-friendly-en.md'));
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0, r.err);
  const md = runFile(dir, RUN, 'bundle.md');
  assert.match(md, /^- Golden prompt: `out\/sales-agent\/cold-email\/saas-friendly-en\.md`, below\./m);
  assert.ok(md.endsWith('## Golden prompt\n\nFrom `out/sales-agent/cold-email/saas-friendly-en.md`. Keep this structure; replace the content with this bundle\'s.\n\n````\n## Role\n\nYou write cold emails.\n\n## Examples\n\n```text\nHi.\n```\n````\n'), md.slice(-400));
  assert.equal(runJson(dir, RUN, 'meta.json').golden.file, 'out/sales-agent/cold-email/saas-friendly-en.md');
});

test('bundle usage errors exit 2 and write nothing', async () => {
  const dir = tempRepo();
  for (const args of [[], ['customer=acme-pharma'], ['task=cold-email', 'colour=red'], ['task=cold-email', 'cold-email']]) {
    const r = await bundle(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: beak bundle task=/);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'runs')));
});

test('runId and toJson are deterministic', () => {
  assert.equal(runId(new Date(2026, 0, 5, 7, 3), 'cold-email', 'saas-friendly-en'), '20260105-0703-cold-email-saas-friendly-en');
  assert.equal(toJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
});
