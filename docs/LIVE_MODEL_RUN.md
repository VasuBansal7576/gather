# Live-model booking-proposal journey (scaffold, not live)

Smallest REAL path from an OpenClaw model through Gather tools to a
Google booking proposal — currently runnable scripted end to end, with
live execution honestly closed until its three external gates land.

## What is built (`src/server/live-model/`)

- `tools.ts` — four narrowly bound tools over already-resolved provider
  ports: `readInquiry` (designated Gmail thread), `readVenuePolicy`
  (designated Drive file), `checkAvailability` (owner-bound calendar),
  `prepareProposal` (exact terms + evidence into booking + `send_offer`
  action, `pending_approval`). No approve/send/claim tool exists.
- `controller.ts` — one business, one verified account, one run id;
  Gmail/Drive/calendar ports must agree on the business or the run
  refuses. Policy is enforced before any row: exact per-person
  arithmetic, capacity, and a free slot attested in the same run.
- `index.ts` — integration hook (`runLiveModelJourney`, `getLiveRun`).
- `app/api/live-model/run/route.ts` — owner same-origin entry; typed
  codes (MODEL_UNCONFIGURED 503, LIVE_NOT_AUTHORIZED 409,
  POLICY_VIOLATION 422, TOOL_FAILURE 502).

Authority: the model only interprets terms. It cannot approve (owner
UI `approveAndExecute` does), cannot override policy (violations reject
pre-write), cannot claim receipts (payloads carry evidence only;
receipts come from provider dispatch after approval).

## Exact run command

Scripted verification (this is what CI runs):

```
node --experimental-strip-types --test tests/live-model-journey.test.ts
```

Live attempt (refuses honestly until the gates land):

```
node --experimental-strip-types scripts/gather-live-model.mjs \
  --business <businessId> --thread <threadId> \
  --file <driveFileId> --calendar <calendarId> [--allow-live]
```

## Test facts (explicitly FICTIONAL, reused — never regenerated)

`/tmp/gather-live-test-seed/`: `inquiry.txt` (12 guests,
2026-09-18 18:00–20:00 Europe/London, vegetarian x2, budget GBP 650),
`venue-policy.md` (GBP 50/person, 20 seated, GATHER TEST rules),
`manifest.json` (`prepared locally; not uploaded or sent`). The
scripted transports serve exactly these contents; the journey derives
the exact GBP 600 total from them.

## Remaining before any live outcome (no overall completion claimed)

1. **I — authorized model auth path**: no term interpreter is
   configured, so every live-capable run ends MODEL_UNCONFIGURED.
2. **Chief — designated account + controlled recipient**: live gate
   additionally requires the connected account and
   `GATHER_LIVE_RECIPIENT`; nothing sends or reads live data meanwhile.
3. **Dependencies**: provider 85027c8 accepted; scheduler bbc residual
   fix, runtime 497 spawn fix, and proposal 4402 fix still pending
   elsewhere — this module uses only preserved public contracts and
   store primitives, and the route/script above are the only new
   surfaces.
