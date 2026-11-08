# pi runtime notes

What Beak relies on in pi, checked against the real thing (plan.md §2, Milestone 0).

- **Verified on:** `@earendil-works/pi-coding-agent` **1.5.0**, Node 22.23, 2026-11-06.
- The old `@mariozechner/pi-coding-agent` (last 0.73.1) is deprecated on npm ("please use @earendil-works/pi-coding-agent instead going forward").
- **Method:** read `pi --help` and the bundled docs (`docs/*.md` in the package), read the relevant source (`dist/core/resource-loader.js`, `dist/core/system-prompt.js`), then ran `pi -p` against a local mock OpenAI-compatible endpoint (a custom provider in `models.json`) that logged every request. Each leak source got a unique marker string (user-level `AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md`, repo `AGENTS.md` / `CLAUDE.md`, `.pi/APPEND_SYSTEM.md`, a `.pi/skills` skill, a `.pi/prompts` template). Then we checked which markers reached the model. No real model was called.

## Assumptions from plan §2

| Assumption | Result | Notes |
|---|---|---|
| pi loads `AGENTS.md` from the working directory | ✅ yes, and more | Also loads it from **every parent directory** and from the user's agent dir (`~/.pi/agent/AGENTS.md`). It loads **without project trust**. Only the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` is read per directory, so pi never sees Beak's `CLAUDE.md` (verified). |
| `.pi/prompts/<name>.md` become `/name` with `$1…`, `$@`, `description` | ✅ yes, needs trust | Also `$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`, and `argument-hint` frontmatter. Only direct `.md` children load. Arguments use shell-like quoting: `/hello key=value "two words"` expands `$@` to `key=value two words`. The quotes are consumed and `$@` re-joins with single spaces. |
| `.pi/skills/<name>/SKILL.md` listed in the system prompt, loaded on demand | ✅ yes, needs trust | Agent Skills format. `name`: lowercase/digits/hyphens, ≤ 64 chars. `description`: ≤ 1024 chars, required (a skill without one is not loaded). Skills are only listed when the `read` (or `bash`) tool is enabled. `/skill:<name> [args]` forces loading. `disable-model-invocation: true` hides a skill from automatic selection. `.agents/skills/` is also discovered (cwd up to the repo root). |
| `pi -p "<msg>"` runs once and exits; `--provider` / `--model` select the model | ✅ yes | Both `--model provider/id` and `--provider X --model id` work. Final assistant text goes to stdout. Exit code 0 on success. Exit code 1 on connection failure (`Connection error.` on stderr) or unknown model (`Model "…" not found`). stdout is empty on failure. |
| A way to replace or append the system prompt for one run | ✅ yes | `--system-prompt <text\|path>` replaces it (a file path is read). `--append-system-prompt <text\|path>` appends and is repeatable. Also `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` (need trust) and `~/.pi/agent/SYSTEM.md` / `APPEND_SYSTEM.md`. |
| `--no-skills` / `--no-extensions` keep Beak's skills and AGENTS.md out | ⚠️ not enough on their own | `AGENTS.md` needs `--no-context-files`. The user's `~/.pi/agent/APPEND_SYSTEM.md` is still appended unless `--append-system-prompt` is passed (an empty string works). See the invocation below. |

## What leaks into a "clean" run

Test-run cwd was `fakerepo/runs/r1` (inside a repo with all markers planted). Requests were captured at the mock endpoint.

| Invocation | What reached the model besides the candidate prompt |
|---|---|
| `pi -p --model … "<input>"` | pi's default coding-agent system prompt, the user's `AGENTS.md` and `APPEND_SYSTEM.md`, the repo `AGENTS.md` (from a parent dir), tools `read,bash,edit,write`, `<cwd>` |
| `+ --no-session --no-context-files --no-skills --no-prompt-templates --no-extensions --no-mcp --no-themes --no-tools --no-approve --system-prompt ./prompt.md` | the user's `APPEND_SYSTEM.md` (as `<addendum>`), `<cwd>` |
| `+ --append-system-prompt ""` | only `<cwd>` |

