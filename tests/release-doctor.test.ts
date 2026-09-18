/**
 * ADR-016 release test: doctor capability report.
 *
 * Missing profile credentials are BLOCKED skips with exact missing
 * evidence — never passes. Supplied knobs (presence only) pass. The report
 * never fails the deterministic prerequisites and never touches a provider.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error: gather-doctor.mjs is an untyped script; typed via the cast below.
import { runDoctor as untypedRunDoctor } from "../scripts/gather-doctor.mjs";

interface DoctorCheck {
  status: "pass" | "fail" | "skip";
  name: string;
  detail: string;
}

interface DoctorResult {
  cwd: string;
  checks: DoctorCheck[];
  ok: boolean;
}

type RunDoctor = (options?: {
  cwd?: string;
  emit?: (line: string) => void;
  env?: Record<string, string | undefined>;
}) => DoctorResult;

const runDoctor: RunDoctor = untypedRunDoctor as RunDoctor;

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), "gather-016-doctor-"));
  mkdirSync(join(dir, ".runtime"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      scripts: { dev: "x", build: "x", lint: "x", typecheck: "x", test: "x", start: "x" },
    }),
  );
  return dir;
}

function byName(result: ReturnType<typeof runDoctor>, name: string) {
  const found = result.checks.find((item) => item.name === name);
  assert.ok(found, `doctor reports ${name}`);
  return found;
}

test("016 doctor: empty environment blocks every credentialed profile, prerequisites still pass", () => {
  const dir = projectDir();
  try {
    const result = runDoctor({ cwd: dir, env: {} });
    assert.equal(result.ok, true, "BLOCKED skips do not fail deterministic prerequisites");
    assert.equal(byName(result, "release profile").status, "pass");
    assert.match(byName(result, "release profile").detail, /"base"/);
    for (const name of [
      "profile:base/model-access",
      "profile:base/test-recipient",
      "profile:base/acceptance-signing",
      "profile:assemblyai/voice-key",
      "profile:nebius/token-factory",
    ]) {
      const item = byName(result, name);
      assert.equal(item.status, "skip", `${name} is skipped, not passed`);
      assert.match(item.detail, /BLOCKED/);
    }
    assert.match(byName(result, "profile:assemblyai/voice-key").detail, /GATHER_ASSEMBLYAI_API_KEY/);
    assert.match(byName(result, "profile:nebius/token-factory").detail, /GATHER_NEBIUS_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("016 doctor: selected profile and supplied knobs pass by presence (values never read)", () => {
  const dir = projectDir();
  try {
    const result = runDoctor({
      cwd: dir,
      env: {
        GATHER_INTEGRATION_PROFILE: "nebius",
        GATHER_MODEL_PROFILE_ID: "operator-profile",
        GATHER_TEST_RECIPIENT: "test@example.test",
        GATHER_ACCEPTANCE_KEY: "k",
        GATHER_ASSEMBLYAI_API_KEY: "k",
        GATHER_NEBIUS_API_KEY: "k",
      },
    });
    assert.equal(result.ok, true);
    assert.match(byName(result, "release profile").detail, /"nebius"/);
    for (const name of [
      "profile:base/model-access",
      "profile:base/test-recipient",
      "profile:base/acceptance-signing",
      "profile:assemblyai/voice-key",
      "profile:nebius/token-factory",
    ]) {
      assert.equal(byName(result, name).status, "pass", `${name} passes on presence`);
    }
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /operator-profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("016 doctor: explicit voice disable is an honest BLOCKED skip even with a key", () => {
  const dir = projectDir();
  try {
    const result = runDoctor({
      cwd: dir,
      env: { GATHER_ASSEMBLYAI_API_KEY: "k", GATHER_ASSEMBLYAI_DISABLED: "1" },
    });
    const item = byName(result, "profile:assemblyai/voice-key");
    assert.equal(item.status, "skip");
    assert.match(item.detail, /disabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
