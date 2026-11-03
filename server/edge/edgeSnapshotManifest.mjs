/**
 * Authenticated manifests for fully encrypted factory database + uploads backups.
 * A verified checkpoint is NOT a replayable transaction log or cloud replication.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SNAPSHOT_PROTOCOL = "erp-factory/encrypted-checkpoint/v1";
const BACKUP_ID = /^\d{8}T\d{6}Z$/;
const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export function expectedEncryptedNames(backupId) {
  if (!BACKUP_ID.test(backupId)) throw new Error("EDGE_SYNC_BACKUP_ID_INVALID");
  return [`edge-db-${backupId}.dump.age`, `edge-uploads-${backupId}.tar.age`];
}

function canonicalUnsigned(value) {
  if (!value || value.protocol !== SNAPSHOT_PROTOCOL || !SITE_ID.test(value.siteId ?? "")) {
    throw new Error("EDGE_SYNC_MANIFEST_IDENTITY_INVALID");
  }
  const [database, uploads] = expectedEncryptedNames(value.backupId);
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error("EDGE_SYNC_MANIFEST_DATE_INVALID");
  }
  if (!Array.isArray(value.files) || value.files.length !== 2) {
    throw new Error("EDGE_SYNC_MANIFEST_FILES_INVALID");
  }
  for (const [index, expected] of [database, uploads].entries()) {
    const entry = value.files[index];
    if (
      !entry ||
      entry.name !== expected ||
      !SHA256.test(entry.sha256 ?? "") ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1
    ) {
      throw new Error("EDGE_SYNC_MANIFEST_FILES_INVALID");
    }
  }
  // Explicit, deterministic allowlist prevents untrusted manifest fields from
  // changing signed meaning when a different parser verifies the same payload.
  return {
    protocol: SNAPSHOT_PROTOCOL,
    siteId: value.siteId,
    backupId: value.backupId,
    createdAt: value.createdAt,
    files: value.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
  };
}

function authTag(unsigned, key) {
  if (typeof key !== "string" || key.length < 48 || /^REPLACE/i.test(key)) {
    throw new Error("EDGE_SYNC_SIGNING_KEY_INVALID");
  }
  return createHmac("sha256", key)
    .update("ERP_FACTORY_ENCRYPTED_BACKUP_V1\n", "utf8")
    .update(JSON.stringify(unsigned), "utf8")
    .digest("hex");
}

export function createEncryptedSnapshotManifest({
  siteId,
  backupId,
  files,
  signingKey,
  createdAt = new Date().toISOString(),
}) {
  const unsigned = canonicalUnsigned({ protocol: SNAPSHOT_PROTOCOL, siteId, backupId, createdAt, files });
  return { ...unsigned, auth: authTag(unsigned, signingKey) };
}

export function verifyEncryptedSnapshotManifest(manifest, { siteId, signingKey, files } = {}) {
  const unsigned = canonicalUnsigned(manifest);
  if (unsigned.siteId !== siteId) throw new Error("EDGE_SYNC_WRONG_SITE");
  if (typeof manifest.auth !== "string" || !SHA256.test(manifest.auth)) {
    throw new Error("EDGE_SYNC_MANIFEST_AUTH_INVALID");
  }
  const signed = Buffer.from(manifest.auth, "hex");
  const expected = Buffer.from(authTag(unsigned, signingKey), "hex");
  if (!timingSafeEqual(signed, expected)) throw new Error("EDGE_SYNC_MANIFEST_SIGNATURE_MISMATCH");
  if (files !== undefined) {
    if (
      !Array.isArray(files) ||
      files.length !== 2 ||
      files.some(
        (file, index) =>
          file.name !== unsigned.files[index].name ||
          file.bytes !== unsigned.files[index].bytes ||
          file.sha256 !== unsigned.files[index].sha256
      )
    ) {
      throw new Error("EDGE_SYNC_MANIFEST_ARCHIVE_MISMATCH");
    }
  }
  return unsigned;
}
