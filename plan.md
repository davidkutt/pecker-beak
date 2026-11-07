# Beak: implementation plan

> Repo: `pecker-beak` · Project: **Beak** · Builder: Claude Code · Runtime: pi coding agent (main model GLM-5.3)

## 1. What Beak is

Beak is a harness that writes prompts. The tasks repeat; the context changes each time: customers, industries, scenarios, tones. Beak keeps those as small, versioned building blocks. It puts them together into a prompt, runs that prompt in a **quality loop** (test → judge → revise) until it is good or the loop stops making progress, and then a human approves it. Approved prompts go into per-agent folders, where the agents that use them (the "consumer" agents) pick them up.

Guiding principle: **one great prompt beats 100 mediocre ones.** Batch generation comes later, and it always starts from an approved "golden" prompt, never from scratch.

Beak is made of configuration, skills and small Node scripts that run inside pi. v1 needs **no pi extensions**.

### Goals (v1)
- A structured, versioned library of building blocks.
- Intake in plain language: "New customer: Acme Pharma, … Examples are …" becomes a correctly formatted block.
- Compose a prompt from blocks.
- **Quality loop**: a bounded number of rounds; every round leaves evidence on disk; the best round wins; a human approves at the end.
- Review, approve and reject. Rejection reasons are written back into the checklists, so the system learns.
- Route approved prompts to `out/<consumer>/…`.

### Non-goals (v1)
- Batch generation: Ralph is listed in TODO (§15).
- Auto-approval of any kind.
- Custom pi extensions (TypeScript).
- UI or dashboards.

---

## 2. Runtime assumptions. Verify these first (Milestone 0)

Check each item against the current pi docs, `pi --help` and the installed version (package `@earendil-works/pi-coding-agent`; the old `@mariozechner/...` package is deprecated). Adjust the plan wherever reality differs, and record the findings in `docs/pi-notes.md`.

**Verified on pi 1.5.0 (2026-11-06).** Details, evidence and the exact invocations are in `docs/pi-notes.md`.

| Assumption | Used for | Result |
|---|---|---|
| pi loads `AGENTS.md` from the working directory | house rules | ✅ Also from every parent directory and `~/.pi/agent/`, **without** project trust. pi reads only one of `AGENTS.md` / `CLAUDE.md` per directory (AGENTS.md wins), so it never sees `CLAUDE.md`. |
| `.pi/prompts/<name>.md` become `/name` slash commands, with `$1…$n` / `$@` args and `description` frontmatter | commands | ✅ Requires **project trust** (`/trust` or `pi --approve`). Shell-like quoting: quotes are consumed and `$@` re-joins with spaces. |
| `.pi/skills/<name>/SKILL.md` (Agent Skills format: `name`, `description` frontmatter) is listed in the system prompt and loaded on demand | skills | ✅ Requires project trust and the `read` tool. `/skill:<name>` forces loading. |
| `pi -p "<msg>"` (print mode) runs non-interactively and exits; `--provider` / `--model` select the model | test runs and the judge | ✅ Exit code 1 and empty stdout on failure. Piped stdin becomes the user message. |
| pi has some way to replace or append the system prompt for one run (a flag such as `--system-prompt` / `--append-system-prompt`, or `SYSTEM.md` / `APPEND_SYSTEM.md` in a temp cwd) | testing a candidate prompt in isolation | ✅ `--system-prompt <text\|path>` replaces the whole default prompt. pi always appends a `<cwd>` line, so test calls run from an empty temp dir. |
| `--no-skills` / `--no-extensions` (or equivalent) keep Beak's own skills and AGENTS.md out of test runs | clean test runs | ⚠️ Not on their own. Also needs `--no-context-files` (AGENTS.md), `--append-system-prompt ""` (the user's `APPEND_SYSTEM.md`), `--no-prompt-templates --no-mcp --no-themes --no-tools --no-approve --no-session`. Verified against a request-logging mock endpoint. |

