# Connector boundaries

This package defines the provider-neutral boundary between Gather and connected business applications.

The implementation in `src/connectors/demo.ts` is an injected, deterministic in-memory simulator.
It is not a live integration and must not be presented as one.

## Mode and provenance

Every demo result carries `metadata.mode.mode = "demo"`, `metadata.mode.label = "DEMO ONLY"`, `metadata.mode.fictional = true`, and `metadata.simulated = true`.
Demo source references are marked fictional and use fixture locators.
Document and inquiry results repeat their source references as `provenance` so downstream proposal and evidence code can preserve the origin of facts.

The connector source shape is structurally compatible with the foundation `SourceReference` contract.
The connector package does not import provider SDK types or mutate the foundation domain contracts.

## Stable operation keys

`stableOperationKey` creates a deterministic key from a connector, operation name, and sorted semantic identity fields.
The resulting key is safe to persist as the foundation action execution `idempotencyKey`.
Callers must generate it from the logical action identity and reuse the exact value across retries and reconciliation.

The demo write adapters store successful results by operation key.
Repeating the same key and payload returns the original result without duplicating the send or hold.
Reusing a key with a different payload returns a conflict.

The supplied `demoSendEmailKey` and `demoCreateHoldKey` helpers cover the two mutating demo operations.
Read operation keys can be generated directly with `stableOperationKey` or the other demo key helpers.

## Result states and reconciliation

Connector operations return `succeeded`, `failed`, or `uncertain`.
An `uncertain` result has `reconciliationRequired = true` and a `timeout_after_success` error.
The simulator has already committed the in-memory write before returning that result.
Call `reconcileSentEmail` or `reconcileProvisionalHold` with the same operation key before retrying.

The seed option `timeoutAfterSuccessOperationKeys` selects keys that simulate this behavior exactly once.
This makes timeout recovery and duplicate prevention testable without network access.

## Boundary interfaces

### Email inquiry/thread reads

`InquiryThreadReader.readInquiryThread` accepts a thread ID and stable operation key.
It returns the ordered message list, subject, and source references, or a typed `not_found` failure.

### Email send

`EmailSender.sendEmail` accepts recipients, optional thread ID, subject, body, source references, and stable operation key.
It returns a sent-message receipt with provider-neutral fields and provenance.
`EmailSender.reconcileSentEmail` looks up the result by the same operation key after an uncertain response.

### Document retrieval

`DocumentRetriever.retrieveDocument` accepts a document ID and stable operation key.
It returns the document text, title, MIME type, and an explicit provenance array.
The real adapter must preserve the authoritative document locator and revision information when the provider exposes it.

### Calendar availability

`CalendarAvailabilityReader.checkAvailability` accepts a start and end time and returns both available and unavailable slots.
Unavailable slots include a reason when one is known.
The demo returns only slots overlapping the requested range, so callers can verify that an unavailable date is not silently treated as open.

### Provisional holds

`ProvisionalHoldWriter.createProvisionalHold` accepts booking identity, calendar identity, a time range, expiry, provenance, and stable operation key.
It refuses unavailable or already-held ranges and returns `status = "provisional_hold"` on success.
This result is not a confirmed booking and does not imply payment.
`ProvisionalHoldWriter.reconcileProvisionalHold` discovers a hold after an uncertain response.

## Requirements for real adapters

Live adapters remain unverified in this repository.
The following are capability requirements, not claims that an available tool, SDK, or OpenClaw interface exists.

### Email provider requirements

- Read a single inquiry thread by a stable provider thread identifier.
- Return message IDs, thread ID, sender, recipients, subject, body or an approved content representation, and provider timestamps.
- Send a message to explicit recipients with an optional existing thread association.
- Return a provider message ID and enough fields to reconcile a request after a timeout.
- Support lookup by provider message ID or a caller-supplied idempotency marker, or document an equivalent deterministic reconciliation query.
- Distinguish authorization failure, revoked access, not found, rate limiting, and transport timeout.
- Preserve a source locator and account identity without exposing access tokens or raw credentials.

### Document provider requirements

- Retrieve a specific document revision or an explicitly identified current revision.
- Return text or a safely parseable representation, title, MIME type, provider document ID, and revision metadata when available.
- Preserve a stable source locator that a reviewer can use to inspect the authoritative document.
- Report permission denial, missing document, unsupported content, and transient transport failure separately.
- Avoid silently substituting a similarly named document when an exact ID or revision cannot be resolved.

### Calendar provider requirements

- Read free/busy or equivalent availability for a specified calendar and time range.
- Represent unavailable, tentative, out-of-office, and permission-unknown states without collapsing them into available.
- Create a provisional or otherwise reversible hold with an explicit expiry if the provider supports it.
- Return a provider event or hold identifier and enough fields to reconcile completion after a timeout.
- Enforce idempotency or provide a deterministic lookup that prevents duplicate holds during retry.
- Recheck availability immediately before a consequential hold and distinguish conflicts from authorization, quota, and transport failures.
- Preserve the calendar source locator and the provider's observed timestamp.

## What is intentionally absent

There are no live provider clients, network sends, OAuth configuration, credential reads, environment lookups, or external runtime dependencies in this package.
No provider tool names or OpenClaw capabilities are asserted here because they have not been verified.
Production wiring must be implemented only after the supported interface, account identity, test account, and reconciliation behavior are verified by the coordinator.

## Node-compatible checks

This repository currently has no package manifest or test runner configuration.
On Node 22 or newer with built-in TypeScript stripping, run:

```sh
node --experimental-strip-types --test src/connectors/demo.test.ts
```

The tests exercise deterministic keys, provenance, unavailable slots, idempotent sends, and timeout-after-success reconciliation for both email and calendar writes.
