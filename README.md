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

Then edit `beak.config.yaml`: set `provider` for each model to one you have a key for (`pi --list-models glm` shows what's available).

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
