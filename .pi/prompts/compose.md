---
description: Compose a prompt from library blocks (bundle, round 0, quality loop)
argument-hint: "task=… [customer=…] [industry=…] [tone=…] [scenario=…] [context=…] [tester=…] [judge=…]"
---
Read the beak-compose skill (.pi/skills/beak-compose/SKILL.md) and follow it with these arguments:

${@:-(none given: ask the user which task, and which customer or industry)}

Pass the key=value arguments to `node tools/beak.mjs bundle` unchanged; the script parses and checks them.
