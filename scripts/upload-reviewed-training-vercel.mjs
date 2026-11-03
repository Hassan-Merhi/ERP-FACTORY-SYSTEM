/**
 * Upload explicitly approved real-screen training recordings to a PRIVATE
 * Vercel Blob store. Runs only after a protected GitHub environment approval
 * and successful review evidence validation. No production ERP credentials.
 *
 * Install @vercel/blob in an isolated temporary folder alongside this script.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";

const topic = process.env.TOPIC || "";
const sha = process.env.TRAINING_SOURCE_SHA || "";
const token = process.env.TRAINING_MEDIA_VERCEL_TOKEN || "";
const storeId = process.env.TRAINING_MEDIA_VERCEL_STORE_ID || "";
const root = process.env.RUNNER_TEMP || "";

if (!/^[a-z0-9-]{1,80}$/.test(topic) || !/^[a-f0-9]{40}$/.test(sha)) {
  throw new Error("Invalid selected training topic or source SHA");
}
if (!/^store_[A-Za-z0-9]{8,80}$/.test(storeId) || !token.startsWith("vercel_blob_rw_")) {
  throw new Error("Approved private Vercel Blob store token and store ID are required");
}
const bareStoreId = storeId.slice("store_".length);
if (token.split("_")[3] !== bareStoreId) {
  throw new Error("The Vercel Blob token does not belong to the approved training store");
}
if (!root) throw new Error("GitHub temporary review directory is required");

const specs = [
  { filename: "screen.webm", extension: ".webm", contentType: "video/webm" },
  { filename: "captions.vtt", extension: ".vtt", contentType: "text/vtt" },
  { filename: "screenshot.png", extension: ".png", contentType: "image/png" },
];
const uploaded = [];
for (const spec of specs) {
  const key = "training/videos/" + topic + "/" + sha + spec.extension;
  const file = path.join(root, "review", topic, spec.filename);
  const bytes = await fs.readFile(file);
  if (bytes.length < 16 || bytes.length > 100 * 1024 * 1024) {
    throw new Error("Invalid or oversized approved recording: " + spec.filename);
  }
  const result = await put(key, bytes, {
    access: "private",
    token,
    addRandomSuffix: false,
    contentType: spec.contentType,
  });
  const expectedUrl = "https://" + bareStoreId + ".private.blob.vercel-storage.com/" + key;
  if (result.pathname !== key || result.url !== expectedUrl) {
    throw new Error("Unexpected Vercel private blob result for " + spec.filename);
  }
  uploaded.push({ key, filename: spec.filename, size: bytes.length });
}
await fs.writeFile(
  path.join(root, "review", topic, "approved-upload-report.json"),
  JSON.stringify({ topic, sourceSha: sha, provider: "vercel-private-blob", items: uploaded }, null, 2)
);
console.log("Uploaded " + uploaded.length + " approved training media files to private Vercel Blob store");
