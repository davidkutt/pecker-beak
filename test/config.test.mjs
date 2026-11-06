import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, ConfigError, DEFAULTS, findRoot, loadConfig, resolveConfig } from '../tools/lib/config.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const minimal = () => ({
  models: { 'model-a.1': { provider: 'p', model: 'org/a' }, 'model-b': { provider: 'q', model: 'b' } },
  roles: { tester: 'model-a.1', judge: 'model-b' },
  consumers: ['sales-agent'],
});

function tempRepo(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-config-'));
  if (yamlText !== undefined) fs.writeFileSync(path.join(dir, CONFIG_FILE), yamlText);
  return dir;
}

test('the repo config loads cleanly', () => {
  const { config, warnings } = loadConfig({ root: REPO, env: {} });
  assert.deepEqual(warnings, []);
  assert.equal(config.runner, 'pi');
  assert.deepEqual(config.consumers, ['sales-agent', 'support-agent']);
  assert.deepEqual(config.loop, DEFAULTS.loop);
  assert.equal(config.dirs.library, path.join(REPO, 'library'));
  assert.deepEqual(config.roles.tester, { name: 'glm-5.3', provider: 'openrouter', model: 'z-ai/glm-5.3' });
  assert.deepEqual(config.roles.judge, {
    name: 'deepseek-v4-flash',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
  });
});

test('the pi session (.pi/settings.json) only offers models from beak.config.yaml', () => {
  const { config } = loadConfig({ root: REPO, env: {} });
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.pi', 'settings.json'), 'utf8'));
  const ids = Object.values(config.models).map((m) => `${m.provider}/${m.model}`);
  assert.ok(ids.includes(`${settings.defaultProvider}/${settings.defaultModel}`), 'default writer model is not in models');
  assert.deepEqual([...settings.enabledModels].sort(), [...ids].sort(), 'Ctrl+P cycling should offer exactly the configured models');
});

test('missing sections fall back to defaults', () => {
  const { config, problems } = resolveConfig(minimal());
  assert.deepEqual(problems, []);
  assert.equal(config.runner, 'pi');
  assert.equal(config.runner_source, 'default');
  assert.deepEqual(config.loop, DEFAULTS.loop);
  assert.deepEqual(config.paths, DEFAULTS.paths);
  assert.deepEqual(config.git, DEFAULTS.git);
});

test('partial sections merge with defaults', () => {
  const { config, problems } = resolveConfig({ ...minimal(), loop: { max_rounds: 6 } });
  assert.deepEqual(problems, []);
  assert.equal(config.loop.max_rounds, 6);
  assert.equal(config.loop.pass_threshold, DEFAULTS.loop.pass_threshold);
});

test('BEAK_RUNNER overrides runner', () => {
  const { config, problems } = resolveConfig({ ...minimal(), runner: 'pi' }, { BEAK_RUNNER: 'fake' });
  assert.deepEqual(problems, []);
  assert.equal(config.runner, 'fake');
  assert.equal(config.runner_source, 'BEAK_RUNNER');
});

test('invalid runner is reported with its source', () => {
  const { problems } = resolveConfig(minimal(), { BEAK_RUNNER: 'gpt' });
  assert.ok(problems.some((p) => p.includes('runner must be one of pi, fake') && p.includes('BEAK_RUNNER')));
});

test('roles resolve to the named model', () => {
  const { config, problems } = resolveConfig(minimal());
  assert.deepEqual(problems, []);
  assert.deepEqual(config.roles.tester, { name: 'model-a.1', provider: 'p', model: 'org/a' });
  assert.deepEqual(config.roles.judge, { name: 'model-b', provider: 'q', model: 'b' });
});

test('switching a role is a one-word change', () => {
  const raw = minimal();
  raw.roles.tester = 'model-b';
  raw.roles.judge = 'model-a.1';
  const { config, problems } = resolveConfig(raw);
  assert.deepEqual(problems, []);
  assert.equal(config.roles.tester.model, 'b');
  assert.equal(config.roles.judge.model, 'org/a');
});

test('tester and judge roles are required', () => {
  const raw = minimal();
  raw.roles = {};
  const { problems } = resolveConfig(raw);
  assert.ok(problems.includes('roles.tester is required'));
  assert.ok(problems.includes('roles.judge is required'));
  assert.ok(resolveConfig({ ...minimal(), roles: undefined }).problems.some((p) => p.startsWith('roles must be a mapping')));
});