Node ≥ 22. Use plain ESM JavaScript (`.mjs`) with minimal dependencies (`yaml`, plus `ajv` for JSON validation if needed). Tests use `node:test`.

---

## 3. Repository layout

```
pecker-beak/
├── AGENTS.md                  # runtime house rules (read by pi)
├── CLAUDE.md                  # builder instructions (read by Claude Code)
├── README.md
├── plan.md                    # this file
├── beak.config.yaml           # models, loop limits, consumers, paths
├── package.json               # "bin": { "beak": "tools/beak.mjs" }
├── library/
│   ├── tasks/                 # what the generated prompt must make an agent do
│   ├── scenarios/             # situations + sample inputs used as test cases
│   ├── customers/             # one file per customer, incl. verbatim examples
│   ├── industries/
│   ├── tones/
│   ├── context/               # shared background (product facts, policies)
│   ├── _templates/            # one blank template per block type
│   └── _intake/               # intake proposals waiting for the user's OK (gitignored)
├── .pi/
│   ├── prompts/               # compose, refine, review, approve, reject, add, beak-status
│   └── skills/
│       ├── beak-intake/SKILL.md
│       ├── beak-compose/SKILL.md
│       └── beak-quality-loop/SKILL.md
├── tools/
│   ├── beak.mjs               # CLI entry
│   ├── lib/                   # parsing, merging, checks, runner, scoring
│   └── prompts/judge.md       # judge prompt (used by `beak judge`)
├── runs/                      # one folder per compose run (gitignored by default)
├── drafts/                    # loop results awaiting human review
│   └── _rejected/
├── out/
│   └── <consumer>/
│       ├── index.json         # regenerated on every approve
│       └── <task>/<variant>.md (+ _archive/)
├── docs/
└── test/                      # fixtures + unit tests (fake runner)
```

**Two instruction files, two audiences:** `CLAUDE.md` tells Claude Code how to *build* Beak. `AGENTS.md` tells pi/GLM how to *operate* Beak. Do not mix the two.

---

## 4. Block format (the core contract)

Every library file is Markdown with YAML frontmatter and a fixed set of sections. `beak lint` enforces this.

### Common frontmatter
```yaml
---
id: acme-pharma            # must equal the filename slug
type: customer             # task | scenario | customer | industry | tone | context
version: 3                 # bump on every content edit
language: de               # optional; inherited by prompts unless overridden
updated: 2026-11-06
checks:                    # optional HARD (deterministic) checks this block adds
  output:                  # applied to what the consumer agent produces
    banned: ["revolutionär", "game changer"]
    max_words: 180
    required_phrases: []
  prompt:                  # applied to the generated prompt itself
    required_sections: []
---
```

### Body sections (in this order)
- `## Purpose`: 1–3 sentences.
- `## Must include`
- `## Avoid`
- `## Examples`: verbatim; label them `Good:` / `Bad:`. **Intake never rewrites examples.**
- `## Done when`: a checklist of observable criteria. These become the judge's criteria. Lines added from rejections carry `(learned YYYY-MM-DD)`. Prefix a line with `[must]` to make it blocking.

### Type-specific frontmatter
- **task**: `consumer` (an agent name from config), `output_format` (the required structure of the generated prompt, e.g. Role / Context / Instructions / Constraints / Output format / Examples), `test_inputs` (scenario ids or inline inputs), `runtime_vars` (placeholders the consumer fills at runtime, e.g. `[lead_name, company]`), `default_tone`, `golden` (path to the approved reference prompt, optional).
- **customer**: `industry` (an id), `default_tone` (an id), `language`.
- **scenario**: `input` (sample user input for test runs), `notes` (what a good response does).
- **tone**: `language`, register notes in the body.

### Format details (settled in M1; `beak lint` enforces them)

Templates for every type are in `library/_templates/`. The parser is `tools/lib/blocks.mjs`, the loader `tools/lib/library.mjs`.

