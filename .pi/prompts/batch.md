---
description: Batch mode (one approved golden prompt × a list) - create, status, review, approve
argument-hint: "create task=<id> <key>=@<file>|<a,b> [key=value…] | status|review|approve <batch>"
---
Run `node tools/beak.mjs batch $@` and show the user what it printed.

- After `create`: the user starts the batch themselves with `/ralph --path runs/batches/<batch-id>` (a pi command of the Ralph extension, not a shell command). Do not run `batch next`, `batch done` or any round yourself here: the Ralph iterations do that.
- After `review`: offer `/review` for each sampled draft, then `/approve` or `/reject` it on the user's word. FAIL drafts are always reviewed one by one.
- Run `batch approve` only when the user asked for exactly that batch. If it refuses, show why; never work around it.
