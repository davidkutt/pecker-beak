// pi loads Beak's skills (.pi/skills/<name>/SKILL.md) and slash commands (.pi/prompts/<name>.md) only if their
// frontmatter parses. pi uses the same `yaml` package, and in print mode drops a broken file without a word
// (an unquoted "New customer: …" in a description once did exactly that). See docs/pi-notes.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { COMMANDS } from '../tools/beak.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = path.join(REPO, '.pi', 'skills');
const PROMPTS = path.join(REPO, '.pi', 'prompts');

// Same split as pi's parseFrontmatter (dist/utils/frontmatter.js): YAML.parse throws on invalid YAML.
function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  assert.ok(text.startsWith('---\n'), `${file} must start with frontmatter`);
  const end = text.indexOf('\n---', 3);
  assert.ok(end > 0, `${file}: frontmatter is never closed`);
  return { data: YAML.parse(text.slice(4, end)) ?? {}, body: text.slice(end + 4).trim() };
}

test('every skill has frontmatter pi accepts (Agent Skills rules)', () => {
  const dirs = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.ok(dirs.includes('beak-intake'));
  for (const dir of dirs) {
    const { data } = frontmatter(path.join(SKILLS, dir, 'SKILL.md'));
    assert.equal(data.name, dir, `${dir}: name must equal the folder name`);
    assert.match(data.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(data.name.length <= 64);
    assert.equal(typeof data.description, 'string', `${dir}: description is required, or pi skips the skill`);
    assert.ok(data.description.trim().length > 0 && data.description.length <= 1024, `${dir}: description length`);
  }
});

test('every prompt template has frontmatter pi accepts and a description', () => {
  const files = fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.md')).sort();
  assert.ok(files.includes('add.md'));
  for (const f of files) {
    const { data, body } = frontmatter(path.join(PROMPTS, f));
    assert.equal(typeof data.description, 'string', `${f}: description`);
    assert.ok(body.length > 0, `${f}: empty body`);
  }
});

test('the intake skill uses the scripts and states the rules plan §8 asks for', () => {
  const { body } = frontmatter(path.join(SKILLS, 'beak-intake', 'SKILL.md'));
  for (const cmd of ['find', 'save']) {
    assert.ok(COMMANDS.find((c) => c.name === cmd)?.run, `beak ${cmd} must be built`);
    assert.match(body, new RegExp(`node tools/beak\\.mjs ${cmd} `), `skill must run beak ${cmd}`);
  }
  for (const phrase of [
    'library/_templates/<type>.md', // load the template
    'library/_intake/<id>.md', // stage, never write the library directly
    '--check', // show before writing
    'verbatim', // examples
    'TODO:', // unknowns
    'at most 3 questions',
    'relative to the repo root', // pi says skill paths are relative to the skill folder; ours are not
  ]) {
    assert.ok(body.includes(phrase), `skill should mention ${phrase}`);
  }
  assert.ok(!/version: \d|updated: 20\d\d/.test(body), 'the skill must not tell the model to write version or updated');
});

test('/add hands its text to the intake skill and warns that pi stripped quotes and line breaks', () => {
  const { body } = frontmatter(path.join(PROMPTS, 'add.md'));
  assert.match(body, /beak-intake/);
  assert.match(body, /\$\{@:-[^}]+\}/, 'uses ${@:-…} so an empty /add still asks what to add');
  assert.match(body, /quote characters and line breaks/);
  assert.match(body, /never copy examples from it/);
});

test('the compose skill bundles with the script, reads only bundle.md and hands over to the quality loop', () => {
  const { body } = frontmatter(path.join(SKILLS, 'beak-compose', 'SKILL.md'));
  assert.ok(COMMANDS.find((c) => c.name === 'bundle')?.run, 'beak bundle must be built');
  for (const phrase of [
    'node tools/beak.mjs bundle',
    'bundle.md',
    'inputs.json', // the holdout inputs it must not read
    'round-0/prompt.md',
    'round-0/changes.md',
    '{{name}}',
    'verbatim',
    'Scripts produce all evidence, scores and stop decisions.',
    '.pi/skills/beak-quality-loop/SKILL.md',
    'relative to the repo root',
  ]) {
    assert.ok(body.includes(phrase), `compose skill should mention ${phrase}`);
  }
});

test('/compose hands its key=value arguments to the compose skill', () => {
  const { data, body } = frontmatter(path.join(PROMPTS, 'compose.md'));
  assert.match(data['argument-hint'], /task=<id>/);
  assert.match(body, /beak-compose/);
  assert.match(body, /\$\{@:-[^}]+\}/);
});
