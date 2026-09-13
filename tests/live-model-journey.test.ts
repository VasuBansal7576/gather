import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GoogleHttpRequest,
  GoogleHttpResponse,
} from "../src/connectors/google/transport.ts";
import type { GoogleProviderApp, OAuthTokenResponse, OAuthTransport } from "../src/server/connections/index.ts";
import {
  ConnectionService,
  MemorySecretStore,
} from "../src/server/connections/index.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { demoFixtureSlots } from "../src/server/demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import {
  getLiveRun,
  LiveModelError,
  runLiveModelJourney,
  type ProposalTerms,
} from "../src/server/live-model/index.ts";
import { bindBusinessCalendar } from "../src/server/proactive/calendar.ts";
import { createProviderConnectors, type ProviderConnectors } from "../src/server/provider-runtime/index.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

/**
 * Scripted live-model journey tests. The ONLY facts used are the explicit
 * FICTIONAL seed files at /tmp/gather-live-test-seed (inquiry + venue
 * policy, prepared locally, never uploaded); nothing is generated to
 * duplicate them. All provider surfaces are scripted fictional HTTP —
 * no model executes (scripted term interpreter injected instead), no
 * approval, no send, no live reads.
 */

const SEED_DIR = "/tmp/gather-live-test-seed";
const INQUIRY_TEXT = readFileSync(join(SEED_DIR, "inquiry.txt"), "utf8");
const POLICY_TEXT = readFileSync(join(SEED_DIR, "venue-policy.md"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(SEED_DIR, "manifest.json"), "utf8")) as { status: string };

const APP: GoogleProviderApp = {
  clientId: "gather-test-client",
  authEndpoint: "https://accounts.example.test/auth",
  tokenEndpoint: "https://oauth2.example.test/token",
  userinfoEndpoint: "https://openid.example.test/userinfo",
  revokeEndpoint: "https://oauth2.example.test/revoke",
  redirectUri: "http://localhost:3000/api/connections/google/callback",
  requiredScopes: [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
};

const THREAD_ID = "t-gather-test-1";
const MESSAGE_ID = "m-gather-test-1";
const FILE_ID = "f-gather-test-policy";
const CALENDAR_ID = "gather-test-calendar";
const BODY_B64URL = Buffer.from(INQUIRY_TEXT, "utf-8").toString("base64url");

class ScriptedOAuth implements OAuthTransport {
  async exchangeCode(): Promise<OAuthTokenResponse> {
    return { accessToken: "access-sub-test", refreshToken: "refresh-sub-test", expiresInSec: 3600, scope: APP.requiredScopes.join(" ") };
  }
  async refresh(): Promise<OAuthTokenResponse> {
    return { accessToken: "access-sub-test", expiresInSec: 3600, scope: APP.requiredScopes.join(" ") };
  }
  async fetchAccountIdentity(): Promise<{ accountKey: string; displayName: string }> {
    return { accountKey: "google-sub-test", displayName: "Fictional Test Owner" };
  }
  async revokeToken(): Promise<void> {}
}

class ScriptedGoogle {
  requests: GoogleHttpRequest[] = [];
  json(status: number, body: unknown): GoogleHttpResponse {
    return { status, headers: {}, text: JSON.stringify(body) };
  }
  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    this.requests.push(req);
    if (req.url.includes("/profile")) return this.json(200, { emailAddress: "owner@example.test", historyId: "9000" });
    if (req.url.includes("/messages") && req.method === "GET" && !/\/messages\/[^?]+/.test(req.url)) {
      return this.json(200, { messages: [{ id: MESSAGE_ID, threadId: THREAD_ID }], historyId: "9001" });
    }
    if (req.url.includes("/history")) return this.json(200, { historyId: "9002", history: [] });
    const threadMatch = /\/threads\/([^/?]+)/.exec(req.url);
    if (threadMatch) {
      return this.json(200, {
        id: THREAD_ID,
        messages: [
          {
            id: MESSAGE_ID,
            threadId: THREAD_ID,
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "Customer <customer@example.test>" },
                { name: "To", value: "owner@example.test" },
                { name: "Subject", value: "[GATHER TEST] Private dinner inquiry" },
                { name: "Date", value: "Thu, 10 Sep 2026 09:00:00 +0000" },
              ],
              mimeType: "text/plain",
              body: { data: BODY_B64URL },
            },
          },
        ],
      });
    }
    if (req.url.includes("/drive/v3/files/") && req.url.includes("alt=media")) {
      return { status: 200, headers: {}, text: POLICY_TEXT };
    }
    if (req.url.includes("/drive/v3/files/")) {
      return this.json(200, { id: FILE_ID, name: "venue-policy.md", mimeType: "text/markdown", capabilities: { canDownload: true } });
    }
    if (req.url.includes("/freeBusy")) {
      return this.json(200, { calendars: { [CALENDAR_ID]: { busy: [] } } });
    }
    return this.json(404, {});
  }
  getPosts(): GoogleHttpRequest[] {
    return this.requests.filter((req) => req.method === "POST");
  }
}

