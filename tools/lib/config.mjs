// Loads and validates beak.config.yaml (plan.md §12).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_FILE = 'beak.config.yaml';
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Model names may contain dots (glm-5.3).
export const MODEL_NAME_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const RUNNERS = Object.freeze(['pi', 'fake']);
// Roles Beak's scripts run models for. The writer is the interactive pi session (.pi/settings.json).
export const ROLES = Object.freeze(['tester', 'judge']);

export const DEFAULTS = Object.freeze({
  runner: 'pi',
  loop: Object.freeze({
    max_rounds: 4,
    pass_threshold: 85,
    min_delta: 3,
    patience: 2,
    test_inputs: 3,
    holdout: 1,
    judge_samples: 1,
  }),
  paths: Object.freeze({ library: 'library', runs: 'runs', drafts: 'drafts', out: 'out' }),
  git: Object.freeze({ commit_on_approve: true, track_runs: false }),
});

const TOP_LEVEL_KEYS = ['models', 'roles', 'runner', 'consumers', 'loop', 'paths', 'git'];

// Lower bound for each loop setting (all are integers).
const LOOP_MIN = {
  max_rounds: 1,
  pass_threshold: 0,
  min_delta: 0,
  patience: 1,
  test_inputs: 1,
  holdout: 0,
  judge_samples: 1,
};

