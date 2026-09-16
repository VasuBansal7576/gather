# Public execution index

Chief prepared this plan for the **public hackathon build**. It is a static coverage/dependency contract, not another progress ledger. ADR-000 is historical, `000-template.md` is a template, and ADRs 001–016 are specified work orders. Six earlier proposals have been reconciled and ten missing scopes added; this is not a claim to have recovered a historical fifteen-ADR plan.

**Implementation remains paused in this planning change.** After the owner explicitly starts execution, Orca can use this plan without rediscovering product requirements. Specified does not mean implemented, tested, live-verified or shipped. No credentials, purchases, deployments, submissions or merges are authorized by a document status.

Read: [PRD](../HACKATHON_PRD.md) -> [shared contracts](CONTRACTS.md) -> this index -> assigned ADR and its cited module guides. The PRD governs scope; contracts define cross-ADR semantics; an ADR owns implementation. Chief resolves any conflict before affected work continues. Workers may choose internal implementation details within those boundaries.

## Work orders and dependencies

| ADR | Responsibility | Depends on |
| --- | --- | --- |
| [001](001-local-first-product-shell.md) | Packaged entry, mode isolation, prepared fixtures/reset | none |
| [002](002-durable-intents-and-golden-path.md) | Durable intent envelope, one progression owner, test scaffold | 001 |
| [003](003-scope-and-authority-boundary.md) | Event relevance, qualification boundary, deterministic authority | 002 |
| [004](004-self-healing-system.md) | Incident detection, catalog repair, verification and continuation | 002, 007, 009, 010 |
| [005](005-knowledge-and-self-improvement-ux.md) | Owner knowledge review/correction and regression UX | 003, 008 |
| [006](006-live-mode-on-own-accounts.md) | Complete workspace and live subsystem composition | 004, 005, 011, 012 |
| [007](007-progressive-source-ingestion.md) | Progressive sync, source versions/deletions, truthful coverage | 003 |
| [008](008-native-knowledge-adapter.md) | Native recall/wiki adapter, selection gate and safe cutover | 007, 009 |
| [009](009-runtime-provisioning-and-budgets.md) | Isolated runtime, supported model access, budgets and lifecycle | 001 |
| [010](010-booking-lifecycle-and-followups.md) | Fresh inquiry-to-offer, identity, holds/replies/follow-ups/takeover | 002, 003, 005 |
| [011](011-customer-acceptance-and-handoff.md) | Signed acceptance by email, confirmation and handoff | 010 |
| [012](012-google-onboarding-and-secrets.md) | Google consent/Picker and secret lifecycle | 007, 009 |
| [013](013-assemblyai-voice-intake.md) | AssemblyAI profile | 006 |
| [014](014-amazon-owner-mcp.md) | Amazon owner MCP profile | 006 |
| [015](015-nebius-nvidia-model.md) | Nebius/NVIDIA model profile | 006 |
| [016](016-release-evidence-and-orca-integration.md) | Profile integration and complete release evidence | 006, 013, 014, 015 |

Dependencies mean reviewed predecessor code and contracts are integrated into the worker's base, not that a predecessor agent merely reported completion. A task has separate **contract-ready** and **fully verified** checkpoints: consumers may proceed against an integrated interface with passing scripted contract tests while an explicitly recorded external credential/live-proof gate is pending. Such consumers remain prepared/scripted-only; enabling live behaviour and final release require all relevant real gates. A failed native semantic gate cannot be waived as credential absence or marked fully verified. One rejected acceptance item does not become satisfied by a green unrelated test suite. Real-evidence blockers remain blockers; no downstream release claim may conceal them.

## Safe execution waves

| Wave | Tasks eligible after predecessor verification | Write-conflict rule |
| --- | --- | --- |
| 1 | 001 | Exclusive installation/setup/fixture changes |
| 2 | 002 and 009 | Separate server progression versus isolated runtime; no shared package/lock edits |
| 3 | 003 | Authority/intake boundary after intent contract |
| 4 | 007 | Source pipeline after domain gate |
| 5 | 008 and 012 | Native-knowledge/runtime adapter versus Google/setup; neither edits the other's ports |
| 6 | 005 | Owner correction and evaluation on verified knowledge port |
| 7 | 010 | Lifecycle integration owns shared booking/store/waiting files exclusively |
| 8 | 004 and 011 | Incidents/health/due-work versus acceptance/intake/delivery; central store writes belong only to 004 in this wave |
| 9 | 006 | Shared host/UI/runtime composition exclusively |
| 10 | 013, 014 and 015 | Disjoint event adapter modules/tests/docs; no common registry/package/lock edits |
| 11 | 016 | Integrator mounts profiles and proves final artifact |

