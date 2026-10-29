#!/usr/bin/env node
/**
 * Phase 4 checkpoint transport: upload age-encrypted database/uploads backup
 * pairs to private object storage and verify the uploaded ciphertext bytes.
 *
 * This is archival/staging only. It NEVER restores a cloud database, creates
 * accounting postings, merges rows, or switches which site accepts writes.
 * An operator must separately certify the cutover before any promotion.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEdgeEnvironment } from "./verify-edge-configuration.mjs";
import {
  createEncryptedSnapshotManifest,
  expectedEncryptedNames,
  verifyEncryptedSnapshotManifest,
} from "../../server/edge/edgeSnapshotManifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseDir = join(root, "deploy/lan");
const backupDir = join(baseDir, "backups");
const BACKUP_FILENAME = /^edge-(?:db-\d{8}T\d{6}Z\.dump|uploads-\d{8}T\d{6}Z\.tar)\.age$/;

export function checkCheckpointRemote(remote) {
  if (typeof remote !== "string" || !/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(remote)) {
    throw new Error("EDGE_SYNC_REMOTE_INVALID");
  }
  return remote.replace(/\/+$/, "");
}

export function identifyBackupPairs(names) {
  const ids = new Set();
  for (const name of names) {
    if (!BACKUP_FILENAME.test(name)) continue;
    const id = name.match(/\d{8}T\d{6}Z/)?.[0];
    if (id) ids.add(id);
  }
  const pairs = [];
  for (const id of [...ids].sort()) {
    const files = expectedEncryptedNames(id);
    if (!files.every((file) => names.includes(file))) throw new Error("EDGE_SYNC_INCOMPLETE_BACKUP_PAIR");
    pairs.push({ id, files });
  }
  return pairs;
}

async function digestArchive(path, filename) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.isSymbolicLink()) {
    throw new Error("EDGE_SYNC_ARCHIVE_NOT_REGULAR");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: "r" })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== metadata.size) throw new Error("EDGE_SYNC_ARCHIVE_CHANGED");
  return { name: filename, bytes, sha256: hash.digest("hex") };
}

function runRclone(args, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", args, { stdio: ["ignore", "pipe", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      // Never print remote command output (may contain credentials or paths).
      errorText += chunk.toString().slice(0, Math.max(0, 500 - errorText.length));
    });
    if (onData) child.stdout.on("data", onData);
    else child.stdout.resume();
    child.on("error", () => reject(new Error("EDGE_SYNC_RCLONE_UNAVAILABLE")));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error("EDGE_SYNC_RCLONE_TRANSFER_FAILED"));
      else resolve();
    });
  });
}

async function uploadAndVerify(local, remote, expected) {
  await runRclone(["copyto", local, remote, "--immutable"]);
  const hash = createHash("sha256");
  let size = 0;
  await runRclone(["cat", remote], (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });
  if (size !== expected.bytes || hash.digest("hex") !== expected.sha256) {
    throw new Error("EDGE_SYNC_REMOTE_CHECKSUM_MISMATCH");
  }
}

async function loadConfig() {
  const envPath = join(baseDir, ".env");
  const permission = await lstat(envPath);
  if (!permission.isFile() || (permission.mode & 0o077) !== 0) {
    throw new Error("EDGE_SYNC_ENV_FILE_PERMISSIONS");
  }
  const env = parseEdgeEnvironment(await readFile(envPath, "utf8"));
  if (!env.EDGE_SITE_ID || !env.EDGE_SYNC_SIGNING_KEY || !env.EDGE_SYNC_REMOTE) {
    throw new Error("EDGE_SYNC_CONFIGURATION_MISSING");
  }
  return { ...env, remote: checkCheckpointRemote(env.EDGE_SYNC_REMOTE) };
}

async function processBackup({ id, files }, env, dryRun) {
  const metadata = await Promise.all(files.map((name) => digestArchive(join(backupDir, name), name)));
  const manifestName = `edge-checkpoint-${id}.json`;
  const manifestPath = join(backupDir, manifestName);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("EDGE_SYNC_LOCAL_MANIFEST_INVALID");
  }

  if (manifest) {
    verifyEncryptedSnapshotManifest(manifest, {
      siteId: env.EDGE_SITE_ID,
      signingKey: env.EDGE_SYNC_SIGNING_KEY,
      files: metadata,
    });
  } else {
    manifest = createEncryptedSnapshotManifest({
      siteId: env.EDGE_SITE_ID,
      backupId: id,
      files: metadata,
      signingKey: env.EDGE_SYNC_SIGNING_KEY,
    });
    if (!dryRun) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }

  if (dryRun) {
    console.log(`Validated encrypted checkpoint ${id}, files: ${metadata.length} (not uploaded)`);
    return;
  }
  const remotePrefix = `${env.remote}/${env.EDGE_SITE_ID}/${id}`;
  // Send the manifest only after both encrypted objects pass an end-to-end
  // remote readback. A missing manifest signals an incomplete upload.
  for (const meta of metadata) {
    await uploadAndVerify(join(backupDir, meta.name), `${remotePrefix}/${meta.name}`, meta);
    const current = await digestArchive(join(backupDir, meta.name), meta.name);
    if (current.sha256 !== meta.sha256 || current.bytes !== meta.bytes) {
      throw new Error("EDGE_SYNC_ARCHIVE_CHANGED");
    }
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const manifestDigest = { bytes: manifestBytes.length, sha256: createHash("sha256").update(manifestBytes).digest("hex") };
  await uploadAndVerify(manifestPath, `${remotePrefix}/${manifestName}`, manifestDigest);
  console.log(`Encrypted checkpoint ${id} staged and byte-verified; database NOT promoted`);
}

export async function transferEncryptedSnapshots({ dryRun = false } = {}) {
  const env = await loadConfig();
  const names = await readdir(backupDir);
  const pairs = identifyBackupPairs(names);
  if (pairs.length === 0) throw new Error("EDGE_SYNC_NO_ENCRYPTED_BACKUPS");
  for (const pair of pairs) await processBackup(pair, env, dryRun);
  return pairs.length;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--dry-run")) {
    console.error("Usage: node scripts/edge/transfer-encrypted-snapshots.mjs [--dry-run]");
    process.exitCode = 2;
  } else {
    transferEncryptedSnapshots({ dryRun: process.argv[2] === "--dry-run" }).catch((error) => {
      console.error("Encrypted checkpoint transfer FAILED:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
