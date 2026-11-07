---
description: Reject a draft; the reason becomes a Done-when line in the right block
argument-hint: "<draft> <reason>"
---
Draft: $1
Reason: ${@:2}

1. If the draft or the reason is missing, ask for it (`node tools/beak.mjs status` lists the drafts).
2. Read the draft's frontmatter: `sources` lists the blocks it was made from (`id@version`).
3. Turn the reason into one "Done when" line: a single observable criterion a judge can check in an output, e.g. "Asks for at most one thing." Use `[must]` only if the user says it is non-negotiable.
4. Pick the block it belongs in, and say why:
   - the **task**, if every prompt of this task needs it;
   - the **customer**, if it is about this customer only;
   - the **industry**, if it holds for every customer in that industry;
   - the **tone**, if it is about the register or language.
5. Check it: `node tools/beak.mjs reject $1 --reason "<the reason>" --block <id> --line "<criterion>" [--must] --check`. Show the user the proposed line, the block and what will happen, and ask: "Write it?"
6. Yes: run the same command without `--check`. The user wants no rule: run `node tools/beak.mjs reject $1 --reason "<the reason>"`. A different line or block: change it and go back to step 5.
7. Report what it printed. The draft is now in `drafts/_rejected/`; composing the variant again uses the new rule.

Never edit `library/` yourself; `beak reject` writes the line, bumps the block's version and sets the date.
