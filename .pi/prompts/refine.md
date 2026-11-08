---
description: More quality-loop rounds on a stopped run; your notes become a criterion for that run
argument-hint: "<run-id> [notes]"
skill: beak-quality-loop
---
Follow the "/refine" section of the beak-quality-loop skill. (pi-prompt-template-model puts the skill above; if it is not there, read .pi/skills/beak-quality-loop/SKILL.md first.)

Run: $1
Notes: ${@:2}

Run `node tools/beak.mjs refine $1 <notes>` with the notes as plain words (they become one run-only [must] criterion; leave them out if there are none), then `node tools/beak.mjs loop-status $1`, and continue the loop until it says STOP. If no run id was given, ask the user which run (the run ids are the folder names in runs/).
