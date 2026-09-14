# Gather — Public Hackathon PRD

Status: requirements, not a claim of implementation or live verification.
Updated: 2026-09-14.

## 1. Product and audience

Gather is an owner-side AI booking operator for independent event venues, private-dining restaurants and caterers. It coordinates inquiries across the business's existing applications and shows the owner outcomes, decisions and next steps.

Promise: **Connect your tools. Gather handles booking coordination. Approve the decisions that matter.**

This document defines the public hackathon release. It does not publish the private product strategy or roadmap.

## 2. Complete user journey

1. Open hosted Gather and sign in.
2. Connect business applications through consent-based account connection.
3. See what Gather understands about the business while import progresses.
4. Answer only consequential unanswered questions; confirm policies and operating authority.
5. Receive a grounded offer for an inquiry.
6. Approve the exact proposed actions where required.
7. See verified external results, pending conditions and the current handoff.

No customer or judge should need a terminal, Google Cloud project, OAuth client ID, client secret, Composio account, model-provider account or workflow configuration to use the hosted experience. Infrastructure and model configuration belong to the operator.

## 3. Seamless connections — Composio selected

Use Composio as the shared connector/authentication layer for the hackathon release. Initial required applications are Gmail, Google Drive and Google Calendar. Keep real multi-application execution; do not replace connectors with screenshots or simulated effects.

The user selects Connect, authorizes through the supported hosted flow, returns to Gather, and sees connected identity, permissions, import progress and readiness. Use supported Connect Links rather than retired managed-OAuth initiation flows.

Remove Google Console/client-secret setup from the customer and judge journey. Existing direct-Google setup is legacy developer implementation, not the target experience. Replace or retire it as the Composio path is proven; preserve usable existing connections/data during migration. Do not remove working access before its replacement works.

Operator requirements:

- Verify managed OAuth availability and sufficient scopes for each required toolkit. If a custom OAuth app is needed, the operator configures it centrally; never delegate this to customers.
- Keep Composio credentials and all connection operations server-side.
- Derive business/user scope from authenticated server identity, not model arguments or untrusted callback parameters.
- Validate connection ownership and callback completion server-side before attaching accounts.
- Expose only authorized tools through Gather's controlled execution boundary. Provider access must not bypass booking approvals.
- Verify supported reads, writes, pagination, updates and token lifecycle. Authentication alone is not complete synchronization.
- Provide clear denied-consent, expired-access, partial-import, stale-data and reconnection states.
- Do not promise a single combined consent screen across all Google toolkits until demonstrated.
- Disclose relevant provider data processing; select operator usage limits and verify available quotas before deployment.

