# Live-model booking-proposal execution (wired, gated)

The model drives the journey by CALLING four registered Gather MCP
tools — reads and proposal assembly happen inside tool handlers
against server-side designated sources, never in a hardcoded pipeline
(the ed7c68c pipeline was replaced; its history stays in git for G's
review). N's exact model-config commit is consumed (cherry-picked):
the runner carries an explicit `GatherModelSelection` through
`modelStatus()`/`requireModelSelection()` with no fallback model.

## What is wired (`src/server/live-model/`)

- `mcp-tools.ts` — `gather.read_inquiry`, `gather.read_venue_policy`,
  `gather.check_availability`, `gather.prepare_proposal` via
  `defineGatherTool`. Identity (business, account, thread, file,
  calendar, recipient) is server-side run scope only; tool arguments
  carry non-identity content alone, so the model cannot forge
  provenance, redirect sources, or choose recipients.
- `execution.ts` — `startScopedExecutionHost` (real
  GatherOpenClawRuntime constructed with the model + tools, loopback
  MCP boundary; close reaps everything owned) and `runLiveExecution`:
  live-gate, port resolution with cross-business refusal, MCP tool
  listing check, planner-driven tool calls over a real MCP client,
  submit/wait/history on the injected tasks channel, durable run
  record + per-call tool audit, timeout → `continuing` run id without
  duplicates, idempotent caller keys (gateway key stable per key).
- `tools.ts` — policy enforcement reused by the handlers (exact
  arithmetic, capacity, same-run attested free slot; violations reject
  pre-write). Proposal payloads name the controlled test recipient
  (`work.vasu.ai@gmail.com`) server-side and stay `pending_approval`.
- `app/api/live-model/run/route.ts` — owner same-origin entry with
  typed codes; `scripts/gather-live-model.mjs` — run command below.

Authority: no approve/send/claim tool exists; owner UI approves only;
receipts come solely from provider dispatch after approval.

## Exact commands

Scripted MCP regression (no live requests of any kind):

```
node --experimental-strip-types --test tests/live-model-execution.test.ts
```

Live attempt (refuses honestly until consent, designation, and the
authorized model path land):

```
node --experimental-strip-types scripts/gather-live-model.mjs \
  --business <businessId> --thread <threadId> \
  --file <driveFileId> --calendar <calendarId> \
  --model openai-codex/gpt-5.6-luna --auth-profile <profileId> \
  [--allow-live] [--idempotency-key <key>]
```

## Test facts (explicitly FICTIONAL, reused — never regenerated)

`/tmp/gather-live-test-seed/`: `inquiry.txt` (12 guests,
2026-09-18 18:00–20:00 Europe/London, vegetarian x2, budget GBP 650),
`venue-policy.md` (GBP 50/person, 20 seated, GATHER TEST rules),
`manifest.json` (`prepared locally; not uploaded or sent`). Scripted
transports serve exactly these contents; the journey derives the exact
GBP 600 total from them.

## Remaining before any live outcome (no overall completion claimed)

1. **Astra start handoff + consent**: no live Google/model requests
   until then (`GATHER_LIVE_CONSENT` + `allowLive` gate).
2. **I — authorized Codex OAuth** under `main/.runtime/openclaw-live`
   and the exact Luna auth profile (root/config untouched meanwhile);
   model-driven (non-scripted) tool calling wires up with that path.
3. **Dependencies**: provider 85027c8 accepted; scheduler bbc
   residual, runtime 497 spawn, and proposal 4402 fixes still pending
   elsewhere — this module uses only preserved public contracts, and
   the runtime here is constructed, never spawned.
