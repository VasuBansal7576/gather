# Gather ↔ OpenClaw runtime adapter

`src/runtime/` implements the isolated, supported OpenClaw backend adapter for
Gather. It supervises a dedicated `openclaw gateway` child process, talks to it
over the Gateway WebSocket protocol with the published client package, and
exposes Gather-owned tools to the agent through an authenticated loopback MCP
boundary.

Everything the instance touches — config, state, workspace, secrets, temp,
logs — lives under one Gather-owned root (`.runtime/openclaw`, gitignored). The
developer's personal `~/.openclaw` install, credentials, and memory are never
read or written.

## Verified package interface

| Package | Pinned | Evidence |
| --- | --- | --- |
| `openclaw` (runtime binary) | host-installed `2026.9.4`, resolved as an explicit absolute path and verified via `--version` (`OpenClaw x.y.z` banner required) | `npm view openclaw bin` → `openclaw.mjs` entry; `resolveInstalledPackageEntry()` mirrors the embedding doc's `import.meta.resolve("openclaw")` + sibling `openclaw.mjs` pattern |
| `@openclaw/gateway-client` | `2026.9.4` | exports `GatewayClient`, `GatewayClientOptions`, `GatewayClientRequestError`, `GatewayClientRequestTimeoutError`, `GatewayTransport`, readiness helpers |
| `@openclaw/gateway-protocol` | `2026.9.4` (transitive) | `ConnectParamsSchema` / `HelloOkSchema` in `dist/frames-*.d.mts` |
| `@modelcontextprotocol/sdk` | `1.30.0` | `McpServer.registerTool`, `StreamableHTTPServerTransport` in `dist/esm/server/` |
| `zod` | `4.6.4` | satisfies the SDK's `^3.25 \|\| ^4.0` dependency |

RPC methods used (all verified in the installed server's method table and the
RPC reference at `docs.openclaw.ai/gateway/protocol/rpc-methods`):

| Method | Scope | Use |
| --- | --- | --- |
| `agent` | `operator.write` | start one run; params `message`, `sessionKey`, `idempotencyKey` (required), `deliver`, `label`, `timeout`, `extraSystemPrompt`; returns `{runId, acceptedAt}` |
| `agent.wait` | `operator.write` | wait for terminal snapshot; params `{runId, timeoutMs}`; returns `{status: ok\|error\|timeout, ...}` |
| `chat.history` | `operator.read` | session transcript for evidence display |
| `sessions.list` | `operator.read` | durable session index |
| `status` | `operator.read` | gateway status summary |
| `config.get` | `operator.write` | redacted config snapshot — proves the written config was accepted |

Every RPC response is validated at the boundary (`tasks.ts`): a malformed
`agent` reply (missing `runId`/`acceptedAt`) or `chat.history` reply
(non-array `messages`) throws instead of being trusted. An `agent.wait`
status outside the known set maps to `"unknown"` with
`executionMayContinue: true` — an unrecognized status can never imply the
remote run finished.

## Isolation contract

Child environment is built by `buildGatewayChildEnv` in
`src/runtime/process.ts` — a **minimal** env (not `process.env`):

| Variable | Value | Why |
| --- | --- | --- |
| `OPENCLAW_HOME` | `<root>/home` | replaces `$HOME` for OpenClaw path defaults; no personal-home fallback |
| `HOME` | `<root>/home` | belt-and-suspenders for OS-level `~` expansion |
| `OPENCLAW_STATE_DIR` | `<root>/state` | sessions/creds/caches stay Gather-owned |
| `OPENCLAW_CONFIG_PATH` | `<root>/openclaw.json` | per-instance config |
| `OPENCLAW_WORKSPACE_DIR` | `<root>/workspace` | per-instance agent workspace |
| `OPENCLAW_GATEWAY_PORT` | configured port | unique per instance |
| `OPENCLAW_GATEWAY_TOKEN` | generated per provision, stored `<root>/secrets/gateway-token` (0600) | shared-token auth |
| `GATHER_MCP_TOKEN` | generated per provision, stored `<root>/secrets/mcp-token` (0600) | MCP boundary bearer auth |
| `TMPDIR` | `<root>/tmp` | scratch files stay Gather-owned |
| `OPENCLAW_CONFIG_READONLY` | `1` | config is externally managed |
| `OPENCLAW_SKIP_CHANNELS` | `1` | control-plane only; Gather owns Gmail/Calendar connectors |
| `OPENCLAW_NO_RESPAWN` | `1` | host keeps ownership of the tracked PID |
| `OPENCLAW_DISABLE_BONJOUR` | `1` | host owns discovery |
| `OPENCLAW_EXEC_SHELL_SNAPSHOT` | `0` | no login-shell snapshot |

