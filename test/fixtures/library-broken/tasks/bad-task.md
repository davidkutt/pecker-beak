---
id: bad-task
type: task
version: 1
updated: 2026-11-06
consumer: marketing-agent
output_format: []
test_inputs:
  - missing-scenario
  - { id: inline-one }
default_tone: ok-tone
golden: out/sales-agent/bad-task/nowhere.md
runtime_vars: [Lead-Name]
checks:
  output:
    max_words: 100
    min_words: 300
    banned: "not a list"
    maxwords: 3
  style:
    loud: true
---

## Purpose

A task with broken fields.

## Must include

## Avoid

## Examples

## Done when