interface Fx {
  dir: string;
  store: GatherStore;
  service: ConnectionService;
  providers: ProviderConnectors;
  gmail: ScriptedGoogle;
  businessId: string;
}

async function fixture(): Promise<Fx> {
  assert.match(MANIFEST.status, /prepared locally/, "seed manifest must mark local-only preparation");
  const dir = mkdtempSync(join(tmpdir(), "gather-live-model-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const service = new ConnectionService({
    store,
    secrets: new MemorySecretStore(),
    transport: new ScriptedOAuth(),
    googleApp: APP,
    ownerId: "local-owner",
  });
  const gmail = new ScriptedGoogle();
  const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
  const providers = createProviderConnectors({
    store,
    ownerId: "local-owner",
    demo: { calendar: new DurableDemoCalendar(store, demo.calendar), email: new DurableDemoEmail(store, demo.email) },
    connectionService: service,
    transport: { request: (req) => gmail.request(req) },
  });
  const business = store.createBusiness({ name: "Gather Test Venue", timezone: "Europe/London" });
  const start = service.startAuthorization({ businessId: business.id, provider: "google" });
  const state = new URL(start.authorizationUrl).searchParams.get("state") ?? "";
  await service.completeAuthorization({ code: "code-test", state });
  bindBusinessCalendar({ store, connectionService: service, ownerId: "local-owner", businessId: business.id, calendarId: CALENDAR_ID });
  return { dir, store, service, providers, gmail, businessId: business.id };
}

function cleanupFx(fx: Fx): void {
  try {
    fx.store.close();
  } catch {
    // Already closed.
  }
  rmSync(fx.dir, { recursive: true, force: true });
}

/** Scripted stand-in for the model term interpreter: reads the inquiry, never invents. */
function scriptedExtractor(expectedBody: string) {
  return {
    async extractTerms(input: { inquiryBody: string; inquirySubject: string }): Promise<ProposalTerms> {
      assert.ok(input.inquiryBody.includes(expectedBody.slice(0, 40)), "extractor works from the read inquiry text");
      return {
        startAt: "2026-09-18T18:00:00+01:00",
        endAt: "2026-09-18T20:00:00+01:00",
        guestCount: 12,
        perPersonGbp: 50,
        totalGbp: 600,
        notes: "Two vegetarian meals on request; GATHER TEST only.",
      };
    },
  };
}