- **Files:** `library/<type folder>/<id>.md`, with folders `tasks`, `scenarios`, `customers`, `industries`, `tones` and `context`. The folder decides the type, and `type:` must match it. Folders starting with `_` and non-`.md` files are not read; lint warns about stray files.
- **Frontmatter:** `id`, `type`, `version` (whole number ≥ 1) and `updated` (`YYYY-MM-DD`) are required. `language` is a code such as `de`, `en` or `de-CH`, required for customers and tones and optional elsewhere. A field that doesn't belong to the block's type is an error.
- **Required per type:** task: `consumer`, `output_format`, `test_inputs`. Customer: `industry`, `default_tone`, `language`. Scenario: `input`. Tone: `language`.
- **`test_inputs`:** each entry is a scenario id or an inline `{ id, input }`. Lint warns if there are fewer than `loop.test_inputs`.
- **`runtime_vars`:** names like `sender_name` (lowercase, digits, underscores). Inside prompts they are written `{{sender_name}}` (fixed in M3). Any other `{{…}}`, `[Bracket placeholder]` or `TODO` in a prompt fails a hard check.
- **`checks`:** two scopes, `output` and `prompt`. Both take `banned` and `required_phrases` (lists of strings) and `max_words`, `min_words`, `max_chars`, `min_chars` (whole numbers). `prompt` also takes `required_sections`. Unknown keys are errors, and `min_* > max_*` is an error.
- **Body:** an optional `# Title` line, then exactly the five `##` sections, in order. `## Purpose` must not be empty. Headings inside code fences are content.
- **`## Done when`:** one criterion per `- ` line. `[must]` at the start makes it blocking, and ` (learned YYYY-MM-DD)` at the end marks a line added from a rejection. Prose and checkboxes are errors. A task needs at least one criterion.
- **`## Examples`:** a line starting with `Good:` or `Bad:` begins an example; put multi-line examples in a code fence. Labels are optional (intake only labels when the user says which).
- **`TODO:`** anywhere is a warning. A `TODO:` value in a reference field (`industry`, `default_tone`, `consumer`, `language`) skips the reference check, so intake stubs lint with warnings only.
- **Lint output:** `path:line: level: message`, sorted, then a summary line. Exit code 1 if there is any error. `beak lint <file|folder>` reports only that path but resolves ids against the whole library.

### Merging rules (`beak bundle`)
- Lists (`banned`, `required_phrases`, `required_sections`, Done-when lines) are unioned, and each item keeps its source id.
- Numbers take the strictest value: the minimum of the `max_*` values, the maximum of the `min_*` values. A conflict (`min > max`) is an error.
- Precedence for single-value fields: scenario > customer > industry > tone > task (most specific wins).
- A customer implies its industry and default tone unless they are passed explicitly. A run may use an industry without a customer (needed for "for each industry" later). Without a customer or `tone=`, the task's `default_tone` is used.

Settled in M3 (`tools/lib/bundle.mjs`):

- **Block order** in `bundle.md`, `rubric.json` and `meta.json`: task, customer, industry, tone, scenario, context. Context blocks join a run with `context=<id>,<id>` (a reversible default, see §14 Q7).
- **The task's `output_format`** becomes the prompt's `required_sections` (source: the task).
- **Criteria** get ids `C1`, `C2`, … in block order. A criterion that two blocks share is listed once with both sources; it is `[must]` if either says so.
- **Test inputs:** the first `loop.test_inputs` entries of the task's `test_inputs`. A scenario used as a test input brings its `notes`, its Done-when lines and its `checks.output` **for that input's output only** (`inputs: [id]` on the criterion, `input_checks.<id>` in the rubric). The last `loop.holdout` inputs are holdout inputs; at least one stays visible.
- **`scenario=`** makes the scenario part of the prompt: its criteria apply to every output, and the run is tested on that scenario's input only (one input, no holdout; see §14 Q6).
- **Language:** the first block in precedence order that sets one. A tone in another language is a warning.
- The run's blocks must lint clean; their `TODO:` warnings are passed on. A `TODO:` reference (e.g. `industry: "TODO: …"`) is skipped with a warning.

