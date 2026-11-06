import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, ConfigError, DEFAULTS, findRoot, loadConfig, resolveConfig } from '../tools/lib/config.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const minimal = () => ({
  models: { tester: { provider: 'p', model: 'a' }, judge: { provider: 'q', model: 'b' } },
  consumers: ['sales-agent'],
});

function tempRepo(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-config-'));
  if (yamlText !== undefined) fs.writeFileSync(path.join(dir, CONFIG_FILE), yamlText);
  return dir;
}

test('the repo config loads cleanly', () => {
  const { config, warnings } = loadConfig({ root: REPO, env: {} });
  assert.equal(config.runner, 'pi');
  assert.deepEqual(config.consumers, ['sales-agent', 'support-agent']);
  assert.deepEqual(config.loop, DEFAULTS.loop);
  assert.equal(config.dirs.library, path.join(REPO, 'library'));
  // The shipped config uses the same model for tester and judge until plan §14 Q2 is answered.
  assert.ok(warnings.every((w) => w.startsWith('models.judge uses the same model')), warnings.join('\n'));
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

test('tester and judge models are required', () => {
  const { problems } = resolveConfig({ consumers: ['a'], models: { writer: { provider: 'p', model: 'm' } } });
  assert.ok(problems.includes('models.tester is required'));
  assert.ok(problems.includes('models.judge is required'));
});

test('a model without provider is a problem', () => {
  const raw = minimal();
  raw.models.judge = { model: 'b' };
  const { problems } = resolveConfig(raw);
  assert.ok(problems.includes('models.judge must have non-empty "provider" and "model"'));
});

test('same tester and judge model warns', () => {
  const raw = minimal();
  raw.models.judge = { ...raw.models.tester };
  const { problems, warnings } = resolveConfig(raw);
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.startsWith('models.judge uses the same model')));
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
