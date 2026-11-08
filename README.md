# Beak

Beak is a harness that writes prompts. The tasks repeat; the context changes each time: customers, industries, scenarios, tones. Beak keeps those as small, versioned building blocks. It composes them into a prompt and improves the prompt in a quality loop (test → judge → revise). A human approves the result, and Beak routes it to the agent that uses it (`out/<consumer>/`).

One great prompt beats 100 mediocre ones.

```text
 intake ─▶ library
              │
 /compose ─▶ bundle ─▶ round 0 ─▶ [ test ▸ check ▸ judge ▸ score ▸ decide ] × N
                                                   │
                                           finalize (best round)
                                                   │
                                             drafts/ ─▶ /review
                                                   │
                                   /approve ─▶ out/<consumer>/<task>/<variant>.md
                                   /reject  ─▶ a new "Done when" line in the right block
```

You talk to Beak in [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). The model in your pi session (GLM-5.3 by default) writes the prompts. Small Node scripts (`node tools/beak.mjs …`) do everything that decides something: they merge the blocks, run the tests, check the outputs, call the judge, score each round, decide when the loop stops, and version and route what you approve. Every round leaves its evidence on disk.

**Status:** all v1 milestones are built, plus staleness (M7), score history (M8) and batch mode (M9) from the later list (plan §13). The library that ships is an example with a fictional customer, Acme Pharma; it will be replaced by real pilot tasks.

## Contents

