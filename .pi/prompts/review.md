---
description: Report on a draft waiting for review (report only, changes nothing)
argument-hint: "[draft]"
---
Run `node tools/beak.mjs review $@` and show the user its report as it is.

This is a report only: do not edit the draft, the run or the library, and do not approve or reject anything. If the report lists several drafts, ask which one to review.

Afterwards the user may edit the draft (by hand, or by asking you in chat). Edit only `drafts/<task>/<variant>.md`, only the prompt below its frontmatter, and only what the user asked for. Then run `node tools/beak.mjs review <draft>` again: it reruns the prompt's hard checks on the edited draft, and `beak approve` records `edited_after_loop: true`.