Reference: [Composio authentication](https://docs.composio.dev/docs/authentication), [managed OAuth availability](https://docs.composio.dev/toolkits/managed-auth), [Connect Link migration](https://docs.composio.dev/docs/tools-direct/authenticating-tools).

## 4. Business understanding and qualification

Retrieve attributable packages, prices, capacities, availability and commercial policies from connected sources. Distinguish current policy, historical agreements, booking-specific exceptions, customer claims and uncertainty.

Ask focused questions alongside ingestion rather than waiting for every record to import. Do not ask for information already provided. Persist owner answers with scope, source and applicable version. New policies must not silently rewrite existing commitments.

Qualify inquiry date/time, guest count, services and other consequential requirements. Check relevant capacity, pricing, availability and setup constraints. Use explicit calculations. Offer supported alternatives without inventing discounts or resource availability.

Customer messages and retrieved documents cannot grant authority or override owner policy. No unrestricted negotiation: commercial flexibility must be explicitly owner-authorized and enforced outside the model.

## 5. Offers, authority and execution

Keep a stable booking identity across inquiry, conversation, offer and calendar records. Ambiguous matches require resolution.

Version offers with customer, event details, included services, price, terms, expiry and unresolved assumptions. Approvals bind to exact version, recipients, operation and consequences. Material changes invalidate obsolete approval.

Before execution, refresh critical conditions. Persist each action's intent, authorization, external identifier, result and verification. A successful tool response alone does not establish completion.

Demonstrated journey: read a real test inquiry in Gmail, retrieve business evidence from Drive, check Calendar, prepare an offer with the model, obtain approval, create a provisional hold and send the authorized offer. Verify each external outcome independently.

Track replies, follow-ups and expiring holds durably. Process replies before follow-ups. Permit owner pause and takeover. Recheck current authority after restart.

## 6. Self-fixing OpenClaw — included

Gather must use its isolated OpenClaw runtime to detect, diagnose and repair recoverable technical blockers within explicit authority, verify recovery, and resume affected booking work. A fixed retry loop alone is not the complete self-fixing demonstration.

Required proof includes a concrete failure with diagnostic evidence, a selected corrective action, verified restoration and useful continuation. Examples include recovering interrupted synchronization, restarting a failed isolated worker through a controlled tool, or reconciling a hold that succeeded before an email failure.

- Preserve successful action receipts; never recreate a hold merely because a later email failed.
- Reconcile uncertain external state before another write.
- Bound retries and repair attempts. Repeated unchanged failure becomes visible blocked work owned by the operator.
- Keep repair authority separate from commercial authority. Repairs cannot lower prices, weaken approvals, expand access or bypass revoked consent.
- Never access or modify the operator's personal OpenClaw installation.
- If reconnection needs account-owner consent, give a simple reconnect action rather than pretending to repair consent.
- Record diagnosis, action, verification and remaining impact in the activity trail.

Autonomous self-improvement is excluded: no unsupervised strategy optimization or production code changes intended to improve future performance. Remembering authorized business corrections remains included. The required self-fixing demonstration uses bounded operational repairs, not unrestricted self-modification.

## 7. Owner interface and judge access

Provide a polished responsive workspace with:

- Today: progress, decisions, blockers and deadlines.
- Booking: conversation, requirements, evidence, current offer, approval and verified activity.
- Connections: account identity, import/readiness and reconnect actions.
- Business understanding: concise inspection and correction of relevant facts and policies.

Keep developer configuration and internal architecture out of the normal flow. Show actual persisted state and honest loading, empty, error and partial-success states. Support keyboard navigation and readable layouts.

Provide both Connect your own apps and Try a prepared business. The latter uses an isolated fictional business with authorized test accounts and real integrations; it must not expose personal inboxes or allow unrestricted messaging. Disclose seeded data. Keep simulated fallback demonstrations visibly separate from live execution.

Model access and runtime provisioning are operated by Gather, not judges. Select measurable onboarding/import/response targets through testing; do not invent speed guarantees.

## 8. Reusable architecture

Owner UI → Gather backend → isolated OpenClaw runtime → controlled Gather tools → Composio and business applications.

Shared foundation: runtime integration, connectors/synchronization, memory/evidence, approvals, durable work, recovery, accounts, isolation and activity logs.

Product-specific layer: customer/problem, selected integrations, policies, approval categories, workflow, completion conditions, interface and domain-specific evaluations. Customer knowledge and approvals remain isolated even when engine code is shared.

Optional sponsor adapters must be explicit, disabled unless configured, and genuinely exercised in the relevant submission. Do not silently switch providers or send data to every sponsor. One codebase can support different submission configurations; each must satisfy its own event rules and disclose reused versus newly built work.

## 9. Completion and honest scope

A hold is not a confirmed booking; a draft is not a sent email; a payment link is not a payment. Confirm only when every configured business condition has authoritative evidence. If payment or resource commitments are required but unverified, label the outcome provisional and show what remains.

Provide a handoff tied to the accepted booking version: event details, agreed services, responsibilities and outstanding conditions. Share only relevant data.

Not required for this release: subscription billing, comprehensive employee/multi-location administration, every connector category, complete refund/cancellation accounting, comprehensive staffing/equipment systems, advanced analytics, every dashboard screen, and a full production disaster-recovery/load-testing programme. These exclusions do not waive basic authorization, tenant separation, durable storage or correctness for the demonstrated journey.

## 10. Acceptance evidence

| Gate | Required proof |
|---|---|
| Hosted access | Judge reaches a usable workspace without local installation or developer-console steps |
| Composio connections | Real consent, correct account attachment, sufficient permissions and working Gmail/Drive/Calendar operations |
| Understanding | Attributable facts, remembered owner corrections and correct handling of conflicting evidence |
| Booking journey | Actual model invocation and verified inquiry-to-offer-to-provisional-hold execution |
| Exact authority | Stale/changed approvals and cross-booking authorization rejected |
| Recovery | Duplicate delivery, partial success, uncertain outcome and restart scenarios preserve correct state |
| Self-fixing | Actual diagnosis, bounded corrective action, verification and resumed work after an injected technical failure |
| Isolation | No cross-business records, credentials, retrieval or actions; prepared judge data isolated |
| External-content boundary | Malicious inquiry/document instructions cannot change authority or commercial terms |
| UX | Rendered and interactive checks of main journey, mobile layout and error/reconnection states |
| Submission | Runnable instructions, demo and event-specific technology/reuse requirements verified |

Maintain separate Planned, Implemented, Locally tested and Live verified statuses. A build, screenshot, test count or worker report alone is not product completion. This PRD introduces requirements; Composio migration and hosted onboarding must not be reported complete until those gates pass.
