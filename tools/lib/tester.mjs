// `beak test <run> <round>` (plan.md §6): one fresh runner call per test input, with the round's prompt as
// the system prompt and the input as the user message. Visible outputs go to round-N/outputs/, holdout
// outputs to round-N/holdout/ (judged, never shown to the writer).
import fs from 'node:fs';
import path from 'node:path';
import { findRoot, loadConfig } from './config.mjs';
import { ROUND_FILES, clearAfter, holdoutLabel, loadRun, outputPath, parseRound, recordAttempt, roundDir } from './run.mjs';
import { RunnerError, getRunner } from './runner.mjs';
import { BeakError, command, relPath, sha256, writeJson, writeText } from './util.mjs';

const USAGE = 'Usage: beak test <run> <round>';

/**
 * Test one round. Returns the test.json object ({ ok, inputs: [{ id, holdout, ok, error? }] }).
 * Runner failures are recorded, not thrown; a missing prompt or a finished round is a BeakError.
 */
export async function testRound({ config, run, round, runner }) {
  const dir = roundDir(run.dir, round);
  const promptFile = path.join(dir, ROUND_FILES.prompt);
  if (!fs.existsSync(promptFile) || !fs.readFileSync(promptFile, 'utf8').trim()) {
    throw new BeakError(`${relPath(config.root, promptFile)} is missing or empty: write the round's prompt first`);
  }
  if (fs.existsSync(path.join(dir, ROUND_FILES.scorecardJson))) {
    throw new BeakError(`round ${round} is already scored; a new prompt goes into round-${round + 1}/`);
  }
  const prompt = fs.readFileSync(promptFile, 'utf8');
  clearAfter(run.dir, round, 'test');
  for (const sub of [ROUND_FILES.outputs, ROUND_FILES.holdout]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });

  const model = run.meta.models.tester;
  const results = await Promise.all(
    run.inputs.map(async (input) => {
      try {
        const text = await runner.call({ role: 'tester', key: `round-${round}/${input.id}`, system: prompt, input: input.input, model });
        writeText(outputPath(run.dir, round, input), text);
        return { id: input.id, holdout: input.holdout, ok: true };
      } catch (err) {
        if (!(err instanceof RunnerError)) throw err;
        return { id: input.id, holdout: input.holdout, ok: false, error: err.message };
      }
    }),
  );
  const ok = results.every((r) => r.ok);
  const test = {
    generator: 'beak test',
    run: run.id,
    round,
    tester: model,
    runner: runner.name,
    prompt_sha256: sha256(prompt),
    ok,
    inputs: results,
  };
  writeJson(path.join(dir, ROUND_FILES.test), test);
  const failed = results.filter((r) => !r.ok);
  recordAttempt(run.dir, round, ok ? { step: 'test', ok } : { step: 'test', ok, error: failed.map((f) => `${f.id}: ${f.error}`).join('; ') });
  return test;
}

export const testCommand = command('test', USAGE, async (args, io, { cwd = process.cwd(), env = process.env, runner } = {}) => {
  if (args.length !== 2) throw new BeakError('give the run id and the round number', 2);
  const round = parseRound(args[1]);
  const { config } = loadConfig({ root: findRoot(cwd), env });
  const run = loadRun(config, args[0], cwd);
  const test = await testRound({ config, run, round, runner: runner ?? getRunner(config, env) });
  for (const r of test.inputs) {
    const input = run.inputs.find((i) => i.id === r.id);
    const name = r.holdout ? holdoutLabel(run.inputs, r.id) : r.id;
    if (!r.ok) io.out.write(`FAIL ${name}: ${r.holdout ? 'the runner failed' : r.error}\n`);
    else if (r.holdout) io.out.write(`ok   ${name} (output hidden from the writer)\n`);
    else io.out.write(`ok   ${name}: ${relPath(config.root, outputPath(run.dir, round, input))}\n`);
  }
  if (!test.ok) {
    io.err.write(`beak test: the runner failed (tester ${test.tester.name}); run beak loop-status ${run.id} to see what to do\n`);
    return 1;
  }
  io.out.write(`next: node tools/beak.mjs check ${run.id} ${round}\n`);
  return 0;
});
