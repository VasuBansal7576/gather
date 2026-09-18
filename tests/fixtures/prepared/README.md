# Prepared fixture scenarios (ADR-001 / C01)

These JSON files are the reviewed, fictional input fixtures for the prepared
product path. The executable copies live in `src/server/demo-fixtures.ts`
(`PREPARED_SCENARIOS`); `tests/setup-prepared.test.ts` asserts the two stay in
exact agreement, so a fixture edit here without a matching code change fails
tests instead of drifting silently.

- `glasshouse.json` — the inquiry-first reference business: six inbox
  messages (three event inquiries — one complete, one missing a date, one
  with conflicting dates — plus an invoice, a newsletter and a vendor pitch),
  two independently seeded busy calendar blocks, zero prebuilt offers, and
  the fictional owner-confirmed commercial facts (exclusive room, capacity
  100, $50/guest 4-hour package, $1,000 minimum, no concessions, no extra
  taxes/fees, 30-minute setup/teardown either side).
- `empty.json` — connected inbox with nothing in it.
- `non-event.json` — inbox containing only non-event mail.
- `partial.json` — an honestly labelled partial import (some messages and
  some facts, coverage `partial`).
- `connection-failed.json` — the first scan failed; nothing imported.

`legacy` is named in code for the preserved two-proposal regression seed and
intentionally has no JSON file here: it is not a product scenario.

All data is fictional (`*.example.test` addresses, `demo://` provenance) and
must stay labelled DEMO ONLY / simulated. The demo clock anchor is
`2026-10-01T12:00:00.000Z`; fixture dates are fixed relative to it.