---

## 5. The flow

```
 intake ─▶ library
              │
 /compose ─▶ bundle ─▶ round 0 ─▶ [ test ▸ check ▸ judge ▸ score ▸ decide ] ×N
                                                   │
                                           finalize (best round)
                                                   │
                                             drafts/  ─▶ /review
                                                   │
                                  /approve ─▶ out/<consumer>/<task>/…  (+ index.json, git commit)
                                  /reject  ─▶ reason ─▶ new "Done when" line in the right block
```

### Slash commands (`.pi/prompts/*.md`)
| Command | Does |
|---|---|
| `/add <free text>` | Runs the intake skill. Plain chat ("New customer: …") must trigger it too. pi strips quotes and line breaks from `/add` text, so examples come from a plain message (see below) |
| `/compose task=… [customer=…] [industry=…] [tone=…] [scenario=…] [context=…] [tester=…] [judge=…]` | Bundle, round 0, then the quality loop. `tester` / `judge` pick a model from `models:` for this run (default: `roles:`) |
| `/refine <run-id> [notes]` | More rounds on an existing run; notes become extra criteria for that run |
| `/review [draft]` | Report only: scorecard, failing criteria, one sample output, diff against the golden prompt |
| `/approve <draft> [--golden]` | Route to `out/`, version, archive the previous version, commit |
| `/reject <draft> <reason>` | Record the reason, propose a Done-when line and the block it belongs to, write on confirm |
| `/beak-status` | Drafts waiting for review, recent runs and their scores |

Arguments use `key=value`, passed through `$@` and parsed by the scripts, not by the LLM. pi consumes quotes when it expands `$@`, so `key=value` values must be slugs. Free text (reasons, notes) goes last and is taken with `${@:2}` (see `docs/pi-notes.md`).

Template arguments are lossy (verified in M2): pi removes `"` and `'` and collapses line breaks and runs of spaces outside quotes, and an apostrophe swallows the rest of the line into one quoted span. That is fine for slugs and short notes, never for examples. `/add` therefore tells the model to take examples only from a plain chat message. Plain messages and `/skill:beak-intake <text>` reach the model unchanged.

The commands and skills load only in a **trusted** project. Run `/trust` once in pi, or start it with `pi --approve`.

---

## 6. Scripts (`tools/`): deterministic, testable

**Rule: the LLM writes prompts. Scripts produce all evidence, scores and stop decisions.** The agent never writes `checks.json`, `judge.json`, `scorecard.*` or loop decisions by hand. AGENTS.md states this, and `beak score` refuses round folders that lack script-generated files.