- [Requirements and setup](#requirements-and-setup)
- [Walkthrough: from a new customer to an approved prompt](#walkthrough-from-a-new-customer-to-an-approved-prompt)
- [Try it without a model](#try-it-without-a-model)
- [How a consumer agent reads `out/`](#how-a-consumer-agent-reads-out)
- [The library](#the-library)
- [Picking a model](#picking-a-model)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements and setup

- Node ≥ 22
- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): `npm install -g @earendil-works/pi-coding-agent` (verified with 1.5.0)
- An OpenRouter API key: Beak's models (GLM-5.3, DeepSeek V4 Flash) are called through OpenRouter.

```bash
git clone https://github.com/davidkutt/pecker-beak && cd pecker-beak
npm install
node tools/beak.mjs --help
```

Give pi your key, either as `OPENROUTER_API_KEY` in your environment or with `/login` inside pi.

Start pi from the repo root:

```bash
pi
```

The first time, pi asks whether to trust the folder. Say yes (or run `/trust`, or start with `pi --approve`). **Beak's slash commands and skills only load in a trusted folder.** `AGENTS.md`, the rules pi follows here, loads either way.

## Walkthrough: from a new customer to an approved prompt

Everything below happens in your pi session. You type the commands and messages; pi runs the scripts and shows you what they print.

### 1. Add a customer (intake)

Describe it in a **normal message** (not `/add`), with the examples pasted as they are:

```text
New customer: Globex Logistics, a freight forwarder in Hamburg. They write to shippers in English, friendly tone. Examples are:

Hi Sam,

it's Jana from Globex – your Rotterdam → Leipzig loads fit our Tuesday "express" run.

Cheers,
Jana
```

The `beak-intake` skill:

1. checks for existing blocks with `beak find` (a customer you mention again is updated, not duplicated),
2. asks at most three questions about missing required fields (here: which tone and industry, proposing defaults),
3. stages `library/_intake/globex-logistics.md` (plus a `logistics` industry stub if that industry is new) with your examples **verbatim**,
4. shows you the files and what `beak save --check` says, and
5. saves them when you say yes. `beak save` sets `version` and `updated`, lints the blocks, and refuses to change an existing example unless you asked for it.

`/add <text>` works for short requests without examples. pi strips quotes and line breaks from slash-command arguments, so Beak never takes examples from `/add` text. `/skill:beak-intake <text>` passes text through unchanged.

Later changes work the same way: "Globex never wants prices in the first email." updates the block and bumps its version.

### 2. Compose a prompt

```text
/compose task=cold-email customer=acme-pharma
```

Arguments are `key=value` with ids from the library: `task` (required), `customer`, `industry`, `tone`, `scenario`, `context` (ids separated by commas), `tester`, `judge`. A customer brings its industry and default tone unless you name others.

What happens:

- `beak bundle` creates `runs/<run-id>/` (for example `runs/20261107-0930-cold-email-acme-pharma-formal-de/`). `bundle.md` holds the blocks in a fixed order, the merged hard checks, the judge's criteria and the test inputs; `rubric.json`, `meta.json` and `inputs.json` hold the same for the scripts. The run records the block versions and the models, so it can be reproduced.
- pi reads `bundle.md` and writes `round-0/prompt.md`: the system prompt for the consumer agent, with the sections the task asks for (Role, Context, Instructions, Constraints, Output format, Examples), in the target language, with the library's examples verbatim and only the task's runtime variables as placeholders (`{{sender_name}}`).

### 3. The quality loop

pi then runs one round after another, each with the same five scripts:

| Step | Script | Writes (in `round-N/`) |
|---|---|---|
| test | `beak test <run> N` | `outputs/<input>.md`: the tester model runs the prompt on each test input, in a clean pi process that sees nothing of Beak |
| check | `beak check <run> N` | `checks.json`: required sections, banned and required phrases, length limits, no stray placeholders |
| judge | `beak judge <run> N` | `judge.json`: the judge model grades every output against every criterion; a pass needs a verbatim quote from the output |
| score | `beak score <run> N` | `scorecard.json`, `scorecard.md`: pass = all hard checks, all `[must]` criteria and a score ≥ 85 |
| decide | `beak loop-status <run>` | prints `CONTINUE` or `STOP <reason>` |

On `CONTINUE`, pi copies the prompt to the next round, fixes only the scorecard's top issues (at most three) and records what it changed in `changes.md`. The loop stops on:

- `pass`: the round passes,
- `max_rounds`: round 3 is done (4 rounds, counting round 0),
- `plateau`: the score has not improved by 3 or more for 2 rounds,
- `error`: the runner failed twice in a row.

One test input is a **holdout**: it is tested and judged like the others, but pi only sees whether it passed. That keeps the prompt from being tuned to the visible examples.

On `STOP`, `beak finalize` copies the **best** round (the highest score among passing rounds, else the highest score), not the last one, to `drafts/cold-email/acme-pharma-formal-de.md` with `status: needs-review`. pi shows you the score per round, what still fails, a sample output and the draft path.

Not happy with the direction? Steer it:

```text
/refine 20261107-0930-cold-email-acme-pharma-formal-de mention the three-month stock in every email
```

The note becomes a `[must]` criterion for this run only, and the loop gets up to four more rounds.

### 4. Review

```text
/review
```

`beak review` reports on the draft: the rounds, what still fails and the judge's suggested fixes, a sample output, and a diff against the task's golden prompt (once there is one). It changes nothing. You may edit the draft afterwards, by hand or by asking pi; review then reruns the prompt's hard checks on your edited version.

### 5. Approve, or reject with a reason

```text
/approve drafts/cold-email/acme-pharma-formal-de.md --golden
```

`beak approve`:

- writes `out/sales-agent/cold-email/acme-pharma-formal-de.md` with `status: approved` and `version: 1` (the next approval of the same variant becomes version 2, and version 1 moves to `_archive/acme-pharma-formal-de.v1.md`),
- regenerates `out/sales-agent/index.json`,
- with `--golden`, makes this prompt the task's structural reference for future runs,
- commits exactly these files: `beak: approve sales-agent/cold-email/acme-pharma-formal-de v1`.

pi then asks whether you changed anything that should become a rule; each answer becomes a new "Done when" line in the block you choose (`beak learn`).

Or reject it:

```text
/reject drafts/cold-email/acme-pharma-formal-de.md too pushy, it asks for a call twice
```

pi proposes one "Done when" line ("Asks for at most one thing.") and the block it belongs in (task, customer, industry or tone), and writes it when you confirm, with `(learned <date>)` and a version bump. The draft moves to `drafts/_rejected/`. The next `/compose` of that variant is judged against the new rule, so Beak learns from every rejection.

### 6. Where things stand

```text
/beak-status
```

Drafts waiting for review, recent runs with their best score and stop reason, and the approved prompts per consumer. An approved prompt marked `STALE` was made from a block that has changed since.

```text
/beak-history cold-email acme-pharma-formal-de
```

The scores over time for one variant (leave out the variant, or both arguments, for more): every run with its round scores, best round and stop reason, what became of it (approved, rejected and why, waiting as a draft), and the approved versions with their scores. `runs/` stays on the machine that ran them; the approved versions and rejected drafts are committed, so their scores show up everywhere.

### 7. When a block changes

Blocks keep changing: intake updates a customer, a rejection adds a rule to a tone, `approve --golden` points a task at its golden prompt. Each of these bumps the block's version, and every approved prompt made from the old version becomes **stale**. The script that bumped the version marks those prompts right away and tells you how to refresh them:

```text
marked stale: out/sales-agent/cold-email/acme-pharma-formal-de.md v1 (formal-de v1 → v2); refresh it with /compose task=cold-email customer=acme-pharma
```

A stale prompt stays approved and in use. Run the `/compose` it names to put the new version through the loop, then review and approve it as usual. After a `git pull` or a hand edit of the library, `node tools/beak.mjs stale` brings the marks up to date.

### 8. Many variants at once: batch mode

Once a task has an approved golden prompt (`/approve <draft> --golden`), Beak can make that prompt for a whole list of customers, industries, scenarios or tones. It never starts a batch from scratch.

```text
/batch create task=cold-email industry=@lists/industries.txt
/ralph --path runs/batches/20261108-1700-cold-email-by-industry
```

`beak batch create` checks every item up front (each must bundle), then writes `runs/batches/<id>/`. `/ralph` (the [Ralph extension](https://www.npmjs.com/package/@lnilluv/pi-ralph-loop), installed from `.pi/settings.json` when you trust the folder) works through the queue unattended: per item, a fresh pi process takes the next item, writes round 0 in the golden prompt's structure, runs the normal quality loop and finalizes the best round into `drafts/batch-<id>/`. Ralph may only run Beak's loop scripts and may not write `library/`, `out/` or any evidence file. A problem it cannot solve goes into the batch's `OPEN_QUESTIONS.md` under `## P1`, and the batch then waits for you.

When it is done (`/batch status <id>`):

```text
/batch review <id>      # the sample (10% of the PASS drafts) and the FAIL drafts: /review, then /approve or /reject each
/batch approve <id>     # the other PASS drafts, in one commit, once every sampled draft was approved
```

A rejected sample turns bulk approval off for that batch; FAIL drafts are always reviewed one by one. Nothing is approved without you.

## Try it without a model

The **fake runner** answers test and judge calls from canned files in `test/fixtures/fake/` instead of calling a model. With it you can run the whole flow from the shell in a minute, without pi or a key. The canned judge passes everything, so the loop stops after round 0.

`beak approve` commits, so try this on a scratch branch:

```bash
git switch -c try-beak
export BEAK_RUNNER=fake

node tools/beak.mjs bundle task=cold-email customer=acme-pharma
RUN=$(ls -t runs | head -1)                     # the run id bundle printed
cp docs/examples/round-0-prompt.md runs/$RUN/round-0/prompt.md   # pi's job, normally

node tools/beak.mjs test $RUN 0
node tools/beak.mjs check $RUN 0
node tools/beak.mjs judge $RUN 0
node tools/beak.mjs score $RUN 0
node tools/beak.mjs loop-status $RUN            # STOP pass
node tools/beak.mjs finalize $RUN               # → drafts/cold-email/acme-pharma-formal-de.md
node tools/beak.mjs review
node tools/beak.mjs approve drafts/cold-email/acme-pharma-formal-de.md
node tools/beak.mjs status
```

Look at `runs/$RUN/round-0/scorecard.md` (what pi reads between rounds) and `out/sales-agent/`. Afterwards: `git switch - && git branch -D try-beak && rm -rf runs`.

`test/fixtures/fake/README.md` explains how to make the fake runner fail, score low or reject a criterion.

## How a consumer agent reads `out/`

Approved prompts live at a stable path, one folder per consumer agent (`consumers:` in `beak.config.yaml`):

```text
out/sales-agent/
├── index.json
└── cold-email/
    ├── acme-pharma-formal-de.md           # always the latest approved version
    └── _archive/acme-pharma-formal-de.v1.md
```

`index.json` lists every approved prompt:

```json
{
  "consumer": "sales-agent",
  "prompts": [
    {
      "task": "cold-email",
      "variant": "acme-pharma-formal-de",
      "version": 2,
      "language": "de",
      "runtime_vars": ["sender_name", "sender_role"],
      "approved_at": "2026-11-07T09:30:00.000Z",
      "stale": false,
      "path": "cold-email/acme-pharma-formal-de.md"
    }
  ]
}
```

Each prompt file is Markdown with YAML frontmatter (`status`, `version`, `language`, `runtime_vars`, `sources`, `score`, …) and the system prompt as its body. A consumer:

1. looks up its task and variant in `index.json` (`path` is relative to the consumer's folder),
2. reads the file and uses it only if its frontmatter says `status: approved` (archived versions say `archived`),
3. replaces each `{{name}}` in the body with its value for every name in `runtime_vars`, and
4. uses the result as the system prompt.

`"stale": true` means a block the prompt was made from has changed since it was approved (the file's `stale:` list says which). The prompt is still the latest approved one and safe to use; a refreshed version will replace it once it is approved. A consumer may log a warning, but should not refuse it.

```js
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export function loadPrompt(outDir, { task, variant }, vars) {
  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  const entry = index.prompts.find((p) => p.task === task && p.variant === variant);
  if (!entry) throw new Error(`no approved prompt for ${task}/${variant}`);
  const [, frontmatter, body] = fs.readFileSync(path.join(outDir, entry.path), 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (YAML.parse(frontmatter).status !== 'approved') throw new Error(`${entry.path} is not approved`);
  for (const name of entry.runtime_vars) if (!(name in vars)) throw new Error(`missing runtime variable ${name}`);
  return body.trim().replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name) => vars[name]);
}

const system = loadPrompt('out/sales-agent', { task: 'cold-email', variant: 'acme-pharma-formal-de' }, {
  sender_name: 'Markus Lehmann',
  sender_role: 'Key Account Manager Kliniken',
});
```

A consumer in another repository can pull this repo's `out/` folder as a git submodule, with a sparse checkout, or by fetching `index.json` and the files it lists from the raw URLs. Which one is still open (plan §14, question 1).

## The library

`library/` holds the building blocks: `tasks/`, `customers/`, `industries/`, `tones/`, `scenarios/` and `context/`. Each block is a Markdown file with YAML frontmatter and five sections:

- **Purpose**: 1–3 sentences.
- **Must include** and **Avoid**: the rules.
- **Examples**: verbatim, labelled `Good:` or `Bad:`.
- **Done when**: one observable criterion per line; these become the judge's criteria. `[must]` makes one blocking, and `(learned <date>)` marks a line that came from a rejection.

Rules a script can check go into the frontmatter (`checks.output.banned`, `max_words`, …). Blank templates are in `library/_templates/`; the full format is in `plan.md` §4. Change blocks through intake (or `beak reject` / `beak learn` after a review), so the version and date stay right.

```bash
node tools/beak.mjs lint                                   # the whole library
node tools/beak.mjs find Acme Pharma type=customer         # is there a block like this?
node tools/beak.mjs save library/_intake/acme-pharma.md --check
```

## Picking a model

There are two models to choose from: **GLM-5.3** and **DeepSeek V4 Flash**.

- **Writer** (your pi session): starts on GLM-5.3. Press **Ctrl+P** to switch to DeepSeek V4 Flash and back. The default lives in `.pi/settings.json`.
- **Tester and judge** (run by Beak's scripts): set in `beak.config.yaml` under `roles:`. The default is GLM-5.3 testing and DeepSeek V4 Flash judging. To swap, change the names:

  ```yaml
  roles:
    tester: deepseek-v4-flash
    judge:  glm-5.3
  ```

Tester and judge can be the same model or different ones. For a single run, pick them on the command: `/compose task=cold-email … tester=deepseek-v4-flash judge=deepseek-v4-flash`. The run records its models, so `/refine` keeps using them.

To add another model, add it under `models:` and to `enabledModels` in `.pi/settings.json`.

The loop's limits (`max_rounds`, `pass_threshold`, `min_delta`, `patience`, number of test and holdout inputs, `judge_samples`) are under `loop:` in `beak.config.yaml`. A run keeps the values it started with.

## Commands

In pi:

| Command | Does |
|---|---|
| plain message, `/add <text>` | Add or update library content (intake) |
| `/compose task=… [customer=…] [industry=…] [tone=…] [scenario=…] [context=…] [tester=…] [judge=…]` | Bundle, write round 0, run the quality loop, finalize a draft |
| `/refine <run-id> [notes]` | More rounds on a stopped run; the notes become a run-only criterion |
| `/review [draft]` | Report on a draft (changes nothing) |
| `/approve <draft> [--golden]` | Route the draft to `out/`, archive the old version, commit |
| `/reject <draft> <reason>` | Reject the draft; the reason becomes a Done-when line where you choose |
| `/beak-status` | Drafts, recent runs, approved prompts |
| `/beak-history [task] [variant]` | Scores over time per task and variant |
| `/batch create … \| status\|review\|approve <batch>` | Batch mode (start it with `/ralph --path runs/batches/<id>`) |

The scripts behind them (`node tools/beak.mjs <command> --help` for details):

| Script | Does |
|---|---|
| `lint [path]` | Validate library blocks |
| `find <name…> [type=…]` | Similar blocks, and the slug for a new one |
| `save <file…> [--check] [--new] [--drop-examples]` | Move staged intake blocks into the library |
| `bundle key=value…` | Create a run folder |
| `test`, `check`, `judge`, `score` `<run> <round>` | One step of a round |
| `loop-status <run>` | `CONTINUE` or `STOP <reason>`, and the next step |
| `finalize <run> [--force]` | Best round → `drafts/` |
| `refine <run> [rounds=N] [notes…]` | More rounds, plus a run-only criterion |
| `review [draft]`, `status` | Reports |
| `stale [--check]` | Mark approved prompts whose blocks changed since; say how to refresh each |
| `history [task] [variant] [--json]` | Scores over time: runs, outcomes, approved versions |
| `batch create\|next\|done\|status\|gate\|review\|approve …` | Batch mode: the queue, the sample, bulk approval |
| `score --gate <run>` | Exit 0 only if the run's loop stopped with a pass |
| `approve <draft> [--golden]` | Route to `out/<consumer>/`, archive, `index.json`, commit |
| `reject <draft> --reason "…" [--block <id> --line "…" [--must]] [--check]` | Reject, optionally with a rule |
| `learn <block> --line "…" [--must] [--check]` | Add a learned Done-when line to a block |

Exit codes: `0` ok, `1` failure, `2` usage error.

## Troubleshooting

**`/compose` (or another slash command) arrives as plain text, or pi does not know the Beak skills.** The folder is not trusted. Run `/trust` in pi, or start it with `pi --approve`.

**A skill or command vanished after you edited it.** Its frontmatter is probably invalid YAML (a `: ` inside an unquoted value); pi drops such a file without a warning. `npm test` checks every skill and template.

**`beak test` fails with `pi not found`.** Install pi: `npm install -g @earendil-works/pi-coding-agent`.

**`pi (openrouter …) exited with code 1: Connection error.`** No key or no network. Check `OPENROUTER_API_KEY` (or `/login` in pi) and that `pi -p --provider openrouter --model z-ai/glm-5.3 "hi"` works in a terminal.

**`Model "…" not found for provider`.** A model id in `beak.config.yaml` is misspelled. pi would send the request anyway, so Beak treats it as a failure. `pi --list-models openrouter` lists the ids your key can use.

**The loop says `CONTINUE` and `next: … test` after a failed step.** One failure gets one retry. Two failures in a row stop the loop with `STOP error`; `beak finalize` then drafts the best round so far. Fix the cause and continue with `/refine <run>`.

**`the judge's reply was invalid twice`.** The judge model did not return the required JSON. Its replies are in `round-N/runner.json`. Try the other model as judge for that run: `/compose … judge=glm-5.3`.

**`beak score` refuses: "was not written by beak judge" or "changed after beak check ran".** Evidence files are written by scripts only, for the prompt and outputs as they are. Run the step it names again; never edit `checks.json`, `judge.json` or a scorecard by hand.

**`prompt.md changed after beak test`.** The round's prompt was edited after its outputs were made. Run `beak test` for that round again (or put the change into the next round).

**`beak bundle: these blocks have lint errors`.** Run `node tools/beak.mjs lint`, then fix the block through intake.

**`output checks conflict: min_words … is larger than max_words …`.** Two blocks of the run disagree (for example a long-form tone and a customer's 120-word limit). Change one of them, or pick another tone.

**`the loop has not stopped`** from `beak finalize`. Follow `beak loop-status`. To stop early on purpose: `beak finalize <run> --force`.

**`the draft fails N hard checks on its prompt`** from `beak approve`. Usually a placeholder (`[Name]`, `{company}`) or a missing section in an edited draft. Fix `drafts/<task>/<variant>.md` and approve again.

**`/ralph` arrives as plain text.** The Ralph package is not loaded: trust the folder (it is declared in `.pi/settings.json`), let pi install it (needs npm access on start), or run `/reload`.

**A batch does not finish.** `beak batch gate <id>` says what is open. Ralph also refuses to finish while the batch's `OPEN_QUESTIONS.md` lists something under `## P0` or `## P1`: fix it, tick it off (`- [x] …`) and start `/ralph --path runs/batches/<id>` again. It picks up the running item.

**`STALE` in `beak status`, or `"stale": true` in `index.json`.** A block the prompt was made from has a newer version (or was deleted). The prompt keeps working. Refresh it with the `/compose` that `beak stale` prints. If status says the marks are out of date, run `node tools/beak.mjs stale`.

**`warning: not committed`** after approving. The folder is not a git repository, or git has no `user.name` / `user.email`. The approval stands; commit the files it lists yourself.

**`warning: the library changed during this run`.** A block was edited between `bundle` and `finalize`, so the draft may not match the current library. Compose the variant again.

**I can only see two of three outputs.** The third is the holdout. You can read it in `runs/<run>/round-N/holdout/`; pi must not, and the scorecard shows it as pass or fail only.

**Where is a run's evidence?** `runs/<run-id>/`: `bundle.md`, `rubric.json`, `meta.json`, `inputs.json`, and per round `prompt.md`, `changes.md`, `outputs/`, `holdout/`, `test.json`, `checks.json`, `judge.json` (including the judge's raw replies), `scorecard.json`, `scorecard.md`, `runner.json`. `runs/` is not committed (plan §14, question 5).

## Development

```bash
npm test
```

Tests never call a model; they use the fake runner. See:

- `plan.md`: what Beak is and how it is built
- `CLAUDE.md`: conventions for building Beak
- `AGENTS.md`: runtime rules for pi
- `docs/pi-notes.md`: how pi actually behaves (verified), including how test runs are isolated, and the manual smoke tests that still need a real model
