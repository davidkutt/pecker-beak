import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../tools/lib/config.mjs';
import { findCommand, localDate, saveCommand, setFrontmatterFields } from '../tools/lib/intake.mjs';
import { loadLibrary } from '../tools/lib/library.mjs';
import { lint } from '../tools/lib/lint.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'tools', 'beak.mjs');
const TODAY = '2026-11-07';

/** A temp repo with the real beak.config.yaml and a copy of the example library. */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-intake-'));
  fs.copyFileSync(path.join(REPO, 'beak.config.yaml'), path.join(dir, 'beak.config.yaml'));
  fs.cpSync(path.join(REPO, 'library'), path.join(dir, 'library'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'library', '_intake'));
  return dir;
}

function stage(dir, name, text) {
  const file = path.join(dir, 'library', '_intake', name);
  fs.writeFileSync(file, text);
  return file;
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

/** Run a command function in-process; returns { code, out, err }. */
async function run(command, dir, args) {
  let out = '';
  let err = '';
  const io = { out: { write: (s) => (out += s) }, err: { write: (s) => (err += s) } };
  const code = await command(args, io, { cwd: dir, env: {}, today: TODAY });
  return { code, out, err };
}

const save = (dir, ...args) => run(saveCommand, dir, args);
const find = (dir, ...args) => run(findCommand, dir, args);

// A new customer whose industry does not exist yet. The example is deliberately awkward to copy:
// quotes, an apostrophe, an umlaut, double spaces and a blank line.
const EXAMPLE = 'Hi Sam,  it\'s "Globex" here.\n\nGrüße aus Hamburg';
const GLOBEX = `---
id: globex
type: customer
version: 1                # set by beak save
language: en
updated: "TODO: YYYY-MM-DD" # set by beak save
industry: logistics
default_tone: friendly-en
---

# Globex Logistics

## Purpose

Globex Logistics is a freight forwarder. Its sales agent writes to shippers in the UK.

## Must include

- TODO: what every Globex email contains.

## Avoid

- Promises about delivery times.

## Examples

\`\`\`text
${EXAMPLE}
\`\`\`

## Done when

- Mentions the shipper's route.
`;

const LOGISTICS = `---
id: logistics
type: industry
updated: x
---

# Logistics

## Purpose

Writing to shippers and freight buyers.

## Must include

- Routes and transit times.

## Avoid

- Guarantees about customs clearance.

## Examples

## Done when

- Names the route.
`;

test('find: exact, likely and new', async () => {
  const dir = tempRepo();
  let r = await find(dir, 'Acme', 'Pharma', 'GmbH', 'type=customer');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'slug: acme-pharma\nexact: library/customers/acme-pharma.md (customer acme-pharma, version 1, "Acme Pharma (example customer)")\n');

  r = await find(dir, 'Acme', 'type=customers');
  assert.equal(r.out, 'slug: acme\nlikely: library/customers/acme-pharma.md (customer acme-pharma, version 1, "Acme Pharma (example customer)")\nnew: library/customers/acme.md\n');

  r = await find(dir, 'Globex Logistics Ltd', 'type=customer');
  assert.equal(r.out, 'slug: globex-logistics\nnew: library/customers/globex-logistics.md\n');

  r = await find(dir, 'Globex');
  assert.equal(r.out, 'slug: globex\nnone: no similar block in the library\n');

  r = await find(dir, 'pharma');
  assert.match(r.out, /^slug: pharma\nexact: library\/industries\/pharma\.md .*\nlikely: library\/customers\/acme-pharma\.md /);
});

test('find: usage errors', async () => {
  const dir = tempRepo();
  for (const [args, message] of [
    [[], /give the name to look for/],
    [['Acme', 'type=person'], /type must be one of: task, scenario, customer, industry, tone, context \(got "person"\)/],
    [['Acme', 'kind=customer'], /unknown key "kind"/],
    [['Acme', '--json'], /unknown option --json/],
    [['!!'], /has no letters or digits/],
  ]) {
    const r = await find(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, message);
  }
});