Things to know:
- **`<cwd>` is always appended** to the system prompt (`<cwd>\n/abs/path\n</cwd>`). Only an extension could remove it. Beak runs test and judge calls from a fresh empty temp directory so this line says nothing about the repo.
- **No `--flag=value` syntax.** `--append-system-prompt=` fails with `Unknown option`. Pass the value as a separate argument. Beak spawns pi with an argv array, so an empty string is just `""`.
- **Piped stdin** becomes the user message (it is prepended to any message arguments). This is the safe way to send multi-line test inputs or inputs starting with `-`. Trailing newlines are trimmed.
- **Project trust** gates `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` and project `.agents/skills`. Print/JSON/RPC modes cannot prompt for trust. Without `--approve` or a saved decision they skip those resources (default `defaultProjectTrust: "ask"`). Context files (`AGENTS.md`) are **not** gated.

## Invocations Beak uses

### Test and judge calls (runner `pi`, M4)

Spawn from a fresh `fs.mkdtempSync(os.tmpdir() + '/beak-')` directory, with the user message on stdin:

```text
pi -p
   --no-session --no-context-files --no-skills --no-prompt-templates
   --no-extensions --no-mcp --no-themes --no-tools --no-approve
   --offline
   --system-prompt <abs path to prompt.md or judge system prompt>
   --append-system-prompt ""
   --provider <models.tester|judge.provider> --model <…model>
```

- `--system-prompt` replaces pi's coding-agent preamble completely. The tool list, rules and docs sections are dropped too.
- `--no-tools`: the simulated consumer and the judge only produce text. They cannot read or change files.
- `--offline`: skips startup network work such as model catalog refreshes. Model calls still go out.
- `--no-approve` and `--no-context-files` are both needed. Trust gates `.pi/`, but not `AGENTS.md`.
- Treat exit code ≠ 0, **empty stdout**, or a `Model "…" not found for provider` warning on stderr as a runner failure (it counts toward the `error` stop rule).
- The argument builder must stay covered by a unit test, so a flag cannot be dropped silently.

### Operator session (interactive)

Run `pi` from the repo root. The first time, pi asks whether to trust the folder. Answer yes, or run `/trust` to save the decision (saved in `~/.pi/agent/trust.json`), or start with `pi --approve`. Without trust, `/compose`, `/add` etc. and the Beak skills do not exist, though `AGENTS.md` still loads. The writer model comes from `.pi/settings.json` (GLM-5.3). Ctrl+P switches to DeepSeek V4 Flash and back. `/model` or `pi --model openrouter/deepseek/deepseek-v4-flash` also work.

## Intake: `/add`, `/skill:` and plain chat (M2)

Checked on pi 1.5.0, 2026-11-07. Method: read `dist/core/prompt-templates.js` (`parseCommandArgs`, `substituteArgs`), `dist/core/agent-session.js` (`_expandSkillCommand`) and `dist/core/skills.js`, then ran `pi -p --approve --no-session --offline --provider mock --model m "<message>"` from a copy of this repo against the request-logging mock endpoint (see "Method" above) and read what reached the model.

| Input | What the model received |
|---|---|
| `/add <text>` | The template with `$@` replaced by the **re-parsed** arguments: `"` and `'` are removed, and outside quotes every run of spaces and line breaks becomes one space. An apostrophe opens a quote that runs to the next `'` or the end. Sent `/add New customer: Globex, a "freight"   firm.⏎Examples are:⏎Hi Sam,⏎thanks!`, received `New customer: Globex, a freight firm. Examples are: Hi Sam, thanks!` |
| `/skill:beak-intake <text>` | The skill body inside `<skill name="…" location="…">References are relative to <skill dir>. …</skill>`, then the text **unchanged** (only trimmed). Quotes, apostrophes, double spaces and line breaks arrived intact. |
| a plain message | Unchanged. `beak-intake` is listed in the system prompt's `<available_skills>` (name, description, absolute path), and the model decides whether to read it. |
| any of these, without trust | `/add` is not expanded (the literal text is sent) and no skill is listed. |

