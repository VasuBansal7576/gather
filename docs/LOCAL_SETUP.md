# Local development and inspection

This runs the existing prototype with simulated fixtures, not the proposed one-command product. Use Node.js 26+ and npm; `.node-version` pins the development/CI baseline. Gather uses built-in SQLite and TypeScript stripping, but the version policy is the tested project baseline—not a claim that SQLite first appeared in Node 26.

## Fresh checkout

From the repository root:

```sh
npm ci
mkdir -p .runtime
node scripts/gather-doctor.mjs
npm run build
GATHER_DATABASE_PATH=.runtime/owner-demo.sqlite npm start -- --hostname 127.0.0.1 --port 3000
```

Open `/setup`, choose **Try demo**, then **Enter workspace**. The initializer creates two fictional bookings with proposals. It does not exercise model extraction or a complete real booking journey. All provider effects on this path are simulated.

Keep the server bound to loopback. The local owner identity and same-origin checks are not hosted authentication.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev -- --hostname 127.0.0.1` | Next.js development server; use an explicit database path as below. |
| `npm run build` | Production compilation. |
| `npm start -- --hostname 127.0.0.1` | Serve an existing build; does not install or build it. |
| `npm run typecheck` | TypeScript check. |
| `npm run lint` | Compatibility alias for typecheck; no separate linter is configured. |
| `npm test` | Local regression suite, with optional OpenClaw process checks skipped unless requested. Includes the scripted golden-path (`tests/golden-path.test.ts`) and release (`tests/release-*.test.ts`) suites. |
| `node scripts/gather-doctor.mjs --json` | Read-only prerequisites check, including the per-profile capability report (missing credentials are BLOCKED skips). |
| `node scripts/gather-start.mjs --dry-run` | Check prerequisites and describe the legacy development launcher without starting it. |

Submission profiles: server runs read `GATHER_INTEGRATION_PROFILE` (`base` default; demonstrated with `assemblyai` on loopback port 3102, `/setup` 200):

```sh
GATHER_INTEGRATION_PROFILE=assemblyai GATHER_DATABASE_PATH=.runtime/voice-demo.sqlite npm start -- --hostname 127.0.0.1 --port 3000
```

The setup page also offers a UI-only profile selector; only the selected profile's workspace panel mounts. See [release evidence](RELEASE_EVIDENCE.md) for the gate-by-gate proof index and blocker list.

For development:

```sh
GATHER_DATABASE_PATH=.runtime/development.sqlite npm run dev -- --hostname 127.0.0.1 --port 3000
```

The legacy `gather-start.mjs` helper invokes `npm run dev`, inherits `PORT`, and does not implement the proposed packaged CLI. Prefer the explicit loopback commands above. No `bin` entry or working `npx github:` installer is shipped.

## State and credentials

- The commands above explicitly place SQLite in `.runtime/`; the unchanged application default is `data/gather.sqlite`.
- Existing databases are not moved or reset. Use a new database filename to inspect fresh fictional fixtures without affecting prior work.
- The doctor requires `.runtime/` to exist and never creates it, installs dependencies or starts a runtime.
- The simulated path needs no provider credentials or OpenClaw binary. Do not configure live accounts for routine checks.
- Live Google secrets use macOS Keychain by default; the proposed cross-platform file-backed adapter is not implemented. See [connections](CONNECTIONS.md).

## Optional OpenClaw process checks

`npm test` does not discover or boot a personal OpenClaw installation. Four doctor/process tests use Node's explicit skip reporting by default. To deliberately exercise them against an existing absolute-path binary:

```sh
GATHER_TEST_OPENCLAW_BIN=/absolute/path/to/openclaw npm test
```

An invalid explicit path fails rather than skipping. These checks create isolated temporary state, use per-run loopback ports, and exercise process/control-plane behavior, not model or Google calls. They do not log into or reuse personal `~/.openclaw` state. The supported runtime interface is described in [OPENCLAW.md](OPENCLAW.md).

## CI and evidence

[CI](../.github/workflows/ci.yml) installs the lockfile, runs the doctor, typechecks, tests and builds on Linux and macOS using `.node-version`. It has read-only repository permissions, no provider secrets, and does not install OpenClaw or deploy the app. Optional process-test skips remain visible; the scripted golden-path and release suites run as part of `npm test`.

For a PR, report the exact commands, failures/skips and the boundary exercised. A build or simulated receipt is not a live booking result. See the [README](../README.md#inspect-the-prototype-locally) for the inspection scope.

## Troubleshooting

- Missing dependencies: run `npm ci` from the checkout.
- Missing `.runtime/`: create it explicitly before the doctor.
- Unsupported Node: select `.node-version`, then reinstall dependencies.
- Port occupied: choose another local port; do not stop an unrelated process.
- Existing fixture state: choose a new `GATHER_DATABASE_PATH`; no automated reset/migration is provided by this cleanup.
