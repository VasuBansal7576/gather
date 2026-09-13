import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import {
  assertLoopbackRedirectUri,
  ConnectionError,
  ConnectionService,
  FetchOAuthTransport,
  KeychainSecretStore,
  MemorySecretStore,
  type GoogleProviderApp,
  type OAuthTokenResponse,
  type OAuthTransport,
} from "../src/server/connections/index.ts";

interface Fixture {
  store: GatherStore;
  secrets: MemorySecretStore;
  transport: ScriptedTransport;
  dir: string;
  businessId: string;
  nowMs: number;
  cleanup: () => void;
}

const APP: GoogleProviderApp = {
  clientId: "gather-test-client",
  clientSecret: "test-client-secret",
  authEndpoint: "https://accounts.example.test/auth",
  tokenEndpoint: "https://oauth2.example.test/token",
  userinfoEndpoint: "https://openid.example.test/userinfo",
  revokeEndpoint: "https://oauth2.example.test/revoke",
  redirectUri: "http://localhost:3000/api/connections/google/callback",
  requiredScopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"],
};

class ScriptedTransport implements OAuthTransport {
  exchangeCalls = 0;
  refreshCalls = 0;
  identityCalls = 0;
  revokeCalls = 0;
  tokenResponse: OAuthTokenResponse = {
    accessToken: "access-initial",
    refreshToken: "refresh-1",
    expiresInSec: 3600,
    scope: APP.requiredScopes.join(" "),
  };
  refreshResponse: OAuthTokenResponse = { accessToken: "access-refreshed", expiresInSec: 3600, scope: APP.requiredScopes.join(" ") };
  identity = { accountKey: "sub-1", displayName: "Fictional Owner Inbox" };
  refreshError: Error | undefined;
  exchangeError: Error | undefined;
  lastVerifier: string | undefined;
  /** Optional gate the refresh waits on — lets tests interleave disconnect. */
  refreshGate: Promise<void> | undefined;

  async exchangeCode(input: { codeVerifier: string } & Record<string, unknown>): Promise<OAuthTokenResponse> {
    this.exchangeCalls += 1;
    this.lastVerifier = input.codeVerifier;
    if (this.exchangeError) throw this.exchangeError;
    return this.tokenResponse;
  }
  async refresh(): Promise<OAuthTokenResponse> {
    this.refreshCalls += 1;
    if (this.refreshGate) await this.refreshGate;
    if (this.refreshError) throw this.refreshError;
    return this.refreshResponse;
  }
  async fetchAccountIdentity(): Promise<{ accountKey: string; displayName: string }> {
    this.identityCalls += 1;
    return this.identity;
  }
  async revokeToken(): Promise<void> {
    this.revokeCalls += 1;
  }
}

function fixture(withApp = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "gather-connections-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  const fx: Fixture = {
    store,
    secrets: new MemorySecretStore(),
    transport: new ScriptedTransport(),
    dir,
    businessId: business.id,
    nowMs: 1_700_000_000_000,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  if (!withApp) return fx;
  return fx;
}

function service(fx: Fixture, withApp = true): ConnectionService {
  return new ConnectionService({
    store: fx.store,
    secrets: fx.secrets,
    transport: fx.transport,
    googleApp: withApp ? APP : undefined,
    ownerId: "local-owner",
    nowMs: () => fx.nowMs,
  });
}

function stateOf(url: string): string {
  const state = new URL(url).searchParams.get("state");
  assert.ok(state, "authorization URL must carry a state");
  return state;
}

test("missing provider app yields explicit unavailable status, never fake connected", () => {
  const fx = fixture();
  try {
    const svc = service(fx, false);
    const summary = svc.getConnections(fx.businessId);
    const google = summary.providers.find((p) => p.provider === "google");
    assert.equal(google?.status, "unavailable");
    assert.match(google?.unavailableReason ?? "", /unavailable in this installation/i);
    assert.ok(!/GATHER_|environment variable/i.test(google?.unavailableReason ?? ""), "public copy must not instruct env configuration");
    assert.equal(svc.providerReadiness()[0]?.status, "unavailable");
    assert.throws(() => svc.startAuthorization({ businessId: fx.businessId, provider: "google" }), (e: unknown) => {
      assert.ok(e instanceof ConnectionError && e.code === "UNAVAILABLE");
      return true;
    });
  } finally {
    fx.cleanup();
  }
});

