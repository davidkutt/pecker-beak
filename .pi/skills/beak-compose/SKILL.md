---
name: beak-compose
description: >-
  Start a Beak compose run: bundle library blocks for a task (with a customer, industry, tone or scenario),
  write the first prompt draft (round 0) and hand over to the quality loop. Use for /compose, or when the user
  asks to write, compose or generate a prompt, e.g. "write the cold-email prompt for Acme Pharma".
---

# Beak compose

You start a run: the scripts pick and merge the blocks, you write the first draft of the prompt, then the quality loop takes over.

All paths in this skill are relative to the repo root (the folder with `beak.config.yaml`, your working directory), not to this skill's folder.

## Rules

1. **Scripts produce all evidence, scores and stop decisions.** You write only `round-N/prompt.md` and `round-N/changes.md`.
2. **Never edit `library/` during a run.** If a block is wrong or missing, tell the user and stop. They fix it with intake and start a new run.
3. **Read `bundle.md`, nothing else in the run folder before round 0.** `inputs.json` holds the holdout inputs, which you must never see.

## Steps

### 1. Arguments

`/compose` passes `key=value` arguments: `task` (required), `customer`, `industry`, `tone`, `scenario`, `context` (ids separated by commas), `tester`, `judge`. Pass them to the script unchanged.

If the user asked in plain words instead ("the cold email for Acme"), find the ids first with `node tools/beak.mjs find "<name>" type=<type>` and use the `exact:` id. If there is no task, ask which one (the files in `library/tasks/`). Never guess a customer.

### 2. Bundle

```text
$ node tools/beak.mjs bundle task=cold-email customer=acme-pharma
20261107-0930-cold-email-acme-pharma-formal-de
created runs/20261107-0930-cold-email-acme-pharma-formal-de/: bundle.md, rubric.json, meta.json, inputs.json
next: read runs/…/bundle.md, then write runs/…/round-0/prompt.md and runs/…/round-0/changes.md
```

The first line is the run id. Tell the user the run id and any `warning:` lines. If the command fails, show its message and stop.

### 3. Read the bundle

Read `runs/<run-id>/bundle.md` completely. It has what to write (sections, language, placeholders), the hard checks, the judge criteria, the visible test inputs and every block.

### 4. Write round 0

Write `runs/<run-id>/round-0/prompt.md`: the system prompt the consumer agent will run with.

- Use exactly the sections listed under "What to write", in that order, each as a Markdown heading (`## Role`, `## Context`, …).
- Write it in the language bundle.md names.
- Turn every "Must include", "Avoid" and "Done when" line of the blocks into a concrete instruction or constraint. Concrete beats adjectives: "at most 180 words, one question", not "short and engaging".
- Copy examples verbatim from the blocks, each in a code fence, labelled Good or Bad as in the block.
- Use no placeholders except the runtime variables bundle.md lists, written as `{{name}}`. Everything else must be written out.
- If bundle.md shows a golden prompt, keep its structure and swap the content.
- The file is the prompt and nothing else: no notes to the user, no "Here is the prompt", nothing about Beak.

Then write `runs/<run-id>/round-0/changes.md`: `Round 0: first draft from bundle.md.`, plus any choice the user should know about.

### 5. Hand over to the quality loop

Read `.pi/skills/beak-quality-loop/SKILL.md` and follow it, starting with `beak test` for round 0.
