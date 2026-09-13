# Local setup

Gather's local packaging launches the owner application and its explicit simulated demo.
An isolated OpenClaw control-plane adapter exists; model execution and real external app connections remain unverified.
These commands therefore do not constitute a complete one-command Gather product launch.

## Prerequisites

- Node.js 26 or newer.
- npm, as provided by the Node.js installation.
- The Gather foundation scaffold, including `package.json` and its application files.

The foundation uses Node's built-in `node:sqlite` API, so older Node versions are not supported.
The application scaffold and launcher are integrated on `main`.

## First-time local setup

Run these commands from the repository root:

```sh
mkdir -p .runtime
npm ci
node scripts/gather-doctor.mjs
```

`gather-doctor.mjs` only reads and checks the project.
It never creates `.runtime`, installs dependencies, downloads files, changes ports, or starts a process.
Create `.runtime` explicitly as shown above, and run `npm ci` explicitly when `node_modules` is absent.
The `.runtime` directory is project-local and ignored by Git.

## Supported local commands

The doctor expects the foundation package to expose these scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Gather owner application in development mode. |
| `npm run build` | Build the Gather application. |
| `npm run lint` | Run the foundation's lint or type-check command. |
| `npm run typecheck` | Run the foundation's explicit type-check command. |
| `npm test` | Run the local test suite. |
| `npm run start` | Run a previously built application. |

The packaging launcher uses only `npm run dev`.
It does not start, configure, copy, or inspect any OpenClaw installation.

## Check and launch

Show command help inline:

```sh
node scripts/gather-doctor.mjs --help
node scripts/gather-start.mjs --help
```

Run a machine-readable preflight check:

```sh
node scripts/gather-doctor.mjs --json
```

Run a local dry check without starting the app:

```sh
node scripts/gather-start.mjs --dry-run
```

Launch the Gather owner application after all checks pass:

```sh
node scripts/gather-start.mjs
```

`gather-start.mjs` fails clearly when the scaffold is absent or prerequisites are incomplete.
It never runs `npm install`, downloads dependencies, or launches a separate runtime.
It inherits `PORT` unchanged when it is set, for example:

```sh
PORT=4310 node scripts/gather-start.mjs
```

It does not kill, reassign, or probe for another process using that port.

## Troubleshooting

- If `package.json` is missing, integrate or check out the Gather foundation scaffold before running the launcher.
- If dependencies are missing, run `npm ci` explicitly and rerun the doctor.
- If `.runtime` is missing, create it with `mkdir -p .runtime` and rerun the doctor.
- If Node.js is too old, install or select Node.js 26 or newer, then rerun the doctor.
- If a supported npm script is missing, restore the foundation package scripts before launching.

The owner demo does not require OpenClaw or provider credentials.
The separate isolated OpenClaw doctor has shown an intermittent Gateway handshake timeout; a passing control-plane check does not establish model execution.
See the [README demonstration](../README.md#run-the-local-demo) for the production build launch and the exact simulated boundary.
