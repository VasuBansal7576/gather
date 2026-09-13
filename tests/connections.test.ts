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

  async exchangeCode(input: { codeVerifier: string } & Record<string, unknown>): Promise<OAuthTokenResponse> {
    this.exchangeCalls += 1;
    this.lastVerifier = input.codeVerifier;
    if (this.exchangeError) throw this.exchangeError;
    return this.tokenResponse;
  }
  async refresh(): Promise<OAuthTokenResponse> {
    this.refreshCalls += 1;
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
    assert.match(google?.unavailableReason ?? "", /not configured/i);
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
    const [t1, t2] = await Promise.all([svc.accessToken(connectionId), svc.accessToken(connectionId)]);
    assert.equal(t1, "access-refreshed");
    assert.equal(t2, "access-refreshed");
    assert.equal(fx.transport.refreshCalls, 1, "concurrent refresh deduped to one exchange");

    // A revoked refresh token marks the connection revoked, not retried.
    fx.store.db.prepare("UPDATE connection_token_meta SET access_expires_at_ms = $t").run({ $t: fx.nowMs - 1000 });
    fx.transport.refreshError = new Error("invalid_grant: token revoked");
    await assert.rejects(svc.accessToken(connectionId), (e: unknown) => e instanceof ConnectionError && e.code === "ACCESS_REVOKED");
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
    assert.equal(await restarted.accessToken(connectionId), "access-initial");
    assert.equal(fx.transport.refreshCalls, 0, "fresh token reused without refresh");
  } finally {
    fx.cleanup();
  }
});

test("disconnect removes only the selected binding and its secrets", async () => {
  const fx = fixture();
  try {
    const svc = service(fx);
    const first = svc.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await svc.completeAuthorization({ code: "c1", state: stateOf(first.authorizationUrl) });
    fx.secrets.set("conn:other-owner:token", "someone-elses-secret");
    const connectionId = (fx.store.db.prepare("SELECT id FROM connection_accounts").get() as Record<string, unknown>).id as string;
    const result = await svc.disconnect(connectionId);
    assert.deepEqual(result, { disconnected: true });
    assert.equal(fx.transport.revokeCalls, 1, "best-effort remote revocation attempted");
    const summary = svc.getConnections(fx.businessId);
    assert.equal(summary.providers[0]?.status, "revoked");
    // Only this connection's secrets are gone; other Gather entries survive.
    assert.equal(fx.secrets.get("conn:other-owner:token"), "someone-elses-secret");
    assert.equal(fx.secrets.get("conn:google:sub-1:access"), undefined);
    assert.equal(fx.secrets.get("conn:google:sub-1:refresh"), undefined);
    // A second disconnect on the same binding is a clean not-found/again-safe call.
    const second = await svc.disconnect(connectionId);
    assert.deepEqual(second, { disconnected: true });
  } finally {
    fx.cleanup();
  }
});