The depth follows actual subsystem dependencies, not a target number of simultaneous agents. A valid serial order is 001, 002, 009, 003, 007, 008, 012, 005, 010, 004, 011, 006, 013, 014, 015, 016. The coordinator may run the listed independent pairs/triple concurrently, never invent independence to fill worker slots.

Before dispatch, expand the ADR's Owns paths against the current checkout. Claim an exclusive lease for each shared path/glob; future new files are included in the claim. `package.json`, lockfiles, common host/DTOs, `src/server/sqlite-store.ts`, `src/server/runtime.ts` and `tests/golden-path.test.ts` are single-writer files. If an implementation needs another worker's path, send a concrete coordination request; serialize that edit after its owner settles. Do not weaken Must not touch or grant broad repository ownership.

Each worker has one authoritative task attempt in its own worktree. Never relaunch on mere timeout/contact loss. Use Orca's version-matched lifecycle rules for questions, completion evidence and terminal ownership. The coordinator is responsible for integration tests after combining branches, not just branch tests.

## PRD requirement coverage

Every PRD section is mapped below. The final column names the acceptance IDs in the owning ADR; C-references are shared requirements, not separate work items. Section-10 gates are mapped separately to make release verification explicit.

| PRD requirement group | Owning ADR(s) | Contract and acceptance |
| --- | --- | --- |
| 1 audience, owner-side operator, public/private boundary | 001, 006, 016 | C01/C12; 001-A01, 006-A01, 016-A01 |
| 2 full first-run/user journey | 001, 006, 010, 011 | C01/C05/C07; 001-A04, 006-A01–A04, 010-A05, 011-A01–A04 |
| 2.1 CLI, paths, isolation, startup/reset | 001 | C01; 001-A01–A04 |
| 2.2 prepared/live distinction and controlled recipient | 001, 003, 006, 009 | C01/C05/C08; 001-A04, 003-A02/A04, 006-A02/A03, 009-A01 |
| 3 OAuth, account ownership, narrow scopes, tokens and reconnect | 012 | C11; 012-A01–A04 |
| 3 reads/writes/pagination/import and stale/partial state | 007, 006 | C03; 007-A01–A04, 006-A02 |
| 3.1 common source-tagged intake, no channel authority | 003, 007, 013, 014 | C02; 003-A01–A04, 007-A04, 013-A02, 014-A02 |
| 4 native understanding, provenance, scoped policy/conflicts | 008, 005 | C04; 008-A01–A04, 005-A01/A02 |
| 4 focused questions, readiness, qualification/pricing/alternatives | 010 | C05; 010-A01/A05 |
| 4.1 concessions, cumulative floors, exact owner decisions | 003, 005, 010 | C05; 003-A02, 005-A04, 010-A01/A03 |
| 4.2 progressive history, caches, cursors, excluded sampling | 007 | C03; 007-A01–A04 |
| 4.2 knowledge changes, authority, readiness/freshness | 008, 005, 010 | C04/C05; 008-A02/A03, 005-A01, 010-A01/A03 |
| 4.3 typed facts/source metadata and scope/authority | 008, 005, 003 | C04/C05; 008-A01/A03, 005-A02, 003-A02 |
| 4.3 honest no leads/no facts versus unavailable/incomplete | 007, 005, 006 | C03/C04; 007-A01, 005-A04, 006-A01 |
| 4.3 source deletion and one-business boundary | 001, 007, 008 | C01/C03/C04; 001-A04, 007-A02/A04, 008-A01/A02 |
| 4.4 event-only gate, incomplete inquiries and malicious content | 003 | C05; 003-A01–A04 |
| 5 stable booking identity/ambiguity | 010 | C02; 010-A02 |
| 5 versioned grounded offers, exact approval, refreshed conditions | 003, 010 | C05/C06; 003-A02, 010-A01/A03/A05 |
| 5 durable intent, separate verified hold/email effects | 002, 010, 006 | C06; 002-A01–A04, 010-A03/A05, 006-A02 |
| 5 replies before follow-up, hold expiry, pause/takeover/resume | 010 | C07; 010-A03/A04 |
| 5.1 signed customer acceptance, supersession, no account/payment claim | 011 | C07; 011-A01–A04 |
| 6 detection/diagnosis/repair/verification/useful continuation | 004 | C08/C09; 004-A01–A04 |
| 6.1 durable intents and uncertain outcomes | 002 | C06; 002-A01–A03 |
| 6.2 incidents/health/deadletters | 004 | C09; 004-A01/A02 |
| 6.3 repair tiers, read-only diagnosis and code-patch proposal | 004, 009 | C08/C09; 004-A03/A04, 009-A03 |
| 6.4 owner repair trail | 004, 006 | C09/C10; 004-A02, 006-A01 |
| 6.5 labelled injected faults versus actual runtime evidence | 004, 009, 016 | C01/C09/C10; 004-A02/A03, 009-A01, 016-A01/A04 |
| 6.6 bounded catalogue, no authority changes/duplicate effects | 004 | C09; 004-A01–A04 |
| 7 Today/Booking/Connections/Understanding/Recoveries/trend | 005, 006 | C10; 005-A03/A04, 006-A01 |
| 7 responsive, accessible, honest persisted UI | 001, 006 | C10; 001-A04, 006-A01/A03 |
| 7.1 interactive demo script including empty scans | 006, 016 | C10/C12; 006-A01, 016-A01/A04 |
| 8 reusable foundation with explicit independent adapters | 006, 013–016 | C12; 006-A03, 013-A03, 014-A03, 015-A03, 016-A03 |
| 8.1 isolated pinned runtime and provisioning | 009 | C08; 009-A01/A03 |
| 8.2 consistent backup/compatible restoration/external reconciliation | 009, 004 | C08/C09; 009-A04, 004-A03 |
| 8.3 model access, secret references and run budgets | 009, 012, 015 | C08/C11; 009-A01–A03, 012-A04, 015-A02 |
| 8.4 design before implementation and bounded task scopes | all, coordinator | This index + per-ADR Owns/Dependencies/Acceptance/Completion handoff |
| 8.5 minimal stack, supported extension points, no competing brains | 008, 002, 007 | C03/C04/C06; 008-A04, 002-A01, 007-A02 |
| 8.6 specified release defaults and capability failure outcomes | 001, 007–012 | C01–C11; corresponding acceptance IDs above |
| 9 confirmed conditions, immutable accepted terms, handoff/exclusions | 011, 016 | C07/C12; 011-A03/A04, 016-A01 |
| 10 all release gates | 016 plus gate owners below | 016-A01–A04 |
| 11 common license/new-work baseline/profiles/evidence | 016 | C12; 016-A01–A03 |
| 11 AssemblyAI actual voice | 013 | C12; 013-A01–A03 |
| 11 Amazon owner-interface route and protocol | 014 | C12; 014-A01–A03 |
| 11 Nebius runtime + NVIDIA model | 015 | C12; 015-A01–A03 |

