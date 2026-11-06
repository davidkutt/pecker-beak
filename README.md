# Beak

Beak is a harness that writes prompts. The tasks repeat; the context changes each time: customers, industries, scenarios, tones. Beak keeps those as small, versioned building blocks. It composes them into a prompt and improves the prompt in a quality loop (test → judge → revise). A human approves the result, and Beak routes it to the agent that uses it (`out/<consumer>/`).

One great prompt beats 100 mediocre ones.

**Status:** Milestone 0 (scaffold). The CLI and config exist; the commands are being built milestone by milestone (see [`plan.md`](plan.md) §13). A full walkthrough will follow in M6.

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

Tester and judge can be the same model or different ones. For a single run, pick them on the command: `/compose task=cold-email … tester=deepseek-v4-flash judge=deepseek-v4-flash` (available once compose is built in M3). The run records its models, so `/refine` keeps using them.

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
