import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLocalEncryptedCheckpoint } from "../scripts/edge/verify-encrypted-checkpoint.mjs";
import { describe, expect, it } from "vitest";
import {
  createEncryptedSnapshotManifest,
  expectedEncryptedNames,
  verifyEncryptedSnapshotManifest,
} from "../server/edge/edgeSnapshotManifest.mjs";
import { checkCheckpointRemote, identifyBackupPairs } from "../scripts/edge/transfer-encrypted-snapshots.mjs";

const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const backupId = "20261029T223001Z";
const signingKey = "offline-checkpoint-fixture-only-".repeat(3);
const names = expectedEncryptedNames(backupId);
const files = names.map((name, index) => ({ name, bytes: index + 1, sha256: (index ? "b" : "a").repeat(64) }));

describe("Phase 4 authenticated encrypted checkpoint", () => {
  it("verifies original data but rejects changes or wrong site", () => {
    const m = createEncryptedSnapshotManifest({ siteId, backupId, files, signingKey });
    expect(verifyEncryptedSnapshotManifest(m, { siteId, files, signingKey }).backupId).toBe(backupId);
    expect(() => verifyEncryptedSnapshotManifest({ ...m, backupId: "20261030T223001Z" }, { siteId, signingKey }))
      .toThrow();
    expect(() =>
      verifyEncryptedSnapshotManifest(m, { siteId, files: [{ ...files[0], bytes: 50 }, files[1]], signingKey })
    )
      .toThrow("EDGE_SYNC_MANIFEST_ARCHIVE_MISMATCH");
  });
  it("requires complete ciphertext pairs and safe rclone destinations", () => {
    expect(identifyBackupPairs(names)).toHaveLength(1);
    expect(() => identifyBackupPairs([names[0]])).toThrow("EDGE_SYNC_INCOMPLETE_BACKUP_PAIR");
    expect(() => checkCheckpointRemote("s3:bucket/../other")).toThrow("EDGE_SYNC_REMOTE_INVALID");
    expect(checkCheckpointRemote("s3:factory-backups/archive")).toBe("s3:factory-backups/archive");
  });
});

describe("isolated checkpoint verification", () => {
  it("accepts matching encrypted-format archives and refuses altered bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edge-phase4-"));
    try {
      const originals = names.map((name, i) => ({
        name,
        body: Buffer.from("age-encryption.org/v1\nfixture-" + i),
      }));
      for (const item of originals) await writeFile(join(dir, item.name), item.body);
      const evidence = originals.map(({ name, body }) => ({
        name,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      }));
      const signed = createEncryptedSnapshotManifest({ siteId, backupId, files: evidence, signingKey });
      const manifestPath = join(dir, "edge-checkpoint-" + backupId + ".json");
      await writeFile(manifestPath, JSON.stringify(signed));
      await expect(verifyLocalEncryptedCheckpoint(manifestPath, { siteId, signingKey })).resolves.toMatchObject({
        backupId,
      });
      await writeFile(join(dir, names[0]), Buffer.from("a non-encrypted replacement"));
      await expect(verifyLocalEncryptedCheckpoint(manifestPath, { siteId, signingKey })).rejects.toThrow(
        "EDGE_SYNC_AGE_HEADER_INVALID"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isolated cloud bootstrap rehearsal", () => {
  const script = "deploy/lan/rehearse-encrypted-bootstrap.sh";
  it("passes bash syntax validation and cannot run without a dedicated acknowledgment", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    const denied = spawnSync("bash", [script, "/not-here", "/not-here"], {
      encoding: "utf8",
      env: { ...process.env, EDGE_RESTORE_ACK: "" },
    });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("EDGE_RESTORE_REHEARSAL_ACK_REQUIRED");
  });
  it("never selects the live ERP database or a destructive pg_restore mode", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('target="erp_edge_rehearsal_');
    expect(source).toContain('createdb --username=erp_edge --template=template0 "$target"');
    expect(source).not.toContain("pg_restore --clean");
    expect(source).toContain("--single-transaction --exit-on-error");
  });
});
