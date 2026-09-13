# Gather ↔ OpenClaw runtime adapter

`src/runtime/` implements the isolated, supported OpenClaw backend adapter for
Gather. It supervises a dedicated `openclaw gateway` child process, talks to it
over the Gateway WebSocket protocol with the published client package, and
exposes Gather-owned tools to the agent through a loopback MCP boundary.

Everything the instance touches — config, state, workspace, secrets, temp —
lives under one Gather-owned root (`.runtime/openclaw`, gitignored). The
developer's personal `~/.openclaw` install, credentials, and memory are never
read or written.

## Verified package interface

| Package | Pinned | Evidence |
| --- | --- | --- |
| `openclaw` (runtime binary) | host-installed `2026.9.4` (`/opt/homebrew/bin/openclaw`) | `openclaw --version`; bin entry `openclaw.mjs` per `npm view openclaw bin` |
| `@openclaw/gateway-client` | `2026.9.4` | `npm view @openclaw/gateway-client versions` — `2026.8.1` exists but `2026.9.4` is pinned to match the verified gateway; exports `.` (Node client), `./browser`, `./timeouts`, `./readiness`, `./scope-upgrade`, `./websocket-data` |
| `@openclaw/gateway-protocol` | `2026.9.4` (transitive) | `ConnectParamsSchema` / `HelloOkSchema` in `dist/frames-*.d.mts` |
| `@modelcontextprotocol/sdk` | `1.30.0` | `McpServer.registerTool`, `StreamableHTTPServerTransport` in `dist/esm/server/` |
| `zod` | `4.6.4` | satisfies the SDK's `^3.25 \|\| ^4.0` dependency |

Used API surface (from `node_modules/@openclaw/gateway-client/dist/*.d.mts`):

- `new GatewayClient(opts)` — `url`, `token`, `role`, `scopes`, `mode`,
  `requestTimeoutMs`, `onHelloOk`, `onEvent`, `onClose`, `onReconnectPaused`,
  `minProtocol`/`maxProtocol`.
- `client.start()`, `client.stopAndWait({timeoutMs})`,
  `client.request<T>(method, params, {timeoutMs})`.
- `GatewayClientRequestError` / `GatewayClientRequestTimeoutError`.

RPC methods used (all verified present in the installed server's method table
`dist/method-scopes-*.mjs` and `dist/agent-*.mjs`, `run-wait-*.mjs`):

| Method | Scope | Use |
| --- | --- | --- |
| `agent` | `operator.write` | start one run; params `message`, `sessionKey`, `idempotencyKey` (required), `deliver`, `label`, `timeout`, `extraSystemPrompt`; returns `{runId, acceptedAt}` |
| `agent.wait` | `operator.write` | wait for terminal snapshot; params `{runId, timeoutMs}`; returns `{status: ok\|error\|timeout, ...}` |
| `chat.history` | `operator.read` | session transcript for evidence display |
| `sessions.list` | `operator.read` | durable session index |
| `status` | `operator.read` | gateway status summary |

Doc citations: `docs.openclaw.ai/gateway/external-apps` (agent + agent.wait
path, wait-timeout semantics), `/gateway/protocol` (connect handshake, roles,
scopes), `/gateway/operator-scopes` (closed scope set), `/gateway/embedding`
(child-process supervision contract), `/gateway/multiple-gateways` (isolation
checklist), `/gateway/config-gateway` (`gateway.*` config),
`/gateway/config-secrets-env` + `/help/environment` (env precedence, `${VAR}`
substitution), `/tools/mcp` (`mcp.servers` client definitions),
`/concepts/agent-loop` (run lifecycle, wait timeout defaults).

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
| `TMPDIR` | `<root>/tmp` | scratch files stay Gather-owned |
| `OPENCLAW_CONFIG_READONLY` | `1` | config is externally managed |
| `OPENCLAW_SKIP_CHANNELS` | `1` | control-plane only; Gather owns Gmail/Calendar connectors |
| `OPENCLAW_NO_RESPAWN` | `1` | host keeps ownership of the tracked PID |
| `OPENCLAW_DISABLE_BONJOUR` | `1` | host owns discovery |
| `OPENCLAW_EXEC_SHELL_SNAPSHOT` | `0` | no login-shell snapshot |

`OPENCLAW_LOAD_SHELL_ENV` is never set, and provider keys are absent because
the env is a whitelist, not inherited.

