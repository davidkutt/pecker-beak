---
description: Add or update Beak library content (customer, industry, tone, scenario, task, context)
argument-hint: "<what to add, e.g. New customer: Acme Pharma, generics maker, formal German>"
skill: beak-intake
---
Follow the beak-intake skill for this request. (pi-prompt-template-model puts the skill above; if it is not there, read .pi/skills/beak-intake/SKILL.md first.)

Request: $@

If the request is empty, ask the user what to add.

This text came through the /add command, so pi removed its quote characters and line breaks. Use it to see what the user wants, but never copy examples from it: if it contains examples, ask the user to paste them again as a normal message, without /add in front.
