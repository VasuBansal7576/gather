#!/usr/bin/env node

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDoctor } from "./gather-doctor.mjs";

function usage() {
  return `Usage: node scripts/gather-start.mjs [--help] [--dry-run]

Run the Gather app through the existing npm dev script after local checks pass.
This command never installs packages, downloads anything, or starts a separate runtime.

Options:
  --help      Show this help.
  --dry-run   Run all checks and print the command that would be launched.
`;
}

function parseArguments(argv) {
  const options = { help: false, dryRun: false };
  for (const argument of argv) {
    if (argument === "--help") options.help = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
}

function hasScaffold(cwd) {
  try {
    return lstatSync(join(cwd, "package.json")).isFile();
  } catch {
    return false;
  }
}

function runStart(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`gather-start: ${reason}`);
    console.error("Run with --help for usage.");
    return Promise.resolve(2);
  }
  if (options.help) {
    process.stdout.write(usage());
    return Promise.resolve(0);
  }

  const cwd = resolve(process.cwd());
  if (!hasScaffold(cwd)) {
    console.error(`Cannot start Gather: the scaffold is not present in ${cwd}.`);
    console.error("Expected package.json and the application files from the foundation worktree.");
    console.error("No installation, download, or process launch was attempted.");
    return Promise.resolve(1);
  }

  const result = runDoctor({ cwd, emit: (line) => console.log(line) });
  if (!result.ok) {
    console.error("Gather was not started because local preflight checks failed.");
    console.error("Install or create prerequisites explicitly, then run this command again.");
    return Promise.resolve(1);
  }

  const command = "npm run dev";
  if (options.dryRun) {
    console.log(`Dry run: would execute ${command} in ${cwd}.`);
    console.log("PORT is inherited unchanged; no existing process will be stopped or reassigned.");
    console.log("No process was started.");
    return Promise.resolve(0);
  }

  console.log(`Starting Gather with ${command}.`);
  if (Object.hasOwn(process.env, "PORT")) console.log(`Using PORT=${process.env.PORT}.`);
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmExecutable, ["run", "dev"], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  return new Promise((resolveExit) => {
    child.once("error", (error) => {
      console.error(`Could not launch ${command}: ${error.message}`);
      resolveExit(1);
    });
    child.once("close", (code, signal) => {
      if (signal) {
        console.error(`Gather dev process exited after signal ${signal}.`);
        resolveExit(1);
      } else {
        resolveExit(code ?? 1);
      }
    });
  });
}

if (isMainModule()) {
  process.exitCode = await runStart(process.argv.slice(2));
}

export { runStart };