The materialized `openclaw.json` contains no secrets:
`gateway.auth.token` is the literal `${OPENCLAW_GATEWAY_TOKEN}` substitution.
Config pins `gateway.mode: "local"`, `bind: "loopback"`, `auth.mode: "token"`,
and `agents.defaults.workspace` to the Gather-owned workspace. When MCP tools
are registered it also writes `mcp.servers.gather` (`streamable-http`,
loopback URL, `toolFilter.include` = registered tool names).

## Lifecycle semantics

- **Boot**: `OpenClawGatewayProcess.start()` spawns `openclaw gateway`.
  Exit `78` (`EX_CONFIG`) triggers one `openclaw doctor --fix --yes
  --non-interactive` repair under the same env and one retry, then fails with
  the stderr tail. Process survival is not readiness.
- **Readiness**: `GatherGatewayConnection.connect()` resolves on `hello-ok` —
  the documented application-readiness signal — within a caller deadline
  (default 30 s). The library retries `startup-sidecars` closes internally.
- **Reconnect**: the client owns backoff/reconnect; the adapter surfaces
  `connecting`/`ready`/`reconnecting`/`closed` via `onStateChange` and
  `onReconnectPaused`.
- **Shutdown**: `stop()` closes the WS client (`stopAndWait`), then SIGTERMs
  the child and SIGKILLs after the grace window (default 10 s). The gateway
  drains active work on SIGTERM (observed: `received SIGTERM; shutting down`,
  `shutdown completed cleanly`).

## Task API

`GatherRuntimeTasks`:

- `submitTask({bookingId, message, idempotencyKey, ...})` → `agent` RPC on the
  stable per-booking session `agent:<agentId>:gather:booking:<bookingId>`
  (valid `agent:<id>:<rest>` shape). `deliver: false` — Gather renders results
  itself. Idempotency keys derive via `stableTaskIdempotencyKey` (sha256 over
  sorted identity) — this is the duplicate-run prevention hook.
- `waitForRun({runId, timeoutMs})` → `agent.wait`. **`status: "timeout"` is
  wait-only** — `executionMayContinue: true`; the remote run may still be
  executing. Reconcile before retrying. `stopReason: "superseded"` is
  preserved verbatim.
- `sessionHistory({sessionKey})` → `chat.history` (evidence, not truth).
- `listSessions()` / `gatewayStatus()` → `sessions.list` / `status`.

## MCP tool boundary

`GatherMcpBoundary` hosts the `gather` MCP server on loopback with the
official SDK's stateful Streamable HTTP transport. Tools are narrowly typed
injected handlers — the dependent integration wires them to the verified
Gather backend.

Authority rules enforced structurally:

- Every tool declares `execution: "live" | "simulated"` — no silent default.
- Simulated tools get `[SIMULATED — not a verified integration]` prepended to
  their description and every result, `gather:simulated: true`, and any
  `verified` claim stripped.
- Every result is stamped `gather:authority: "advisory"`. This boundary never
  mints booking receipts: durable `ActionExecution` records are created only
  by Gather's own store through approved-action execution. Model prose and
  arbitrary tool calls cannot manufacture a verified receipt here, and
  OpenClaw's own tool-approval system is a separate mechanism that confers no
  Gather booking authority.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 24 tests pass; `tests/runtime.test.ts` covers isolation,
  config materialization, session/idempotency keys, mock-transport protocol
  (connect/hello-ok/request/error mapping, reconnect state), `agent.wait`
  timeout semantics, and real loopback MCP initialize/tools-list/tools-call
  with simulated and live-declared handlers.
- `node scripts/openclaw-doctor.mjs` — actual isolated boot on the host
  `openclaw@2026.9.4`: provision → spawn → `hello-ok` (protocol 4, 424
  methods) → `status` + `sessions.list` → clean SIGTERM shutdown. Contract
  tests use a mock transport; the doctor script is the real-process proof.
  No model/provider invocation occurs.

## Known limitations

1. The gateway writes its log file to the host-shared `/tmp/openclaw/`
   (`resolveSecureTempRoot` prefers that fixed path when safe); `TMPDIR`
   covers other scratch but not this log path — no supported override exists.
2. `agent.wait` returns a terminal snapshot; full reply text requires
   `chat.history`/session events.
3. OpenClaw session/transcript durability lives in its own SQLite inside the
   Gather-owned state dir — private layout; the adapter never reads it.
   Gather's store remains the source of truth for action records.
4. Inbound customer replies must be injected by Gather via `agent` RPC —
   channels are intentionally disabled (`OPENCLAW_SKIP_CHANNELS=1`).
5. `agent` runs require a configured model provider; the doctor verifies
   control-plane only. No live model or Google API call has been made.