`OPENCLAW_LOAD_SHELL_ENV` is never set. Caller-supplied `extraEnv` is restricted
to an explicit diagnostic allowlist (`EXTRA_ENV_ALLOWLIST`):
`OPENCLAW_LOG_LEVEL`, `OPENCLAW_DIAGNOSTICS`,
`OPENCLAW_DIAGNOSTICS_TIMELINE_PATH`, `OPENCLAW_DEBUG_SSE`,
`OPENCLAW_DEBUG_MODEL_TRANSPORT`. Everything else — including isolation keys,
runtime toggles (`NO_RESPAWN`, `SKIP_CHANNELS`, `CONFIG_READONLY`,
`EXEC_SHELL_SNAPSHOT`), `OPENCLAW_LOAD_SHELL_ENV`, and `NODE_OPTIONS` — is
rejected, so no personal imports or policy weakening can ride along.

## Materialized config (`config.ts`)

Written `openclaw.json` contains no secrets (env substitution for both
tokens):

- `gateway`: `mode: "local"`, `bind: "loopback"`, configured port,
  `auth.mode: "token"`, `token: "${OPENCLAW_GATEWAY_TOKEN}"`.
- `agents.defaults.workspace`: Gather-owned workspace.
- `tools`: `profile: "messaging"` plus a deny list (`GATHER_TOOL_DENY`)
  covering `group:runtime` (exec/process/code_execution), `group:fs`
  (read/write/edit/apply_patch), `group:web`, `browser`, `cron`, `subagents`,
  `sessions_spawn`, `image_generate`, `music_generate`, `video_generate`.
  Per `docs.openclaw.ai/gateway/config-tools/tool-policy`: profiles are the
  base allowlist and deny always wins; `messaging` keeps MCP tools visible
  (`minimal` hides them) while the deny list is the hard stop for every
  mutating/arbitrary surface — the agent's only business capability is the
  Gather MCP boundary. Sandboxing stays off (no backend provisioned); exec/fs
  denies make host mutation unreachable.
- `logging.file`: `<root>/logs/gateway.log` — supported config
  (`docs.openclaw.ai/logging`, `/gateway/config-observability`), so gateway
  file logs stay inside the Gather-owned root instead of the shared
  `/tmp/openclaw` default.
- `mcp.servers.gather` (when tools are registered): `transport:
  "streamable-http"`, loopback URL, `headers.authorization: "Bearer
  ${GATHER_MCP_TOKEN}"` (the `headers` field is marked *sensitive* in the
  OpenClaw config schema — it resolves via env substitution and is redacted
  from config snapshots and logs), and `toolFilter.include` = registered tool
  names.

## Lifecycle semantics

- **Executable**: `resolveOpenClawExecutable` requires either an explicit
  absolute validated path or the installed `openclaw` package entry
  (`import.meta.resolve` + sibling `openclaw.mjs`); bare PATH commands are
  rejected — the adapter never selects an arbitrary runtime. `start()` then
  verifies the executable via `--version` (`OpenClaw x.y.z` required) under
  the minimal env before spawning.
- **Boot**: spawn `openclaw gateway`. A spawn-level error (missing or
  unexecutable binary) rejects `start()` immediately — it is never mistaken
  for a running child. Exit `78` (`EX_CONFIG`) triggers one
  `doctor --fix --yes --non-interactive` repair under the same env and one
  retry. Process survival is not readiness.
- **Readiness**: `connect()` resolves on `hello-ok` within a caller deadline
  (default 30 s). The library retries `startup-sidecars` closes internally.
- **Reconnect**: the client owns backoff/reconnect; the adapter surfaces
  `connecting`/`ready`/`reconnecting`/`closed`.
- **Facade startup**: `GatherOpenClawRuntime.start()` is single-flight —
  concurrent calls share the one in-flight startup. A new startup is rejected
  whenever *any* previously owned resource remains — a live or unexited child
  process, a WS connection (ready OR disconnected), or an MCP boundary — and
  while a `stop()` is in flight; a failed start rolls back only the resources
  that invocation owned and keeps the process reference whenever the child's
  exit was not verifiably observed, so a retry can never orphan a second
  process. Recovery is allowed only after an observed `stop()` has released
  every owned reference.
- **Shutdown**: `stop()` is single-flight (concurrent callers share the
  teardown) and first lets any in-flight startup settle, then closes the WS
  client (`stopAndWait`), SIGTERMs the child and waits for the *observed*
  exit event; SIGKILL follows after the grace window. If no exit is observed
  even after SIGKILL the state is `failed` (never `stopped`), resources are
  retained, and `stop()` rejects — "stopped" always means the exit was
  observed.
- **Signals**: `openclaw-doctor.mjs` runs the same coordinated shutdown on
  SIGINT/SIGTERM — client close, observed child exit, then cleanup of only
  the unique doctor-owned directory — before exiting 130/143.

## Task API

