import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JUDGE_PROMPT, aggregateSamples, buildJudgeMessage, evidenceFound, extractJson, judgePairs, validateJudgeReply } from '../tools/lib/judge.mjs';

const criteria = [
  { id: 'C1', text: 'Subject line first.', must: true, inputs: null },
  { id: 'C2', text: 'Mentions the fair.', must: false, inputs: ['b'] },
];
const inputs = [
  { id: 'a', input: 'Lead A', notes: null, holdout: false },
  { id: 'b', input: 'Lead B', notes: 'Refers to the fair.', holdout: true },
];
const pairs = judgePairs(criteria, inputs);
const outputs = { a: 'Betreff: Hallo\n\nSehr geehrte Frau Weber,\n„Danke“ – bis bald.', b: 'Subject: The fair\nThanks for Thursday.' };
const verdict = (criterion, input, pass, evidence = '', fix = '') => ({ criterion, input, pass, evidence, fix });

test('judgePairs: every criterion for every input it applies to', () => {
  assert.deepEqual(pairs, [
    { criterion: 'C1', input: 'a' },
    { criterion: 'C1', input: 'b' },
    { criterion: 'C2', input: 'b' },
  ]);
});

test('the judge message has the criteria, the prompt, every input and output, and the pairs; holdout is not marked', () => {
  const msg = buildJudgeMessage({ criteria, inputs, prompt: '## Role\nX', outputs, pairs });
  for (const s of ['- C1 [must]: Subject line first.', '- C2 (only for input b): Mentions the fair.', '## Role\nX', '## Input: b', 'What a good response does: Refers to the fair.', 'Thanks for Thursday.', '- C2, b', 'these 3 pairs']) {
    assert.ok(msg.includes(s), s);
  }
  assert.ok(!/holdout/i.test(msg));
  const system = fs.readFileSync(JUDGE_PROMPT, 'utf8');
  assert.match(system, /verbatim/);
  assert.match(system, /A pass without a verbatim quote counts as a fail/);
  assert.match(system, /"verdicts": \[\{"criterion": "C1", "input": "input-id", "pass": true, "evidence": "[^"]*", "fix": ""\}\], "score": 0, "top_issues": \[\]/);
});

test('extractJson accepts a bare object, a fenced one or one with text around it', () => {
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a": {"b": 2}}\nDone.').value, { a: { b: 2 } });
  assert.match(extractJson('no json here').error, /no JSON object/);
  assert.match(extractJson('{"a": }').error, /not valid JSON/);
});

test('validateJudgeReply: the schema, and exactly one verdict per expected pair', () => {
  const ok = { verdicts: [verdict('C1', 'a', true, 'Betreff: Hallo'), verdict('C1', 'b', false), verdict('C2', 'b', true, 'fair')], score: 70, top_issues: [] };
  assert.deepEqual(validateJudgeReply(ok, pairs), []);
  const bad = {
    verdicts: [verdict('C1', 'a', 'yes', 'x'), { ...verdict('C1', 'a', true, 'x'), note: 1 }, verdict('C9', 'a', true, 'x')],
    score: 140,
    top_issues: ['1', '2', '3', '4'],
    comment: 'hi',
  };
  assert.deepEqual(validateJudgeReply(bad, pairs), [
    'unknown field "comment"',
    '"score" must be a number from 0 to 100',
    '"top_issues" has 4 entries; at most 3',
    'verdicts[0].pass must be true or false',
    'verdicts[1] has an unknown field "note"',
    'verdicts[1]: (C1, a) is judged twice',
    'verdicts[2]: (C9, a) is not one of the pairs to judge',
    'missing verdicts for 2 pairs: (C1, b), (C2, b)',
  ]);
  assert.deepEqual(validateJudgeReply([], pairs), ['the reply must be a JSON object']);
});

test('evidenceFound: a verbatim quote, ignoring case, whitespace and quote or dash styles; "…" joins passages', () => {
  assert.ok(evidenceFound(outputs.a, 'Betreff: Hallo'));
  assert.ok(evidenceFound(outputs.a, '"sehr geehrte   frau weber,"'));
  assert.ok(evidenceFound(outputs.a, '"Danke" - bis bald'));
  assert.ok(evidenceFound(outputs.a, 'Betreff: Hallo … bis bald.'));
  assert.ok(!evidenceFound(outputs.a, 'Betreff: Hallo … see you'), 'every passage must be in the output');
  assert.ok(!evidenceFound(outputs.a, 'Sehr geehrter Herr Weber'), 'a paraphrase is not evidence');
  assert.ok(!evidenceFound(outputs.a, ''));
  assert.ok(!evidenceFound(outputs.a, '…'));
  assert.ok(!evidenceFound(outputs.a, undefined));
});

test('aggregate: a pass without evidence found in the output counts as a fail', () => {
  const sample = { verdicts: [verdict('C1', 'a', true, 'Betreff: Hallo'), verdict('C1', 'b', true, 'Subject: Something else'), verdict('C2', 'b', true, '')], score: 88, top_issues: [] };
  const agg = aggregateSamples({ samples: [sample], pairs, criteria, inputs, outputs });
  assert.deepEqual(
    agg.verdicts.map((v) => [v.criterion, v.input, v.holdout, v.pass, v.votes, v.evidence_found]),
    [
      ['C1', 'a', false, true, '1/1', true],
      ['C1', 'b', true, false, '0/1', false],
      ['C2', 'b', true, false, '0/1', false],
    ],
  );
  assert.match(agg.verdicts[1].fix, /without a verbatim quote/);
  assert.deepEqual(agg.criteria, [
    { id: 'C1', must: true, pass: false, failed_inputs: ['b'] },
    { id: 'C2', must: false, pass: false, failed_inputs: ['b'] },
  ]);
  assert.equal(agg.score, 88);
});

test('aggregate: several samples vote per pair; the score is the median', () => {
  const s = (c1a, score, issues = []) => ({ verdicts: [verdict('C1', 'a', c1a, c1a ? 'Betreff: Hallo' : '', c1a ? '' : `fix ${score}`), verdict('C1', 'b', true, 'The fair'), verdict('C2', 'b', false, '', 'name the fair')], score, top_issues: issues });
  const agg = aggregateSamples({ samples: [s(false, 60, ['low']), s(true, 90, ['high']), s(false, 70, ['mid'])], pairs, criteria, inputs, outputs });
  assert.deepEqual(agg.verdicts.map((v) => `${v.criterion}/${v.input}:${v.pass}:${v.votes}`), ['C1/a:false:1/3', 'C1/b:true:3/3', 'C2/b:false:0/3']);
  assert.equal(agg.verdicts[0].fix, 'fix 60', 'evidence and fix come from a sample that agrees with the majority');
  assert.equal(agg.score, 70);
  assert.deepEqual(agg.top_issues, ['mid'], 'top issues from the sample closest to the median');
  const even = aggregateSamples({ samples: [s(true, 80), s(true, 85)], pairs, criteria, inputs, outputs });
  assert.equal(even.score, 83);
  assert.equal(even.verdicts[0].pass, true);
});
