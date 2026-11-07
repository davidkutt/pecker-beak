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

## Compose: `/compose` (M3)

Checked on pi 1.5.0, 2026-11-07, with the same mock setup. `/compose task=cold-email customer=acme-pharma tester=deepseek-v4-flash` reached the model as the template with exactly those three `key=value` tokens. Slugs have no quotes or spaces, so pi's argument parsing leaves them alone. Both `beak-compose` and `beak-intake` were listed in `<available_skills>`. Writing round 0 itself needs a real model; it is part of the M4 smoke test (one full loop).

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

- `@lnilluv/pi-ralph-loop` exists (2.1.2). It is a pi extension (keywords `pi-extension`, `pi-package`; peer dep `@earendil-works/pi-coding-agent >= 0.85.1`). Its README documents `max_iterations`, `completion_promise`, `completion_gate`, `required_outputs` and `guardrails.protected_files` frontmatter. The **50-iteration cap from plan §15 is not confirmed** by the README. Check again when batch mode is built.
- `pi-prompt-template-model` exists (0.12.3), also an extension.

## Re-verifying after a pi upgrade

1. `pi --version` and `pi --help`. Check that the flags in the invocation above still exist.
2. Point a custom provider at a local endpoint that logs request bodies (`models.json`: `"api": "openai-completions"`, any `apiKey`). Plant a marker string in each context source listed under "Method". Run the test-call invocation from a subdirectory of the repo, and confirm that only the candidate prompt and `<cwd>` reach the endpoint.
3. Update this file and the version at the top.
