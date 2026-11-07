import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsPhrase } from '../tools/lib/text.mjs';

test('containsPhrase matches whole words and phrases, case-insensitively', () => {
  assert.ok(containsPhrase('Hallo Anna!', 'hallo'));
  assert.ok(containsPhrase('…sagte: „Hallo“', 'Hallo'));
  assert.ok(containsPhrase('Mit freundlichen\n  Grüßen', 'mit freundlichen grüßen'));
  assert.ok(containsPhrase('is it a game changer?', 'Game Changer'));
  assert.ok(containsPhrase('price (USD) is', '(USD)'), 'regex characters are literal');
  assert.ok(!containsPhrase('Hallorenkugeln', 'Hallo'));
  assert.ok(!containsPhrase('geheilt', 'heilt'));
  assert.ok(!containsPhrase('anything', '   '));
});