| Command | Output |
|---|---|
| `beak lint [path]` | Validates frontmatter, sections, slug = filename, that referenced ids exist, known consumers. Warns on `TODO:`. |
| `beak find <name…> [type=…]` | Intake's duplicate check: prints the slug for the name, every block whose id or title is like it (`exact:` same id, `likely:` similar), and with `type=` the path for a new block (`new:`). |
| `beak save <file…> [--check] [--new] [--drop-examples]` | Moves staged blocks from `library/_intake/` to `library/<type folder>/<id>.md`. Sets `version` (1 when new, +1 when the content changed, unchanged otherwise) and `updated` (today), lints the staged blocks together with the library, removes the staged files. Writes nothing on any error: lint errors, a new block like an existing one (unless `--new`), an existing example changed or removed (unless `--drop-examples`). `--check` reports and writes nothing. |
| `beak bundle key=value…` | Creates `runs/<run-id>/` with `bundle.md` (blocks in fixed order, with ids and versions, plus the visible test inputs), `rubric.json` (merged hard checks + judge criteria with source ids), `meta.json` (args, block versions, library hash, test input ids, a copy of `loop:`, and the run's `tester` and `judge` models as `{ name, provider, model }`) and `inputs.json` (every test input's text, holdout included, so the writer never reads it). Optional `tester=` / `judge=` pick models for this run; the default comes from `roles:`. Prints the run id on the first line. |
| `beak test <run> <round>` | For each test input, a **fresh** runner call with the candidate prompt as the system prompt and the input as the user message, writing `round-N/outputs/<input-id>.md`. Beak's AGENTS.md and skills must not leak into the call. |
| `beak check <run> <round>` | Hard checks on `prompt.md` and `outputs/*` → `round-N/checks.json`. Always on: no unresolved placeholders except `runtime_vars`. |
| `beak judge <run> <round>` | Fresh runner call with `tools/prompts/judge.md`, the rubric, the prompt and the outputs. Strict JSON: per criterion `pass`, `evidence` (a quote from the output), `fix`; overall `score` 0–100; `top_issues` (≤3). Validated against a schema; one retry on invalid JSON. Writes `round-N/judge.json`. |
| `beak score <run> <round>` | Combines checks and judge into `round-N/scorecard.json` + `scorecard.md`. `pass` = all hard checks pass AND all `[must]` criteria pass AND score ≥ threshold. |
| `beak loop-status <run>` | Table of rounds; prints `CONTINUE` or `STOP <reason>` using the stop rules (§7). The skill must follow it. |
| `beak finalize <run>` | Copies the **best** round (highest score among passing rounds, else highest overall) to `drafts/<task>/<variant>.md` with frontmatter: `status: needs-review`, run, round, score, sources (`id@version`), consumer. Warns if the library hash changed during the run. |
| `beak approve <draft> [--golden]` | See §9. |
| `beak reject <draft> --reason "…" [--block id]` | See §9. |

**Runner abstraction** (`tools/lib/runner.mjs`): `pi` (real, through print mode) and `fake` (returns canned outputs from `test/fixtures/`). Select it with `runner:` in the config or the `BEAK_RUNNER` environment variable. Every unit test uses `fake`.

The `pi` runner spawns `pi -p` with an argv array from a fresh empty temp directory. The system prompt comes from a file (`--system-prompt <path>`), the user message is sent on stdin, and the isolation flags are those listed in `docs/pi-notes.md` ("Test and judge calls"). A non-zero exit or empty stdout counts as a runner failure. A unit test pins the argument list. `beak test` and `beak judge` take the models from the run's `meta.json`, not from the config, so a run keeps its models even if `roles:` changes, and `/refine` continues with them.

**Variant naming:** `<customer|industry>-<tone>[-<scenario>]`, e.g. `acme-pharma-formal.md`.
**Run id:** `<yyyymmdd-hhmm>-<task>-<variant>`.

---

## 7. Quality loop specification (the core of Beak)

Lives in `.pi/skills/beak-quality-loop/SKILL.md`; orchestrated by the pi agent, with evidence produced by the scripts.

**Round 0:** the writer (GLM-5.3, interactive pi session) drafts `round-0/prompt.md` from `bundle.md`, following the task's `output_format`. If the task has a `golden` prompt, it serves as the structural reference: keep the structure, swap the content.

**Each round N:**
1. The writer saves `round-N/prompt.md` and `round-N/changes.md`, which lists what changed and which scorecard issue each change addresses.
2. `beak test`: outputs for the test inputs (default 3).
3. `beak check`: hard checks.
4. `beak judge`: criteria verdicts.
5. `beak score`, then `beak loop-status`.
6. On `CONTINUE`: the writer fixes **only the top issues** with targeted edits, no full rewrite (this prevents oscillation). Then round N+1.

**On `STOP`:** run `beak finalize` and show the user the score per round, the criteria still failing, one sample output and the draft path.

**Stop rules** (deterministic, in `loop-status`):
- `pass`: scorecard passes.
- `max_rounds` reached.
- `plateau`: score has not improved by ≥ `min_delta` for `patience` rounds.
- `error`: the runner failed twice in a row.

