---
description: Drafts waiting for review, recent runs and their scores, approved prompts
---
Run `node tools/beak.mjs status` and show the user what it printed.

Then suggest the obvious next step, if there is one: `/review <draft>` for a draft waiting for review, finishing a run that is still in progress (`node tools/beak.mjs loop-status <run>`), or `beak finalize <run>` for a stopped run that was never finalized. Do not start anything without the user.
