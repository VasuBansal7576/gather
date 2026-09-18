import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { FileSecretStore } from "../src/server/connections/secrets.ts";
import { GOOGLE_SCOPE_CAPABILITIES, capabilitiesForGoogleScopes } from "../src/connectors/google/transport.ts";
import { validateSelectedGoogleDocuments } from "../src/connectors/google/documents.ts";

test("file secret store confines keys, uses owner-only permissions, and cleans up", () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-file-secrets-"));
  try {
    const root = join(dir, "live", "secrets");
    const store = new FileSecretStore(root);
    store.set("conn:google:fictional:access", "fictional-access-token");
    assert.equal(store.get("conn:google:fictional:access"), "fictional-access-token");
    assert.equal(statSync(root).mode & 0o777, 0o700);
    const files = readdirSync(root);
    assert.equal(files.length, 1);
    assert.equal(statSync(join(root, files[0]!)).mode & 0o777, 0o600);
    assert.ok(!files[0]!.includes("google"));
    assert.ok(!readFileSync(join(root, files[0]!), "utf8").includes("conn:"));
    store.delete("conn:google:fictional:access");
    assert.equal(store.get("conn:google:fictional:access"), undefined);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C11 maps only narrow scopes and Picker selections are explicit IDs", () => {
  assert.equal(GOOGLE_SCOPE_CAPABILITIES["https://www.googleapis.com/auth/drive.file"], "selected_document_read");
  assert.equal(GOOGLE_SCOPE_CAPABILITIES["https://www.googleapis.com/auth/calendar.freebusy"], "calendar_freebusy");
  assert.equal(GOOGLE_SCOPE_CAPABILITIES["https://www.googleapis.com/auth/drive.readonly"], undefined);
  assert.deepEqual(
    capabilitiesForGoogleScopes([
      "openid",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "https://www.googleapis.com/auth/drive.file",
    ]),
    new Set(["identity", "calendar_freebusy", "selected_document_read"]),
  );
  assert.deepEqual(validateSelectedGoogleDocuments([{ documentId: "picker_file_1", name: "Policy" }]), [{ documentId: "picker_file_1", name: "Policy" }]);
  assert.throws(() => validateSelectedGoogleDocuments([{ documentId: "../outside" }]));
  assert.throws(() => validateSelectedGoogleDocuments([{ documentId: "same" }, { documentId: "same" }]));
});