Consequences for Beak:

- **Examples never come through `/add`.** The template says so and tells the model to ask for examples as a plain message. For an explicit, lossless trigger use `/skill:beak-intake <text>`.
- **A skill with invalid YAML frontmatter disappears silently.** An unquoted `description: … "New customer: …" …` is invalid YAML (`: ` inside a plain scalar). In print mode pi gave no warning: the skill was not listed, and `/skill:beak-intake` went through as plain text. pi parses frontmatter with the same `yaml` package Beak uses, so `test/pi-resources.test.mjs` parses every skill and template the same way and checks pi's name and description rules.
- **Skill paths.** pi tells the model that paths in a skill are relative to the skill's folder. Beak's skills say explicitly that their paths are relative to the repo root.
- **No date.** pi's system prompt contains no current date, so the model cannot be trusted with `updated:`. `beak save` sets it (and `version`).

### Manual smoke test (M2 acceptance, needs a real model)

**Not run yet.** The build environment has no OpenRouter key. To run it:

1. Start `pi` from the repo root (trusted folder, writer GLM-5.3).
2. Send as a **plain message** (not `/add`):

   ```text
   New customer: Globex Logistics, a freight forwarder in Hamburg. They write to shippers in English, friendly tone. Examples are:

   Hi Sam,

   it's Jana from Globex – your Rotterdam → Leipzig loads fit our Tuesday "express" run.

   Cheers,
   Jana
   ```

   Expected: it runs `beak find` for the customer, the industry and the tone; asks at most 3 questions; stages `library/_intake/globex-logistics.md` (plus a `logistics` industry stub); runs `beak save … --check`; shows the files; and on "yes" runs `beak save`. Then check that `node tools/beak.mjs lint` has no errors and that the example in `library/customers/globex-logistics.md` is byte for byte what you sent (apostrophe, dash, arrow, quotes, blank lines).
3. Send: `Globex never wants prices in the first email.` Expected: `beak find Globex type=customer` shows `likely: …globex-logistics.md`. It asks whether that is the customer, or says it will update it. It stages an update and saves it as version 2. The example is unchanged.
4. Send `/add New tone: brisk English, short sentences`. It should work without examples. Then send `/add New customer: Initech, example: Hi Bob, it's me`. It should ask for the example again as a plain message.
5. Record the outcome here (date, model, what deviated) and tick M2 in plan §13.

## The runner (M4)

`tools/lib/runner.mjs` builds the test and judge invocation above with `piArgs()`, pinned by `test/runner.test.mjs`. `runPi()` writes the system prompt to `<tmp>/system.md`, runs pi from the empty `<tmp>/cwd/`, sends the user message on stdin and removes the temp dir afterwards. A test drives it against a stand-in `pi` script to check stdin, the empty cwd and every failure case (exit code, empty stdout, the model-not-found warning, a missing binary, a 10-minute timeout).

### Manual smoke test (M4 acceptance, needs a real model)

**Not run yet** (no OpenRouter key in the build environment). To run it:

1. In pi (trusted folder), send `/compose task=cold-email customer=acme-pharma`.
2. Expected: it runs `beak bundle`, reads `bundle.md`, writes `round-0/prompt.md` and `changes.md`, then runs `test`, `check`, `judge`, `score` and `loop-status` for each round, revising only the top issues, until `STOP`, and then `beak finalize`. It never opens `inputs.json`, `judge.json` or `round-N/holdout/`.
3. Check `runs/<run>/round-*/judge.json`: the judge's evidence quotes are verbatim (`evidence_found: true` on passes), and `raw` holds valid JSON. If DeepSeek V4 Flash keeps failing validation, note the reply here.
4. Record the outcome here (date, models, rounds, scores, what deviated) and tick M4 in plan §13.

