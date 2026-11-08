---
# Beak batch mode (plan §13 M9). Template: `beak batch create` copies it to runs/batches/<batch-id>/RALPH.md,
# fills in the batch id and sets max_iterations / items_per_iteration for the size of the queue.
# Start a batch in pi with:  /ralph --path runs/batches/<batch-id>
# Format: the Ralph extension's RALPH.md (@lnilluv/pi-ralph-loop, see docs/pi-notes.md).
commands:
  - name: queue
    run: node tools/beak.mjs batch status {{ beak.batch }}
    timeout: 60
  - name: gate
    run: node tools/beak.mjs batch gate {{ beak.batch }}
    timeout: 60
    acceptance: true
max_iterations: 50
items_per_iteration: 1
timeout: 3600
stop_on_error: false
completion_promise: BATCH_DONE
completion_gate: required
guardrails:
  shell_policy:
    mode: allowlist
    allow:
      - 'node tools/beak\.mjs batch (next|done|status|gate) [a-z0-9-]+'
      - 'node tools/beak\.mjs (test|check|judge|score) [a-z0-9-]+ (0|[1-9][0-9]*)'
      - 'node tools/beak\.mjs (loop-status|finalize) [a-z0-9-]+'
  protected_files:
    - 'library/**'
    - 'out/**'
    - 'drafts/**'
    - 'loops/**'
    - 'tools/**'
    - '.pi/**'
    - 'AGENTS.md'
    - 'beak.config.yaml'
    - 'runs/batches/*/RALPH.md'
    - 'runs/batches/*/batch.json'
    - 'runs/*/*.json'
    - 'runs/*/bundle.md'
    - 'runs/*/round-*/*.json'
    - 'runs/*/round-*/scorecard.md'
    - 'runs/*/round-*/outputs/**'
    - 'runs/*/round-*/holdout/**'
    - 'policy:secret-bearing-paths'
---

# Beak batch {{ ralph.name }} (iteration {{ ralph.iteration }} of {{ ralph.max_iterations }})

You work through a Beak batch: one approved golden prompt, one new variant per queue item. The scripts keep the queue, run the tests and decide; you write prompts. Nobody is watching this loop: never wait for an answer, never ask the user anything, never approve or reject, never touch the library.

All paths are relative to the repo root. `AGENTS.md` (house style and hard rules) applies in full.

## The queue now

{{ commands.queue }}

## For each item

1. Run `node tools/beak.mjs batch next {{ beak.batch }}`. It starts the next item (or names the one still running) and prints its run id and the next step. If it says `queue empty`, go to "Finishing".
2. Read `runs/<run-id>/bundle.md`, and nothing else in the run folder before round 0. Never open `inputs.json` or a `holdout/` folder. The bundle shows the golden prompt: keep its structure and headings, and swap the content for this variant.
3. Write `runs/<run-id>/round-0/prompt.md` and `runs/<run-id>/round-0/changes.md`.
4. Run the quality loop exactly as `.pi/skills/beak-quality-loop/SKILL.md` describes (read it once in this iteration): `test`, `check`, `judge`, `score`, then `loop-status`, and do what its `next:` line says. On `CONTINUE`, write the next round, fixing only the top issues of the last `scorecard.md` with targeted edits.
5. On `STOP`, run `node tools/beak.mjs batch done {{ beak.batch }}`. It finalizes the best round into `drafts/batch-{{ beak.batch }}/` and ticks the item off. Do not run `beak finalize` yourself, and do not show anything to a user.
6. Keep this iteration to the number of items the pacing note allows, then end your turn. The next iteration picks up the queue.

Keep `runs/batches/{{ beak.batch }}/RALPH_PROGRESS.md` to a few lines: the item you are on and anything the next iteration must know.

## When something is wrong

If a script fails in a way that a better prompt cannot fix (a block is missing or wrong, a command keeps failing), add one line under `## P1` in `runs/batches/{{ beak.batch }}/OPEN_QUESTIONS.md` that says which item and what failed, then go on with the next item. A person resolves it. Never work around a guardrail.

## Finishing

When `batch next` says `queue empty` and `node tools/beak.mjs batch gate {{ beak.batch }}` says `complete`, answer with <promise>BATCH_DONE</promise>. Never before. The drafts then wait for a person: `beak batch review {{ beak.batch }}`.