test('a role naming an unknown model lists the known ones', () => {
  const raw = minimal();
  raw.roles.judge = 'gpt-9';
  const { problems } = resolveConfig(raw);
  assert.ok(problems.includes('roles.judge must name a model from models (model-a.1, model-b); got "gpt-9"'));
});

test('models need a provider, a model id and a valid name', () => {
  const raw = minimal();
  raw.models['model-b'] = { model: 'b' };
  raw.models['Bad Name'] = { provider: 'p', model: 'x' };
  const { problems } = resolveConfig(raw);
  assert.ok(problems.includes('models.model-b must have non-empty "provider" and "model"'));
  assert.ok(problems.some((p) => p.startsWith('model name "Bad Name"')));
  assert.ok(resolveConfig({ ...minimal(), models: {} }).problems.some((p) => p.startsWith('models must map at least one')));
});

test('a writer role is ignored with a pointer to .pi/settings.json', () => {
  const raw = minimal();
  raw.roles.writer = 'model-a.1';
  const { problems, warnings } = resolveConfig(raw);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.startsWith('roles.writer is ignored') && w.includes('.pi/settings.json')));
});

test('same tester and judge model warns', () => {
  const raw = minimal();
  raw.roles.judge = raw.roles.tester;
  const { problems, warnings } = resolveConfig(raw);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.startsWith('roles.judge uses the same model as roles.tester')));
});

test('consumers must be unique slugs', () => {
  const { problems } = resolveConfig({ ...minimal(), consumers: ['Sales Agent', 'ok', 'ok'] });
  assert.ok(problems.some((p) => p.includes('"Sales Agent" must be a lowercase slug')));
  assert.ok(problems.some((p) => p.includes('"ok" is listed twice')));
  assert.ok(resolveConfig({ ...minimal(), consumers: [] }).problems.some((p) => p.startsWith('consumers must be')));
});

test('loop values are validated', () => {
  const { problems } = resolveConfig({
    ...minimal(),
    loop: { max_rounds: 0, pass_threshold: 101, min_delta: 1.5, holdout: 3, test_inputs: 3 },
  });
  assert.ok(problems.some((p) => p.startsWith('loop.max_rounds must be an integer >= 1')));
  assert.ok(problems.some((p) => p.startsWith('loop.pass_threshold must be between 0 and 100')));
  assert.ok(problems.some((p) => p.startsWith('loop.min_delta must be an integer')));
  assert.ok(problems.some((p) => p.startsWith('loop.holdout (3) must be smaller than loop.test_inputs (3)')));
});

test('even judge_samples warns about ties', () => {
  const { problems, warnings } = resolveConfig({ ...minimal(), loop: { judge_samples: 2 } });
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.startsWith('loop.judge_samples is even')));
});

test('paths must be relative and git flags boolean', () => {
  const { problems } = resolveConfig({ ...minimal(), paths: { out: '/abs/out' }, git: { commit_on_approve: 'yes' } });
  assert.ok(problems.some((p) => p.startsWith('paths.out must be relative')));
  assert.ok(problems.some((p) => p.startsWith('git.commit_on_approve must be true or false')));
});

test('unknown keys warn instead of failing', () => {
  const { problems, warnings } = resolveConfig({ ...minimal(), colour: 'blue', loop: { speed: 9 } });
  assert.deepEqual(problems, []);
  assert.ok(warnings.includes('unknown key "colour" is ignored'));
  assert.ok(warnings.includes('unknown key "loop.speed" is ignored'));
});

test('loadConfig throws ConfigError listing every problem', () => {
  const dir = tempRepo('runner: nope\nconsumers: []\n');
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (err) => err instanceof ConfigError && err.problems.length >= 3 && err.message.includes(CONFIG_FILE),
  );
});

test('loadConfig reports invalid YAML', () => {
  const dir = tempRepo('models: [unclosed\n');
  assert.throws(() => loadConfig({ root: dir, env: {} }), (err) => err instanceof ConfigError && /invalid YAML/.test(err.message));
});

test('findRoot walks up to the directory holding the config', () => {
  const dir = tempRepo('consumers: [a]\n');
  const nested = path.join(dir, 'runs', 'x', 'round-0');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRoot(nested), dir);
  assert.equal(findRoot(tempRepo()), null);
});
