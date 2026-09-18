import assert from "node:assert/strict";
import test from "node:test";
import { createAmazonOwnerMcp, MemoryApprovalContextStore, type AmazonOwnerBackend } from "../src/integrations/amazon/index.ts";

const offer = {
  offerId: "offer:glasshouse",
  version: 3,
  fingerprint: "a".repeat(64),
  actionSummary: "Hold Glasshouse on 2030-05-02 and send the exact approved offer",
  customerId: "customer-1",
};

function backendFor(calls: { approved: number }): AmazonOwnerBackend {
  return {
    async whatNeedsAttention() {
      return [{ id: "attention-1", kind: "approval", summary: "Offer requires owner approval", offerId: offer.offerId, offerVersion: offer.version }];
    },
    async resolveOffer(_session, reference) {
      if (reference.name === "Glasshouse") {
        return { candidates: [{ offerId: offer.offerId, version: offer.version, actionSummary: offer.actionSummary }] };
      }
      return offer;
    },
    async approveExact(_session, exact) {
      calls.approved += 1;
      return { receipt: "existing-gather-authority", offerId: exact.offerId, version: exact.version };
    },
  };
}

async function jsonRequest(url: string, body: unknown, token: string, sessionId?: string, origin?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: new URL(url).host,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const data = text.match(/(?:^|\n)data: (\{.*\})(?:\n|$)/s)?.[1] ?? text;
  return JSON.parse(data) as Record<string, unknown>;
}

test("ADR-014 scripted Streamable HTTP handshake and exact approval", async () => {
  const calls = { approved: 0 };
  const token = "owner-token-014-long";
  const adapter = createAmazonOwnerMcp({
    authToken: token,
    session: { ownerId: "owner-1", businessId: "business-1" },
    backend: backendFor(calls),
    contexts: new MemoryApprovalContextStore(),
  });
  const listening = await adapter.boundary.listen({ port: 0 });
  try {
    const initialize = await jsonRequest(listening.url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "simulated-alexa-client", version: "0.1.0" } },
    }, token);
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const attention = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "what_needs_attention", arguments: {} } }, token, sessionId, new URL(listening.url).origin);
    assert.equal(attention.status, 200);
    assert.match(await attention.text(), /attention-1/);

    const prepared = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "prepare_exact_offer_approval", arguments: { offerId: offer.offerId } } }, token, sessionId);
    const preparedBody = await responsePayload(prepared) as { result?: { structuredContent?: { confirmationToken?: string } } };
    const confirmationToken = preparedBody.result?.structuredContent?.confirmationToken;
    assert.ok(confirmationToken);

    const approved = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "confirm_exact_offer", arguments: { confirmationToken, offerId: offer.offerId, version: offer.version, fingerprint: offer.fingerprint, actionSummary: offer.actionSummary, confirmation: "CONFIRM" } } }, token, sessionId);
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /existing-gather-authority/);
    assert.equal(calls.approved, 1);
  } finally {
    await adapter.boundary.close();
  }
});

test("ADR-014 rejects missing auth, bad origin, ambiguous names, and stale exact context", async () => {
  const calls = { approved: 0 };
  const token = "owner-token-014-long";
  const adapter = createAmazonOwnerMcp({
    authToken: token,
    session: { ownerId: "owner-1", businessId: "business-1" },
    backend: backendFor(calls),
  });
  const listening = await adapter.boundary.listen({ port: 0 });
  try {
    const noAuth = await fetch(listening.url, { method: "POST", headers: { host: new URL(listening.url).host, "content-type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);
    const badOrigin = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "client", version: "1" } } }, token, undefined, "https://attacker.invalid");
    assert.equal(badOrigin.status, 403);

    const initialize = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "simulated-alexa-client", version: "0.1.0" } } }, token);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const ambiguous = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "prepare_exact_offer_approval", arguments: { name: "Glasshouse" } } }, token, sessionId);
    assert.match(JSON.stringify(await responsePayload(ambiguous)), /AMBIGUOUS_REFERENCE/);

    const prepared = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "prepare_exact_offer_approval", arguments: { offerId: offer.offerId } } }, token, sessionId);
    const body = await responsePayload(prepared) as { result?: { structuredContent?: { confirmationToken?: string } } };
    const confirmationToken = body.result?.structuredContent?.confirmationToken;
    assert.ok(confirmationToken);
    const stale = await jsonRequest(listening.url, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "confirm_exact_offer", arguments: { confirmationToken, offerId: offer.offerId, version: 2, fingerprint: offer.fingerprint, actionSummary: offer.actionSummary, confirmation: "CONFIRM" } } }, token, sessionId);
    assert.match(JSON.stringify(await responsePayload(stale)), /STALE_OR_MISMATCHED_OFFER/);
    assert.equal(calls.approved, 0);
  } finally {
    await adapter.boundary.close();
  }
});
