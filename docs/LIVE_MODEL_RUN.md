# Live-model booking-proposal execution (wired, gated)

The existing developer runner exposes four scoped Gather tools to a model through the isolated OpenClaw runtime. It reads designated inquiry/policy/calendar sources and persists a pending proposal. It does not provide completed customer onboarding, approve the proposal, send an offer, or prove a confirmed booking.

## Live capability gate (ADR-006)

`GET /api/live-model/status?profile=base` reports the owner-visible gate:
the `IntegrationProfile` (`src/integrations/registry.ts` — base plus the
specified-only AssemblyAI/Amazon/Nebius profiles consumed by event ADRs in
016), per-capability results, and the exact missing evidence. Without
operator-supplied accounts/credentials the report is explicitly BLOCKED —
never passed — and no fixture is injected into the empty-account path:

- pinned runtime harness (`GATHER_TEST_OPENCLAW_BIN`, presence only; never
  booted or discovered implicitly; `~/.openclaw` is never touched),
- native knowledge cutover (prepared simulator does not authorize live facts),
- Google provider configuration plus a connected authorized account,
- supported model access (`GATHER_MODEL_PROFILE_ID` / `GATHER_LIVE_CONSENT`),
- restricted test recipient (`GATHER_TEST_RECIPIENT`),
- acceptance signing key (`GATHER_ACCEPTANCE_KEY`).

The setup page's live card renders these blocked reasons and stays disabled
until the gate passes. Prepared mode remains fully usable either way.

## Deferred 011 inbound acceptance callback (ADR-006)

`src/server/live-model/acceptance-callback.ts` composes the reviewed
`processAcceptanceReply` with the delivery token store, the durable
current-proposal pointer, and the persisted email provider receipt as the
original offer-send proof. Runtime composition wires it into the proactive
bootstrap behind the same live gate: live sweeps validate token replies
before the new-inquiry gate; prepared installs wire nothing. Fail-closed:
no token → ignored; no keyring → ignored; missing send receipt or
non-live transport → review, never acceptance.

## Durable intent progress on long-running routes (ADR-006)

`POST /api/bookings/:id/approve` and `POST /api/executions/:id/reconcile`
accept an opt-in `{ intent: true }` body flag that commits the exact
command as a durable intent and returns `202 { intentId, intent }` for
persisted progress via `GET /api/intents/:id`. Authority and error mapping
are identical to the synchronous path (enqueue validates the exact version
first); without the flag both routes behave byte-identically to before.

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
  duplicates. Idempotency keys name one exact designated journey:
  same key + same inputs replays or resumes (gateway key stable per
  key, no duplicate provider run), same key + changed inputs rejects,
  concurrent duplicates collapse onto the winner's claimed run.
- `tools.ts` — policy enforcement reused by the handlers (exact
  arithmetic, capacity, same-run attested free slot; violations reject
  pre-write). Proposal payloads name the controlled test recipient
  (`GATHER_TEST_RECIPIENT`) server-side and stay `pending_approval`.
- `app/api/live-model/run/route.ts` — owner same-origin entry with
  typed codes; `scripts/gather-live-model.mjs` — run command below.

Authority: no approve/send/claim tool exists; owner UI approves only;
receipts come solely from provider dispatch after approval.

## Exact commands

Scripted MCP regression (no live requests of any kind):

```
node --experimental-strip-types --test tests/live-model-execution.test.ts
```

## Developer-only live invocation

Do not run this during default checks. It requires a separately authorized test account, configured Google connection and calendar binding, a Gather-owned runtime root with OAuth credentials, and an explicit model profile. The supported model is currently `openai/gpt-5.6-luna`; `--model` and `--auth-profile` are not CLI options.

After those prerequisites have been established outside this cleanup:

```sh
GATHER_LIVE_CONSENT=1 \
GATHER_MODEL_PROFILE_ID='<configured-profile-id>' \
GATHER_TEST_RECIPIENT='<authorized-test-recipient>' \
GATHER_DATABASE_PATH='.runtime/live-test.sqlite' \
node --experimental-strip-types scripts/gather-live-model.mjs \
  --business '<business-id>' --thread '<thread-id>' \
  --file '<drive-file-id>' --calendar '<calendar-id>' \
  --root '.runtime/isolated-live-runtime' --allow-live
```

Do not copy personal runtime credentials or assume a fresh root has a model login. The runner's gate refusing a run is not proof that all onboarding prerequisites have been tested. A returned proposal still requires exact approval and independent provider verification before external outcomes can be claimed.

## Scripted fixtures

`tests/fixtures/live-model/` contains versioned, fictional `inquiry.txt` and `venue-policy.md`: 12 guests, 18 September 2026 from 18:00–20:00 Europe/London, two vegetarian meals, GBP 650 budget, GBP 50/person and 20-seat capacity. The scripted planner requests 12 guests and the handler computes GBP 600. This tests the controlled tool/handler path, not free-text understanding by a real model.

The suite does not depend on shared `/tmp` input files or local account content. Temporary databases and server state are created per test and cleaned up by that test.
