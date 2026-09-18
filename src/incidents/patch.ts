import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-004 Tier-3 code-defect branch (C09).
 *
 * For code defects the supervisor produces an isolated reproduction, a
 * proposed patch, and a failing regression artifact under
 * `.runtime/repairs/<incident>/` for operator review. It NEVER applies the
 * patch to the running application. If no patch can be produced, the
 * incident stays blocked with that stated plainly — a Markdown suggestion
 * is not a tested patch.
 */

export interface PatchProposalInput {
  incidentId: string;
  /** Repository-relative path of the suspected file (informational only). */
  suspectFile: string;
  reproduction: string;
  /** Unified-diff text of the PROPOSED patch. Written, never applied. */
  proposedDiff?: string;
  /** Regression test source that fails before the patch. Written, never run against live state. */
  regressionTest?: string;
  repairsRoot: string;
}

export interface PatchProposalResult {
  dir: string;
  files: string[];
  applied: false;
  complete: boolean;
  note: string;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "incident";
}

export function proposeCodePatch(input: PatchProposalInput): PatchProposalResult {
  const dir = join(input.repairsRoot, safeSegment(input.incidentId));
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const repro = join(dir, "repro.md");
  writeFileSync(repro, `# Isolated reproduction (prepared, never applied)\n\nSuspect file: ${input.suspectFile}\n\n${input.reproduction}\n`, { mode: 0o600 });
  files.push(repro);
  if (input.proposedDiff && input.regressionTest) {
    const patch = join(dir, "proposed.patch");
    writeFileSync(patch, `${input.proposedDiff}\n`, { mode: 0o600 });
    files.push(patch);
    const regression = join(dir, "regression.test.ts");
    writeFileSync(regression, `${input.regressionTest}\n`, { mode: 0o600 });
    files.push(regression);
    return {
      dir,
      files,
      applied: false,
      complete: true,
      note: "Proposed patch + failing regression artifact written for operator review; the running application was NOT modified.",
    };
  }
  const blocked = join(dir, "BLOCKED.md");
  writeFileSync(
    blocked,
    `# No patch proposed\n\nDiagnosis could not produce an isolated reproduction with a proposed patch and regression test. A Markdown suggestion is not a tested patch. The incident stays blocked.\n`,
    { mode: 0o600 },
  );
  files.push(blocked);
  return {
    dir,
    files,
    applied: false,
    complete: false,
    note: "No patch could be produced; incident stays blocked. A Markdown suggestion is not a tested patch.",
  };
}