test("non-loopback redirect URIs are rejected by the fixed allowlist", () => {
  assert.equal(assertLoopbackRedirectUri(APP.redirectUri), APP.redirectUri);
  for (const bad of [
    "https://localhost:3000/api/connections/google/callback",
    "http://evil.example.com/api/connections/google/callback",
    "http://localhost:3000/other/path",
    "not-a-url",
  ]) {
    assert.throws(() => assertLoopbackRedirectUri(bad), ConnectionError);
  }
  assert.throws(
    () => {
      const fx = fixture();
      try {
        new ConnectionService({
          store: fx.store, secrets: fx.secrets, transport: fx.transport,
          googleApp: { ...APP, redirectUri: "https://evil.example.com/cb" }, ownerId: "o",
        }).startAuthorization({ businessId: fx.businessId, provider: "google" });
      } finally {
        fx.cleanup();
      }
    },
    ConnectionError,
  );
});

test("authorization completes once; replay, expired, and unknown states are rejected", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const start = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    const url = new URL(start.authorizationUrl);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"), "PKCE challenge present");
    const state = stateOf(start.authorizationUrl);
    assert.equal(svc.peekSessionBusinessId(state), fx.businessId, "session carries business context for the redirect");

    const done = await svc.completeAuthorization({ code: "code-1", state });
    assert.equal(done.provider, "google");
    assert.equal(done.businessId, fx.businessId);
    assert.equal(done.displayName, "Fictional Owner Inbox");
    assert.equal(fx.transport.exchangeCalls, 1);
    assert.ok(fx.transport.lastVerifier, "PKCE verifier was sent to the token endpoint");
    // The verifier never touches SQLite.
    const leaked = fx.store.db.prepare(
      "SELECT COUNT(*) AS n FROM connection_auth_sessions WHERE verifier_ref = $v",
    ).get({ $v: fx.transport.lastVerifier! }) as Record<string, unknown>;
    assert.equal(Number(leaked.n), 0);

    // Replay: the same state is consumed.
    await assert.rejects(
      svc.completeAuthorization({ code: "code-1", state }),
      (e: unknown) => e instanceof ConnectionError && e.code === "REPLAY",
    );
    // Unknown state.
    await assert.rejects(
      svc.completeAuthorization({ code: "code-x", state: "nonsense-state" }),
      (e: unknown) => e instanceof ConnectionError && e.code === "REPLAY",
    );
    // Expired session.
    const later = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    fx.nowMs += 11 * 60 * 1000;
    await assert.rejects(
      svc.completeAuthorization({ code: "code-2", state: stateOf(later.authorizationUrl) }),
      (e: unknown) => e instanceof ConnectionError && e.code === "REPLAY",
    );
  } finally {
    fx.cleanup();
  }
});

test("a Google account already bound to another business is rejected", async () => {
  const fx = fixture();
  try {
    const other = fx.store.createBusiness({ name: "Fictional Second Room", timezone: "UTC" });
    const svc = service(fx);
    const first = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(first.authorizationUrl) });
    const second = svc.startAuthorization({ businessId: other.id, provider: "google" });
    await assert.rejects(
      svc.completeAuthorization({ code: "c2", state: stateOf(second.authorizationUrl) }),
      (e: unknown) => e instanceof ConnectionError && e.code === "CROSS_BUSINESS",
    );
  } finally {
    fx.cleanup();
  }
});

test("missing granted scopes fail the callback and connect nothing", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    fx.transport.tokenResponse = {
      accessToken: "a", refreshToken: "r", expiresInSec: 60,
      scope: "openid email", // calendar missing
    };
    const start = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await assert.rejects(
      svc.completeAuthorization({ code: "c1", state: stateOf(start.authorizationUrl) }),
      (e: unknown) => e instanceof ConnectionError && e.code === "MISSING_SCOPE",
    );
    const summary = svc.getConnections(fx.businessId);
    assert.equal(summary.providers[0]?.accounts.length, 0, "no account bound on missing scope");
  } finally {
    fx.cleanup();
  }
});

