---
description: Compose a prompt from library blocks and improve it in the quality loop
argument-hint: "task=<id> [customer=<id>] [industry=<id>] [tone=<id>] [scenario=<id>] [tester=<model>] [judge=<model>]"
---
Read the beak-compose skill (.pi/skills/beak-compose/SKILL.md) and follow it with these arguments:

${@:-(no arguments given: ask the user which task to compose, and for whom)}

Pass the key=value arguments to `node tools/beak.mjs bundle` unchanged.
