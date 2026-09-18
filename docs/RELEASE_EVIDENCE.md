# Gather release evidence (ADR-016)

Proof index for the public hackathon release. Every PRD section-10 gate and
section-11 event requirement maps to an artifact at the release commit or to
a named blocker. No gate is waived, passed by fixture, or claimed from an
ADR status. Simulated evidence is labelled; live proof needs operator access
that this run does not have.

- Wave base: `1198eb2` (verified merge of ADR-006 `3634ae8` + profiles
  013/014/015; 932/0/4 green at base).
- Release work: branch `VasuBansal7576/gather-adr016` on top of the wave base.
  The release commit SHA (local and remote, verified equal) is recorded in
  the 016 completion handoff, not baked into this file.
- Suite at release: 951 tests, 947 pass, 0 fail, 4 skipped (opt-in
  `GATHER_TEST_OPENCLAW_BIN` process checks, unset here).
- `npm run typecheck` clean, `npm run build` clean, `gather-doctor` passes
  with BLOCKED skips for missing profile credentials.
- Video: NOT recorded (owner action, only after the flow works — 016
  performs no recording). Registration / submission / publish / deploy: NOT
  performed (separate owner actions; no authority implied).

## 1. Selected-only profiles (016-A03 core)

- Registry `src/integrations/registry.ts` imports the real exports
  `ASSEMBLYAI_PROFILE` (013), `AMAZON_OWNER_MCP_PROFILE` (014),
  `NEBIUS_INTEGRATION_PROFILE` (015) plus base. No stubs.
- Selection: `GATHER_INTEGRATION_PROFILE` (default `base`; unknown values
  fall back to `base`, never enabling a sponsor adapter by accident).
- `routeProfileData` delivers to the selected receiver only.
- Artifact: `tests/release-profile-routing.test.ts` (3 tests green —
  exact-export registration, selection fallback, disabled adapters receive
  nothing across all four selections).
- UI: setup page "Submission profile" selector (`app/setup/page.tsx`,
  UI-only, persisted to localStorage + `gather:profile-change` event);
  workspace mounts exactly one event panel (`src/host/GatherHostWorkspace.tsx`:
  `VoiceProfileMount` for assemblyai wired to the real
  `/api/voice/status` + `/api/voice/transcribe` routes, `EventGateMount`
  capability readouts for amazon/nebius). Unselected mounts stay unmounted.
- Rendered evidence: built app HTML contains the selector and mount
  wiring (see §4 UX row; curl excerpts recorded at release).

## 2. PRD section-10 gate map