## Section-10 release gate owners

| Gate (exact PRD label) | Implementation owner | Final verifier |
| --- | --- | --- |
| Local run | 001 | 016 |
| First run | 001, 006 | 016 |
| Prepared business | 001, 006 | 016 |
| Scope boundary | 003 | 016 |
| Live mode | 006, 012 | 016 |
| Local runtime | 009 | 016 |
| Runtime lifecycle | 009, 004 | 016 |
| Understanding | 008, 005 | 016 |
| Progressive ingestion | 007 | 016 |
| Native knowledge selection | 008 | 016 |
| Knowledge lifecycle | 008, 005 | 016 |
| Evaluation | 005 | 016 |
| Booking journey | 010, 006 | 016 |
| Customer acceptance | 011 | 016 |
| Exact authority | 003, 010, 011 | 016 |
| Recovery | 002, 010, 004 | 016 |
| Self-healing | 004 | 016 |
| Budgets | 009, 015 | 016 |
| Isolation | 001, 003, 007, 008, 009, 012 | 016 |
| External-content boundary | 003, 005, 008, 013, 014 | 016 |
| UX | 006 | 016 |
| Submission | 013, 014, 015, 016 | 016 |

## External prerequisites are not missing product decisions

Orca can implement against the specified ports and scripted tests after authorization. It cannot fabricate proof of a configured Google client/Picker, supported model login, native knowledge capability, or sponsor call. Relevant ADRs define the experiment and exact blocked outcome. Chief owns resolving a failed capability check or obtaining operator configuration within authority; the worker reports concrete evidence instead of selecting another architecture.

No direct-to-Composio fallback, new paid service, public server, personal runtime access or scope expansion happens automatically. An absent key is a live-proof blocker, not a reason to ask the user to redesign the product or to fake a receipt. Default tests remain entirely local.

For base-only or a single-event build, the owner can select that profile explicitly; do not silently omit other target events from an all-events request. ADR-016 can check base evidence early, but its all-events completion remains blocked until all listed dependencies and qualifying event proofs are available.