`GatherRuntimeTasks`:

- `submitTask({bookingId, message, idempotencyKey, ...})` → `agent` RPC on
  the stable per-booking session `agent:<agentId>:gather:booking:<slug>-<digest>`,
  where the digest is sha256 over the exact bookingId+agentId — sanitization
  can never alias distinct bookings ("a/b" ≠ "a-b"). `deliver: false` — Gather
  renders results itself. `stableTaskIdempotencyKey` derives the required
  `idempotencyKey` (sha256 over sorted identity) — the duplicate-run
  prevention hook.
- `waitForRun({runId, timeoutMs})` → `agent.wait`. **`status: "timeout"` is
  wait-only** — `executionMayContinue: true`; the remote run may still be
  executing. `stopReason: "superseded"` preserved verbatim. Unknown statuses
  → `"unknown"` + `executionMayContinue: true`.
- `sessionHistory` → `chat.history`; `listSessions` → `sessions.list`;
  `gatewayStatus` → `status`; `configSnapshot` → `config.get`.

## MCP tool boundary

`GatherMcpBoundary` hosts the `gather` MCP server on loopback with the
official SDK's stateful Streamable HTTP transport.

**Authorization** (loopback alone is not authorization):

- `Authorization: Bearer <token>` required on every request — a locally
  generated secret shared with the gateway only through the supported
  `mcp.servers.gather.headers` config field (sensitive/redacted, never a
  config literal, never logged).
- Host header must match the bound loopback address; a present Origin header
  must match the bound origin — DNS-rebinding defense implemented in this
  middleware (the SDK's own `allowedHosts`/`allowedOrigins` options are
  deprecated in favor of external middleware).

**Session lifecycle**: one transport per MCP session — the SDK's stateful
transport serves exactly one initialization, so each `initialize` creates a
fresh session entry (this is the reconnect path after an MCP client restart);
`DELETE` and boundary `close()` reap sessions. Non-initialize requests with
missing/unknown session ids get `404` per the MCP spec.

**Authority rules** (structural):

- Tools are registered via `defineGatherTool` — typed handlers with a zod
  input schema, erased to `unknown` args only after SDK-side validation
  (no `any`).
- Every tool declares `execution: "live" | "simulated"` — no silent default.
  Simulated tools get `[SIMULATED — not a verified integration]` in their
  description and results, `gather:simulated: true`, and any `verified`
  claim stripped.
- Every result is stamped `gather:authority: "advisory"`. This boundary never
  mints booking receipts: durable `ActionExecution` records are created only
  by Gather's own store through approved-action execution. Model prose and
  arbitrary tool calls cannot manufacture a verified receipt here, and
  OpenClaw's tool approval is a separate mechanism that confers no Gather
  booking authority.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 42 tests pass. `tests/runtime.test.ts` covers isolation,
  config materialization, env allowlist rejection, executable validation,
  collision-proof session keys, mock-transport protocol (connect/hello-ok,
  malformed responses, wait-status mapping), spawn-error and observed-exit
  shutdown semantics, facade lifecycle (failed-start MCP rollback, connect-
  failure cleanup, single-flight concurrent/repeated start, blocked retry
  after uncertain child exit, running-child-with-dropped-WS guard,
  start-during-stop ordering), real loopback MCP (auth/Host/Origin,
  two-session reconnect, simulated labeling), and two real-boot doctor tests
  (sentinel preservation; SIGTERM mid-run still observing child exit and
  cleaning only its own directory).
- `node scripts/openclaw-doctor.mjs` — actual isolated boot on host
  `openclaw@2026.9.4`: unique `.runtime/openclaw-doctor-*` root → verified
  `--version` → spawn → `hello-ok` (protocol 4, 424 methods) → `status`,
  `sessions.list`, `config.get` (proves `tools.profile=messaging` +
  `mcp.servers=[gather]` accepted) → observed SIGTERM exit → removes only the
  directory it created. Contract tests use a mock transport; the doctor and
  the two end-to-end tests are real-process proofs. No model/provider
  invocation occurs.

## Known limitations

1. `agent.wait` returns a terminal snapshot; full reply text requires
   `chat.history`/session events.
2. OpenClaw session/transcript durability lives in its own SQLite inside the
   Gather-owned state dir — private layout; the adapter never reads it.
   Gather's store remains the source of truth for action records.
3. Inbound customer replies must be injected by Gather via `agent` RPC —
   channels are intentionally disabled (`OPENCLAW_SKIP_CHANNELS=1`).
4. `agent` runs require a configured model provider; the doctor verifies
   control-plane only. No live model or Google API call has been made.
5. The gateway tool policy constrains *which tools exist*; MCP tool calls
   still flow through OpenClaw's tool-policy layer, which is advisory for
   Gather business authority — the Gather-side approval/action store remains
   the authority boundary.