| Gate | Verdict | Artifact or blocker |
| --- | --- | --- |
| Local run | PROVED (scripted) | `npm ci`, `mkdir -p .runtime`, `node scripts/gather-doctor.mjs` (passes), `npm run build`, `GATHER_DATABASE_PATH=.runtime/owner-demo.sqlite npm start` serves `/setup`. No keys, no OpenClaw install, no external accounts on the prepared path. |
| First run | PROVED | Setup page presents Prepared vs Live; live card disabled with reason (`app/setup/page.tsx`); live-gate fetch shows BLOCKED list. |
| Prepared business | PROVED | `tests/release-prepared-sequence.test.ts`: glasshouse seeds 6 inbox / 3 inquiries / 3 non-events; `seedPreparedFixtures` + `readPreparedState` for all five scenarios. Labels simulated throughout. |
| Scope boundary | PROVED | Existing `intake-gate`, `identity`, `backend-gates` suites green; release voice test shows eligible inquiry stays eligible while transcript instructions never grant authority (`assemblyai-clarification` suite green). |
| Live mode | BLOCKER | No authorized Google OAuth client, test accounts, model access, or recipient in this run. `evaluateLiveGate` BLOCKED for all four profiles (`tests/release-prepared-sequence.test.ts`); doctor reports `SKIP ... BLOCKED` per knob. Prepared mode unaffected. |
| Local runtime | PROVED (install boundary) / BLOCKER (live boot) | Runtime provisions under `.runtime/live/openclaw/`, never `~/.openclaw` (existing `runtime`, `runtime-control`, `runtime-manifest-auth` suites green). Live boot needs operator binary + login: BLOCKED here (4 opt-in process tests skip visibly). |
| Runtime lifecycle | PROVED (scripted) / BLOCKER (live restart) | Pinned manifest `scripts/gather-runtime-manifest.json`; restart/recovery scripted suites green (`runtime-cancellation`, `operator-runtime`, `incidents`). Real restart proof needs the live runtime: BLOCKED here. |
| Understanding | PROVED (scripted) | Knowledge suites green (`knowledge`, `knowledge-conflicts`, `knowledge-rules`, `knowledge-offers`); owner rule applies with citation (release eval test: pricing_bounds correction lands and K06 passes). |
| Progressive ingestion | PROVED (scripted) | `source-sync`, `google-incremental-scope`, `google-read-*` suites green; partial/failed scenarios report honestly (`016 sequence: empty/partial/error scenarios`, green). |
| Native knowledge selection | PROVED (scripted gate) / BLOCKER (live recall) | `native-knowledge-gate`, `native-knowledge-capability` suites green incl. `008-A04 real-runtime probe stays honestly skipped without an explicit harness`. Live OpenClaw recall + memory-wiki proof needs the opted-in harness: BLOCKED here. |
| Knowledge lifecycle | PROVED | `knowledge-conflicts`, `backend-corrections`, `offers-corrections` suites green; accepted commitments unchanged by correction (existing suites). |
| Evaluation | PROVED | `evals`, `knowledge-eval-scorer` suites green; release test measures a correction 5/6 → 6/6 with verdict `improved` on the SAME `005-v1` denominator + `NO_CAUSAL_CLAIM`. |
| Booking journey | PROVED (scripted) | `tests/golden-path.test.ts` green (002-A04 scaffold + 010-A05 fresh inquiry-to-offer-to-approved-hold/email incl. crash reconcile, version invalidation, availability block). All receipts simulated and labelled. Live provider journey: BLOCKER (see Live mode). |
| Customer acceptance | PROVED (scripted) / BLOCKER (live mail) | `customer-acceptance`, `backend-expiry-lifecycle`, workspace `006 callback` tests green (token binding, supersede/forward/replay handling, accepted ≠ confirmed). Real Gmail send/receive proof: BLOCKED here. |
| Exact authority | PROVED | `proposal-authority`, `authority-floors`, `commercial-contract`, `offers` suites green; stale/changed approvals rejected; floors hold. |
| Recovery | PROVED | `faults`, `data-recovery`, `incidents`, `delivery.defects` suites green; golden restart tests preserve holds, reconcile uncertainty, dedupe retries. |
| Self-healing | PROVED (scripted) | `incidents`, `operator-runtime`, `budget-persistence` suites green; injected faults detected/diagnosed/repaired from the catalog with verification; exhaustion ends BLOCKED with attempts listed (existing suites). Real-runtime restart diagnosis needs the harness: BLOCKED here. |
| Budgets | PROVED | `budget-persistence`, `runtime-model-config`, `tool-allowlist` suites green; Nebius path reserves via `RuntimeControl.submit` before the call (release test asserts 1 submission / bounded tools). |
| Isolation | PROVED | One business per installation; server-derived scope (`identity-source-key`, `oauth-boundary`, `setup-contracts` suites green); Amazon MCP hides customer content (release attention round-trip asserts no inquiry text); workspace payload carries no secrets (`006 hygiene`). |
| External-content boundary | PROVED | `intake-gate`, assemblyai clarification (injection) suites green; concession claims rejected with reason (`authority-floors`, `commercial-contract`). |
| UX | PROVED (rendered) | Production build served on loopback: `/setup` renders the Submission profile selector shell (labels hydrate from the live status API); the workspace bundle ships the voice + gate mounts behind single-profile selection; mobile/keyboard states in existing `host-integration`, `setup-*`, `knowledge-rules-ui` suites. Demo video: BLOCKER — owner records after the flow works; 016 records nothing. |
| Submission | PARTIAL — blockers named | License: MIT `LICENSE` at top, detectable. Runnable instructions: README (demonstrated commands only). New-work log + baselines: §3 below. Video: BLOCKER (owner action). Registration/submission/deploy: NOT performed (no authority; owner actions). |