**Defaults** (`beak.config.yaml`):
```yaml
loop:
  max_rounds: 4
  pass_threshold: 85
  min_delta: 3
  patience: 2
  test_inputs: 3
  holdout: 1          # outputs judged, but details hidden from the writer
  judge_samples: 1    # >1 = majority vote per criterion
```

**Guards against known failure modes:**
- *Lenient self-grading:* the judge runs in a fresh process with its own prompt and sees only the rubric, the prompt and the outputs; a pass without an evidence quote counts as a fail. The judge model is selectable per run and may be the same as the tester or a different one.
- *Overfitting to test inputs:* `holdout` inputs are judged, but the writer sees only pass/fail for them, never their content or the judge's detailed feedback.
- *Rubric gaming:* the writer must not edit the library or rubric during a run. `meta.json` stores the library hash, and `finalize` flags any change.
- *Oscillation:* targeted edits only, and the best round wins, not the last.
- *Human steering:* `/refine <run> "notes"` adds the notes as run-only criteria (`rubric_extra.json`); on approve, the user is offered the chance to promote them to the block's Done-when.

---

## 8. Skills

### `beak-intake`
*Description (for triggering):* use when the user adds or updates library content: new customer, industry, tone, scenario, task or context, or phrases like "new customer", "add a tone", "examples are".

Procedure:
1. Classify the block type(s). One message can produce several (a new customer in a new industry gives a customer block plus an industry stub).
2. Run `beak find <name> type=<type>` for each. `exact` → **update** that file. `likely` → ask whether it is the same. Otherwise a new block, with the printed slug as id.
3. Load `library/_templates/<type>.md` (new) or the existing file (update: change only what the user changes).
4. Map the user's text into the sections. Keep **examples verbatim**, labelled Good/Bad if the user says which.
5. Ask at most 3 questions about missing required fields (e.g. `consumer` for tasks, at least one Done-when line), proposing defaults.
6. Never invent facts about a customer. Mark unknowns as `TODO:`.
7. Write each block to `library/_intake/<id>.md` and run `beak save … --check` until it reports no errors. Show the full files and what will happen, save on confirm (`beak save …`) and report the result.

