# Building Beak: instructions for Claude Code

This repo is **Beak**: a prompt-writing harness that runs inside the pi coding agent. `plan.md` is the source of truth for what to build. You build Beak; pi (main model GLM-5.3) operates it.

## Two instruction files, two audiences

- `CLAUDE.md` (this file) is about **building** Beak. pi never reads it: pi loads only the first of `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` per directory, and `AGENTS.md` exists (verified, `docs/pi-notes.md`).
- `AGENTS.md` holds the **runtime** house rules for pi (plan §11). Keep it operator-facing and short. No build instructions there, and no runtime rules here.

## How to work

- Build milestones in order (plan §13). Each one ends with `npm test` green and a commit.
- When reality differs from the plan, update `plan.md` in the same commit. Record pi-specific evidence in `docs/pi-notes.md`.
- When a command gets built, remove its `milestone` field in `tools/beak.mjs` and give it a `run`.
- Open questions for David are in plan §14. Don't silently decide them. Pick a reversible default and say so.

## Code conventions

- Node ≥ 22, plain ESM `.mjs`, no build step, no TypeScript, no pi extensions (v1).
- Dependencies: `yaml`, plus `ajv` if JSON-schema validation needs it. Ask before adding anything else.
- `tools/beak.mjs` is a thin CLI. Logic lives in `tools/lib/*.mjs`, as pure functions where possible, so it can be tested without spawning processes.
- Exit codes: `0` ok, `1` failure, `2` usage error. Errors go to stderr; machine-readable results go to stdout.
- Find the repo root with `findRoot()` from `tools/lib/config.mjs`, so commands work from any subdirectory. Load config with `loadConfig()`. Never re-parse `beak.config.yaml` ad hoc.
- Anything that decides (merging, checks, scores, stop rules, best round, versioning) lives in scripts, never in skills or prompt templates. Scripts write evidence files; the LLM writes only `prompt.md` and `changes.md`.
- Deterministic output: stable key order in JSON, sorted file listings, no timestamps except where the plan asks (run ids, `approved_at`, `updated`).

## Tests

- `npm test` runs `node:test` over `test/**/*.test.mjs`.
- Tests never call a real model or the network. Use the `fake` runner (`BEAK_RUNNER=fake`) and canned outputs in `test/fixtures/`.
- Tests that write files use a temp dir (`fs.mkdtempSync(path.join(os.tmpdir(), 'beak-…'))`). Never write to the repo's `library/`, `runs/`, `drafts/` or `out/`.
- Every bug fix gets a regression test.

## pi runner invariants (from `docs/pi-notes.md`)

Test and judge calls must not see Beak's `AGENTS.md`, skills, prompt templates or the user's pi config. On pi 1.5.0 that takes all of these flags. Keep them covered by a unit test of the argument builder:

`-p --no-session --no-context-files --no-skills --no-prompt-templates --no-extensions --no-mcp --no-themes --no-tools --no-approve --offline --system-prompt <file> --append-system-prompt "" --provider <p> --model <m>`

Also: spawn with an argv array (pi has no `--flag=value` syntax), run from a fresh temp cwd (pi always appends `<cwd>`), send the user message on stdin, and treat a non-zero exit **or** empty stdout as a runner failure.

## Repo hygiene

- `runs/` and `node_modules/` are gitignored (`git.track_runs: false`; see plan §14 Q5).
- Empty layout directories carry a `.gitkeep`. Remove it once the directory has real content.
- Commit messages: imperative, mention the milestone (e.g. `M1: add block parser and beak lint`).