test('save: a new customer and its new industry, checked together, then written', async () => {
  const dir = tempRepo();
  const g = stage(dir, 'globex.md', GLOBEX);

  // alone, the customer refers to an industry that does not exist: nothing is written
  let r = await save(dir, 'library/_intake/globex.md', '--check');
  assert.equal(r.code, 1);
  assert.match(r.out, /^library\/_intake\/globex\.md:7: error: industry "logistics" not found/m);
  assert.match(r.out, /^not saved: 1 error, nothing written/m);

  const l = stage(dir, 'logistics.md', LOGISTICS);
  r = await save(dir, 'library/_intake/globex.md', 'library/_intake/logistics.md', '--check');
  assert.equal(r.code, 0, r.out);
  assert.equal(
    r.out,
    [
      'would create library/customers/globex.md (customer globex, version 1)',
      'would create library/industries/logistics.md (industry logistics, version 1)',
      'library/_intake/globex.md:19: warning: TODO left: - TODO: what every Globex email contains.',
      'check: ok, nothing written',
      '',
    ].join('\n'),
  );
  assert.ok(!fs.existsSync(path.join(dir, 'library/customers/globex.md')), '--check writes nothing');
  assert.ok(fs.existsSync(g) && fs.existsSync(l), '--check keeps the staged files');

  r = await save(dir, 'library/_intake/globex.md', 'library/_intake/logistics.md');
  assert.equal(r.code, 0, r.out);
  assert.equal(
    r.out,
    [
      'created library/customers/globex.md (customer globex, version 1)',
      'created library/industries/logistics.md (industry logistics, version 1)',
      'library/customers/globex.md:19: warning: TODO left: - TODO: what every Globex email contains.',
      'saved: 2 created, 0 updated, 0 unchanged',
      '',
    ].join('\n'),
  );
  assert.ok(!fs.existsSync(g) && !fs.existsSync(l), 'staged files are removed after saving');

  const customer = read(dir, 'library/customers/globex.md');
  assert.equal(customer, GLOBEX.replace('updated: "TODO: YYYY-MM-DD"', `updated: ${TODAY}`), 'only updated changed; comments kept');
  assert.ok(customer.includes(`\`\`\`text\n${EXAMPLE}\n\`\`\``), 'the example is byte for byte what was staged');
  const industry = read(dir, 'library/industries/logistics.md');
  assert.ok(industry.startsWith(`---\nid: logistics\ntype: industry\nversion: 1\nupdated: ${TODAY}\n---\n`), industry);

  const { config } = loadConfig({ root: dir, env: {} });
  assert.deepEqual(lint({ config }).findings.filter((f) => f.level === 'error'), [], 'the library still lints clean');
});

test('save: an update bumps the version and sets updated; the same content again changes nothing', async () => {
  const dir = tempRepo();
  const current = read(dir, 'library/customers/acme-pharma.md');

  // the same content, whatever version or date the staged copy claims
  stage(dir, 'acme-pharma.md', current.replace('version: 1', 'version: 7').replace('updated: 2026-11-06', 'updated: 1999-01-01'));
  let r = await save(dir, 'library/_intake/acme-pharma.md');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^unchanged library\/customers\/acme-pharma\.md \(customer acme-pharma, version 1\)$/m);
  assert.equal(read(dir, 'library/customers/acme-pharma.md'), current);
  assert.ok(!fs.existsSync(path.join(dir, 'library/_intake/acme-pharma.md')));

  // a real change, with version and updated left out entirely
  const changed = current
    .replace('- Comparisons with named competitors.', '- Comparisons with named competitors.\n- Exclamation marks.')
    .replace(/^version: 1\n/m, '')
    .replace(/^updated: 2026-11-06\n/m, '');
  stage(dir, 'acme-pharma.md', changed);
  r = await save(dir, 'library/_intake/acme-pharma.md');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^updated library\/customers\/acme-pharma\.md \(customer acme-pharma, version 1 → 2\)$/m);
  const saved = read(dir, 'library/customers/acme-pharma.md');
  assert.match(saved, new RegExp(`^---\\nid: acme-pharma\\ntype: customer\\nversion: 2\\nupdated: ${TODAY}\\nlanguage: de\\n`));
  assert.ok(saved.includes('- Exclamation marks.'));

  // and again: version 3
  stage(dir, 'acme-pharma.md', saved.replace('- Exclamation marks.', '- Exclamation marks or emojis.'));
  r = await save(dir, 'library/_intake/acme-pharma.md');
  assert.match(r.out, /version 2 → 3/);
});

test('save: a new block that looks like an existing one is refused unless --new', async () => {
  const dir = tempRepo();
  const acme = read(dir, 'library/customers/acme-pharma.md');
  stage(dir, 'acme-pharma-gmbh.md', acme.replace('id: acme-pharma', 'id: acme-pharma-gmbh'));
  let r = await save(dir, 'library/_intake/acme-pharma-gmbh.md');
  assert.equal(r.code, 1);
  assert.match(
    r.out,
    /^library\/_intake\/acme-pharma-gmbh\.md:2: error: looks like a duplicate of library\/customers\/acme-pharma\.md \(customer acme-pharma, version 1, "Acme Pharma \(example customer\)"\)\. If it is the same customer, update that file instead \(stage it with id: acme-pharma\)\. If the user confirms it is a different customer, run beak save again with --new$/m,
  );
  assert.ok(!fs.existsSync(path.join(dir, 'library/customers/acme-pharma-gmbh.md')));

  // the title alone is enough to notice
  stage(dir, 'ap.md', acme.replace('id: acme-pharma', 'id: ap'));
  r = await save(dir, 'library/_intake/ap.md');
  assert.match(r.out, /ap\.md:2: error: looks like a duplicate of library\/customers\/acme-pharma\.md/);

  r = await save(dir, 'library/_intake/acme-pharma-gmbh.md', '--new');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^created library\/customers\/acme-pharma-gmbh\.md \(customer acme-pharma-gmbh, version 1\)$/m);
});