Rendered evidence (production `npm run build` + loopback `npm start`,
this release — commands in §4 / README):

- `GET /setup` (200) SSR HTML contains the `Submission profile` section
  with the `GATHER_INTEGRATION_PROFILE` note; the four profile labels
  hydrate client-side from `GET /api/live-model/status?profile=base`,
  which returns all four profiles with `available: true` (verified
  payload for `nebius`: registry description, credential requirements,
  `intakeAdapter: model-call`, `implementationStatus: implemented`).
- The workspace client bundle (`app/page-*.js`) contains the `Voice
  intake` mount and both `EventGateMount` readouts (`Amazon owner
  interface`, `Nebius/NVIDIA model`, `selected profile` strings present);
  mounts render only for the selected profile (default base renders
  neither — selection is read from localStorage on load).
- `GET /api/voice/status` (200) returns the real gate:
  `enabled: false`, `voiceGate: blocked`, exact `GATHER_ASSEMBLYAI_API_KEY`
  missing evidence, and the upload bounds.

## 3. PRD section-11: per-event verification (rechecked 2026-09-18)

Research snapshot in the PRD was 2026-09-16; all three rulebooks were
re-fetched on 2026-09-18. PRD §11 facts confirmed accurate — no PRD rule
changes made. License: MIT `LICENSE` present at repository top level.

Baseline: the repository's first commit `25476b6` (2026-09-13) postdates
all three window starts, so it is the baseline commit for every event and
all repository work is new within each window. Reuse disclosed: the Gather
base application (booking engine, SQLite store, setup/workspace UI,
Google-connector scaffolding) predates the event adapters and is reused
unchanged; each event's adapter + release wiring is new work (below).

### AssemblyAI Voice Agent Hackathon

- Rules: Sep 1–30, 2026, fully online, join anytime; mandatory AssemblyAI
  usage in a voice-agent project; $10,000 pool ($5,000 cash + credits).
  Source: https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon
- Baseline commit: `25476b6` (window start Sep 1 predates the repo).
- New work: `src/integrations/assemblyai/*` (client, config, bounded
  validation, scripted + live transcription with dedupe, C02 voice intake
  envelope, capability gate), `app/api/voice/*` routes,
  `VoiceIntakePanel` + 016 workspace mount, setup profile entry; scripted
  fixtures `tests/fixtures/assemblyai/*`.
- Reused: shared domain gate, qualification, offer/approval engine,
  SQLite receipts (unchanged).
- Evidence: `assemblyai-transcribe`, `assemblyai-clarification` suites +
  release sequence voice tests green (scripted). Exact profile:
  `assemblyai`, intake adapter `voice`.
- BLOCKER (013-A01): live transcription needs `GATHER_ASSEMBLYAI_API_KEY`
  plus an operator-supplied authorized recording — neither present here.
  Recorded as BLOCKED, not skipped-pass, in code, doctor, and tests.

### Amazon Build, Ship, Shape (Alexa+ track)

- Rules: submission period Aug 31 10:15am PT – Oct 23 12:00pm PDT;
  Alexa+ path = working Agent Skill OR self-hosted MCP server implementing
  MCP spec ≥ 2025-11-25 over Streamable HTTP, OR a simulated Alexa+
  experience (simulated path is exempt from the runtime-hook rule but still
  needs simulation source + demo video); existing projects need significant
  updates in-window; public repo with top-level-detectable license;
  working demo; video < 3 min (YouTube/Vimeo); track selection + product
  feedback required; multiple entries must be unique/substantially
  different; $25,000 1st / $15,000 2nd in the Alexa+ track; $150 AWS
  credits on request by Oct 21. Source:
  https://amazonappdev2026.devpost.com/rules