test("access token refresh is singleflight; revocation marks the connection revoked", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const start = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(start.authorizationUrl) });
    const connectionId = (fx.store.db.prepare("SELECT id FROM connection_accounts").get() as Record<string, unknown>).id as string;

    // Force expiry, then two concurrent refreshes must share one exchange.
    fx.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx.nowMs - 1000 });
    const scope = { accountId: connectionId, businessId: fx.businessId };
    const [t1, t2] = await Promise.all([svc.accessToken(scope), svc.accessToken(scope)]);
    assert.equal(t1, "access-refreshed");
    assert.equal(t2, "access-refreshed");
    assert.equal(fx.transport.refreshCalls, 1, "concurrent refresh deduped to one exchange");

    // A revoked refresh token marks the connection revoked, not retried.
    fx.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx.nowMs - 1000 });
    fx.transport.refreshError = new ConnectionError("EXCHANGE_FAILED", "Token endpoint rejected the request (invalid_grant)", { providerError: "invalid_grant" });
    await assert.rejects(svc.accessToken(scope), (e: unknown) => e instanceof ConnectionError && e.code === "ACCESS_REVOKED");
    const row = fx.store.db.prepare("SELECT status FROM connection_accounts WHERE id = $id").get({ $id: connectionId }) as Record<string, unknown>;
    assert.equal(row.status, "revoked");
    const summary = svc.getConnections(fx.businessId);
    assert.equal(summary.providers[0]?.status, "revoked");
  } finally {
    fx.cleanup();
  }
});

test("secrets never reach DTOs or SQLite; connection survives a service restart", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const start = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(start.authorizationUrl) });
    const summary = svc.getConnections(fx.businessId);
    const serialized = JSON.stringify(summary);
    for (const secret of ["access-initial", "refresh-1", "test-client-secret"]) {
      assert.ok(!serialized.includes(secret), `DTO must not contain secret material (${secret})`);
    }
    const dbDump = (fx.store.db.prepare(
      "SELECT GROUP_concat(sql) AS s FROM sqlite_master WHERE name LIKE 'connection_%'",
    ).get() as Record<string, unknown>).s;
    void dbDump;
    const rows = fx.store.db.prepare("SELECT * FROM connection_token_meta").all() as Record<string, unknown>[];
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes("access-initial"), "token refs only in sqlite");
      assert.ok(!JSON.stringify(row).includes("refresh-1"), "token refs only in sqlite");
    }
    // Restart: new service instance over the same db + secrets still resolves.
    const restarted = service(fx);
    const again = restarted.getConnections(fx.businessId);
    assert.equal(again.providers[0]?.status, "connected");
    const connectionId = (fx.store.db.prepare("SELECT id FROM connection_accounts").get() as Record<string, unknown>).id as string;
    assert.equal(await restarted.accessToken({ accountId: connectionId, businessId: fx.businessId }), "access-initial");
    assert.equal(fx.transport.refreshCalls, 0, "fresh token reused without refresh");
  } finally {
    fx.cleanup();
  }
});

test("disconnect via the public DTO id removes only the selected binding and its secrets", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const first = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(first.authorizationUrl) });
    fx.secrets.set("conn:other-owner:token", "someone-elses-secret");
    // Regression: the PUBLIC connected_accounts id from the DTO must resolve
    // to the internal connection — previously secrets leaked because the
    // input id was used for token-meta lookup.
    const publicId = svc.getConnections(fx.businessId).providers[0]!.accounts[0]!.id;
    const result = await svc.disconnect({ accountId: publicId, businessId: fx.businessId });
    assert.deepEqual(result, { disconnected: true });
    assert.equal(fx.transport.revokeCalls, 1, "best-effort remote revocation attempted");
    const summary = svc.getConnections(fx.businessId);
    assert.equal(summary.providers[0]?.status, "revoked");
    // Only this connection's secrets are gone; other Gather entries survive.
    assert.equal(fx.secrets.get("conn:other-owner:token"), "someone-elses-secret");
    const remaining = fx.secrets.keys().filter((k) => k.includes("sub-1"));
    assert.deepEqual(remaining, [], "every secret ref for the binding must be deleted");
    // A second disconnect is idempotent; a foreign business id is rejected.
    const second = await svc.disconnect({ accountId: publicId, businessId: fx.businessId });
    assert.deepEqual(second, { disconnected: true });
    const other = fx.store.createBusiness({ name: "Fictional Other", timezone: "UTC" });
    await assert.rejects(
      svc.disconnect({ accountId: publicId, businessId: other.id }),
      (e: unknown) => e instanceof ConnectionError && e.code === "NOT_FOUND",
    );
  } finally {
    fx.cleanup();
  }
});

