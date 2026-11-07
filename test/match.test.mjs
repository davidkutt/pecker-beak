import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIKELY, nameTokens, rankBlocks, similarity, slugify } from '../tools/lib/match.mjs';
import { loadLibrary } from '../tools/lib/library.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

test('slugify: lowercase ASCII, umlauts spelled out, legal forms and parentheses dropped', () => {
  assert.equal(slugify('Acme Pharma GmbH'), 'acme-pharma');
  assert.equal(slugify('Acme Pharma (example customer)'), 'acme-pharma');
  assert.equal(slugify('Müller & Co. KG'), 'mueller');
  assert.equal(slugify('Straße der Einheit e.V.'), 'strasse-der-einheit');
  assert.equal(slugify('Société Générale S.A.'), 'societe-generale');
  assert.equal(slugify('Trade-fair follow-up!'), 'trade-fair-follow-up');
  assert.equal(slugify('Formell (Deutsch)'), 'formell');
  assert.equal(slugify('AG'), 'ag', 'a legal form alone is kept');
  assert.equal(slugify('  !! '), '');
});

test('slugify caps long names at a word boundary', () => {
  const slug = slugify('customer asks about a delivery delay after a failed shipment last week and wants a refund');
  assert.ok(slug.length <= 60, slug);
  assert.ok(!slug.endsWith('-'));
  assert.ok('customer-asks-about-a-delivery-delay-after-a-failed-shipment-last-week'.startsWith(slug));
});

test('nameTokens', () => {
  assert.deepEqual(nameTokens('ACME Pharma Deutschland GmbH'), ['acme', 'pharma', 'deutschland']);
  assert.deepEqual(nameTokens('formal-de'), ['formal', 'de']);
  assert.deepEqual(nameTokens(undefined), []);
});

test('similarity: the same customer written differently is a likely match', () => {
  for (const name of ['Acme Pharma GmbH', 'acme pharma', 'ACME-Pharma', 'Akme Pharma', 'Acme Pharmaceuticals', 'ACME Pharma Deutschland', 'Acme']) {
    assert.ok(similarity(name, 'acme-pharma') >= LIKELY, `${name}: ${similarity(name, 'acme-pharma')}`);
  }
  assert.equal(similarity('Bristol-Myers Squibb', 'Bristol Myers Squibb'), 1);
});

test('similarity: different things stay apart', () => {
  for (const [a, b] of [
    ['Pharma Nord', 'acme-pharma'],
    ['friendly-de', 'friendly-en'],
    ['formal-en', 'formal-de'],
    ['Globex', 'acme-pharma'],
    ['saas', 'pharma'],
  ]) {
    assert.ok(similarity(a, b) < LIKELY, `${a} vs ${b}: ${similarity(a, b)}`);
  }
  assert.equal(similarity('', 'x'), 0);
});

test('rankBlocks: exact id first, then likely matches by score; filters by type', () => {
  const { blocks } = loadLibrary(path.join(REPO, 'library'), { root: REPO });
  const ids = (ms) => ms.map((m) => `${m.kind}:${m.block.type}/${m.block.id}`);
  assert.deepEqual(ids(rankBlocks(blocks, 'Pharma')), ['exact:industry/pharma', 'likely:customer/acme-pharma']);
  assert.deepEqual(ids(rankBlocks(blocks, 'Pharma', { type: 'customer' })), ['likely:customer/acme-pharma']);
  assert.deepEqual(ids(rankBlocks(blocks, 'Acme Pharma GmbH', { type: 'customer' })), ['exact:customer/acme-pharma']);
  assert.deepEqual(ids(rankBlocks(blocks, 'Friendly', { type: 'tone' })), ['likely:tone/friendly-en']);
  assert.deepEqual(ids(rankBlocks(blocks, 'Globex', { type: 'customer' })), []);
  // the title counts too: "Formell (Deutsch)" is the title of formal-de
  assert.deepEqual(ids(rankBlocks(blocks, 'Formell', { type: 'tone' })), ['likely:tone/formal-de']);
});
