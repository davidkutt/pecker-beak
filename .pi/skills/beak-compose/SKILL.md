---
name: beak-compose
description: >-
  Compose a prompt with Beak: bundle the library blocks for a task and a customer or industry, then write round 0
  of the prompt. Use for /compose, or when the user asks to write, build or generate a prompt for a task, e.g.
  "write the cold-email prompt for Acme Pharma".
---

# Beak compose

You write the prompt. The scripts pick the blocks, merge their rules and create the run folder.

All paths in this skill are relative to the repo root (the folder with `beak.config.yaml`, your working directory), not to this skill's folder.

## 1. Bundle

Run the bundle script with the user's `key=value` arguments, unchanged:

```text
$ node tools/beak.mjs bundle task=cold-email customer=acme-pharma
20261107-0930-cold-email-acme-pharma-formal-de
```

- Keys: `task` (required), `customer`, `industry`, `tone`, `scenario`, `context` (ids separated by commas), `tester`, `judge`. It needs `customer=` or `industry=`. A customer brings its industry and tone along.
- If the user asked in plain words ("the cold email for Acme"), find the ids first: `node tools/beak.mjs find "<name>" type=<type>` for each name. Use an `exact:` id. If there is only a `likely:` match or none, ask the user. Never guess an id.
- **Exit 0:** stdout is the run id. Tell the user every `warning:` line from stderr (for example, blocks that disagree on language, or `TODO`s in a block).
- **Exit 1 or 2:** show the user the messages and stop. Do not edit the library to make it pass. Fixing a block is intake, and only once the user agrees.

From here until `beak finalize`, never edit `library/`.

## 2. Read the bundle

Read `runs/<run-id>/bundle.md`. It has everything you need: the run settings, the hard checks, the judge's criteria, every block (examples verbatim) and, if there is one, the golden prompt.

Do not open `runs/<run-id>/inputs.json`. It holds the test inputs, including holdout inputs that you must never see. Never edit `rubric.json`, `meta.json` or `inputs.json`.

## 3. Write round 0

Write `runs/<run-id>/round-0/prompt.md`: the system prompt the consumer agent will get. Nothing else goes in the file: no frontmatter, no notes to the user.

- **Sections:** exactly the ones listed under "Prompt sections" in the bundle, in that order, each as a `## <name>` heading (`## Role`, `## Context`, …).
- **Language:** the bundle's language, throughout.
- **Content:** every block's Must include and Avoid, turned into concrete instructions ("at most 180 words, one call to action", not "concise and compelling"). Write so that each output can meet every hard check and criterion. Put the output checks (banned phrases, word limits) into the prompt as explicit constraints.
- **Examples:** copy them verbatim from the bundle, each in a code fence. Label them as examples to follow (Good) or to avoid (Bad). Never rewrite, shorten or translate one, even if it is in another language.
- **Placeholders:** only the ones listed, written `{{name}}`. No other placeholders, no `TODO:`, no `[Name]` or `<name>` stand-ins.
- **Facts:** only what the bundle says. Never invent facts about the customer, its products or the people the agent writes to. Leave out anything marked `TODO:`.
- **Golden prompt:** if the bundle has one, keep its structure and headings and replace the content.

Then write `runs/<run-id>/round-0/changes.md`:

```markdown
# Round 0

First draft from bundle.md.

- <one line per decision worth knowing, e.g. how you resolved two blocks that pull in different directions>
```

## 4. Hand off

Follow the `beak-quality-loop` skill for this run. If that skill does not exist yet (before Milestone 4), stop here. Show the user the run id, the path of `round-0/prompt.md` and the prompt itself, and say that the quality loop is not built yet.
