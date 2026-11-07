---
description: Add or update Beak library content (customer, industry, tone, scenario, task, context)
argument-hint: "<what to add, e.g. New customer: Acme Pharma, generics maker, formal German>"
---
Read the beak-intake skill (.pi/skills/beak-intake/SKILL.md) and follow it for this request:

${@:-(no text given: ask the user what to add)}

This text came through the /add command, so pi removed its quote characters and line breaks. Use it to see what the user wants, but never copy examples from it: if it contains examples, ask the user to paste them again as a normal message, without /add in front.