## Models

Beak uses **OpenRouter** (credentials: `OPENROUTER_API_KEY` or `/login` in pi). There are two models to pick from:

| Name in `beak.config.yaml` | pi provider | pi model id |
|---|---|---|
| `glm-5.3` | `openrouter` | `z-ai/glm-5.3` |
| `deepseek-v4-flash` | `openrouter` | `deepseek/deepseek-v4-flash` |

Verified against the mock endpoint, with pi's built-in `openrouter` provider re-pointed by `models.json` `{"providers":{"openrouter":{"baseUrl":"…"}}}`:

- `--provider openrouter --model deepseek/deepseek-v4-flash` and `--model openrouter/deepseek/deepseek-v4-flash` both send `model: "deepseek/deepseek-v4-flash"` to OpenRouter.
- **Always pass `--provider`.** OpenRouter ids contain a slash. A bare `--model deepseek/deepseek-v4-flash` went to OpenRouter only because no DeepSeek key was set; with `DEEPSEEK_API_KEY` it could resolve to pi's `deepseek` provider instead.
- **A misspelled id is not an error.** pi prints `Warning: Model "…" not found for provider "openrouter". Using custom model id.` on stderr and sends the request anyway. The `pi` runner must treat that warning as a failure.
- Project `.pi/settings.json` sets the interactive session's model. Verified in print mode with `--approve`: `defaultProvider` + `defaultModel` pick the startup model; `--model` on the command line overrides them; `enabledModels` limits startup selection and Ctrl+P cycling. Without trust the file is ignored, and pi falls back to any provider it finds credentials for.
- Other catalog entries if you ever switch: `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4.1-flash`, `~deepseek/deepseek-v4-flash-latest` (alias). GLM-5.3 is also available directly through the `zai` provider and others.

`pi --list-models` only lists providers you have credentials for.

## Packages mentioned in plan §15 (later)

- `@lnilluv/pi-ralph-loop` exists (2.1.2). It is a pi extension (keywords `pi-extension`, `pi-package`; peer dep `@earendil-works/pi-coding-agent >= 0.85.1`). Its README documents `max_iterations`, `completion_promise`, `completion_gate`, `required_outputs` and `guardrails.protected_files` frontmatter. The **50-iteration cap from plan §15 is not confirmed** by the README. Check again when batch mode is built. (Checked in M9: see "Batch mode: the Ralph extension" below. The cap is real.)
- `pi-prompt-template-model` exists (0.12.3), also an extension.

## Batch mode: the Ralph extension (M9)

`@lnilluv/pi-ralph-loop` **2.1.2** with pi 1.5.0, checked 2026-11-08 by reading its README and source (`src/runner.ts`, `src/runner-rpc.ts`, `src/ralph.ts`, `src/index.ts`) and by running it.

What Beak relies on:

