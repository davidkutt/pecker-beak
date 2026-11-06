import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLOCK_TYPES, COMMON_KEYS, SECTIONS, TYPE_KEYS, isValidDate, parseBlock, validateBlock } from '../tools/lib/blocks.mjs';

const TEMPLATES = fileURLToPath(new URL('../library/_templates/', import.meta.url));

const BODY = `## Purpose

What this is for.

## Must include

## Avoid

## Examples

## Done when

- [must] Something observable
`;

function block(frontmatter, body = BODY) {
  return parseBlock(`---\n${frontmatter}\n---\n\n${body}`, 'x.md');
}

const errors = (findings) => findings.filter((f) => f.level === 'error');
const messages = (findings) => findings.map((f) => f.message);

const TONE = 'id: x\ntype: tone\nversion: 1\nlanguage: en\nupdated: 2026-11-06';

test('a complete block parses without findings', () => {
  const b = block(TONE);
  assert.deepEqual(b.findings, []);
  assert.deepEqual(validateBlock(b, { expectedType: 'tone', expectedId: 'x' }), []);
  assert.deepEqual(b.frontmatter, { id: 'x', type: 'tone', version: 1, language: 'en', updated: '2026-11-06' });
  assert.deepEqual(
    b.sections.map((s) => s.name),
    SECTIONS,
  );
});

test('Done when items: [must], (learned date), line numbers', () => {
  const b = block(TONE, BODY.replace('- [must] Something observable', '- [must] Uses Sie (learned 2026-10-01)\n- Short sentences'));
  assert.deepEqual(b.findings, []);
  assert.deepEqual(b.doneWhen, [
    { criterion: 'Uses Sie', must: true, learned: '2026-10-01', line: 21 },
    { criterion: 'Short sentences', must: false, learned: null, line: 22 },
  ]);
});

test('Done when rejects prose, checkboxes and bad learned dates', () => {
  const b = block(TONE, BODY.replace('- [must] Something observable', 'prose\n- [x] done\n- x (learned 2026-02-30)'));
  assert.deepEqual(messages(errors(b.findings)), [
    '"## Done when": each criterion must be one list item line starting with "- "',
    '"## Done when": use plain list items, not checkboxes; mark blocking criteria with "[must]"',
    '"## Done when": "(learned 2026-02-30)" needs a date like (learned 2026-11-06)',
  ]);
});

test('examples: Good:/Bad: labels start an example, fences keep content verbatim', () => {
  const examples = 'Good: inline one\n\nBad:\n```text\nGood: not a label inside a fence\n## not a heading either\n```\n';
  const b = block(TONE, BODY.replace('## Examples\n', `## Examples\n\n${examples}`));
  assert.deepEqual(b.findings, []);
  assert.deepEqual(
    b.sections.map((s) => s.name),
    SECTIONS,
  );
  assert.deepEqual(b.examples, [
    { label: 'good', line: 19, text: 'inline one' },
    { label: 'bad', line: 21, text: '```text\nGood: not a label inside a fence\n## not a heading either\n```' },
  ]);
});

test('unlabelled examples are allowed; near-miss labels warn', () => {
  const b = block(TONE, BODY.replace('## Examples\n', '## Examples\n\nJust an example.\n\nbad: lowercase\n'));
  assert.deepEqual(errors(b.findings), []);
  assert.equal(b.examples[0].label, null);
  assert.ok(messages(b.findings).some((m) => m.includes('write labels exactly as "Good:" or "Bad:"')));
});

test('one # title is allowed above the sections, a second one is not', () => {
  const b = block(TONE, `# Title\n\n${BODY}\n# Another\n`);
  assert.deepEqual(b.title, { text: 'Title', line: 9 });
  assert.deepEqual(messages(b.findings), ['a level-1 heading ("# …") is only allowed once, as a title above "## Purpose"']);
});

test('section layout: unknown, miscased, duplicate, out of order, missing', () => {
  const body = '## Avoid\n\n## purpose\n\nx\n\n## Notes\n\n## Avoid\n\n## Examples\n';
  const m = messages(block(TONE, body).findings);
  assert.ok(m.includes('section "## purpose" must be written "## Purpose"'));
  assert.ok(m.includes('unknown section "## Notes" (sections are: Purpose, Must include, Avoid, Examples, Done when)'));
  assert.ok(m.includes('section "## Avoid" appears twice (first on line 9)'));
  assert.ok(m.some((x) => x.startsWith('missing sections "## Must include", "## Done when"')), m.join('\n'));
  assert.ok(!m.some((x) => x.includes('"## Purpose" (')), 'a miscased section is not also reported missing');

  const swapped = BODY.replace('## Must include\n\n## Avoid', '## Avoid\n\n## Must include');
  assert.ok(messages(block(TONE, swapped).findings).some((x) => x.startsWith('sections are out of order')));
});

test('frontmatter problems: missing, unclosed, invalid YAML with the file line', () => {
  assert.match(parseBlock('## Purpose\n', 'x.md').findings[0].message, /must start with YAML frontmatter/);
  assert.match(parseBlock('---\nid: x\n', 'x.md').findings[0].message, /frontmatter is never closed/);
  const bad = parseBlock(`---\nid: x\ntags: [a\n---\n${BODY}`, 'x.md').findings[0];
  assert.equal(bad.line, 3);
  assert.match(bad.message, /^invalid YAML in frontmatter: /);
  assert.doesNotMatch(bad.message, /at line \d+/);
});

test('unclosed code fence is reported', () => {
  const b = block(TONE, BODY.replace('## Examples\n', '## Examples\n\n```text\nnever closed\n'));
  assert.ok(messages(b.findings).includes('code fence is never closed'));
});

