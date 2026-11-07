---
description: Approve a draft and route it to out/<consumer>/ (only when the user asks)
argument-hint: "<draft> [--golden]"
---
The user asked to approve: ${@:-(no draft named: run `node tools/beak.mjs status`, show the drafts and ask which one)}

1. Run `node tools/beak.mjs approve $@`. It writes `out/<consumer>/<task>/<variant>.md`, archives the previous version, regenerates `index.json` and commits. `--golden` also makes it the task's golden prompt. If it refuses, show the user why and stop.
2. Show the user the lines it printed.
3. Ask: "Did you change anything that should become a rule?" For each rule the user names, propose one "Done when" line: one observable criterion, `[must]` only if the user says it is non-negotiable. Propose the block it belongs in, from the draft's `sources`: the task (every prompt of this task), the customer (only this customer), the industry (every customer in it) or the tone (the register). Show `node tools/beak.mjs learn <block> --line "<criterion>" [--must] --check`, and run it without `--check` once the user confirms.
4. If step 1 listed run-only criteria from /refine (R1, …), offer to turn each into a Done-when line the same way.

Never edit `library/` or `out/` files yourself.
