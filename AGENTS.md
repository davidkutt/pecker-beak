# Beak: operator rules

You are operating **Beak**, a harness that writes prompts for other agents (the "consumer" agents). Beak keeps reusable building blocks in `library/`, composes them into a prompt, improves the prompt in a quality loop (test → judge → revise), and a human approves the result. Approved prompts go to `out/<consumer>/`.

> **Milestone 3.** Intake (`/add`), `/compose` up to round 0, and `beak lint` / `find` / `save` / `bundle` work. The quality loop is not built yet. `node tools/beak.mjs --help` marks every other command "not built yet". If the user asks for one of those, say so; do not improvise a replacement.

## Folder map

| Path | Holds | You may write it? |
|---|---|---|
| `library/` | building blocks: `tasks/`, `scenarios/`, `customers/`, `industries/`, `tones/`, `context/`, `_templates/` | only through intake: stage in `library/_intake/`, then `beak save` on the user's confirmation. Never during a run |
| `runs/<run-id>/` | one compose run: `bundle.md`, `rubric.json`, `meta.json`, `inputs.json`, `round-N/` | only `round-N/prompt.md` and `round-N/changes.md`. Never open `inputs.json`: it holds holdout test inputs |
| `drafts/` | loop results waiting for review; `_rejected/` | no, scripts write it (the user may edit a draft) |
| `out/<consumer>/` | approved prompts and `index.json` | no, only `beak approve` writes it |
| `beak.config.yaml` | models, loop limits, consumers, paths | no |
| `plan.md` | the full specification | no |

## Commands

| Command | Does |
|---|---|
| `/add <free text>` | Add or update library content (`beak-intake` skill). Plain chat such as "New customer: …" means the same. pi strips quotes and line breaks from `/add` text, so take examples only from a plain message |
| `/compose task=… [customer=…] [industry=…] [tone=…] [scenario=…] [context=…] [tester=…] [judge=…]` | Bundle the blocks, write round 0, run the quality loop (`beak-compose` skill). `tester` / `judge` pick models for this run |
| `/refine <run-id> [notes]` | More rounds on an existing run; the notes become run-only criteria |
| `/review [draft]` | Report on a draft. Report only, never edit |
| `/approve <draft> [--golden]` | Route a draft to `out/`. Only when the user asks |
| `/reject <draft> <reason>` | Turn the reason into a proposed Done-when line |
| `/beak-status` | Drafts waiting for review, recent runs and scores |

The scripts behind them: `node tools/beak.mjs <lint|find|save|bundle|test|check|judge|score|loop-status|finalize|approve|reject>`. Pass `key=value` arguments through to the scripts unchanged; the scripts parse them, you do not.

## Hard rules

1. **Scripts produce all evidence, scores and stop decisions.** Never write or edit `checks.json`, `judge.json`, `scorecard.json`, `scorecard.md`, `rubric.json`, `meta.json` or any loop decision yourself. Run the script that produces it.
2. **Obey `beak loop-status`.** `CONTINUE` means write the next round. `STOP <reason>` means run `beak finalize`. Never stop early, never add rounds on your own, never declare a pass yourself.
3. **Never edit `library/` during a run** (from `beak bundle` until `beak finalize`). If a block is wrong, finish or abandon the run and tell the user. Outside a run, change blocks only through intake: write the proposal to `library/_intake/<id>.md` and let `beak save` move it. It sets `version` and `updated`; never write those yourself.
4. **Never approve without the user.** Run `beak approve` only when the user explicitly asks for that draft.
5. **Never invent customer facts.** If information is missing, ask, or mark it `TODO:`.
6. **Examples stay verbatim.** Copy library examples exactly; never rewrite, translate or "improve" them.

## Prompt house style

Every prompt you write for a consumer agent:

- has explicit sections: **Role, Context, Instructions, Constraints, Output format, Examples**, each a `## <name>` heading. If the task's `output_format` asks for a different structure, follow the task.
- uses concrete instructions instead of adjectives ("at most 120 words, one call to action", not "concise and compelling").
- keeps examples verbatim from the library.
- is written in the target language (the block's `language`).
- contains no placeholders except the task's `runtime_vars`, written `{{name}}`. Anything else unresolved is a failed check.

## When revising a round

- Fix only the **top issues** from the scorecard, with targeted edits. Do not rewrite the whole prompt; full rewrites cause oscillation.
- Record each change in `round-N/changes.md`: what changed, and which scorecard issue it addresses.
- For holdout inputs you see only pass or fail. Do not guess their content or tune for it.
