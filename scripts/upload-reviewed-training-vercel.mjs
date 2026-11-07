/**
 * Publishes validated recordings to the private Vercel Blob store and
 * replaces the runtime manifest the ERP reads.
 *
 * Runs only inside the protected main-branch GitHub Actions environment. It
 * requests a GitHub OIDC identity, has the Vercel gateway verify it, obtains
 * one signed PUT URL per immutable media object (and one overwrite grant for
 * the manifest) and uploads directly. No reusable storage credential exists
 * anywhere in GitHub.
 *
 *   TRAINING_REVIEW_DIR   directory holding one folder per topic
 *   TRAINING_SOURCE_SHA   commit the recordings were made from
 *   TRAINING_VALIDATION   JSON written by validate-training-recording.mjs
 *   TRAINING_PUBLISHED_BY actor or job name recorded in the manifest
 */
import fs from "node:fs/promises";
import path from "node:path";

export const GATEWAY = "https://erp-training-storage-access.vercel.app";
export const MANIFEST_KEY = "training/manifest/current.json";
const STORE_ID = "TXyFGTsySrCeQhOj";
const FILES = [
  ["screen.mp4", ".mp4", "video/mp4", 100 * 1024 * 1024],
  ["captions.vtt", ".vtt", "text/vtt", 512 * 1024],
  ["screenshot.png", ".png", "image/png", 10 * 1024 * 1024],
];

/** Replaces each published topic with tonight's recording and keeps the rest. */
export function mergeManifest(current, validated, sha, publishedBy, publishedAt = new Date().toISOString()) {
  const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
  for (const item of validated) {
    if (!/^[a-z0-9-]{1,80}$/.test(item.topic)) throw new Error("Invalid topic id");
    next[item.topic] = {
      videoKey: "training/videos/" + item.topic + "/" + sha + ".mp4",
      captionsKey: "training/videos/" + item.topic + "/" + sha + ".vtt",
      screenshotKey: "training/videos/" + item.topic + "/" + sha + ".png",
      guideSteps: item.guideSteps,
      sourceSha: sha,
      publishedAt,
      publishedBy,
      durationSeconds: Math.round(item.durationSeconds),
      ...(item.route ? { route: item.route } : {}),
    };
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

function trustedUploadUrl(value, key) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== "https://vercel.com" ||
      url.pathname !== "/api/blob/" || url.searchParams.get("pathname") !== key ||
      !url.searchParams.has("vercel-blob-delegation") ||
      !url.searchParams.has("vercel-blob-signature") ||
      !url.searchParams.has("vercel-blob-valid-until")) {
    throw new Error("Gateway returned an untrusted upload destination");
  }
  return url;
}

async function publisherIdentity() {
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error("Missing GitHub OIDC publisher identity");
  }
  const identityUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  identityUrl.searchParams.set("audience", "erp-training-private-publisher-v1");
  const response = await fetch(identityUrl, {
    headers: { Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    redirect: "error",
  });
  if (!response.ok) throw new Error("Unable to obtain the GitHub OIDC publisher identity");
  const jwt = (await response.json()).value;
  if (typeof jwt !== "string" || jwt.length < 200) throw new Error("Invalid GitHub OIDC identity");
  return jwt;
}