test("reauthorization preserves the prior refresh token when the provider omits a new one", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const first = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(first.authorizationUrl) });
    // Reauthorize: provider returns a fresh access token but NO refresh token.
    fx.transport.tokenResponse = {
      accessToken: "access-second", expiresInSec: 3600, scope: APP.requiredScopes.join(" "),
    };
    const second = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c2", state: stateOf(second.authorizationUrl) });
    // Force expiry: the ORIGINAL refresh token must still drive the refresh.
    fx.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx.nowMs - 1000 });
    const connectionId = (fx.store.db.prepare("SELECT id FROM connection_accounts").get() as Record<string, unknown>).id as string;
    const token = await svc.accessToken({ accountId: connectionId, businessId: fx.businessId });
    assert.equal(token, "access-refreshed");
    assert.equal(fx.transport.refreshCalls, 1, "preserved refresh token still usable after reauthorization");
  } finally {
    fx.cleanup();
  }
});

test("a refresh in flight during disconnect cannot resurrect secrets or return a token", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const first = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(first.authorizationUrl) });
    const publicId = svc.getConnections(fx.businessId).providers[0]!.accounts[0]!.id;
    // Force expiry and hold the provider refresh open.
    fx.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx.nowMs - 1000 });
    let release: () => void = () => undefined;
    fx.transport.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = svc.accessToken({ accountId: publicId, businessId: fx.businessId });
    await svc.disconnect({ accountId: publicId, businessId: fx.businessId });
    release();
    await assert.rejects(pending, (e: unknown) => e instanceof ConnectionError && e.code === "STALE");
    const remaining = fx.secrets.keys().filter((k) => k.includes("sub-1"));
    assert.deepEqual(remaining, [], "late refresh must not resurrect deleted secrets");
  } finally {
    fx.cleanup();
  }
});

test("FetchOAuthTransport classifies provider errors structurally and bounds requests", async () => {
  const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 200, body: { access_token: "t", expires_in: 60, scope: "openid" } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  const transport = new FetchOAuthTransport({ fetchImpl, timeoutMs: 5000, maxBytes: 4096 });

  // invalid_grant surfaces structurally, never description text.
  responses.push({ status: 400, body: { error: "invalid_grant", error_description: "token=refresh-1 was revoked bearer abc" } });
  await assert.rejects(
    transport.refresh({ tokenEndpoint: "https://t.example/token", clientId: "c", refreshToken: "refresh-1" }),
    (e: unknown) => {
      assert.ok(e instanceof ConnectionError);
      assert.equal(e.providerError, "invalid_grant");
      assert.equal(e.retryable, false);
      assert.ok(!e.message.includes("refresh-1"), "provider description must not leak into the message");
      return true;
    },
  );
  // Transient failure stays retryable.
  responses.push({ status: 503, body: { error: "temporarily_unavailable" } });
  await assert.rejects(
    transport.refresh({ tokenEndpoint: "https://t.example/token", clientId: "c", refreshToken: "r" }),
    (e: unknown) => e instanceof ConnectionError && e.providerError === "temporarily_unavailable" && e.retryable,
  );
  // Invalid expiry is rejected.
  responses.push({ status: 200, body: { access_token: "t", expires_in: -5, scope: "openid" } });
  await assert.rejects(
    transport.refresh({ tokenEndpoint: "https://t.example/token", clientId: "c", refreshToken: "r" }),
    (e: unknown) => e instanceof ConnectionError && e.code === "EXCHANGE_FAILED",
  );
  // Requests carry a bounded timeout signal.
  responses.push({ status: 200, body: { access_token: "t", expires_in: 60, scope: "openid" } });
  await transport.refresh({ tokenEndpoint: "https://t.example/token", clientId: "c", refreshToken: "r" });
  assert.ok(calls.every((c) => c.init?.signal instanceof AbortSignal), "every request bounded by a timeout signal");
  // Oversized response is rejected.
  responses.push({ status: 200, body: { access_token: "t", expires_in: 60, scope: "openid", pad: "x".repeat(9000) } });
  await assert.rejects(
    transport.refresh({ tokenEndpoint: "https://t.example/token", clientId: "c", refreshToken: "r" }),
    (e: unknown) => e instanceof ConnectionError && e.code === "EXCHANGE_FAILED",
  );
});

