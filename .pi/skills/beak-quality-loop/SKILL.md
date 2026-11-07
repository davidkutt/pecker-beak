---
name: beak-quality-loop
description: >-
  Run Beak's quality loop on a compose run: test the prompt, check, judge, score, and revise it round by round
  until beak loop-status says STOP, then finalize the best round as a draft. Use after beak-compose has written
  round 0, for /refine, or when the user asks to continue a run.
---

# Beak quality loop

All paths in this skill are relative to the repo root (the folder with `beak.config.yaml`, your working directory), not to this skill's folder. `<run>` is the run id that `beak bundle` printed.

**Rule: the LLM writes prompts. Scripts produce all evidence, scores and stop decisions.**

You write only `runs/<run>/round-N/prompt.md` and `runs/<run>/round-N/changes.md`. Never write or edit `checks.json`, `judge.json`, `scorecard.json`, `scorecard.md`, `test.json`, `runner.json`, `meta.json`, `rubric.json` or `rubric_extra.json`, and never decide yourself whether the loop stops. `beak score` refuses evidence that scripts did not write.

**Stop rules** (deterministic, in `loop-status`):
- `pass`: scorecard passes.
- `max_rounds` reached.
- `plateau`: score has not improved by ≥ `min_delta` for `patience` rounds.
- `error`: the runner failed twice in a row.

`beak loop-status` applies them. Obey its last two lines: `CONTINUE` or `STOP <reason>`, then `next: …`.

## What you may read

- `runs/<run>/bundle.md`
- `runs/<run>/round-N/scorecard.md`
- `runs/<run>/round-N/outputs/*.md` (the visible test outputs)
- your own `prompt.md` and `changes.md`

Never open `inputs.json`, `judge.json`, `scorecard.json`, `checks.json` or `round-N/holdout/`. They hold the holdout inputs and outputs. For holdout inputs you see only pass or fail; do not guess their content or tune for them.

## One round (N = 0, 1, 2, …)

Round 0's prompt comes from beak-compose. Then:

1. `node tools/beak.mjs test <run> N`: the tester model runs the prompt on every test input.
2. `node tools/beak.mjs check <run> N`: hard checks.
3. `node tools/beak.mjs judge <run> N`: the judge model grades every output against the criteria.
4. `node tools/beak.mjs score <run> N`: writes `round-N/scorecard.md`.
5. `node tools/beak.mjs loop-status <run>`: `CONTINUE` or `STOP <reason>`.

If a step exits with an error, run `beak loop-status <run>` and do what its `next:` line says. It tells you when to retry a failed step and when the loop stops with `error`.

## On CONTINUE: write round N+1

1. Read `round-N/scorecard.md`: the result, the **top issues**, and the judge's feedback on failing criteria. Read the visible outputs it names if you need to see what went wrong.
2. Copy `round-N/prompt.md` to `round-(N+1)/prompt.md` and fix **only the top issues**, with targeted edits. No full rewrite: rewrites make the score jump around (oscillation), and the best round wins anyway.
3. Keep everything that already works: sections, examples (verbatim), `{{runtime_var}}` placeholders, the language.
4. Write `round-(N+1)/changes.md`: one line per change, what you changed and which top issue it fixes, e.g. `- Constraints: added "exactly one question, at the end" (issue 1: C2 failed on trade-fair-follow-up).`
5. Run round N+1 (steps 1–5 above).

If `loop-status` names run-only criteria (R1, …) from `/refine`, cover them in the next round too.

## On STOP: finalize

1. `node tools/beak.mjs finalize <run>`. It copies the **best** round (the highest score among passing rounds, else the highest score), not the last one, to `drafts/<task>/<variant>.md`.
2. Show the user what it printed: the score per round, the stop reason, the best round, the criteria still failing, the sample output path, the draft path and any warning (for example "the library changed during this run").
3. Say what the user can do next: `/review` the draft, `/approve` it, `/reject` it with a reason, or `/refine <run> <notes>` for more rounds. Never approve on your own.

## Rules during a run

- Never edit `library/` (from `beak bundle` until `beak finalize`). If a block is wrong, finish the run and tell the user.
- Never add rounds after STOP, never skip a step, never stop early. Only `/refine` (the user) adds rounds.
- Never change the models. The run keeps the tester and judge stored in its `meta.json`.

## /refine <run> [notes]

1. `node tools/beak.mjs refine <run> <notes…>`. The notes become a `[must]` criterion for this run only (R1, R2, …), and up to `loop.max_rounds` more rounds are allowed.
2. `node tools/beak.mjs loop-status <run>` and continue the loop as above. The next round fixes the last round's top issues and covers the new criterion.
