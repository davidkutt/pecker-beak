import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundleCommand, mergeChecks, mergeCriteria, resolveBlocks, resolveLanguage, variantName } from '../tools/lib/bundle.mjs';
import { loadLibrary } from '../tools/lib/library.mjs';
import { NOW, REPO, configOf, listFiles, read, readJsonFile, run, tempRepo, writeBlock } from './helpers.mjs';

const RUN = '20261107-0930-cold-email-acme-pharma-formal-de';
const bundle = (dir, ...args) => run(bundleCommand, args, { cwd: dir, now: NOW });
const exampleLibrary = () => loadLibrary(path.join(REPO, 'library'), { root: REPO });
const fakeBlock = (type, id, frontmatter = {}, doneWhen = []) => ({ type, id, frontmatter, doneWhen });

// ---------------------------------------------------------------------------------------------------------
// Merging rules (plan §4)

test('merge: lists are unioned, keep every source and ignore case when deduplicating', () => {
  const { merged, problems } = mergeChecks('output', [
    { source: 'acme-pharma', checks: { banned: ['revolutionär', 'game changer'] } },
    { source: 'saas', checks: { banned: ['Game Changer', 'synergy'], required_phrases: ['Best,'] } },
    { source: 'friendly-en', checks: null },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(merged, {
    banned: [
      { value: 'revolutionär', sources: ['acme-pharma'] },
      { value: 'game changer', sources: ['acme-pharma', 'saas'] },
      { value: 'synergy', sources: ['saas'] },
    ],
    required_phrases: [{ value: 'Best,', sources: ['saas'] }],
  });
});

test('merge: numbers take the strictest value and remember where it came from', () => {
  const { merged, problems } = mergeChecks('output', [
    { source: 'task', checks: { max_words: 200, min_words: 20, max_chars: 1500 } },
    { source: 'customer', checks: { max_words: 180, min_words: 40 } },
    { source: 'tone', checks: { max_words: 250, min_words: 10 } },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(merged, {
    max_words: { value: 180, source: 'customer' },
    min_words: { value: 40, source: 'customer' },
    max_chars: { value: 1500, source: 'task' },
  });
});

test('merge: min larger than max after merging is a conflict naming both blocks', () => {
  const { problems } = mergeChecks('output', [
    { source: 'acme-pharma', checks: { max_words: 120 } },
    { source: 'long-form', checks: { min_words: 150 } },
  ]);
  assert.deepEqual(problems, ['output checks conflict: min_words 150 (from long-form) is larger than max_words 120 (from acme-pharma)']);
});

test('merge: a base result is extended, not changed', () => {
  const base = mergeChecks('output', [{ source: 'a', checks: { max_words: 100 } }]).merged;
  const { merged } = mergeChecks('output', [{ source: 'b', checks: { max_words: 50 } }], base);
  assert.deepEqual(base, { max_words: { value: 100, source: 'a' } });
  assert.deepEqual(merged, { max_words: { value: 50, source: 'b' } });
});

test('merge: Done-when lines are unioned with sources; scenario test inputs add input-only criteria', () => {
  const picked = [
    { role: 'task', block: fakeBlock('task', 't', {}, [{ criterion: 'One CTA.', must: true, learned: null }]) },
    {
      role: 'tone',
      block: fakeBlock('tone', 'x', {}, [
        { criterion: 'one cta.', must: false, learned: '2026-11-01' },
        { criterion: 'No emojis.', must: false, learned: null },
      ]),
    },
  ];
  const scenario = fakeBlock('scenario', 's', {}, [
    { criterion: 'Mentions the fair.', must: true, learned: null },
    { criterion: 'No emojis.', must: true, learned: null },
  ]);
  const criteria = mergeCriteria(picked, [{ input: { id: 's' }, block: scenario }]);
  assert.deepEqual(criteria, [
    { id: 'C1', text: 'One CTA.', must: true, sources: ['t', 'x'], learned: '2026-11-01', inputs: null },
    { id: 'C2', text: 'No emojis.', must: true, sources: ['x', 's'], learned: null, inputs: null },
    { id: 'C3', text: 'Mentions the fair.', must: true, sources: ['s'], learned: null, inputs: ['s'] },
  ]);
});

test('precedence: the language comes from scenario > customer > industry > tone > task', () => {
  const all = [
    { role: 'task', block: fakeBlock('task', 't', { language: 'fr' }) },
    { role: 'customer', block: fakeBlock('customer', 'c', { language: 'de' }) },
    { role: 'industry', block: fakeBlock('industry', 'i', { language: 'it' }) },
    { role: 'tone', block: fakeBlock('tone', 'o', { language: 'en' }) },
    { role: 'scenario', block: fakeBlock('scenario', 's', { language: 'es' }) },
  ];
  const without = (...roles) => all.filter((p) => !roles.includes(p.role));
  assert.deepEqual(resolveLanguage(all), { value: 'es', source: 's' });
  assert.deepEqual(resolveLanguage(without('scenario')), { value: 'de', source: 'c' });
  assert.deepEqual(resolveLanguage(without('scenario', 'customer')), { value: 'it', source: 'i' });
  assert.deepEqual(resolveLanguage(without('scenario', 'customer', 'industry')), { value: 'en', source: 'o' });
  assert.deepEqual(resolveLanguage(without('scenario', 'customer', 'industry', 'tone')), { value: 'fr', source: 't' });
  assert.equal(resolveLanguage([]), null);
  assert.deepEqual(resolveLanguage([{ role: 'customer', block: fakeBlock('customer', 'c', { language: 'TODO: ask' }) }, all[3]]), {
    value: 'en',
    source: 'o',
  });
});

// ---------------------------------------------------------------------------------------------------------
// Which blocks a run uses

test('blocks: a customer implies its industry and default tone; arguments override them', () => {
  const library = exampleLibrary();
  const ids = (r) => r.picked.map((p) => `${p.role}:${p.block.id}${p.via === 'argument' ? '' : ` (${p.via})`}`);

  let r = resolveBlocks(library, { task: 'cold-email', customer: 'acme-pharma' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(ids(r), ['task:cold-email', 'customer:acme-pharma', 'industry:pharma (customer acme-pharma)', 'tone:formal-de (customer acme-pharma)']);
  assert.equal(variantName(r.picked), 'acme-pharma-formal-de');

  r = resolveBlocks(library, { task: 'cold-email', customer: 'acme-pharma', industry: 'saas', tone: 'friendly-en', scenario: 'cold-first-contact' });
  assert.deepEqual(ids(r), ['task:cold-email', 'customer:acme-pharma', 'industry:saas', 'tone:friendly-en', 'scenario:cold-first-contact']);
  assert.equal(variantName(r.picked), 'acme-pharma-friendly-en-cold-first-contact');

  // an industry without a customer; the tone falls back to the task's default_tone
  r = resolveBlocks(library, { task: 'cold-email', industry: 'saas' });
  assert.deepEqual(ids(r), ['task:cold-email', 'industry:saas', 'tone:friendly-en (task cold-email)']);
  assert.equal(variantName(r.picked), 'saas-friendly-en');

  r = resolveBlocks(library, { task: 'cold-email' });
  assert.equal(variantName(r.picked), 'generic-friendly-en');

  r = resolveBlocks(library, { task: 'cold-email', customer: 'globex', tone: 'shouty' });
  assert.deepEqual(r.problems, [
    'customer "globex" not found: there is no library/customers/globex.md',
    'tone "shouty" not found: there is no library/tones/shouty.md',
  ]);
});

// ---------------------------------------------------------------------------------------------------------
// beak bundle

test('bundle: creates the run folder with bundle.md, rubric.json, meta.json and inputs.json', async () => {
  const dir = tempRepo();
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n')[0], RUN, 'the first line is the run id');
  assert.match(r.out, /^next: read runs\/.*\/bundle\.md, then write runs\/.*\/round-0\/prompt\.md/m);
  assert.deepEqual(listFiles(path.join(dir, 'runs')), [`${RUN}/bundle.md`, `${RUN}/inputs.json`, `${RUN}/meta.json`, `${RUN}/rubric.json`]);
  assert.ok(fs.statSync(path.join(dir, 'runs', RUN, 'round-0')).isDirectory());

  const meta = readJsonFile(dir, `runs/${RUN}/meta.json`);
  assert.deepEqual(Object.keys(meta), [
    'run', 'task', 'variant', 'consumer', 'args', 'blocks', 'language', 'output_format', 'runtime_vars', 'golden',
    'test_inputs', 'models', 'loop', 'library_hash',
  ]);
  assert.equal(meta.variant, 'acme-pharma-formal-de');
  assert.equal(meta.consumer, 'sales-agent');
  assert.deepEqual(meta.args, { task: 'cold-email', customer: 'acme-pharma' });
  assert.deepEqual(
    meta.blocks.map((b) => `${b.type} ${b.id}@${b.version} ${b.path} (${b.via})`),
    [
      'task cold-email@1 library/tasks/cold-email.md (argument)',
      'customer acme-pharma@1 library/customers/acme-pharma.md (argument)',
      'industry pharma@1 library/industries/pharma.md (customer acme-pharma)',
      'tone formal-de@1 library/tones/formal-de.md (customer acme-pharma)',
    ],
  );
  assert.deepEqual(meta.language, { value: 'de', source: 'acme-pharma' });
  assert.deepEqual(meta.test_inputs, [
    { id: 'cold-first-contact', source: 'scenario', holdout: false },
    { id: 'trade-fair-follow-up', source: 'scenario', holdout: false },
    { id: 'sparse-lead-data', source: 'task', holdout: true },
  ]);
  assert.deepEqual(meta.models, {
    tester: { name: 'glm-5.3', provider: 'openrouter', model: 'z-ai/glm-5.3' },
    judge: { name: 'deepseek-v4-flash', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
  });
  assert.equal(meta.loop.max_rounds, 4);
  assert.match(meta.library_hash, /^sha256:[0-9a-f]{64}$/);

  const rubric = readJsonFile(dir, `runs/${RUN}/rubric.json`);
  assert.deepEqual(rubric.runtime_vars, ['sender_name', 'sender_role']);
  assert.deepEqual(rubric.checks.prompt.required_sections.map((s) => s.value), ['Role', 'Context', 'Instructions', 'Constraints', 'Output format', 'Examples']);
  assert.deepEqual(rubric.checks.output.max_words, { value: 180, source: 'acme-pharma' }, 'customer 180 beats task 200');
  assert.deepEqual(rubric.checks.output.banned.find((b) => b.value === 'Hallo'), { value: 'Hallo', sources: ['formal-de'] });
  const c = (text) => rubric.criteria.find((x) => x.text.startsWith(text));
  assert.deepEqual(c('The first line is a subject line'), {
    id: 'C1', text: 'The first line is a subject line ("Subject:" or "Betreff:").', must: true, sources: ['cold-email'], learned: null, inputs: null,
  });
  assert.deepEqual(c('Refers to the conversation at the trade fair').inputs, ['trade-fair-follow-up']);
  assert.deepEqual(c('Does not imply any previous contact').inputs, ['cold-first-contact']);

  const { inputs } = readJsonFile(dir, `runs/${RUN}/inputs.json`);
  assert.equal(inputs[2].id, 'sparse-lead-data');
  assert.match(inputs[2].input, /Jonas Berg/);
  assert.match(inputs[0].notes, /shortage post/);
});

test('bundle: bundle.md has what the writer needs and nothing of the holdout input', async () => {
  const dir = tempRepo();
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  const md = read(dir, `runs/${RUN}/bundle.md`);
  for (const expected of [
    '- Blocks: task cold-email v1; customer acme-pharma v1; industry pharma v1 (via customer acme-pharma); tone formal-de v1 (via customer acme-pharma)',
    '- Language: de (from acme-pharma)',
    '- Sections, in this order, each as a Markdown heading: Role, Context, Instructions, Constraints, Output format, Examples.',
    '{{sender_name}}, {{sender_role}}',
    '- at most 180 words (acme-pharma)',
    '- C1 [must] The first line is a subject line ("Subject:" or "Betreff:"). (cold-email)',
    '### cold-first-contact',
    'Dr. Anna Weber',
    '- C13 [must] Does not imply any previous contact. (cold-first-contact)',
    '1 more input is held out',
    '### customer acme-pharma v1: Acme Pharma (example customer)',
    'Betreff: Lieferengpässe bei Antibiotika – kurzer Austausch?', // examples verbatim
  ]) {
    assert.ok(md.includes(expected), `bundle.md should contain: ${expected}`);
  }
  assert.ok(!md.includes('Jonas Berg') && !md.includes('sparse-lead-data'), 'the holdout input must not be in bundle.md');
  assert.ok(md.indexOf('### task cold-email') < md.indexOf('### customer acme-pharma'), 'blocks in fixed order');
  assert.ok(md.indexOf('### customer acme-pharma') < md.indexOf('### industry pharma'));
  assert.ok(md.indexOf('### industry pharma') < md.indexOf('### tone formal-de'));
});

test('bundle: a scenario run tests that scenario only; models can be picked per run', async () => {
  const dir = tempRepo();
  const r = await bundle(dir, 'task=cold-email', 'industry=saas', 'scenario=trade-fair-follow-up', 'tester=deepseek-v4-flash', 'judge=deepseek-v4-flash');
  assert.equal(r.code, 0, r.err);
  const id = '20261107-0930-cold-email-saas-friendly-en-trade-fair-follow-up';
  assert.equal(r.out.split('\n')[0], id);
  assert.match(r.out, /warning: scenario trade-fair-follow-up: the run is tested on that scenario's input only/);
  const meta = readJsonFile(dir, `runs/${id}/meta.json`);
  assert.deepEqual(meta.test_inputs, [{ id: 'trade-fair-follow-up', source: 'scenario', holdout: false }]);
  assert.equal(meta.models.tester.name, 'deepseek-v4-flash');
  assert.equal(meta.models.judge.name, 'deepseek-v4-flash');
  assert.equal(meta.language.value, 'en', 'from the tone; the scenario and industry set none');
  const rubric = readJsonFile(dir, `runs/${id}/rubric.json`);
  assert.equal(rubric.criteria.find((c) => c.text.startsWith('Refers to the conversation')).inputs, null, 'the run scenario applies to every output');
});

test('bundle: the same run twice in one minute gets a new id', async () => {
  const dir = tempRepo();
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.out.split('\n')[0], `${RUN}-2`);
});

test('bundle: a scenario test input brings its checks for that input only', async () => {
  const dir = tempRepo();
  writeBlock(dir, 'scenario', 'short-reply', { fm: 'input: "Lead: Kim. Wants a short answer."\nchecks:\n  output:\n    max_words: 80', done: ['- [must] Answers in at most three sentences.'] });
  const task = read(dir, 'library/tasks/cold-email.md').replace('  - cold-first-contact\n', '  - short-reply\n');
  fs.writeFileSync(path.join(dir, 'library/tasks/cold-email.md'), task);
  const r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.equal(r.code, 0, r.err);
  const rubric = readJsonFile(dir, `runs/${RUN}/rubric.json`);
  assert.deepEqual(rubric.input_checks, { 'short-reply': { max_words: { value: 80, source: 'short-reply' } } });
  assert.deepEqual(rubric.checks.output.max_words, { value: 180, source: 'acme-pharma' }, 'the global limit is unchanged');
  assert.ok(read(dir, `runs/${RUN}/bundle.md`).includes('Hard checks for this input only:\n- at most 80 words (short-reply)'));
});

test('bundle: refuses conflicting checks, blocks with lint errors, unknown ids and models, and bad usage', async () => {
  const dir = tempRepo();
  writeBlock(dir, 'tone', 'long-form', { fm: 'language: de\nchecks:\n  output:\n    min_words: 250' });
  let r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma', 'tone=long-form');
  assert.equal(r.code, 1);
  assert.match(r.err, /output checks conflict: min_words 250 \(from long-form\) is larger than max_words 180 \(from acme-pharma\)/);
  assert.match(r.err, /no run created/);

  fs.writeFileSync(path.join(dir, 'library/tones/broken.md'), read(dir, 'library/tones/formal-de.md').replace('id: formal-de', 'id: broken').replace('## Avoid', '## Avoids'));
  r = await bundle(dir, 'task=cold-email', 'customer=acme-pharma', 'tone=broken');
  assert.equal(r.code, 1);
  assert.match(r.err, /these blocks have lint errors; fix them first \(beak lint\):\n  library\/tones\/broken\.md: error: missing section "## Avoid"/);
  assert.match(r.err, /library\/tones\/broken\.md:\d+: error: unknown section "## Avoids"/);

  r = await bundle(dir, 'task=cold-mail');
  assert.equal(r.code, 1);
  assert.match(r.err, /task "cold-mail" not found: there is no library\/tasks\/cold-mail\.md/);

  r = await bundle(dir, 'task=cold-email', 'judge=gpt-9');
  assert.equal(r.code, 1);
  assert.match(r.err, /judge=gpt-9 is not a configured model \(choose from: glm-5\.3, deepseek-v4-flash\)/);

  for (const [args, message] of [
    [['customer=acme-pharma'], /task= is required/],
    [['task=cold-email', 'colour=blue'], /unknown key "colour"/],
    [['task=cold-email', 'acme-pharma'], /unexpected argument "acme-pharma": use key=value/],
    [['task=cold-email', 'task=x'], /task= is given twice/],
  ]) {
    r = await bundle(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, message);
  }
  r = await bundle(dir, 'task=cold-email', 'customer=Acme Pharma');
  assert.equal(r.code, 1);
  assert.match(r.err, /customer=Acme Pharma: "Acme Pharma" is not an id/);
  assert.ok(!fs.existsSync(path.join(dir, 'runs')) || listFiles(path.join(dir, 'runs')).length === 0, 'nothing was written');
});

test('bundle: never writes into the library', async () => {
  const dir = tempRepo();
  const before = listFiles(path.join(dir, 'library')).map((f) => [f, read(dir, `library/${f}`)]);
  await bundle(dir, 'task=cold-email', 'customer=acme-pharma');
  assert.deepEqual(listFiles(path.join(dir, 'library')).map((f) => [f, read(dir, `library/${f}`)]), before);
  assert.equal(configOf(dir).dirs.runs, path.join(dir, 'runs'));
});
