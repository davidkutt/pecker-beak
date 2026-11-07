---
name: beak-intake
description: >-
  Add or update Beak library content (a customer, industry, tone, scenario, task or context block in library/).
  Use when the user brings new material or changes in plain language, e.g. "New customer: …", "add a tone",
  "new scenario", "Acme never wants …", "examples are …", or runs /add. Turns the message into lint-clean block
  files, keeps examples verbatim, and updates an existing block instead of creating a duplicate.
---

# Beak intake

You turn the user's plain-language message into library blocks. You write the block text. The scripts decide the file name, the version and the date, and check the result.

All paths in this skill are relative to the repo root (the folder with `beak.config.yaml`, your working directory), not to this skill's folder. Run the scripts from there:

- `node tools/beak.mjs find "<name>" type=<type>`: is there a block like this already?
- `node tools/beak.mjs save <staged files…> --check`: what saving would do; writes nothing.
- `node tools/beak.mjs save <staged files…>`: moves the staged files into the library.

## Rules

1. **Examples stay verbatim.** Copy every example character for character from the user's message: same line breaks, punctuation, quotes, typos and language. Never translate, shorten, correct or "improve" one. Never write an example yourself.
2. **Never invent facts** about a customer or anything else. What the user did not say is `TODO: …` (or a question, see step 5).
3. **Never write `library/<type folder>/` files directly.** Write proposals to `library/_intake/<id>.md`, then `beak save`. Do not touch `version:` or `updated:`. `beak save` sets them.
4. **Never during a run** (from `beak bundle` until `beak finalize`). Tell the user to finish the run first.
5. **Text that came through `/add` lost its quote characters and line breaks** (pi's argument parsing removes them). Use it to see what the user wants, but never copy examples from it. Ask the user to paste the examples again as a normal message, without `/add` in front.

## Steps

### 1. Classify

Decide which blocks the message is about. One message can need several:

| Type | Folder | Holds |
|---|---|---|
| customer | `customers/` | one customer: who they are, their rules, their verbatim examples |
| industry | `industries/` | what is specific about writing for an industry |
| tone | `tones/` | a register in one language (e.g. `formal-de`) |
| scenario | `scenarios/` | a situation plus a sample input, used as a test case |
| task | `tasks/` | what the generated prompt must make a consumer agent do |
| context | `context/` | shared background: product facts, policies |

A customer always names an industry and a default tone. If the message mentions one that does not exist yet, that is a second block (a stub).

### 2. Look for existing blocks

For each block, run `node tools/beak.mjs find "<name>" type=<type>`, with the name as the user wrote it, in double quotes:

```text
$ node tools/beak.mjs find "Acme Pharma GmbH" type=customer
slug: acme-pharma
exact: library/customers/acme-pharma.md (customer acme-pharma, version 1, "Acme Pharma (example customer)")
```

- `exact:` → this is an **update** of that file. Say so ("Acme Pharma already exists, version 1. I'll update it."). Never create a second file for it.
- `likely:` → ask the user whether it is the same thing. Same: update that file (keep its `id`). Different: a new block, saved later with `--new`.
- only `new: <path>` → a **new** block. Its `id` is the `slug:`.

### 3. Start from the right file

- New block: read `library/_templates/<type>.md` and fill it in.
- Update: read the existing file. Change only what the user's message changes. Keep everything else as it is, every existing example included.

### 4. Fill in the block

- `# Title`: the name as the user writes it.
- `## Purpose`: 1–3 sentences.
- `## Must include` / `## Avoid`: one rule per `- ` line, as concrete as the user put it.
- `## Examples`: each example in its own code fence: a line ```` ```text ```` before it, a line ```` ``` ```` after it. Put `Good:` or `Bad:` on the line above the fence only if the user said which it is.
- `## Done when`: observable criteria, one per `- ` line. Start a line with `[must]` only when the user says it is non-negotiable ("never", "always", "must"). A task needs at least one line.
- Frontmatter: `id` (the slug), `type`, `language` (a code like `de` or `en`) and the fields of the type (see the template). Rules a script can check also go into `checks:`: words that must never appear → `checks.output.banned`, words that must appear → `checks.output.required_phrases`, a word limit → `checks.output.max_words`.
- Write the section text in the language the user writes in. Phrases the output must contain (greetings, sign-offs, product names) stay in the target language, exactly as given.
- Remove the template's `TODO:` lines that you filled in. Leave a `TODO:` for anything the user did not say.

### 5. Ask about what is missing (at most 3 questions)

Ask only about required fields you cannot fill, and propose a default for each, e.g. "Which agent uses this task: sales-agent (my guess) or support-agent?" Required:

- customer: `industry`, `default_tone`, `language`
- tone: `language`
- scenario: `input` (the sample message the consumer agent receives)
- task: `consumer` (one of `consumers:` in `beak.config.yaml`), `output_format`, `test_inputs`, one `## Done when` line

If the user does not know, write `TODO: …` as the value. Ask everything in one message.

### 6. Stage and check

Write each block to `library/_intake/<id>.md`. Then check all of them together, so blocks that refer to each other resolve:

```text
$ node tools/beak.mjs save library/_intake/globex.md library/_intake/logistics.md --check
would create library/customers/globex.md (customer globex, version 1)
would create library/industries/logistics.md (industry logistics, version 1)
library/_intake/logistics.md:19: warning: TODO left: TODO: terms, concerns or rules this industry expects.
check: ok, nothing written
```

Fix every `error:` in the staged files and check again. `TODO left` warnings are fine.

### 7. Show and confirm

Show the user each staged file in full, the `would create` / `would update` lines, and the remaining `TODO`s. For an update, also list what changed. Ask: "Save it?"

- Yes: go to step 8.
- Changes: edit the staged files, then go back to step 6.
- No: delete the staged files.

### 8. Save

Run `node tools/beak.mjs save` with the same files, without `--check`. Report the `created` / `updated` lines and any warnings.

If `beak save` refuses, do not work around it. Tell the user what it said and ask:

- "looks like a duplicate of …": same block → stage it with that block's `id` instead. Different block, and the user confirms it → run again with `--new`.
- "the example on line … is missing or changed": copy the example back unchanged. Use `--drop-examples` only if the user asked to remove or replace that example.