- Baseline commit: `25476b6` (window start Aug 31 predates the repo).
- New work: `src/integrations/amazon/index.ts` (loopback Streamable HTTP
  MCP surface over the pinned `@modelcontextprotocol/sdk` 1.30.0 — no new
  dependency — with `what_needs_attention` /
  `prepare_exact_offer_approval` / `confirm_exact_offer`, exact-version
  confirmation context, per-session auth, no customer content), 016
  registry entry + `EventGateMount` status readout, setup profile entry.
- Reused: booking engine authority (MCP is advisory-only; receipts still
  come from Gather's store via exact approval), isolation boundary.
- Evidence: `amazon-owner-mcp` suite + release attention round-trip green
  (scripted, loopback). Exact profile: `amazon`, intake adapter
  `owner-mcp`. No Alexa-platform claim: labelled loopback/self-hosted.
- BLOCKERS: externally reachable deployment (needs separately authorized
  secure deployment — loopback only here); demo video, track selection,
  product feedback, registration/submission (owner actions, not performed).

### Nebius x NVIDIA Global AI Hackathon (Personal AI track)

- Rules: submission period Aug 26 9:00am PT – Oct 30 10:00am PDT;
  mandatory runtime call to Nebius Token Factory (or run on Nebius AI
  Cloud) + at least one NVIDIA open-source model; Personal AI track
  (always-on private assistant, data under control, persistent memory,
  reusable skills) with local-first Gather on OpenClaw as fit; existing
  projects need significant in-window updates; public OSS-licensed repo
  with source/assets/run instructions; working demo or test build;
  project description; technology feedback; public video < 3 min
  (YouTube); one track per submission (also eligible for Overall awards).
  Source: https://nebiusglobalaihackathon.devpost.com/rules
- Baseline commit: `25476b6` (window start Aug 26 predates the repo).
- New work: `src/integrations/nebius/index.ts` (operator-verified NVIDIA
  identity, qualifying-endpoint check, budget-reserved call through
  `RuntimeControl`, injected transport so scripted checks never contact
  Nebius — no new dependency), 016 registry entry + `EventGateMount`
  status readout, setup profile entry.
- Reused: booking tools surface (`GATHER_BOOKING_TOOLS`), runtime budget
  boundary, SQLite receipts (unchanged).
- Evidence: `nebius-model` suite + release Nebius tests green (scripted
  transport). Exact profile: `nebius`, intake adapter `model-call`.
- BLOCKERS: qualifying live Token Factory call needs
  `GATHER_NEBIUS_API_KEY` + operator-verified NVIDIA model id + credits —
  absent here (scripted transport only); demo video, tech feedback,
  registration/submission (owner actions, not performed).

## 4. Determinism and boundaries

- CI (`.github/workflows/ci.yml`, unchanged) runs `npm ci`, doctor,
  typecheck, test, build on Linux + macOS with no secrets and
  read-only permissions. `GATHER_INTEGRATION_PROFILE` unset in CI, so the
  safe `base` default applies; failures would come only from code.
- No new dependencies were requested or added: AssemblyAI uses existing
  `fetch`, Amazon uses the pinned `@modelcontextprotocol/sdk`, Nebius
  uses an injected transport. `package.json` / `package-lock.json`
  unchanged by 016.
- Never touched: `~/.openclaw`, live customer data, credentials,
  databases, `.runtime/` contents (git-ignored), merges, deploys,
  purchases, registrations, video recording.
- Out of scope, not performed: publish/submit/register/deploy, hosted
  SaaS, billing, autonomous redeploy.