- **Iterations:** `max_iterations` is 1–50 (default 50), so the cap in plan §15 is real. `timeout` is 1–3600 s per iteration. `items_per_iteration` (1–20) adds a "[pacing] at most N items" note to each iteration prompt.
- **Each iteration is a fresh child** `pi --mode rpc --no-session --no-extensions -e <ralph>` started with the same pi CLI (`process.argv[1]`), on the session's model (`set_model` with `ctx.model`). It gets no `--approve`, so no project skills, prompt templates or packages, but `AGENTS.md` does load (context files are not trust-gated). That is why `RALPH.md` tells the agent to *read* `.pi/skills/beak-quality-loop/SKILL.md`.
- **`commands`** run before each iteration from the project root (or from the task folder if they start with `./`), and their output goes into `{{ commands.NAME }}`. Inside `run`, only `{{ args.* }}` is resolved, not `{{ ralph.name }}`, so `beak batch create` writes the batch id into the generated `RALPH.md`.
- **Guardrails:** `shell_policy: { mode: allowlist, allow: [...] }` tests every bash call (the agent's and the `commands`) as `^(?:pattern)$`. `protected_files` (minimatch, `matchBase`) blocks the `write` and `edit` tools. Reads are not restricted.
- **Completion:** with `completion_gate: required`, stopping needs the promise, every `required_outputs` file, an `OPEN_QUESTIONS.md` *in the task folder* with no list item under a `P0`/`P1` heading (a missing file blocks), and a passing rerun of each `acceptance: true` command.
- **Progress:** an iteration counts as progress when a file in the task folder changed (`.ralph-runner/` and `RALPH_PROGRESS.md` aside). After iterations without any, the run stops as `no-progress-exhaustion`. `batch.json` lives in the task folder, so every `batch next` / `batch done` counts.
- **Memory:** the agent writes `RALPH_PROGRESS.md` itself (Ralph injects up to 4096 characters of it), so the task folder cannot be protected as a whole.

### Smoke test of the generated RALPH.md

Scratch copy of the repo, a one-item batch from `beak batch create` (`max_iterations` set to 1 by hand), `pi -p --approve --no-session -e npm:@lnilluv/pi-ralph-loop@2.1.2 --provider openrouter --model z-ai/glm-5.3 "/ralph --path runs/batches/<id>" < /dev/null`, with pi's `openrouter` provider re-pointed at a scripted mock that answers the iteration prompt with fixed tool calls. (Without `< /dev/null`, a backgrounded `pi -p` waits for stdin forever.)

| Mock's tool call | Result |
|---|---|
| bash `node tools/beak.mjs batch next <id>` | ran: item started, run bundled, `batch.json` changed; Ralph logged `progress: true, changedFiles: ["batch.json"]` |
| bash `cat library/tasks/cold-email.md; rm -rf library` | `ralph: blocked (shell_policy.allowlist)` |
| write `library/tasks/evil.md` | `ralph: library/tasks/evil.md is protected` |
| write `runs/batches/<id>/RALPH_PROGRESS.md` | written |

- Ralph parsed the frontmatter as generated: `status.json` showed the allowlist and all protected patterns. The iteration prompt contained the queue from `{{ commands.queue }}`, and the child ran on `z-ai/glm-5.3` with the tools read, bash, edit and write.
- **Promise too early:** a mock that answers `<promise>BATCH_DONE</promise>` while the item was still running. Ralph reran `batch gate` (exit 1, "not complete: … 1 running"), recorded `gateBlocked: true, blockingReasons: ["Acceptance command failed: gate (error)"]` and did not stop as complete.
- **Promise after the queue is done:** the item finished (`batch done`), then the same mock. Gate `ok` ("complete: 1 of 1 items finished"), and Ralph's status was **`complete`**.
- **Project package:** `.pi/settings.json` `packages: [{ "source": "npm:@lnilluv/pi-ralph-loop@2.1.2", "skills": [] }]`. With `--approve`, pi installed it on start, and `/ralph-list` was handled by the extension (no model request). The system prompt listed only Beak's skills (Ralph's `ralph-loop` / `ralph-draft` stay off). `pi list` without trust shows "No packages installed": project declarations are read only after trust.
- **Not verified:** a real model working through a real batch (it needs an OpenRouter key). Run `/batch create …`, then `/ralph --path runs/batches/<id>`, and watch `beak batch status <id>`.

## Re-verifying after a pi upgrade

1. `pi --version` and `pi --help`. Check that the flags in the invocation above still exist.
2. Point a custom provider at a local endpoint that logs request bodies (`models.json`: `"api": "openai-completions"`, any `apiKey`). Plant a marker string in each context source listed under "Method". Run the test-call invocation from a subdirectory of the repo, and confirm that only the candidate prompt and `<cwd>` reach the endpoint.
3. Update this file and the version at the top.
