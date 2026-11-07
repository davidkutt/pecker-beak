import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineChecks, countChars, countWords, findPhrase, findPlaceholders, findSection, runChecks } from '../tools/lib/checks.mjs';

test('countWords counts tokens with a letter or digit; countChars ignores surrounding whitespace', () => {
  assert.equal(countWords('Sehr geehrte Frau Dr. Weber,\n\nvielen Dank – bis bald!'), 9, 'the dash is not a word');
  assert.equal(countWords('  '), 0);
  assert.equal(countChars('  Grüße  '), 5);
});

test('findPhrase ignores case and whitespace runs, but not word boundaries', () => {
  assert.deepEqual(findPhrase('Line one\nWe are a GAME   changer.', 'game changer'), { line: 2, text: 'GAME   changer' });
  assert.equal(findPhrase('Das Mittel hat ihn geheilt.', 'heilt'), null);
  assert.deepEqual(findPhrase('Es heilt nicht.', 'heilt'), { line: 1, text: 'heilt' });
  assert.equal(findPhrase('Hallodri', 'Hallo'), null);
  assert.deepEqual(findPhrase('Best,\nAnna', 'Best,'), { line: 1, text: 'Best,' });
  assert.deepEqual(findPhrase('Mit freundlichen Grüßen\nX', 'mit freundlichen grüßen'), { line: 1, text: 'Mit freundlichen Grüßen' });
});

test('findSection matches Markdown headings outside code fences, loosely', () => {
  const text = '# Role\n\n## 2. Output Format:\n\n```text\n## Examples\n```\n\n### **Constraints**\n';
  assert.deepEqual(findSection(text, 'Role'), { name: 'Role', line: 1 });
  assert.deepEqual(findSection(text, 'Output format'), { name: '2. Output Format:', line: 3 });
  assert.deepEqual(findSection(text, 'Constraints'), { name: '**Constraints**', line: 9 });
  assert.equal(findSection(text, 'Examples'), null, 'a heading inside a code fence does not count');
  assert.equal(findSection('Role: you are…', 'Role'), null, 'it must be a heading');
});

test('findPlaceholders allows only {{runtime_var}} and reports everything else', () => {
  const text = [
    '## Role', // 1
    'Sign as {{sender_name}}, {{sender_role}}.', // 2
    'Greet {{lead_name}} and {{ sender_name }}.', // 3
    'Use {company} and [Firmenname] here. TODO: tone.', // 4
    'Mark blocking rules [must], see [the docs](https://x), [x] done.', // 5
    '```text', // 6
    'Hallo [Name], {company}', // 7
    '{{oops}}', // 8
    '```', // 9
  ].join('\n');
  const found = findPlaceholders(text, ['sender_name', 'sender_role']).map((f) => `${f.line} ${f.text}`);
  assert.deepEqual(found, ['3 {{lead_name}}', '3 {{ sender_name }}', '4 {company}', '4 [Firmenname]', '4 TODO', '8 {{oops}}']);
  const hint = findPlaceholders('{{ sender_name }}', ['sender_name'])[0].hint;
  assert.equal(hint, 'write it as {{sender_name}}, without spaces');
  assert.deepEqual(findPlaceholders('Nothing to see.', []), []);
});

test('runChecks: every merged check becomes one result with its sources', () => {
  const checks = {
    required_sections: [{ value: 'Role', sources: ['task'] }, { value: 'Examples', sources: ['task'] }],
    required_phrases: [{ value: 'Mit freundlichen Grüßen', sources: ['formal-de'] }],
    banned: [{ value: 'Hallo', sources: ['formal-de'] }],
    max_words: { value: 5, source: 'customer' },
    min_chars: { value: 3, source: 'task' },
  };
  const results = runChecks('## Role\nHallo Frau Weber, {{x}}\nMit freundlichen Grüßen', checks, { scope: 'prompt', runtimeVars: [] });
  assert.deepEqual(
    results.map((r) => [r.check, r.value, r.pass, r.detail]),
    [
      ['required_section', 'Role', true, '"Role" on line 1'],
      ['required_section', 'Examples', false, 'no heading "Examples"'],
      ['required_phrase', 'Mit freundlichen Grüßen', true, 'on line 3'],
      ['banned', 'Hallo', false, '"Hallo" on line 2'],
      ['max_words', 5, false, '8 words'],
      ['min_chars', 3, true, '55 characters'],
      ['placeholders', null, false, '{{x}} on line 2 (not a runtime variable (this task has none))'],
    ],
  );
  assert.deepEqual(results[3].sources, ['formal-de']);
  assert.deepEqual(results[4].sources, ['customer']);
  assert.ok(!runChecks('x', {}, { scope: 'output' }).some((r) => r.check === 'placeholders'), 'outputs get no placeholder check');
});

test('combineChecks adds a test input\'s own checks, keeping the strictest numbers', () => {
  const base = { banned: [{ value: 'Hallo', sources: ['a'] }], max_words: { value: 180, source: 'c' }, min_words: { value: 10, source: 'c' } };
  const out = combineChecks(base, { banned: [{ value: 'hallo', sources: ['s'] }, { value: 'Hi', sources: ['s'] }], max_words: { value: 80, source: 's' }, min_words: { value: 5, source: 's' } });
  assert.deepEqual(out, {
    banned: [{ value: 'Hallo', sources: ['a'] }, { value: 'Hi', sources: ['s'] }],
    max_words: { value: 80, source: 's' },
    min_words: { value: 10, source: 'c' },
  });
  assert.equal(base.banned.length, 1, 'the base is not changed');
  assert.equal(combineChecks(base, undefined), base);
});
