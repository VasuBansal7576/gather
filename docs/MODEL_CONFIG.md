# Explicit model configuration (DEMO/LIVE config surface, no credentials)

Owner-authorized model wiring for the isolated gateway. Code and scripted
tests only: no actual provider calls, logins, or credentials anywhere on
this surface. The live auth root (`main/.runtime/openclaw-live`) is never
touched — OAuth login and provider/model verification happen there,
outside this lane.

## Authorized model

Exactly one owner-authorized ref, enforced in code
(`GATHER_SUPPORTED_MODELS` in `src/runtime/config.ts`):

- `openai/gpt-5.6-luna` via the owner OAuth subscription ONLY
  (verified actual: provider `openai`, profile `openai:bansalv8198@gmail.com`).
- No alternate model, no `fallbacks` chain, no API-key fallback.

## Exact API (for the live-model runner)

```ts
import {
  GatherOpenClawRuntime,
  type GatherModelSelection,
} from "./src/runtime/index.ts";

const runtime = new GatherOpenClawRuntime({
  rootDir: "<repo>/.runtime/openclaw",
  gatewayPort: 18789,
  model: {
    model: "openai/gpt-5.6-luna",
    auth: {
      profileId: "openai:bansalv8198@gmail.com", // metadata only, never a secret
      provider: "openai",              // must equal the model ref provider
      mode: "oauth",                         // literal: api_key is unrepresentable
      email: "owner@example.test",           // fictional example: caller email is
                                             // unverified display metadata only —
                                             // never authorization evidence
      // displayName?: string                // optional, selection surfaces
    },
  } satisfies GatherModelSelection,
});

// Gate before live-model runs (configured/unverified — configuration
// alone never proves OAuth or model readiness; actual verification lives
// in the separately managed live auth root):
runtime.modelStatus();
// → { configured: true, verified: false, model: "openai/gpt-5.6-luna" }
// → { configured: false, verified: false, reason: "MODEL_NOT_CONFIGURED: ..." } when absent
runtime.requireModelSelection(); // throws MODEL_NOT_CONFIGURED when absent
```

## Emitted config (installed OpenClaw schema)

`buildGatewayConfig` writes exactly these supported fields:

- `agents.defaults.model = "openai/gpt-5.6-luna"` — a bare
  string, never the primary+fallbacks object.
- `auth.profiles.<profileId> = { provider, mode: "oauth", email?,
  displayName? }` and `auth.order.<provider> = [<profileId>]` —
  selection/order metadata only. Credentials live in the separately
  managed auth store created by explicit OAuth login; they are never
  written here, never logged, and never accepted by these options.

Validation failures are typed `ModelConfigError` codes:
`MODEL_NOT_CONFIGURED`, `INVALID_MODEL` (not a `provider/model` ref),
`UNSUPPORTED_MODEL` (not owner-authorized), `INVALID_AUTH` (missing
profile id, non-oauth mode, or provider mismatch). Absent model emits no
`model`/`auth` keys, so existing control-plane/demo behavior is
unchanged. Process isolation, lifecycle, tool policy, MCP handling, and
the child-env allowlist are untouched; every config rewrite path
(provision, MCP re-write, rollback) carries the model through one
`configOptions()` source.