test('save: a changed or missing example is refused unless --drop-examples', async () => {
  const dir = tempRepo();
  const acme = read(dir, 'library/customers/acme-pharma.md');
  stage(dir, 'acme-pharma.md', acme.replace('Hätten Sie in der kommenden Woche', 'Hätten Sie nächste Woche'));
  let r = await save(dir, 'library/_intake/acme-pharma.md');
  assert.equal(r.code, 1);
  assert.match(
    r.out,
    /^library\/_intake\/acme-pharma\.md: error: the example on line 35 of library\/customers\/acme-pharma\.md \("Betreff: Lieferengpässe bei Antibiotika – kurze…"\) is missing or changed\. Examples stay verbatim: copy it back unchanged, or pass --drop-examples if the user asked to remove or replace it$/m,
  );
  assert.equal(read(dir, 'library/customers/acme-pharma.md'), acme);

  // a new label or another fence language is not a change to the example
  stage(dir, 'acme-pharma.md', acme.replace('Good:\n```text\nBetreff: Ihre', 'Bad:\n```\nBetreff: Ihre'));
  r = await save(dir, 'library/_intake/acme-pharma.md');
  assert.equal(r.code, 0, r.out);

  stage(dir, 'acme-pharma.md', read(dir, 'library/customers/acme-pharma.md').replace('Hätten Sie in der kommenden Woche', 'Hätten Sie nächste Woche'));
  r = await save(dir, 'library/_intake/acme-pharma.md', '--drop-examples');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /version 2 → 3/);
});

test('save: staged files must say where they go, and must not already be in the library', async () => {
  const dir = tempRepo();
  stage(dir, 'a.md', '---\nid: Globex Two\ntype: customer\n---\n');
  stage(dir, 'b.md', '---\nid: b\ntype: person\n---\n');
  stage(dir, 'c.md', 'no frontmatter\n');
  let r = await save(dir, 'library/_intake/a.md', 'library/_intake/b.md', 'library/_intake/c.md');
  assert.equal(r.code, 1);
  assert.match(r.out, /^library\/_intake\/a\.md:2: error: id "Globex Two" must be a lowercase slug .* \(beak find suggests one\)$/m);
  assert.match(r.out, /^library\/_intake\/b\.md:3: error: type "person" must be one of: task, scenario, customer, industry, tone, context; it decides which folder the block goes in$/m);
  assert.match(r.out, /^library\/_intake\/c\.md:1: error: must start with YAML frontmatter/m);
  assert.match(r.out, /^not saved: 3 errors, nothing written/m);

  r = await save(dir, 'library/customers/acme-pharma.md');
  assert.equal(r.code, 1);
  assert.match(r.out, /^library\/customers\/acme-pharma\.md: error: is already in the library; write the proposal to library\/_intake\/ and save it from there$/m);

  stage(dir, 'x1.md', GLOBEX);
  stage(dir, 'x2.md', GLOBEX);
  r = await save(dir, 'library/_intake/x1.md', 'library/_intake/x2.md', '--new');
  assert.match(r.out, /^library\/_intake\/x2\.md: error: goes to the same file as library\/_intake\/x1\.md \(library\/customers\/globex\.md\)$/m);
});

test('save: lint errors point at the staged file, with its own line numbers', async () => {
  const dir = tempRepo();
  // no version or updated: save inserts two lines, the reported line must still match the staged file
  const text = '---\nid: brisk-en\ntype: tone\nlanguage: en\n---\n\n## Purpose\n\nShort.\n\n## Avoid\n\n## Examples\n\n## Done when\n\n- [ ] a checkbox\n';
  stage(dir, 'brisk-en.md', text);
  const r = await save(dir, 'library/_intake/brisk-en.md');
  assert.equal(r.code, 1);
  assert.equal(text.split('\n')[16], '- [ ] a checkbox');
  assert.match(r.out, /^library\/_intake\/brisk-en\.md:17: error: "## Done when": use plain list items, not checkboxes/m);
  assert.match(r.out, /^library\/_intake\/brisk-en\.md: error: missing section "## Must include"/m);
  assert.ok(!fs.existsSync(path.join(dir, 'library/tones/brisk-en.md')));
});

