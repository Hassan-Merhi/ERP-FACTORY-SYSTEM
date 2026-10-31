#!/usr/bin/env node
/**
 * Run on an isolated recovery machine, AFTER obtaining the manifest and two
 * ciphertext archives from the private checkpoint store. Does not decrypt,
 * connect to PostgreSQL, restore data, or authorize a production cutover.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { assertAgeV1Header } from "./check-age-archive.mjs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEncryptedSnapshotManifest, expectedEncryptedNames } from "../../server/edge/edgeSnapshotManifest.mjs";

async function digestFile(filePath, name) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("EDGE_CHECKPOINT_ARCHIVE_INVALID");
  }
  await assertAgeV1Header(filePath);
  let bytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== stat.size) throw new Error("EDGE_CHECKPOINT_ARCHIVE_CHANGED");
  return { name, bytes, sha256: hash.digest("hex") };
}

export async function verifyLocalEncryptedCheckpoint(manifestPath, { siteId, signingKey }) {
  const path = resolve(manifestPath);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) {
    throw new Error("EDGE_CHECKPOINT_MANIFEST_INVALID");
  }
  const manifest = JSON.parse(await readFile(path, "utf8"));
  // Verify provenance before trusting filenames sourced from the manifest.
  verifyEncryptedSnapshotManifest(manifest, { siteId, signingKey });
  const files = await Promise.all(
    expectedEncryptedNames(manifest.backupId).map((name) => digestFile(join(dirname(path), name), name))
  );
  return verifyEncryptedSnapshotManifest(manifest, { siteId, signingKey, files });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.length !== 3 || !process.env.EDGE_SYNC_SITE_ID || !process.env.EDGE_SYNC_SIGNING_KEY) {
    console.error("Usage: EDGE_SYNC_SITE_ID=... EDGE_SYNC_SIGNING_KEY=... node scripts/edge/verify-encrypted-checkpoint.mjs /isolated/edge-checkpoint-<timestamp>.json");
    process.exitCode = 2;
  } else {
    verifyLocalEncryptedCheckpoint(process.argv[2], {
      siteId: process.env.EDGE_SYNC_SITE_ID,
      signingKey: process.env.EDGE_SYNC_SIGNING_KEY,
    }).then(({ backupId }) => {
      console.log(`Checkpoint ${backupId} ciphertext provenance VERIFIED. Database remains untouched.`);
    }).catch((error) => {
      console.error("Checkpoint verification FAILED:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
