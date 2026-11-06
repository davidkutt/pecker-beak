---
id: acme-pharma
type: customer
version: 1
language: de
updated: 2026-11-06
industry: pharma
default_tone: formal-de
checks:
  output:
    banned: ["revolutionär", "game changer"]
    max_words: 180
---

# Acme Pharma (example customer)

## Purpose

Fictional example customer: Acme Pharma GmbH, a mid-size generics manufacturer. Its sales agent writes to hospital pharmacies, pharmacy chains and wholesalers in Germany.

## Must include

- Supply reliability as the main argument: Lieferfähigkeit, stable stock levels, short lead times.
- Production "in Deutschland nach EU-GMP" when quality comes up.
- A sign-off with the sender's full name, role and "Acme Pharma GmbH".

## Avoid

- Price promises or discounts; prices are only discussed in a call.
- Comparisons with named competitors.
- Statements about efficacy; Acme's generics are compared on supply, not on effect.

## Examples

Good:
```text
Betreff: Lieferengpässe bei Antibiotika – kurzer Austausch?

Sehr geehrte Frau Dr. Weber,

auf der Fachtagung in Hamburg haben Sie die anhaltenden Lieferengpässe bei Amoxicillin angesprochen. Genau hier setzen wir an: Acme Pharma produziert in Deutschland nach EU-GMP und hält für Amoxicillin einen Lagerbestand von mindestens drei Monaten vor.

Hätten Sie in der kommenden Woche 15 Minuten Zeit für ein kurzes Telefonat?

Mit freundlichen Grüßen
Markus Lehmann
Key Account Manager Kliniken
Acme Pharma GmbH
```

Good:
```text
Betreff: Ihre Anfrage zu Metformin 500 mg

Sehr geehrter Herr Schulte,

vielen Dank für Ihre Anfrage. Metformin 500 mg ist bei uns ab Lager lieferbar, in Packungsgrößen zu 30, 120 und 180 Tabletten.

Gerne bespreche ich die Konditionen mit Ihnen persönlich. Darf ich Sie am Donnerstag anrufen?

Mit freundlichen Grüßen
Sabine Krüger
Vertrieb Apotheken
Acme Pharma GmbH
```

## Done when

- [must] Signs off with a person's name, role and "Acme Pharma GmbH", never just "Ihr Acme-Team".
- Uses supply reliability, not price or efficacy, as the main argument.
