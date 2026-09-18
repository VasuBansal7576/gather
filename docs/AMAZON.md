# Amazon Owner MCP

ADR-014 provides an owner-facing MCP surface over the existing Gather authority. It uses the official `@modelcontextprotocol/sdk` Streamable HTTP transport and the MCP protocol version negotiated by that SDK (currently verified with SDK `1.30.0`, protocol `2025-11-25`).

## Security boundary

- Every request requires the configured bearer token. Loopback is transport locality, not authentication.
- Host and Origin are checked by the shared Gather boundary; unknown or missing MCP sessions are rejected.
- The adapter binds pending confirmation context to the configured owner and business. Context is persistent when an injected `ApprovalContextStore` is backed by the existing Gather store; the in-memory store is for scripted tests only.
- Approval requires an exact offer ID, version, fingerprint, action summary, and a second explicit `CONFIRM`. Name/voice references never approve directly.
- Customer inquiry text is not an input to any owner-control tool or approval call. Tools use server-scoped identifiers and exact offer snapshots.

## Tools

`what_needs_attention` lists owner-scoped pending items. `prepare_exact_offer_approval` resolves an exact offer and creates a confirmation context. `confirm_exact_offer` delegates the exact snapshot to existing Gather approval authority; the MCP edge does not mint receipts.

The local scripted client used for ADR evidence is a **simulated Alexa-facing client**, not Alexa platform acceptance. No external deployment or platform submission is claimed. Live 014-A03 deployment proof remains blocked without operator-supplied deployment and test context.
