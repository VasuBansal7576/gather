#!/usr/bin/env node

import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIN_NODE_MAJOR = 26;
const SUPPORTED_COMMANDS = Object.freeze([
  "dev",
  "build",
  "lint",
  "typecheck",
  "test",
  "start",
]);

function usage() {
  return `Usage: node scripts/gather-doctor.mjs [--help] [--json]

Check the local Gather app prerequisites without changing the project.

Checks:
  Node.js 26 or newer (the supported development baseline)
  package.json and the supported npm commands
  installed package dependencies
  an existing, writable project-local .runtime directory

Options:
  --help  Show this help.
  --json  Print machine-readable check results.
`;
}

function parseArguments(argv) {
  const options = { help: false, json: false };
  for (const argument of argv) {
    if (argument === "--help") options.help = true;
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function check(status, name, detail) {
  return { status, name, detail };
}

function readPackage(cwd) {
  const packagePath = join(cwd, "package.json");
  try {
    const stat = lstatSync(packagePath);
    if (!stat.isFile()) {
      return { result: check("fail", "package.json", "package.json exists but is not a regular file."), packageJson: null };
    }
  } catch {
    return {
      result: check("fail", "package.json", `package.json is missing from ${cwd}.`),
      packageJson: null,
    };
  }

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
      throw new Error("root value is not an object");
    }
    return { result: check("pass", "package.json", "package.json is present and valid JSON."), packageJson };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { result: check("fail", "package.json", `package.json could not be read as valid JSON: ${reason}`), packageJson: null };
  }
}

function dependencyNames(packageJson) {
  const sections = [packageJson.dependencies, packageJson.devDependencies];
  const names = new Set();
  for (const section of sections) {
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const name of Object.keys(section)) names.add(name);
  }
  return [...names].sort();
}

function checkNode() {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".", 1)[0], 10);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    return check("pass", "Node.js", `Node.js ${version} meets the supported baseline (${MIN_NODE_MAJOR}+).`);
  }
  return check("fail", "Node.js", `Node.js ${version} is unsupported; Gather's supported development baseline is Node.js ${MIN_NODE_MAJOR}+. See .node-version.`);
}

function checkDependencies(cwd, packageJson) {
  if (!packageJson) return check("skip", "dependencies", "Skipped because package.json is unavailable or invalid.");

  const names = dependencyNames(packageJson);
  if (names.length === 0) return check("pass", "dependencies", "No runtime or development dependencies are declared.");

  let modulesStat;
  try {
    modulesStat = lstatSync(join(cwd, "node_modules"));
  } catch {
    return check("fail", "dependencies", "node_modules is missing; install dependencies explicitly with npm ci or npm install.");
  }
  if (!modulesStat.isDirectory()) return check("fail", "dependencies", "node_modules exists but is not a directory.");

  const missing = names.filter((name) => {
    try {
      const packageDirectory = join(cwd, "node_modules", name);
      return !statSync(packageDirectory).isDirectory() || !statSync(join(packageDirectory, "package.json")).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    return check("fail", "dependencies", `Missing ${missing.length} installed package${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Run npm ci explicitly.`);
  }
  return check("pass", "dependencies", `All ${names.length} declared runtime and development dependencies are installed.`);
}

function checkCommands(packageJson) {
  if (!packageJson) return check("skip", "npm commands", "Skipped because package.json is unavailable or invalid.");
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return check("fail", "npm commands", `package.json has no scripts object; expected: ${SUPPORTED_COMMANDS.join(", ")}.`);
  }
  const missing = SUPPORTED_COMMANDS.filter((name) => typeof scripts[name] !== "string" || scripts[name].trim() === "");
  if (missing.length > 0) {
    return check("fail", "npm commands", `Missing supported command${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Expected: ${SUPPORTED_COMMANDS.join(", ")}.`);
  }
  return check("pass", "npm commands", `Supported commands are present: ${SUPPORTED_COMMANDS.join(", ")}.`);
}

function checkRuntimeDirectory(cwd) {
  const runtimePath = join(cwd, ".runtime");
  let stat;
  try {
    stat = lstatSync(runtimePath);
  } catch {
    return check("fail", ".runtime", ".runtime is missing. Create this project-local directory explicitly with mkdir -p .runtime; doctor never creates it.");
  }
  if (stat.isSymbolicLink()) return check("fail", ".runtime", ".runtime must be a real project-local directory, not a symbolic link.");
  if (!stat.isDirectory()) return check("fail", ".runtime", ".runtime exists but is not a directory.");
  if ((stat.mode & 0o222) === 0) return check("fail", ".runtime", ".runtime has no write permission bits for its owner, group, or others.");
  try {
    accessSync(runtimePath, constants.W_OK);
  } catch {
    return check("fail", ".runtime", ".runtime exists but is not writable by the current user.");
  }
  return check("pass", ".runtime", ".runtime is an existing writable project-local directory; doctor did not create it.");
}

export function runDoctor({ cwd = process.cwd(), emit } = {}) {
  const projectDirectory = resolve(cwd);
  const packageInfo = readPackage(projectDirectory);
  const checks = [
    checkNode(),
    packageInfo.result,
    checkDependencies(projectDirectory, packageInfo.packageJson),
    checkCommands(packageInfo.packageJson),
    checkRuntimeDirectory(projectDirectory),
  ];
  const failed = checks.filter(({ status }) => status === "fail");

  if (emit) {
    emit(`Gather local doctor: ${projectDirectory}`);
    for (const item of checks) {
      const marker = item.status === "pass" ? "PASS" : item.status === "fail" ? "FAIL" : "SKIP";
      emit(`${marker} ${item.name}: ${item.detail}`);
    }
    emit(failed.length === 0 ? "Doctor passed: local Gather prerequisites are ready." : `Doctor failed: ${failed.length} check${failed.length === 1 ? "" : "s"} need attention.`);
  }

  return { cwd: projectDirectory, checks, ok: failed.length === 0 };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`gather-doctor: ${reason}`);
    console.error("Run with --help for usage.");
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const result = runDoctor({ emit: (line) => { if (!options.json) console.log(line); } });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result.ok ? 0 : 1;
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