test('lineOf points at nested frontmatter values', () => {
  const b = block(`${TONE}\nchecks:\n  output:\n    max_words: 10`);
  assert.equal(b.lineOf(['checks', 'output', 'max_words']), 9);
  assert.equal(b.lineOf(['version']), 4);
  assert.equal(b.lineOf(['missing', 'path']), undefined);
});

test('validate: id, type, version, updated and language', () => {
  const b = block('id: Wrong_Id\ntype: tone\nversion: 1.5\nupdated: 2026-02-30');
  const m = messages(validateBlock(b, { expectedType: 'customer', expectedId: 'acme' }));
  assert.ok(m.includes('id "Wrong_Id" must be a lowercase slug (a-z, 0-9, single hyphens)'));
  assert.ok(m.includes('type "tone" does not match its folder customers/ (expected "customer")'));
  assert.ok(m.includes('version must be a whole number >= 1 (got 1.5)'));
  assert.ok(m.includes('updated must be a date like 2026-11-06 (got "2026-02-30")'));
  assert.ok(m.includes('a customer needs "language" (e.g. de, en)'));
  assert.ok(m.includes('missing "industry" (an industry id)'));
});

test('validate: fields from another block type and unknown fields', () => {
  const m = messages(validateBlock(block(`${TONE}\nconsumer: sales-agent\ncolour: red`), { expectedType: 'tone', expectedId: 'x' }));
  assert.ok(m.includes('"consumer" does not belong in a tone block (it is a task field)'));
  assert.ok(m.some((x) => x.startsWith('unknown field "colour" (a tone block allows: id, type')));
});

test('validate: TODO: values in references are left to the TODO warning', () => {
  const fm = 'id: x\ntype: customer\nversion: 1\nlanguage: "TODO: ask"\nupdated: 2026-11-06\nindustry: "TODO: which?"\ndefault_tone: formal-de';
  const b = block(fm);
  assert.deepEqual(validateBlock(b, { expectedType: 'customer', expectedId: 'x' }), []);
  assert.equal(b.todos.length, 2);
});

test('validate: task fields', () => {
  const fm = [
    'id: t',
    'type: task',
    'version: 1',
    'updated: 2026-11-06',
    'consumer: sales-agent',
    'output_format: [Role, Role]',
    'test_inputs: [a, { id: a, input: hi }, { id: b }, 42, { id: c, input: x, extra: 1 }]',
    'runtime_vars: [sender_name, sender_name]',
  ].join('\n');
  const findings = validateBlock(block(fm), { expectedType: 'task', expectedId: 't' });
  const m = messages(findings);
  assert.ok(m.includes('output_format lists "Role" more than once'));
  assert.ok(m.includes('test_inputs: "a" is listed twice'));
  assert.ok(m.includes('test_inputs[2] ("b") needs non-empty "input" text'));
  assert.ok(m.includes('test_inputs[3] must be a scenario id or { id, input }'));
  assert.ok(m.includes('test_inputs[4] has unknown fields: extra (only id and input)'));
  assert.ok(m.includes('runtime_vars lists "sender_name" more than once'));
});

test('validate: checks scopes, keys, numbers and min > max', () => {
  const fm = `${TONE}\nchecks:\n  output:\n    max_chars: 10\n    min_chars: 20\n    required_phrases: ["", ok]\n  prompt:\n    required_sections: [Role]\n    max_words: -1`;
  const m = messages(validateBlock(block(fm), { expectedType: 'tone', expectedId: 'x' }));
  assert.ok(m.includes('checks.output.min_chars (20) is larger than max_chars (10)'));
  assert.ok(m.includes('checks.output.required_phrases must be a list of non-empty strings'));
  assert.ok(m.includes('checks.prompt.max_words must be a whole number >= 0 (got -1)'));
  assert.ok(!m.some((x) => x.includes('required_sections')));
});

test('a task needs at least one Done-when criterion; other types do not', () => {
  const empty = BODY.replace('- [must] Something observable\n', '');
  const task = 'id: t\ntype: task\nversion: 1\nupdated: 2026-11-06\nconsumer: a\noutput_format: [Role]\ntest_inputs: [s]';
  const tf = validateBlock(block(task, empty), { expectedType: 'task', expectedId: 't' });
  assert.deepEqual(messages(tf), ['a task needs at least one criterion under "## Done when"']);
  assert.equal(tf[0].line, 21);
  assert.deepEqual(validateBlock(block(TONE, empty), { expectedType: 'tone', expectedId: 'x' }), []);
});

test('isValidDate', () => {
  assert.ok(isValidDate('2026-11-06'));
  assert.ok(isValidDate('2028-02-29'));
  assert.ok(!isValidDate('2026-02-29'));
  assert.ok(!isValidDate('06.11.2026'));
});

test('there is a template for every block type, with every section and field', () => {
  const files = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(BLOCK_TYPES).map((t) => `${t}.md`).sort());
  for (const type of Object.keys(BLOCK_TYPES)) {
    const text = fs.readFileSync(`${TEMPLATES}${type}.md`, 'utf8');
    const b = parseBlock(text, `${type}.md`);
    assert.deepEqual(errors(b.findings), [], `${type}.md has structural errors`);
    assert.equal(b.frontmatter.type, type);
    assert.deepEqual(
      b.sections.map((s) => s.name),
      SECTIONS,
      `${type}.md sections`,
    );
    for (const key of [...COMMON_KEYS.filter((k) => k !== 'checks' && k !== 'language'), ...TYPE_KEYS[type]]) {
      assert.match(text, new RegExp(`^(# )?${key}:`, 'm'), `${type}.md should show "${key}"`);
    }
    assert.ok(b.todos.length > 0, `${type}.md should mark what intake must fill with TODO:`);
  }
});
