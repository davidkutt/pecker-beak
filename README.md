# Beak

Beak is a harness that writes prompts. The tasks repeat; the context changes each time: customers, industries, scenarios, tones. Beak keeps those as small, versioned building blocks. It composes them into a prompt and improves the prompt in a quality loop (test → judge → revise). A human approves the result, and Beak routes it to the agent that uses it (`out/<consumer>/`).

One great prompt beats 100 mediocre ones.

**Status:** Milestone 5. Every command works: intake, compose, the quality loop, review, approve, reject and routing to `out/`. A full walkthrough follows in M6.

## The library

`library/` holds the building blocks: `tasks/`, `customers/`, `industries/`, `tones/`, `scenarios/` and `context/`. Each block is a Markdown file with YAML frontmatter and five sections (Purpose, Must include, Avoid, Examples, Done when). Blank templates are in `library/_templates/`; the format is described in `plan.md` §4.

```bash
node tools/beak.mjs lint
```

The library that ships is an example (a fictional customer, Acme Pharma). It will be replaced by real pilot tasks.

### Adding to the library (intake)

In pi, describe what you want to add in a normal message:

```text
New customer: Globex Logistics, a freight forwarder in Hamburg. They write to shippers in English, friendly tone. Examples are:

Hi Sam,
...
```

The `beak-intake` skill turns that into block files. It checks for an existing block first (`beak find`), so a customer you mention again gets updated instead of duplicated. It asks at most three questions, stages the files in `library/_intake/`, shows them to you, and saves them when you say yes (`beak save`). `beak save` sets the version and date, lints the result, and refuses to change an existing example unless you asked for it.

Paste examples in a **normal message**. `/add <text>` works for short requests, but pi strips quotes and line breaks from slash-command arguments, so Beak never takes examples from `/add` text. `/skill:beak-intake <text>` passes text through unchanged.

The scripts also work by hand:

```bash
node tools/beak.mjs find Acme Pharma type=customer       # is there a block like this?
node tools/beak.mjs save library/_intake/acme-pharma.md --check
```

## Requirements

- Node ≥ 22
- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`, verified with 1.5.0), with credentials for the models in `beak.config.yaml`

## Setup

```bash
npm install
```

```bash
node tools/beak.mjs --help
```

Beak calls models through OpenRouter. Give pi your key, either as `OPENROUTER_API_KEY` or with `/login` inside pi.

### Picking a model

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

## Operating Beak in pi

Run `pi` from the repo root. The first time, pi asks whether to trust the folder. Say yes, or start with `pi --approve`. Beak's slash commands (`.pi/prompts/`) and skills (`.pi/skills/`) only load in a trusted folder. `AGENTS.md` holds the rules pi follows here.

## Development

```bash
npm test
```

- `plan.md`: what Beak is and how it is built
- `CLAUDE.md`: conventions for building Beak
- `AGENTS.md`: runtime rules for pi
- `docs/pi-notes.md`: how pi actually behaves (verified), including how test runs are isolated
