---
id: "TODO: slug, same as the filename (e.g. cold-email)"
type: task
version: 1
updated: "TODO: YYYY-MM-DD"
consumer: "TODO: agent name from beak.config.yaml consumers"
output_format:            # the sections the generated prompt must have, in order
  - Role
  - Context
  - Instructions
  - Constraints
  - Output format
  - Examples
test_inputs:              # scenario ids, or inline entries: { id: short-slug, input: "…" }
  - "TODO: scenario id"
runtime_vars: []          # placeholders the consumer fills at runtime, e.g. [sender_name]
# default_tone: tone id used when neither customer nor run names one
# golden: path to the approved reference prompt (set by `beak approve --golden`)
# language: de            # optional; usually comes from the customer or tone
checks:
  output:                 # checked on what the consumer agent writes
    banned: []
    required_phrases: []
    # max_words: 180
  prompt:                 # checked on the generated prompt itself
    required_sections: []
---

# TODO: task name

## Purpose

TODO: 1–3 sentences: what the generated prompt must make the consumer agent do.

## Must include

TODO: what every output of this task contains.

## Avoid

TODO: what outputs of this task must never do.

## Examples

Good:
```text
TODO: a verbatim example of a good output
```

Bad:
```text
TODO: a verbatim example of a bad output
```

## Done when

- [must] TODO: an observable criterion that blocks approval when it fails
- TODO: an observable criterion
