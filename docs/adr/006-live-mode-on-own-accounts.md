# ADR-006: Authorized live connections in the managed service

Status: reconciled design contract — feature implementation remains paused. Existing defect repairs are authorized.

PRD: 2–3, 8.1–8.3, 10. Related: ADR-001–005.

## Reconciled decision

Live customers connect authorized business tools to Gather's managed runtime. They do not install OpenClaw, register a Google Cloud project or supply personal subscription OAuth for pooled hosting. The former desktop/loopback installer plan and zero-operator-cost promise are superseded. Current developer integration remains separate from finished hosted onboarding.

## Connection and execution contracts

- Use a Gather-operated web OAuth callback with state/PKCE validation, verified account identity, exact business binding and protected server-side tokens. Hosted session/tenant authentication must exist before public exposure.
- Determine Google scope, permitted-use and verification/assessment requirements for the actual data flow. Do not instruct production users to bypass unverified warnings or treat a connector broker as an automatic exemption.
- Validate selected-document access and least-privilege scopes end to end before narrowing current configured scopes. There is no shipped Picker merely because the PRD names one.
- Handle consent denial, callback replay/expiry, token refresh/revocation, partial import, connection ambiguity and account changes explicitly. Authentication is not proof of complete sync.
- Use supported model access with per-business usage attribution, cancellation and tool/token/time limits. No silent provider fallback, pooled personal subscription credentials or unlimited/zero-cost claim.
- Exact approved recipients and message content remain enforced. A developer test-recipient allowlist is an additional restriction, not permission to reroute mail.
- Keep secrets behind the existing interface; the current macOS Keychain adapter does not establish hosted storage. No tokens in logs, browser errors, analytics, fixtures or Git.
- Provider uncertainty follows ADR-002; operational failure follows ADR-004. A tool return is not independent verification of a live effect.

## Existing interfaces / future scope

`src/runtime/`, `server/connections/`, `connectors/google/`, `provider-runtime/`, `live-model/` and connection routes are existing integration boundaries. Repair malformed responses, credential leaks, state/claim defects and other reproduced failures without implementing hosted authentication/provisioning, new connector brokers or new model onboarding.

## Required future evidence

An authorized isolated account journey: consent, progressive source intake, actual model execution, grounded proposal, exact approval, Calendar/Gmail effects independently re-read, and explicit reconnect/budget-failure behavior. Scripted transports prove boundary behavior only. Preserve fixture inspection without live credentials. Do not start paid or live-provider runs as part of default repository checks.