The skill writes block text only. `beak save` decides path, version and date (pi's system prompt has no date), and enforces the two promises deterministically: a new block that looks like an existing one is refused unless the user confirms (`--new`), and an update that changes or drops an existing example is refused unless the user asked for it (`--drop-examples`). Verbatim copying of *new* examples from the user's message cannot be checked by a script (it never sees the chat); the skill states it as rule 1.

Example: "New customer: Acme Pharma, mid-size generics maker, formal German, examples are: [two emails]" creates `customers/acme-pharma.md` (examples verbatim, `industry: pharma`, `default_tone: formal-de`), and creates or updates `industries/pharma.md` if it is missing.

### `beak-compose`
Parse the args, then `beak bundle`, then read `bundle.md`, write round 0 and hand off to `beak-quality-loop`. Prompt-writing house style lives in AGENTS.md (§11).

### `beak-quality-loop`
Exactly §7. The skill text must include the stop rules and the "scripts produce evidence" rule verbatim.

---

## 9. Review, approve, reject

- **/review** reports only and never edits. If the user edits the draft afterwards (by hand or in chat), rerun `beak check` and set `edited_after_loop: true`.
- **/approve** (`beak approve`):
  - destination `out/<consumer>/<task>/<variant>.md`
  - frontmatter: `status: approved`, `version` (+1 if replacing), `approved_at`, `sources`, `score`, `run`, `language`, `runtime_vars`
  - the previous version moves to `_archive/<variant>.v<n>.md`
  - `--golden` sets the task's `golden:` path
  - regenerates `out/<consumer>/index.json`
  - git commit: `beak: approve <consumer>/<task>/<variant> v<n>`
  - asks: "Did you change anything that should become a rule?" Any answer becomes proposed Done-when lines.
- **/reject** (`beak reject`): proposes one Done-when line and the block it belongs in (task vs. tone vs. customer), writes it on confirm with `(learned <date>)`, bumps that block's version, and moves the draft to `drafts/_rejected/` with the reason in its frontmatter.

---

## 10. Output contract for consumer agents

- Stable path: `out/<consumer>/<task>/<variant>.md`. It always holds the latest approved version.
- Consumers read only files with `status: approved`. Older versions live in `_archive/`.
- `out/<consumer>/index.json` lists every prompt with `task`, `variant`, `version`, `language`, `runtime_vars`, `approved_at` and `path`.
- Consumers are declared in `beak.config.yaml`. An unknown consumer is a lint error.
- Consumers may live in other repos. They pull from this repo's `out/` (git submodule, sparse checkout or a raw fetch). See the open questions.

---

## 11. AGENTS.md (runtime house rules). Contents to write

- What Beak is, the folder map and the command list (short).
- **Never** write evidence files (`checks.json`, `judge.json`, `scorecard.*`) or decide loop stops yourself. Run the scripts and obey `beak loop-status`.
- Never edit `library/` during a run. Never approve without the user.
- Prompt house style: explicit Role, Context, Instructions, Constraints, Output format, Examples. Use concrete instructions over adjectives. Keep examples verbatim from the library. Write in the target language. Only `runtime_vars` placeholders are allowed.
- When revising: targeted fixes to the top issues, recorded in `changes.md`.
- When information is missing: ask, or mark `TODO:`. Never invent customer facts.

---

## 12. `beak.config.yaml` (example)

```yaml
models:                      # named choices; each is a pi provider + model id
  glm-5.3:           { provider: openrouter, model: z-ai/glm-5.3 }
  deepseek-v4-flash: { provider: openrouter, model: deepseek/deepseek-v4-flash }
roles:                       # switch a role by changing the name
  tester: glm-5.3            # simulates the consumer agent
  judge:  deepseek-v4-flash  # may be the same model as the tester
# Per run: /compose … tester=<name> judge=<name> (recorded in meta.json).
# The writer is the interactive pi session. Its model is set in .pi/settings.json
# (defaultProvider/defaultModel; enabledModels limits Ctrl+P cycling to the models above).
runner: pi            # pi | fake
consumers: [sales-agent, support-agent]
loop: { max_rounds: 4, pass_threshold: 85, min_delta: 3, patience: 2, test_inputs: 3, holdout: 1, judge_samples: 1 }
paths: { library: library, runs: runs, drafts: drafts, out: out }
git: { commit_on_approve: true, track_runs: false }
```

---

## 13. Milestones and acceptance criteria

Build in this order; each milestone ends with `npm test` green and a commit.

**M0: verify and scaffold** (done 2026-11-06)
- Verify §2, write `docs/pi-notes.md`, adjust the plan where needed.
- Create the layout, `package.json`, `.gitignore` (`runs/`, `node_modules/`), `CLAUDE.md`, `AGENTS.md` (draft), `beak.config.yaml`.
- ✅ `node tools/beak.mjs --help` works.

**M1: block format and lint** (done 2026-11-06)
- `_templates/` for every type, the parser, `beak lint`.
- Example library: 1 task (`cold-email`, consumer `sales-agent`), 1 customer, 2 industries, 2 tones (`formal-de`, `friendly-en`), 2 scenarios.
- ✅ The example library lints clean, and the broken fixtures fail with clear messages.

**M2: intake skill** (built 2026-11-07; the manual smoke test with GLM-5.3 is still open, see `docs/pi-notes.md`)
- `beak-intake` SKILL.md and the `/add` template.
- Added in M2: `beak find` and `beak save` (§6), so that the duplicate check, versioning and the date are decided by scripts, not by the model.
- ✅ Manual pi smoke test: the free-text "New customer… examples are…" produces a lint-clean file with examples verbatim; a second mention of the same customer proposes an update, not a duplicate.

**M3: bundle and compose (round 0)** (done 2026-11-07)
- `beak bundle` with the merging rules (§4) and `rubric.json`; `beak-compose` skill; `/compose`.
- ✅ Unit tests cover merging (union, strictest number, precedence, conflict error); the run folder is created correctly.

**M4: quality loop**
- Runner (`pi` + `fake`), `test`, `check`, `judge` (schema plus retry), `score`, `loop-status`, `finalize`; the `beak-quality-loop` skill; `/refine`.
- ✅ With the fake runner, the scenarios pass→stop, plateau→stop, max_rounds→stop and regression→best-round-wins all behave correctly; holdout details never appear in what the writer sees; manual pi smoke test of one full loop.

**M5: review, approve, reject, routing**
- `/review`, `/approve`, `/reject`, `/beak-status`, archive and versioning, `index.json`, git commit, feedback written into Done-when.
- ✅ Approving twice produces v2 with v1 archived; a reject reason lands in the chosen block with a version bump.

**M6: docs**
- README walkthrough (intake → compose → loop → review → approve), troubleshooting, and how a consumer agent reads `out/`.
- ✅ A newcomer can follow the README end to end.

Optional: a GitHub Action that runs `npm test` on every push.

---

## 14. Open questions (for David)

1. Consumer agent names, and how they read prompts: same repo, or pulled from here (e.g. by other `pecker-*` repos)?
2. ~~Which model should be the judge?~~ **Answered:** OpenRouter, with a pick between GLM-5.3 and DeepSeek V4 Flash. Tester and judge are both selectable, as defaults in `roles:` and per run with `/compose … tester=… judge=…`. They may be the same model or different ones. The shipped default is GLM-5.3 testing and DeepSeek V4 Flash judging. The writer switches with Ctrl+P in pi.
3. Languages: German and English both? Should a prompt's language follow the tone or the customer? (M3 follows the plan's precedence, so the customer wins over the tone, and `beak bundle` warns when they differ.)
4. Which 2–3 real tasks to pilot with (to replace the example library)?
5. Should `runs/` (the full loop evidence) be committed, or kept local only?
6. **Scenario runs have one test input.** A scenario block holds a single `input`, so `/compose … scenario=X` tests on that input alone (no holdout). Default for now; should a scenario hold several inputs (`input` as a list)? That changes the block format.
7. **How context blocks join a run.** Default for now: `context=<id>,<id>` on `/compose`. Alternatives: a task lists its context blocks, or every context block is always included.

