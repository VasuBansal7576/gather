import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApiError,
  parseAuthorizationStart,
  parseConnectionsSummary,
  parseCreateBusinessResult,
  parseDisconnectResult,
  parseSetupBusiness,
  parseSetupSummary,
} from "../src/setup/contracts.ts";
import {
  hasConnectedAccount,
  nextStep,
  parseCallbackNotice,
  RequestEpoch,
  statusBlurb,
} from "../src/setup/state.ts";

const SUMMARY = {
  businessId: "biz-1",
  providers: [{
    provider: "google",
    status: "connected",
    accounts: [{
      id: "acc-1",
      businessId: "biz-1",
      provider: "gmail",
      displayName: "Owner inbox",
      status: "connected",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }],
};

test("connections summary parses; unknown shapes rejected", () => {
  assert.deepEqual(parseConnectionsSummary(SUMMARY)?.businessId, "biz-1");
  assert.equal(parseConnectionsSummary({}), undefined);
  assert.equal(parseConnectionsSummary({ businessId: "b", providers: [{ provider: "github", status: "connected", accounts: [] }] }), undefined);
  assert.equal(parseConnectionsSummary({ businessId: "b", providers: [{ provider: "google", status: "smoke-signal", accounts: [] }] }), undefined);
  assert.equal(parseConnectionsSummary({ businessId: "b", providers: [{ provider: "google", status: "connected", accounts: [{ id: "a" }] }] }), undefined);
  // No arbitrary providers: the server decides the list, the UI never invents one.
  assert.equal(parseConnectionsSummary({ businessId: "b", providers: [] })?.providers.length, 0);
});

test("authorize URL must be absolute http(s); tokens never part of the shape", () => {
  const good = parseAuthorizationStart({ provider: "google", authorizationUrl: "https://accounts.example/consent?x=1", expiresAt: "2026-01-01T00:10:00.000Z" });
  assert.equal(good?.authorizationUrl, "https://accounts.example/consent?x=1");
  assert.equal(parseAuthorizationStart({ provider: "google", authorizationUrl: "javascript:alert(1)", expiresAt: "2026-01-01T00:10:00.000Z" }), undefined);
  assert.equal(parseAuthorizationStart({ provider: "google", authorizationUrl: "/relative/path", expiresAt: "2026-01-01T00:10:00.000Z" }), undefined);
  assert.equal(parseAuthorizationStart({ provider: "google", authorizationUrl: "https://a.b/", expiresAt: "not-a-date" }), undefined);
  assert.equal(parseAuthorizationStart({ provider: "google", authorizationUrl: "https://a.b/" }), undefined);
});

test("disconnect and error bodies parse strictly", () => {
  assert.deepEqual(parseDisconnectResult({ disconnected: true }), { disconnected: true });
  assert.equal(parseDisconnectResult({ disconnected: "yes" }), undefined);
  assert.equal(parseDisconnectResult({}), undefined);
  assert.deepEqual(parseApiError({ code: "UNAVAILABLE", message: "No client id.", retryable: false }, 503).code, "UNAVAILABLE");
  assert.deepEqual(parseApiError(undefined, 503), { code: "HTTP_503", message: "The request did not complete.", retryable: false });
  // Non-JSON 404 means the route itself is absent in this build.
  assert.equal(parseApiError(undefined, 404).code, "API_ABSENT");
  assert.equal(parseApiError({ code: "NOT_FOUND", message: "No such business.", retryable: false }, 404).code, "NOT_FOUND");
  assert.deepEqual(parseSetupBusiness({ id: "b", name: "Hall", timezone: "UTC" })?.status, "active");
  assert.equal(parseSetupBusiness({ id: "b", name: "", timezone: "UTC" }), undefined);
});

test("callback notice reads only the controlled hint", () => {
  assert.deepEqual(parseCallbackNotice("?connected=google"), { kind: "connected", provider: "google" });
  assert.deepEqual(parseCallbackNotice("?businessId=biz-9&connected=google"), { kind: "connected", provider: "google", businessId: "biz-9" });
  assert.deepEqual(parseCallbackNotice("?businessId=biz-9&connectionError=EXCHANGE_FAILED&provider=google"), { kind: "error", provider: "google", code: "EXCHANGE_FAILED", businessId: "biz-9" });
  assert.deepEqual(parseCallbackNotice("?connectionError=EXCHANGE_FAILED&provider=google"), { kind: "error", provider: "google", code: "EXCHANGE_FAILED" });
  assert.equal(parseCallbackNotice("?code=abc&state=xyz"), undefined);
  assert.equal(parseCallbackNotice(""), undefined);
  // Blank business context is dropped, never trusted.
  assert.deepEqual(parseCallbackNotice("?businessId=++&connected=google"), { kind: "connected", provider: "google" });
});

test("request epochs drop stale responses", () => {
  const epoch = new RequestEpoch();
  const first = epoch.next();
  const second = epoch.next();
  assert.equal(epoch.isCurrent(first), false);
  assert.equal(epoch.isCurrent(second), true);
  // Independent loaders use independent epochs: one loader advancing must
  // never invalidate another loader's in-flight response.
  const businesses = new RequestEpoch();
  const connections = new RequestEpoch();
  const bizRun = businesses.next();
  connections.next();
  assert.equal(businesses.isCurrent(bizRun), true);
});

test("setup summary and nested create result match the service contract", () => {
  const summary = parseSetupSummary({
    ownerId: "owner-1",
    businesses: [{ id: "b1", name: "Hall", timezone: "UTC" }],
    providers: [{ provider: "google", status: "unavailable", unavailableReason: "No client id." }],
  });
  assert.equal(summary?.ownerId, "owner-1");
  assert.equal(summary?.providers[0]?.status, "unavailable");
  assert.equal(parseSetupSummary({ ownerId: "o", businesses: [], providers: [{ provider: "google", status: "bogus" }] }), undefined);
  const created = parseCreateBusinessResult({
    business: { id: "b2", name: "Annex", timezone: "Europe/London" },
    created: true,
    ownerId: "owner-1",
  });
  assert.equal(created?.business.id, "b2");
  assert.equal(created?.created, true);
  // A bare business row at the top level is NOT the create response.
  assert.equal(parseCreateBusinessResult({ id: "b2", name: "Annex", timezone: "Europe/London" }), undefined);
});

test("expired connection states parse and read honestly", () => {
  const summary = parseConnectionsSummary({
    businessId: "b",
    providers: [{
      provider: "google",
      status: "expired",
      accounts: [{
        id: "a", businessId: "b", provider: "gmail", displayName: "Inbox",
        status: "expired", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    }],
  });
  assert.equal(summary?.providers[0]?.status, "expired");
  assert.ok(statusBlurb("expired").includes("expired"));
  assert.ok(!/token|scope|redirect|oauth/i.test(statusBlurb("expired")));
});

test("step and readiness helpers stay owner-readable", () => {
  assert.equal(nextStep(undefined), "business");
  assert.equal(nextStep("biz-1"), "apps");
  assert.equal(hasConnectedAccount(parseConnectionsSummary(SUMMARY)!), true);
  assert.equal(hasConnectedAccount({ businessId: "b", providers: [{ provider: "google", status: "not_connected", accounts: [] }] }), false);
  assert.ok(!/oauth|token|scope|redirect/i.test(statusBlurb("unavailable", "No client id configured.")));
  assert.ok(statusBlurb("unavailable", "No client id configured.").includes("No client id"));
});
