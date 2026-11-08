---
description: Compose a prompt from library blocks and improve it in the quality loop
argument-hint: "task=<id> [customer=<id>] [industry=<id>] [tone=<id>] [scenario=<id>] [tester=<model>] [judge=<model>]"
skill: beak-compose
---
Follow the beak-compose skill with these arguments. (pi-prompt-template-model puts the skill above; if it is not there, read .pi/skills/beak-compose/SKILL.md first.)

Arguments: $@

If there are no arguments, ask the user which task to compose, and for whom.

Pass the key=value arguments to `node tools/beak.mjs bundle` unchanged.