test("real transport invalid_grant marks revoked; transient error stays connected", async () => {
  const fx = fixture();
  try {
    let status = 400;
    let body: Record<string, unknown> = { error: "invalid_grant" };
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const svc = new ConnectionService({
      store: fx.store, secrets: fx.secrets, transport: new FetchOAuthTransport({ fetchImpl }),
      googleApp: APP, ownerId: "o", nowMs: () => fx.nowMs,
    });
    // Seed a connected binding directly through the scripted path first.
    const scripted = service(fx);
    const start = scripted.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await scripted.completeAuthorization({ code: "c1", state: stateOf(start.authorizationUrl) });
    const publicId = svc.getConnections(fx.businessId).providers[0]!.accounts[0]!.id;
    fx.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx.nowMs - 1000 });
    await assert.rejects(
      svc.accessToken({ accountId: publicId, businessId: fx.businessId }),
      (e: unknown) => e instanceof ConnectionError && e.code === "ACCESS_REVOKED",
    );
    assert.equal(svc.getConnections(fx.businessId).providers[0]?.status, "revoked");

    // A transient provider error keeps the binding and stays retryable.
    status = 503;
    body = { error: "temporarily_unavailable" };
    const fx2 = fixture();
    try {
      const svc2 = new ConnectionService({
        store: fx2.store, secrets: fx2.secrets, transport: new FetchOAuthTransport({ fetchImpl }),
        googleApp: APP, ownerId: "o", nowMs: () => fx2.nowMs,
      });
      const svc2Scripted = service(fx2);
      const start2 = svc2Scripted.startAuthorization({ businessId: fx2.businessId, provider: "google" });
      await svc2Scripted.completeAuthorization({ code: "c1", state: stateOf(start2.authorizationUrl) });
      const publicId2 = svc2.getConnections(fx2.businessId).providers[0]!.accounts[0]!.id;
      fx2.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx2.nowMs - 1000 });
      await assert.rejects(
        svc2.accessToken({ accountId: publicId2, businessId: fx2.businessId }),
        (e: unknown) => e instanceof ConnectionError && e.code === "EXCHANGE_FAILED" && e.retryable,
      );
      assert.equal(svc2.getConnections(fx2.businessId).providers[0]?.status, "connected");
    } finally {
      fx2.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test("keychain adapter never puts secrets in argv, errors, or logs", async () => {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const backing = new Map<string, string>();
  const store = new KeychainSecretStore({
    namespace: "test-workspace",
    runner: (spec) => {
      calls.push(spec);
      const [tool, ...rest] = spec.argv;
      if (tool === "swift") {
        backing.set(spec.argv[spec.argv.length - 1]!, spec.stdin ?? "");
        return "";
      }
      if (rest[0] === "find-generic-password") {
        const key = spec.argv[spec.argv.length - 2]!;
        const value = backing.get(key);
        if (value === undefined) {
          const e = new Error("fail") as Error & { stderr?: string };
          e.stderr = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
          throw e;
        }
        return value;
      }
      if (rest[0] === "delete-generic-password") {
        backing.delete(spec.argv[spec.argv.length - 1]!);
        return "";
      }
      throw new Error(`unexpected argv ${spec.argv.join(" ")}`);
    },
  });
  store.set("conn:google:sub-1:refresh", "top-secret-value");
  assert.equal(store.get("conn:google:sub-1:refresh"), "top-secret-value");
  store.delete("conn:google:sub-1:refresh");
  assert.equal(store.get("conn:google:sub-1:refresh"), undefined);
  for (const call of calls) {
    assert.ok(
      !call.argv.some((arg) => arg.includes("top-secret-value")),
      `secret must never appear in argv: ${call.argv.join(" ")}`,
    );
  }
  const setCall = calls.find((c) => c.argv[0] === "swift");
  assert.equal(setCall?.stdin, "top-secret-value", "secret travels on stdin to the native boundary");
});

test("redirect userinfo, query, and hash ambiguities are rejected", () => {
  for (const bad of [
    "http://user:pw@localhost:3000/api/connections/google/callback",
    "http://localhost:3000/api/connections/google/callback?x=1",
    "http://localhost:3000/api/connections/google/callback#frag",
    "http://localhost.evil.test/api/connections/google/callback",
  ]) {
    assert.throws(() => assertLoopbackRedirectUri(bad), ConnectionError);
  }
});