test('save: a staged file outside library/_intake/ is not removed', async () => {
  const dir = tempRepo();
  const file = path.join(dir, 'globex.md');
  fs.writeFileSync(file, GLOBEX.replace('industry: logistics', 'industry: saas'));
  const r = await save(dir, 'globex.md');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(dir, 'library/customers/globex.md')));
});

test('save: usage errors', async () => {
  const dir = tempRepo();
  for (const [args, message] of [
    [[], /give the staged file\(s\) to save/],
    [['nope.md'], /nope\.md: no such file/],
    [['library/_intake'], /library\/_intake: no such file/],
    [['x.md', '--force'], /unknown option --force/],
  ]) {
    const r = await save(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, message);
  }
});

test('beak find and beak save work through the CLI from a subdirectory', () => {
  const dir = tempRepo();
  stage(dir, 'globex.md', GLOBEX.replace('industry: logistics', 'industry: saas'));
  const cwd = path.join(dir, 'library', '_intake');
  const beak = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BEAK_RUNNER: '' } });
  let r = beak('find', 'Globex', 'type=customer');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'slug: globex\nnew: library/customers/globex.md\n');
  r = beak('save', 'globex.md');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^created library\/customers\/globex\.md \(customer globex, version 1\)$/m);
  assert.match(read(dir, 'library/customers/globex.md'), new RegExp(`^updated: ${localDate()} # set by beak save$`, 'm'));
  r = beak('find', 'Globex', 'type=customer');
  assert.match(r.stdout, /^exact: library\/customers\/globex\.md \(customer globex, version 1, "Globex Logistics"\)$/m);
});

test('setFrontmatterFields replaces values in place and keeps comments', () => {
  const text = '---\nid: x\ntype: tone\nversion: 3 # bump on every edit\nupdated: "2026-11-06"\nlanguage: de\n---\n\nbody\n';
  const r = setFrontmatterFields(text, [['version', '4'], ['updated', '2026-11-07']]);
  assert.equal(r.text, '---\nid: x\ntype: tone\nversion: 4 # bump on every edit\nupdated: 2026-11-07\nlanguage: de\n---\n\nbody\n');
  assert.deepEqual(r.inserted, []);
});

test('setFrontmatterFields inserts missing fields after type and reports their lines', () => {
  const r = setFrontmatterFields('---\nid: x\ntype: tone\nlanguage: de\n---\nbody', [['version', '1'], ['updated', '2026-11-07']]);
  assert.equal(r.text, '---\nid: x\ntype: tone\nversion: 1\nupdated: 2026-11-07\nlanguage: de\n---\nbody');
  assert.deepEqual(r.inserted, [4, 5]);

  const noType = setFrontmatterFields('---\nid: x\n---\n', [['version', '1']]);
  assert.equal(noType.text, '---\nid: x\nversion: 1\n---\n');
});

test('setFrontmatterFields handles empty values, CRLF, and unreadable frontmatter', () => {
  assert.equal(setFrontmatterFields('---\nid: x\nversion:\nupdated: TODO\n---\n', [['version', '2']]).text, '---\nid: x\nversion: 2\nupdated: TODO\n---\n');
  assert.equal(setFrontmatterFields('---\r\nid: x\r\nversion: 1\r\n---\r\n', [['version', '2']]).text, '---\nid: x\nversion: 2\n---\n');
  assert.equal(setFrontmatterFields('no frontmatter', [['version', '2']]), null);
  assert.equal(setFrontmatterFields('---\nid: [x\n---\n', [['version', '2']]), null);
  assert.equal(setFrontmatterFields('---\nid: x\n', [['version', '2']]), null);
});

test('loadLibrary overlay: files and folders that are not on disk yet', () => {
  const dir = tempRepo();
  const lib = path.join(dir, 'library');
  fs.rmSync(path.join(lib, 'context'), { recursive: true, force: true });
  const overlay = new Map([
    [path.join(lib, 'context', 'product-facts.md'), '---\nid: product-facts\ntype: context\nversion: 1\nupdated: 2026-11-07\n---\n\n## Purpose\n\nFacts.\n\n## Must include\n\n## Avoid\n\n## Examples\n\n## Done when\n'],
    [path.join(lib, 'tones', 'formal-de.md'), read(dir, 'library/tones/formal-de.md').replace('version: 1', 'version: 9')],
  ]);
  const { byType, findings } = loadLibrary(lib, { root: dir, overlay });
  assert.deepEqual(findings, []);
  assert.equal(byType.context.get('product-facts').frontmatter.id, 'product-facts');
  assert.equal(byType.tone.get('formal-de').frontmatter.version, 9, 'the overlay replaces the file on disk');
  assert.equal(read(dir, 'library/tones/formal-de.md').includes('version: 9'), false, 'the disk is untouched');
});

test('localDate formats the local date', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
