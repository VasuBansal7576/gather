import assert from "node:assert/strict";
import test from "node:test";
import { createSetupApi, SetupApiError, type SetupFetch } from "../src/setup/api.ts";

function fixtureFetch(routes: Record<string, { status: number; body: unknown }>): SetupFetch {
  return async (input: string) => {
    const url = new URL(input, "http://localhost:9999");
    const key = `${url.pathname}${url.search}`;
    const hit = routes[key] ?? routes[url.pathname];
    if (!hit) {
      return new Response(JSON.stringify({ code: "HTTP_404", message: "No route.", retryable: false }), { status: 404 });
    }
    return new Response(JSON.stringify(hit.body), { status: hit.status });
  };
}

const SUMMARY_BODY = {
  businessId: "biz-1",
  providers: [{ provider: "google", status: "unavailable", unavailableReason: "No client id configured.", accounts: [] }],
};

test("connections, authorize, disconnect map honest server states", async () => {
  const api = createSetupApi(fixtureFetch({
    "/api/connections?businessId=biz-1": { status: 200, body: SUMMARY_BODY },
    "/api/connections/google/authorize": { status: 200, body: { provider: "google", authorizationUrl: "https://accounts.example/o?x=1", expiresAt: "2026-01-01T00:10:00.000Z" } },
    "/api/connections/google/disconnect": { status: 200, body: { disconnected: true } },
  }));
  const summary = await api.getConnections("biz-1");
  assert.equal(summary.providers[0]?.status, "unavailable");
  const started = await api.startGoogleAuthorization("biz-1");
  assert.equal(started.authorizationUrl, "https://accounts.example/o?x=1");
  assert.deepEqual(await api.disconnectGoogleAccount("acc-1", "biz-1"), { disconnected: true });
});

test("503 UNAVAILABLE and unknown errors surface with codes", async () => {
  const api = createSetupApi(fixtureFetch({
    "/api/connections?businessId=b": { status: 503, body: { code: "UNAVAILABLE", message: "Google app assets are not configured.", retryable: false } },
    "/api/connections/google/authorize": { status: 503, body: { code: "UNAVAILABLE", message: "Google app assets are not configured.", retryable: false } },
  }));
  const error = await api.getConnections("b").then(() => assert.fail("expected throw"), (e: unknown) => e);
  assert.ok(error instanceof SetupApiError);
  assert.equal(error.apiError.code, "UNAVAILABLE");
  assert.equal(error.httpStatus, 503);
  assert.equal(error.apiError.retryable, false);
});

test("network failure and malformed bodies become retryable errors, never silent", async () => {
  const down = createSetupApi((async () => { throw new Error(" refused"); }) as SetupFetch);
  const net = await down.getConnections("b").then(() => assert.fail("expected throw"), (e: unknown) => e);
  assert.ok(net instanceof SetupApiError);
  assert.equal(net.apiError.code, "NETWORK_ERROR");
  assert.equal(net.apiError.retryable, true);

  const weird = createSetupApi(fixtureFetch({ "/api/connections?businessId=b": { status: 200, body: { providers: "google" } } }));
  const bad = await weird.getConnections("b").then(() => assert.fail("expected throw"), (e: unknown) => e);
  assert.ok(bad instanceof SetupApiError);
  assert.equal(bad.apiError.code, "BAD_RESPONSE");
});

test("business list prefers setup summary; create uses the nested wrapper", async () => {
  const seen: string[] = [];
  const api = createSetupApi((async (input: string, init?: RequestInit) => {
    if (input === "/api/setup") {
      return new Response(JSON.stringify({
        ownerId: "owner-1",
        businesses: [{ id: "b1", name: "Hall", timezone: "UTC" }],
        providers: [{ provider: "google", status: "available" }],
      }), { status: 200 });
    }
    if (input === "/api/setup/business") {
      seen.push(String(init?.body));
      return new Response(JSON.stringify({
        business: { id: "b2", name: "Annex", timezone: "Europe/London" },
        created: false,
        ownerId: "owner-1",
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as SetupFetch);
  assert.deepEqual((await api.getBusinesses()).map((b) => b.id), ["b1"]);
  const created = await api.createBusiness("Annex", "Europe/London");
  assert.equal(created.business.id, "b2");
  assert.equal(created.created, false);
  assert.deepEqual(JSON.parse(seen[0] ?? "{}"), { name: "Annex", timezone: "Europe/London" });
});

test("workspace aggregation is an explicit fallback only when setup is absent", async () => {
  const api = createSetupApi((async (input: string) => {
    if (input === "/api/setup") return new Response("<html>no route</html>", { status: 404, headers: { "content-type": "text/html" } });
    if (input === "/api/workspace") {
      return new Response(JSON.stringify({ businesses: [{ id: "w1", name: "Old Hall", timezone: "UTC", status: "active" }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as SetupFetch);
  assert.deepEqual((await api.getBusinesses()).map((b) => b.id), ["w1"]);
});

test("disconnect sends the scoped account identity", async () => {
  const seen: string[] = [];
  const api = createSetupApi((async (input: string, init?: RequestInit) => {
    if (input === "/api/connections/google/disconnect") {
      seen.push(String(init?.body));
      return new Response(JSON.stringify({ disconnected: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as SetupFetch);
  assert.deepEqual(await api.disconnectGoogleAccount("acc-1", "biz-1"), { disconnected: true });
  assert.deepEqual(JSON.parse(seen[0] ?? "{}"), { accountId: "acc-1", businessId: "biz-1" });
});

test("demo start requires explicit demo:true and returns business context", async () => {
  const seen: string[] = [];
  const api = createSetupApi((async (input: string, init?: RequestInit) => {
    if (input === "/api/demo/init") {
      seen.push(String(init?.body));
      return new Response(JSON.stringify({ demo: true, businessId: "demo-b", bookingIds: ["bk-1"] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as SetupFetch);
  assert.deepEqual(await api.startDemo(), { businessId: "demo-b", bookingIds: ["bk-1"] });
  assert.deepEqual(JSON.parse(seen[0] ?? "{}"), { demo: true });
});
