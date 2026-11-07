// Runner abstraction (plan.md §6): `pi` (real, print mode) and `fake` (canned responses, for tests).
// A runner has call({ role, key, system, input, model, context }) → the model's reply text, and throws
// RunnerError when the call fails. `key` names the call (e.g. "round-2/cold-first-contact"); only the fake
// runner uses it, to find a canned response. `context` is extra data for the fake runner's "auto" judge.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_TIMEOUT_MS = 10 * 60 * 1000;
/** pi's warning for a model id it does not know; it still sends the request, Beak counts it as a failure. */
export const MODEL_NOT_FOUND_RE = /Model "[^"]*" not found for provider/;
/** Default folder of canned responses for the fake runner (BEAK_FAKE_DIR overrides it). */
export const FAKE_DIR = fileURLToPath(new URL('../../test/fixtures/fake', import.meta.url));

export class RunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunnerError';
  }
}

/**
 * The pi print-mode arguments for a test or judge call (docs/pi-notes.md "Test and judge calls").
 * Every flag keeps something of Beak or the user's pi setup out of the call. Keep test/runner.test.mjs in sync.
 */
export function piArgs({ systemPromptFile, provider, model }) {
  if (!systemPromptFile || !provider || !model) throw new Error('piArgs needs systemPromptFile, provider and model');
  return [
    '-p',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-extensions',
    '--no-mcp',
    '--no-themes',
    '--no-tools',
    '--no-approve',
    '--offline',
    '--system-prompt',
    systemPromptFile,
    '--append-system-prompt',
    '',
    '--provider',
    provider,
    '--model',
    model,
  ];
}

/**
 * One pi call: the system prompt from a file, the user message on stdin, from a fresh empty temp directory
 * (pi always appends <cwd> to the system prompt). Returns stdout. Throws RunnerError on a non-zero exit, empty
 * stdout, pi's "Model … not found for provider" warning, a missing pi binary or a timeout.
 */
export async function runPi({ system, input, model, bin = 'pi', timeoutMs = PI_TIMEOUT_MS, env = process.env }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beak-pi-'));
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd);
  const systemPromptFile = path.join(tmp, 'system.md');
  fs.writeFileSync(systemPromptFile, system);
  const args = piArgs({ systemPromptFile, provider: model.provider, model: model.model });
  try {
    const { code, stdout, stderr, error, timedOut } = await new Promise((resolve) => {
      const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, error: err, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.stdin.on('error', () => {}); // pi may exit before reading stdin; the exit code says why
      child.stdin.end(input);
    });
    const who = `pi (${model.provider} ${model.model})`;
    if (error?.code === 'ENOENT') throw new RunnerError(`${bin} not found: install @earendil-works/pi-coding-agent (see README)`);
    if (error) throw new RunnerError(`${who} could not start: ${error.message}`);
    if (timedOut) throw new RunnerError(`${who} did not finish within ${Math.round(timeoutMs / 1000)} s`);
    if (code !== 0) throw new RunnerError(`${who} exited with code ${code}${lastLine(stderr) ? `: ${lastLine(stderr)}` : ''}`);
    const notFound = MODEL_NOT_FOUND_RE.exec(stderr);
    if (notFound) throw new RunnerError(`${who}: ${notFound[0]} (check the model id in beak.config.yaml)`);
    if (!stdout.trim()) throw new RunnerError(`${who} printed nothing${lastLine(stderr) ? ` (${lastLine(stderr)})` : ''}`);
    return stdout.replace(/\s+$/, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function lastLine(text) {
  return text.trim().split('\n').filter((l) => l.trim()).at(-1)?.trim() ?? '';
}

export function piRunner({ bin, timeoutMs, env } = {}) {
  return {
    name: 'pi',
    call: ({ system, input, model }) => runPi({ system, input, model, bin, timeoutMs, env }),
  };
}

/**
 * The fake runner answers from canned files in `dir`: for a call with role R and key "round-2/x" it reads the
 * first file that exists of R/round-2/x, R/round-2, R/default (each as .md, .json or .txt).
 * - A file whose text is "FAIL" or starts with "FAIL:" makes the call fail (a runner failure).
 * - A judge file of the form { "auto": { score, fail: ["C2", "C3@input-id"], top_issues, no_evidence: [...] } }
 *   is turned into a full judge reply for the verdicts the call asks for (`context.pairs`), quoting the first
 *   line of each output as evidence.
 */
export function fakeRunner({ dir = FAKE_DIR } = {}) {
  return {
    name: 'fake',
    dir,
    call: async ({ role, key, context }) => {
      const found = cannedFile(dir, role, key);
      if (!found) throw new RunnerError(`fake runner: no canned ${role} response for ${key} in ${dir}`);
      const text = fs.readFileSync(found, 'utf8').replace(/\s+$/, '');
      if (text === 'FAIL' || text.startsWith('FAIL:')) {
        throw new RunnerError(`fake runner: ${text.slice(5).trim() || 'simulated failure'} (${path.basename(found)})`);
      }
      if (role === 'judge' && text.startsWith('{')) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return text; // canned invalid JSON, for the retry tests
        }
        if (parsed && typeof parsed === 'object' && parsed.auto) return JSON.stringify(autoJudge(parsed.auto, context), null, 2);
      }
      return text;
    },
  };
}

function cannedFile(dir, role, key) {
  const parts = key.split('/');
  const names = [];
  for (let n = parts.length; n > 0; n--) names.push(path.join(role, ...parts.slice(0, n)));
  names.push(path.join(role, 'default'));
  for (const name of names) {
    for (const ext of ['.md', '.json', '.txt']) {
      const file = path.join(dir, name + ext);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return null;
}

function autoJudge(spec, context = {}) {
  const fails = new Set(spec.fail ?? []);
  const noEvidence = new Set(spec.no_evidence ?? []);
  const hit = (set, p) => set.has(p.criterion) || set.has(`${p.criterion}@${p.input}`);
  const verdicts = (context.pairs ?? []).map((p) => {
    const pass = !hit(fails, p);
    const output = context.outputs?.[p.input] ?? '';
    const firstLine = output.split('\n').find((l) => l.trim())?.trim() ?? '';
    return {
      criterion: p.criterion,
      input: p.input,
      pass,
      evidence: hit(noEvidence, p) ? '' : pass ? firstLine : '',
      fix: pass ? '' : `Fix ${p.criterion} for ${p.input}.`,
    };
  });
  return { verdicts, score: spec.score ?? 90, top_issues: spec.top_issues ?? [] };
}

/** The runner the config asks for (`runner:` or BEAK_RUNNER). The fake runner reads BEAK_FAKE_DIR. */
export function getRunner(config, env = process.env) {
  if (config.runner === 'fake') {
    return fakeRunner({ dir: env.BEAK_FAKE_DIR ? path.resolve(config.root, env.BEAK_FAKE_DIR) : FAKE_DIR });
  }
  return piRunner({ env: { ...process.env, ...env } });
}
