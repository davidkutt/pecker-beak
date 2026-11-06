---
id: cold-email
type: task
version: 1
updated: 2026-11-06
consumer: sales-agent
output_format: [Role, Context, Instructions, Constraints, Output format, Examples]
test_inputs:
  - cold-first-contact
  - trade-fair-follow-up
  - id: sparse-lead-data
    input: |
      Lead: Jonas Berg, purchasing, Apotheke am Markt (Leipzig).
      No other information.
runtime_vars: [sender_name, sender_role]
default_tone: friendly-en
checks:
  output:
    max_words: 200
    banned: ["I hope this email finds you well", "Ich hoffe, diese E-Mail erreicht Sie"]
---

# Cold email

## Purpose

The generated prompt makes the sales agent write a first email to a lead it has not worked with before. The email should earn a reply, not close a deal.

## Must include

- A subject line on the first line, written as `Subject: …` (or `Betreff: …` in German).
- One concrete detail from the lead information in the input, and why it matters to this lead.
- What the sender's company offers, in one or two sentences, tied to that detail.
- Exactly one call to action with a small, concrete next step (for example a 15-minute call).
- A sign-off with the sender's name and role.

## Avoid

- Facts about the lead that are not in the input.
- More than one question or call to action.
- Attachments, links or prices unless the input mentions them.
- Opening with the sender's company instead of the lead.

## Examples

Bad:
```text
Subject: Quick question

Hi there, I hope this email finds you well! We are the leading provider of innovative solutions. Can we set up a call, and could you also send me your current supplier list?
```

## Done when

- [must] The first line is a subject line ("Subject:" or "Betreff:").
- [must] The email contains exactly one call to action.
- [must] It states no facts about the lead or their organisation beyond the input.
- It refers to at least one specific detail from the input.
- The sign-off uses the sender's name and role.