async function grant(jwt, body) {
  const response = await fetch(GATEWAY + "/api/upload-url", {
    method: "POST",
    headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (!response.ok) {
    // The gateway names the failed check (identity, policy or storage signing).
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error("The protected gateway refused " + body.key + ": HTTP " + response.status + (detail ? " " + detail : ""));
  }
  return response.json();
}

async function upload(jwt, key, bytes, contentType, overwrite) {
  const result = await grant(jwt, { key, bytes: bytes.length });
  if (result.contentType !== contentType || typeof result.uploadUrl !== "string" || Boolean(result.allowOverwrite) !== overwrite) {
    throw new Error("Gateway returned unexpected upload requirements for " + key);
  }
  const response = await fetch(trustedUploadUrl(result.uploadUrl, key), {
    method: "PUT", body: bytes, redirect: "error",
    headers: {
      "Content-Type": contentType, "x-content-type": contentType, "x-vercel-blob-access": "private",
      "x-vercel-blob-store-id": STORE_ID, "x-api-version": "12", "x-add-random-suffix": "0",
      "x-allow-overwrite": overwrite ? "1" : "0",
    },
  });
  if (response.ok) return "uploaded";
  const detail = (await response.text().catch(() => "")).slice(0, 200);
  // An immutable object that is already in the store refuses the overwrite:
  // that is the rollback case, not a failure.
  if (!overwrite && (response.status === 409 || /already exists/i.test(detail))) return "reused";
  throw new Error("Private storage rejected " + key + ": HTTP " + response.status + (detail ? " " + detail : ""));
}

async function readUrl(jwt, key) {
  const result = await grant(jwt, { key, operation: "get" });
  if (typeof result.readUrl !== "string") throw new Error("Gateway returned no read grant for " + key);
  const url = new URL(result.readUrl);
  if (url.protocol !== "https:" || url.host !== "txyfgtsysrceqhoj.private.blob.vercel-storage.com" || url.pathname !== "/" + key) {
    throw new Error("Gateway returned an untrusted location for " + key);
  }
  return url;
}

/**
 * Media objects are immutable and named after the source commit, so a
 * rollback to an earlier recording finds them already in storage. Reuse them
 * instead of failing on the refused overwrite.
 */
async function alreadyStored(jwt, key, bytes) {
  // The signed read grant covers GET only (HEAD is refused), so ask for the
  // first byte. A private store answers 404, or 403, for an object that does
  // not exist; either means "not stored yet".
  const response = await fetch(await readUrl(jwt, key), { headers: { Range: "bytes=0-0" }, redirect: "error" });
  if (response.status === 404 || response.status === 403) return false;
  if (response.status !== 200 && response.status !== 206) {
    throw new Error("Could not check " + key + ": HTTP " + response.status);
  }
  const range = response.headers.get("content-range") || "";
  const total = Number(range.includes("/") ? range.split("/")[1] : response.headers.get("content-length"));
  await response.body?.cancel().catch(() => undefined);
  if (Number.isFinite(total) && total > 0 && total !== bytes.length) {
    throw new Error("Stored object " + key + " differs in size from the validated recording");
  }
  return true;
}

async function currentManifest(jwt) {
  const response = await fetch(await readUrl(jwt, MANIFEST_KEY), { redirect: "error" });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error("Could not read the current manifest: HTTP " + response.status);
  const text = await response.text();
  if (text.length > 256 * 1024) throw new Error("Current manifest is unexpectedly large");
  return JSON.parse(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const root = process.env.TRAINING_REVIEW_DIR || "";
  const sha = process.env.TRAINING_SOURCE_SHA || "";
  const publishedBy = process.env.TRAINING_PUBLISHED_BY || "";
  const validationFile = process.env.TRAINING_VALIDATION || "";
  if (!root || !/^[a-f0-9]{40}$/.test(sha) || !/^[\w.-]{1,80}$/.test(publishedBy) || !validationFile) {
    throw new Error("Missing publisher inputs: review directory, source SHA, publisher name or validation file");
  }
  const validated = JSON.parse(await fs.readFile(validationFile, "utf8"));
  if (!Array.isArray(validated) || !validated.length) throw new Error("Nothing validated to publish");
  const jwt = await publisherIdentity();
  const receipts = [];
  for (const item of validated) {
    for (const [filename, ext, contentType, limit] of FILES) {
      const bytes = await fs.readFile(path.join(root, item.topic, filename));
      if (bytes.length < 16 || bytes.length > limit) throw new Error("Invalid validated file " + item.topic + "/" + filename);
      const key = "training/videos/" + item.topic + "/" + sha + ext;
      const outcome = (await alreadyStored(jwt, key, bytes)) ? "reused" : await upload(jwt, key, bytes, contentType, false);
      receipts.push({ key, bytes: bytes.length, reused: outcome === "reused" });
    }
  }
  const manifest = mergeManifest(await currentManifest(jwt), validated, sha, publishedBy);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await upload(jwt, MANIFEST_KEY, manifestBytes, "application/json", true);
  // The new manifest is live: let the gateway remove recordings it no longer
  // references, so storage holds one set of videos instead of one per night.
  // A failed clean-up is reported but does not undo the publication.
  let pruned = null;
  try {
    pruned = await grant(jwt, { operation: "prune" });
    console.log("Removed " + pruned.deleted + " superseded media file(s), " + Math.round(pruned.freedBytes / 1048576) + " MB");
  } catch (error) {
    console.warn("::warning::Superseded recordings were not removed: " + String(error?.message || error));
  }
  await fs.writeFile(path.join(root, "published-upload-report.json"),
    JSON.stringify({ provider: "Vercel private Blob via OIDC", sourceSha: sha, publishedBy,
      topics: validated.map((item) => item.topic), uploaded: receipts, manifestTopics: Object.keys(manifest), pruned }, null, 2));
  console.log("Published " + validated.length + " training video(s); manifest now lists " + Object.keys(manifest).length + " topic(s)");
}
