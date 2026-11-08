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
  assert.match(body, /^Request: \$@$/m);
  assert.match(body, /If the request is empty, ask the user what to add\./);
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
  assert.match(body, /^Arguments: \$@$/m);
  assert.match(body, /If there are no arguments, ask the user/);
});

test('the quality-loop skill states the stop rules and the evidence rule verbatim (plan §8)', () => {
  const { body } = frontmatter(path.join(SKILLS, 'beak-quality-loop', 'SKILL.md'));
  const plan = fs.readFileSync(path.join(REPO, 'plan.md'), 'utf8');
  const rule = '**Rule: the LLM writes prompts. Scripts produce all evidence, scores and stop decisions.**';
  assert.ok(plan.includes(rule) && body.includes(rule), 'the evidence rule, as in plan §6');
  const stopRules = plan.slice(plan.indexOf('**Stop rules**'), plan.indexOf('\n\n', plan.indexOf('**Stop rules**')));
  assert.match(stopRules, /`error`: the runner failed twice in a row\./);
  assert.ok(body.includes(stopRules), 'the stop rules, as in plan §7');
  for (const cmd of ['test', 'check', 'judge', 'score', 'loop-status', 'finalize', 'refine']) {
    assert.ok(COMMANDS.find((c) => c.name === cmd)?.run, `beak ${cmd} must be built`);
    assert.match(body, new RegExp(`node tools/beak\\.mjs ${cmd} `), `skill must run beak ${cmd}`);
  }
  for (const phrase of ['scorecard.md', 'top issues', 'changes.md', 'holdout', 'inputs.json', 'best', 'relative to the repo root', 'Never approve']) {
    assert.ok(body.includes(phrase), `quality-loop skill should mention ${phrase}`);
  }
});

test('/refine passes the run id and the notes to the quality-loop skill', () => {
  const { body } = frontmatter(path.join(PROMPTS, 'refine.md'));
  assert.match(body, /beak-quality-loop/);
  assert.match(body, /\$1/);
  assert.match(body, /\$\{@:2\}/, 'notes are the free text after the run id');
  assert.match(body, /node tools\/beak\.mjs refine \$1/);
});

test('every skill or template that names another skill names one that exists', () => {
  const skills = new Set(fs.readdirSync(SKILLS));
  const files = [
    ...[...skills].map((d) => path.join(SKILLS, d, 'SKILL.md')),
    ...fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.md')).map((f) => path.join(PROMPTS, f)),
  ];
  for (const file of files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\.pi\/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
      assert.ok(skills.has(m[1]), `${path.relative(REPO, file)} refers to a missing skill ${m[1]}`);
    }
  }
});

test('every slash command in plan §5 exists, and runs the script behind it', () => {
  const expected = { 'add.md': 'find', 'compose.md': null, 'refine.md': 'refine', 'review.md': 'review', 'approve.md': 'approve', 'reject.md': 'reject', 'beak-status.md': 'status', 'beak-history.md': 'history', 'batch.md': 'batch', 'critique.md': 'loop-status' };
  const files = fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(expected).sort());
  for (const [file, cmd] of Object.entries(expected)) {
    if (!cmd || file === 'add.md') continue;
    assert.ok(COMMANDS.find((c) => c.name === cmd)?.run, `beak ${cmd} must be built`);
    assert.match(frontmatter(path.join(PROMPTS, file)).body, new RegExp(`node tools/beak\\.mjs ${cmd}\\b`), `${file} should run beak ${cmd}`);
  }
  assert.ok(COMMANDS.every((c) => c.run && !c.milestone), 'every command is built');
});

test('/review reports only; /approve asks for rules; /reject proposes a line and a block and checks first', () => {
  const review = frontmatter(path.join(PROMPTS, 'review.md')).body;
  assert.match(review, /report only/i);
  assert.match(review, /edited_after_loop/);
  const approve = frontmatter(path.join(PROMPTS, 'approve.md')).body;
  assert.match(approve, /Did you change anything that should become a rule\?/);
  assert.match(approve, /node tools\/beak\.mjs learn/);
  assert.match(approve, /R1/, 'offers to promote /refine notes');
  const reject = frontmatter(path.join(PROMPTS, 'reject.md')).body;
  assert.match(reject, /\$\{@:2\}/, 'the reason is the free text after the draft');
  assert.match(reject, /--check/);
  for (const t of ['task', 'customer', 'industry', 'tone']) assert.match(reject, new RegExp(`\\*\\*${t}\\*\\*`));
});

// M10: pi-prompt-template-model handles every template that uses its frontmatter (model, skill, thinking, …).
const PTM_FIELDS = ['model', 'skill', 'thinking', 'chain', 'loop', 'restore', 'fresh', 'converge', 'boomerang', 'subagent'];

test('templates for pi-prompt-template-model: only syntax it supports, real skills, configured models', async () => {
  const { loadConfig } = await import('../tools/lib/config.mjs');
  const { config } = loadConfig({ root: REPO, env: {} });
  const configured = Object.values(config.models).map((m) => `${m.provider}/${m.model}`);
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.pi', 'settings.json'), 'utf8'));
  const writer = `${settings.defaultProvider}/${settings.defaultModel}`;
  const skills = new Set(fs.readdirSync(SKILLS));
  const handled = [];
  for (const f of fs.readdirSync(PROMPTS).filter((n) => n.endsWith('.md')).sort()) {
    const { data, body } = frontmatter(path.join(PROMPTS, f));
    if (!PTM_FIELDS.some((k) => k in data)) continue;
    handled.push(f);
    // its substituteArgs knows $1, $@, $ARGUMENTS and ${@:N[:L]}, but not ${@:-default} (args.ts)
    assert.doesNotMatch(body, /\$\{(?:@|ARGUMENTS|\d+):-/, `${f}: \${…:-default} is not supported by pi-prompt-template-model`);
    if (data.skill !== undefined) {
      for (const name of String(data.skill).split(',').map((x) => x.trim().replace(/^skill:/, ''))) assert.ok(skills.has(name), `${f}: skill ${name} does not exist`);
      assert.match(body, new RegExp(`read \\.pi/skills/${data.skill}/SKILL\\.md first`), `${f}: still works without the extension`);
    }
    if (data.model !== undefined) {
      for (const m of String(data.model).split(',').map((x) => x.trim())) assert.ok(configured.includes(m), `${f}: model ${m} is not in beak.config.yaml models`);
    }
  }
  assert.deepEqual(handled, ['add.md', 'compose.md', 'critique.md', 'refine.md']);

  // the critic is a second model: not the writer's default, and it hands the session back afterwards
  const critique = frontmatter(path.join(PROMPTS, 'critique.md'));
  assert.notEqual(critique.data.model, writer);
  assert.notEqual(critique.data.restore, false);
  for (const phrase of ['Do not write or edit any file', 'inputs.json', 'holdout', 'at most 3 targeted edits', 'Advice only']) {
    assert.ok(critique.body.includes(phrase), `critique should say ${phrase}`);
  }
});

test('.pi/settings.json: exactly the two pi packages, pinned, with their own skills off', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.pi', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.packages, [
    { source: 'npm:@lnilluv/pi-ralph-loop@2.1.2', skills: [] },
    { source: 'npm:pi-prompt-template-model@0.12.3', skills: [] },
  ]);
  for (const p of settings.packages) assert.match(p.source, /@\d+\.\d+\.\d+$/, 'an exact version, so pi never updates it on its own');
});