---

## 15. TODO (later)

- [ ] **Ralph batch mode** using `@lnilluv/pi-ralph-loop`
  - Batch = **approved golden prompt × a list** (industries, scenarios, customers). Never from scratch.
  - `loops/batch/RALPH.md` with `args` (task, golden, list file), a queue file holding one item per line, and `RALPH_PROGRESS.md` as memory.
  - Each iteration: take the next item, run the existing quality loop (bundle → rounds → finalize) for that variant, tick the item off the queue.
  - Acceptance command: `beak score --gate <run>` (exit code ≠ 0 unless it passes). The completion promise only fires when the queue is empty.
  - Ralph is said to cap a run at 50 iterations (not confirmed in M0: its README documents a configurable `max_iterations`; check when building this). If there is a cap, do several items per iteration or split the work into several runs.
  - Results go to `drafts/batch-<id>/` with `status: needs-review`, followed by a sample review (e.g. 10%) before any bulk approve. **No auto-approve** unless explicitly enabled later.
  - Guardrails: Ralph may write only to `runs/` and `drafts/`; `library/` and `out/` are protected.
- [ ] Optional: `pi-prompt-template-model` for per-command model switching (e.g. a critic model in a chain) if the runner approach proves limiting.
- [ ] Staleness: when a block's version changes, mark approved prompts that used the old version as `stale` and offer to re-run their loop.
- [ ] Score history: a simple report of scores over time per task and variant.