export class ConfigError extends Error {
  constructor(file, problems) {
    super(`Invalid ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.file = file;
    this.problems = problems;
  }
}

/** Walk up from `start` to the directory that holds beak.config.yaml. Returns null if none. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read, validate and resolve the config.
 * Returns { config, warnings }; throws ConfigError listing every problem found.
 * `config.root` is the repo root and `config.dirs` holds absolute paths for `paths`.
 */
export function loadConfig({ root = findRoot(), env = process.env } = {}) {
  if (!root) {
    throw new ConfigError(CONFIG_FILE, [`not found in ${process.cwd()} or any parent directory`]);
  }
  const file = path.join(root, CONFIG_FILE);
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(file, [err.code === 'ENOENT' ? 'file not found' : `invalid YAML: ${err.message}`]);
  }
  const { config, problems, warnings } = resolveConfig(raw, env);
  if (problems.length) throw new ConfigError(file, problems);
  config.root = root;
  config.file = file;
  config.dirs = Object.fromEntries(Object.entries(config.paths).map(([k, v]) => [k, path.resolve(root, v)]));
  return { config, warnings };
}

/** Pure validation + defaults. Returns { config, problems, warnings }. */
export function resolveConfig(raw, env = {}) {
  const problems = [];
  const warnings = [];

  if (raw == null) raw = {};
  if (!isPlainObject(raw)) {
    return { config: null, problems: ['top level must be a mapping'], warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) warnings.push(`unknown key "${key}" is ignored`);
  }

  // runner
  let runner = raw.runner ?? DEFAULTS.runner;
  let runnerSource = raw.runner === undefined ? 'default' : 'config';
  if (env.BEAK_RUNNER) {
    runner = env.BEAK_RUNNER;
    runnerSource = 'BEAK_RUNNER';
  }
  if (!RUNNERS.includes(runner)) {
    problems.push(`runner must be one of ${RUNNERS.join(', ')} (got "${runner}" from ${runnerSource})`);
  }

  // models: named choices, each a pi provider + model id
  const models = {};
  if (!isPlainObject(raw.models) || Object.keys(raw.models).length === 0) {
    problems.push('models must map at least one model name to { provider, model }');
  } else {
    for (const [name, spec] of Object.entries(raw.models)) {
      if (!MODEL_NAME_RE.test(name)) {
        problems.push(`model name "${name}" must be lowercase letters, digits, dots and hyphens`);
        continue;
      }
      if (!isPlainObject(spec) || !nonEmptyString(spec.provider) || !nonEmptyString(spec.model)) {
        problems.push(`models.${name} must have non-empty "provider" and "model"`);
        continue;
      }
      models[name] = { provider: spec.provider, model: spec.model };
    }
  }

  // roles: which named model each script role uses
  const roles = {};
  if (!isPlainObject(raw.roles)) {
    problems.push(`roles must be a mapping that names a model for ${ROLES.join(' and ')}`);
  } else {
    for (const [role, name] of Object.entries(raw.roles)) {
      if (role === 'writer') {
        warnings.push('roles.writer is ignored: the writer is the interactive pi session, set its model in .pi/settings.json');
      } else if (!ROLES.includes(role)) {
        warnings.push(`roles.${role} is not a known role (${ROLES.join(', ')}) and is ignored`);
      }
    }
    for (const role of ROLES) {
      const name = raw.roles[role];
      if (name === undefined) {
        problems.push(`roles.${role} is required`);
      } else if (typeof name !== 'string' || !(name in models)) {
        const known = Object.keys(models);
        problems.push(
          `roles.${role} must name a model from models (${known.length ? known.join(', ') : 'none defined'}); got ${fmt(name)}`,
        );
      } else {
        roles[role] = { name, ...models[name] };
      }
    }
  }

  // consumers
  const consumers = raw.consumers;
  if (!Array.isArray(consumers) || consumers.length === 0) {
    problems.push('consumers must be a non-empty list of agent names');
  } else {
    const seen = new Set();
    for (const c of consumers) {
      if (typeof c !== 'string' || !SLUG_RE.test(c)) {
        problems.push(`consumer "${c}" must be a lowercase slug (a-z, 0-9, single hyphens)`);
      } else if (seen.has(c)) {
        problems.push(`consumer "${c}" is listed twice`);
      }
      seen.add(c);
    }
  }

  const loop = section('loop', raw.loop, DEFAULTS.loop, problems, warnings);
  for (const [key, min] of Object.entries(LOOP_MIN)) {
    const v = loop[key];
    if (!Number.isInteger(v) || v < min) problems.push(`loop.${key} must be an integer >= ${min} (got ${fmt(v)})`);
  }
  if (Number.isInteger(loop.pass_threshold) && loop.pass_threshold > 100) {
    problems.push(`loop.pass_threshold must be between 0 and 100 (got ${loop.pass_threshold})`);
  }
  if (Number.isInteger(loop.holdout) && Number.isInteger(loop.test_inputs) && loop.holdout >= loop.test_inputs) {
    problems.push(
      `loop.holdout (${loop.holdout}) must be smaller than loop.test_inputs (${loop.test_inputs}); ` +
        'the writer needs at least one visible test input',
    );
  }
  if (Number.isInteger(loop.judge_samples) && loop.judge_samples > 1 && loop.judge_samples % 2 === 0) {
    warnings.push(`loop.judge_samples is even (${loop.judge_samples}); a majority vote can tie, use an odd number`);
  }

  const paths = section('paths', raw.paths, DEFAULTS.paths, problems, warnings);
  for (const [key, v] of Object.entries(paths)) {
    if (!nonEmptyString(v)) problems.push(`paths.${key} must be a non-empty string`);
    else if (path.isAbsolute(v)) problems.push(`paths.${key} must be relative to the repo root (got "${v}")`);
  }

  const git = section('git', raw.git, DEFAULTS.git, problems, warnings);
  for (const [key, v] of Object.entries(git)) {
    if (typeof v !== 'boolean') problems.push(`git.${key} must be true or false (got ${fmt(v)})`);
  }

  const config = { runner, runner_source: runnerSource, models, roles, consumers: consumers ?? [], loop, paths, git };
  return { config, problems, warnings };
}

/**
 * The models one run uses. Each role defaults to `roles:` and can be overridden with a model
 * name from `models:` (e.g. `/compose … tester=deepseek-v4-flash judge=glm-5.3`).
 * Tester and judge may be the same model or different ones.
 * Returns { roles, problems } where roles is { tester: { name, provider, model }, judge: … }.
 */
export function selectModels(config, overrides = {}) {
  const problems = [];
  const roles = {};
  for (const role of ROLES) {
    const name = overrides[role] ?? config.roles[role].name;
    if (!(name in config.models)) {
      problems.push(`${role}=${name} is not a configured model (choose from: ${Object.keys(config.models).join(', ')})`);
      continue;
    }
    roles[role] = { name, ...config.models[name] };
  }
  for (const key of Object.keys(overrides)) {
    if (!ROLES.includes(key)) problems.push(`cannot select a model for "${key}" (roles: ${ROLES.join(', ')})`);
  }
  return { roles, problems };
}

function section(name, value, defaults, problems, warnings) {
  if (value === undefined || value === null) return { ...defaults };
  if (!isPlainObject(value)) {
    problems.push(`${name} must be a mapping`);
    return { ...defaults };
  }
  for (const key of Object.keys(value)) {
    if (!(key in defaults)) warnings.push(`unknown key "${name}.${key}" is ignored`);
  }
  const merged = { ...defaults };
  for (const key of Object.keys(defaults)) if (key in value) merged[key] = value[key];
  return merged;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function fmt(v) {
  return v === undefined ? 'nothing' : JSON.stringify(v);
}
