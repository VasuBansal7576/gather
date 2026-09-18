# Nebius/NVIDIA model profile

ADR-015 provides a disabled-by-default, fail-closed profile for booking reasoning through the Nebius Token Factory OpenAI-compatible endpoint. ADR-016 must wire `NEBIUS_INTEGRATION_PROFILE` into the shared registry; this module does not modify the registry.

## Live evidence

Before a live call, an operator must supply the exact model id from current NVIDIA provenance evidence, an official `nvidia.com` provenance URL, the qualifying endpoint `https://api.tokenfactory.nebius.com/v1/chat/completions`, and a Nebius key with credits and access to that exact model. The implementation never invents a model slug, substitutes another provider, or silently falls back.

The current repository has no operator-supplied Nebius key, credits, or qualifying model-access evidence. Therefore 015-A01 is explicitly blocked; scripted tests use an injected transport and are labeled simulated. No key, receipt, customer data, or personal OpenClaw state is read by default.

## Controls

Calls reserve run/input/output budgets through ADR-009 `RuntimeControl` before the provider transport is invoked. The existing four Gather booking tools are passed as an immutable allowlist; no approval, send, filesystem, web, or arbitrary runtime tool is added. Disabled profiles fail before credential, runtime, or transport access, and provider errors are surfaced rather than retried through a fallback.

Provider results retain reasoning and usage when supplied, plus a redacted receipt containing provider, request id, exact model id, endpoint, and simulated/live status. Secrets remain transport-only and are never included in receipts or diagnostics.