test("scripted journey prepares the exact source-linked proposal", async () => {
  const fx = await fixture();
  try {
    const record = await runLiveModelJourney(
      {
        businessId: fx.businessId,
        threadId: THREAD_ID,
        fileId: FILE_ID,
        calendarId: CALENDAR_ID,
        mode: "scripted",
        idempotencyKey: "journey-1",
      },
      { store: fx.store, providers: fx.providers, termsExtractor: scriptedExtractor(INQUIRY_TEXT), now: () => "2026-09-14T00:00:00.000Z" },
    );
    assert.equal(record.status, "ok");
    assert.equal(record.simulated, true);
    assert.deepEqual(record.steps.map((step) => [step.tool, step.ok]), [
      ["readInquiry", true],
      ["readVenuePolicy", true],
      ["checkAvailability", true],
      ["prepareProposal", true],
    ]);
    const proposal = record.proposal!;
    assert.deepEqual(proposal.terms, {
      startAt: "2026-09-18T18:00:00+01:00",
      endAt: "2026-09-18T20:00:00+01:00",
      guestCount: 12,
      perPersonGbp: 50,
      totalGbp: 600,
      notes: "Two vegetarian meals on request; GATHER TEST only.",
    });
    // Three designated sources with scoped ids, no monitors-as-sources.
    const locators = proposal.evidence.map((source) => source.locator).sort();
    assert.deepEqual(locators, [`calendar://${CALENDAR_ID}`, `drive://file/${FILE_ID}`, `gmail://thread/${THREAD_ID}`]);
    for (const step of record.steps) {
      assert.equal(step.provenance?.runId, record.runId);
      assert.equal(step.provenance?.businessId, fx.businessId);
    }
    // Capture only: no proposals approved, no holds, no sends, no model anywhere.
    const action = fx.store.getProposedAction(proposal.proposedActionId);
    assert.equal(action.status, "pending_approval");
    assert.equal(action.kind, "send_offer");
    const writes = fx.gmail.getPosts().filter((req) => !req.url.includes("/freeBusy"));
    assert.deepEqual(writes, [], "no provider writes on the prepare path (freeBusy is a read-only query)");
    assert.deepEqual(getLiveRun(fx.store, record.runId), record, "run record durably readable");
    // Idempotent replay returns the recorded run without new rows.
    const replay = await runLiveModelJourney(
      {
        businessId: fx.businessId,
        threadId: THREAD_ID,
        fileId: FILE_ID,
        calendarId: CALENDAR_ID,
        mode: "scripted",
        idempotencyKey: "journey-1",
      },
      { store: fx.store, providers: fx.providers, termsExtractor: scriptedExtractor(INQUIRY_TEXT) },
    );
    assert.equal(replay.runId, record.runId);
  } finally {
    cleanupFx(fx);
  }
});

test("over-budget terms violate policy before any row is written", async () => {
  const fx = await fixture();
  try {
    const before = (fx.store.db.prepare("SELECT COUNT(*) AS n FROM proposed_actions").all() as Array<{ n: number }>)[0]?.n ?? 0;
    await assert.rejects(
      runLiveModelJourney(
        { businessId: fx.businessId, threadId: THREAD_ID, fileId: FILE_ID, calendarId: CALENDAR_ID, mode: "scripted" },
        {
          store: fx.store,
          providers: fx.providers,
          termsExtractor: {
            async extractTerms(): Promise<ProposalTerms> {
              return { startAt: "2026-09-18T18:00:00+01:00", endAt: "2026-09-18T20:00:00+01:00", guestCount: 12, perPersonGbp: 50, totalGbp: 650, notes: "discounted" };
            },
          },
        },
      ),
      (error: unknown) => error instanceof LiveModelError && error.code === "POLICY_VIOLATION",
    );
    const after = (fx.store.db.prepare("SELECT COUNT(*) AS n FROM proposed_actions").all() as Array<{ n: number }>)[0]?.n ?? 0;
    assert.equal(after, before, "no proposal row on policy violation");
  } finally {
    cleanupFx(fx);
  }
});

test("live mode without opt-in reads nothing; unconfigured model is explicit", async () => {
  const fx = await fixture();
  try {
    const callsBefore = fx.gmail.requests.length;
    await assert.rejects(
      runLiveModelJourney(
        { businessId: fx.businessId, threadId: THREAD_ID, fileId: FILE_ID, calendarId: CALENDAR_ID, mode: "live" },
        { store: fx.store, providers: fx.providers, termsExtractor: scriptedExtractor(INQUIRY_TEXT) },
      ),
      (error: unknown) => error instanceof LiveModelError && error.code === "LIVE_NOT_AUTHORIZED",
    );
    assert.equal(fx.gmail.requests.length, callsBefore, "gate refuses before any provider read");
    await assert.rejects(
      runLiveModelJourney(
        { businessId: fx.businessId, threadId: THREAD_ID, fileId: FILE_ID, calendarId: CALENDAR_ID, mode: "scripted" },
        { store: fx.store, providers: fx.providers },
      ),
      (error: unknown) => error instanceof LiveModelError && error.code === "MODEL_UNCONFIGURED",
    );
  } finally {
    cleanupFx(fx);
  }
});
