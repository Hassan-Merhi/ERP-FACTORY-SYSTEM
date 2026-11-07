import { createRemoteJWKSet, jwtVerify } from "jose";
import { del, issueSignedToken, list, presignUrl } from "@vercel/blob";

const store = "store_TXyFGTsySrCeQhOj";
const mediaKey = /^training\/videos\/[a-z0-9-]{1,80}\/[0-9a-f]{40}\.(webm|mp4|vtt|png)$/;
// The published-media manifest is the one mutable object: the ERP reads it at
// runtime, so a nightly publication replaces it in place.
const manifestKey = "training/manifest/current.json";
const manifestLimit = 256 * 1024;
const jwks = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const workflows = {
  // Nightly audit: records, validates and publishes without a human step.
  "Hassan-Merhi/ERP-FACTORY-SYSTEM/.github/workflows/nightly-training-audit.yml@refs/heads/main": ["schedule", "workflow_dispatch", "push"],
  // Manual re-publication of one topic from an earlier recording run.
  "Hassan-Merhi/ERP-FACTORY-SYSTEM/.github/workflows/publish-training-video.yml@refs/heads/main": ["workflow_dispatch"],
};
const host = "txyfgtsysrceqhoj.private.blob.vercel-storage.com";
// Superseded recordings are removed after each publication so the store only
// holds what Help & Training serves. Objects younger than this are kept so an
// upload still in flight is never touched.
const pruneGraceMs = 60 * 60 * 1000;
// The ERP caches the manifest (60 s) and signed reads (40 s), so a recording
// replaced moments ago may still be streamed: keep it until its topic's new
// entry has been live this long. In practice it goes at the next publication.
const supersedeGraceMs = 10 * 60 * 1000;
const pruneLimit = 1000;

async function readManifest() {
  const token = await issueSignedToken({ pathname: manifestKey, operations: ["get"], validUntil: Date.now() + 100000 });
  const result = await presignUrl(token, { pathname: manifestKey, operation: "get", access: "private", validUntil: Date.now() + 60000 });
  const url = new URL(result.presignedUrl);
  if (url.host !== host || url.pathname !== "/" + manifestKey) throw Error("invalid manifest destination");
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw Error("manifest unreadable: HTTP " + response.status);
  return response.json();
}

/**
 * Delete media the live manifest no longer references. The gateway reads the
 * manifest itself, so a publisher can never name what gets deleted, and it
 * refuses to prune against a missing or empty manifest.
 */
async function pruneSuperseded() {
  const manifest = await readManifest();
  const entries = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? Object.values(manifest) : [];
  const keep = new Set();
  for (const entry of entries) {
    for (const field of ["videoKey", "captionsKey", "screenshotKey"]) {
      if (typeof entry?.[field] === "string" && mediaKey.test(entry[field])) keep.add(entry[field]);
    }
  }
  if (!keep.size) throw Error("refusing to prune against an empty manifest");
  const cutoff = Date.now() - pruneGraceMs;
  const supersededCutoff = Date.now() - supersedeGraceMs;
  const stale = [];
  let cursor;
  do {
    const page = await list({ prefix: "training/videos/", limit: 1000, cursor });
    for (const blob of page.blobs) {
      if (!mediaKey.test(blob.pathname) || keep.has(blob.pathname)) continue;
      if (new Date(blob.uploadedAt).getTime() > cutoff) continue;
      // Orphans of a failed publication (topic not in the manifest) only need
      // the upload grace; a replaced recording also waits out the ERP cache.
      const replacement = manifest[blob.pathname.split("/")[2]];
      if (replacement) {
        const replacedAt = Date.parse(replacement.publishedAt || "");
        if (!Number.isFinite(replacedAt) || replacedAt > supersededCutoff) continue;
      }
      stale.push(blob);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && stale.length < pruneLimit);
  const batch = stale.slice(0, pruneLimit);
  for (let i = 0; i < batch.length; i += 100) await del(batch.slice(i, i + 100).map((blob) => blob.url));
  return { kept: keep.size, deleted: batch.length, freedBytes: batch.reduce((sum, blob) => sum + (blob.size || 0), 0) };
}

function contentTypeFor(key) {
  if (key === manifestKey) return "application/json";
  const ext = key.slice(key.lastIndexOf("."));
  return ext === ".webm" ? "video/webm" : ext === ".mp4" ? "video/mp4" : ext === ".vtt" ? "text/vtt" : "image/png";
}

function sizeLimitFor(key) {
  if (key === manifestKey) return manifestLimit;
  const ext = key.slice(key.lastIndexOf("."));
  return [".webm", ".mp4"].includes(ext) ? 100 * 1024 * 1024 : ext === ".png" ? 10 * 1024 * 1024 : 512 * 1024;
}

export default { async fetch(request) {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  if (process.env.BLOB_STORE_ID !== store) return Response.json({ error: "store unavailable" }, { status: 503 });
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ") || authorization.length > 10000) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), jwks, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: "erp-training-private-publisher-v1",
      algorithms: ["RS256"],
    }));
  } catch (error) {
    // Name the failed check (jose error code, e.g. ERR_JWT_EXPIRED) so the
    // publisher's log shows why; never echo the token itself.
    const reason = String(error?.code || error?.name || "invalid token").slice(0, 60);
    console.error("training gateway: identity rejected:", reason);
    return Response.json({ error: "publisher authorization failed", reason }, { status: 403 });
  }
  try {
    const events = workflows[payload.workflow_ref] || [];
    if (String(payload.repository_id) !== "1087409074" ||
        payload.repository !== "Hassan-Merhi/ERP-FACTORY-SYSTEM" ||
        payload.ref !== "refs/heads/main" || payload.environment !== "training-publication" ||
        !events.includes(payload.event_name)) {
      return Response.json({ error: "publisher not permitted", reason: "workflow, ref, environment or event" }, { status: 403 });
    }
    const body = await request.json();
    if (body?.operation === "prune") {
      return Response.json(await pruneSuperseded(), { headers: { "cache-control": "no-store" } });
    }
    const key = typeof body?.key === "string" ? body.key : "";
    const operation = body?.operation === "get" ? "get" : "put";
    if (key !== manifestKey && !mediaKey.test(key)) {
      return Response.json({ error: "invalid upload" }, { status: 400 });
    }
    if (operation === "get") {
      // The publisher reads the manifest back to merge tonight's recordings
      // with earlier nights, and checks whether an immutable media object
      // already exists before a rollback re-publishes an older recording.
      const token = await issueSignedToken({ pathname: key, operations: ["get"], validUntil: Date.now() + 100000 });
      const result = await presignUrl(token, { pathname: key, operation: "get", access: "private", validUntil: Date.now() + 60000 });
      const url = new URL(result.presignedUrl);
      if (url.host !== host || url.pathname !== "/" + key) throw Error("invalid read destination");
      return Response.json({ readUrl: result.presignedUrl }, { headers: { "cache-control": "no-store" } });
    }
    const size = body?.bytes;
    if (!Number.isInteger(size) || size < 2) return Response.json({ error: "invalid upload" }, { status: 400 });
    if (size > sizeLimitFor(key)) return Response.json({ error: "upload too large" }, { status: 413 });
    const type = contentTypeFor(key);
    const overwrite = key === manifestKey;
    const token = await issueSignedToken({
      pathname: key, operations: ["put"], validUntil: Date.now() + 12 * 60000,
      allowedContentTypes: [type], maximumSizeInBytes: size, allowOverwrite: overwrite,
    });
    // The overwrite permission must be on the presigned URL as well as the
    // token: storage reads it from the signed vercel-blob-allow-overwrite
    // query parameter and otherwise refuses to replace the manifest.
    const result = await presignUrl(token, {
      pathname: key, operation: "put", access: "private", validUntil: Date.now() + 10 * 60000,
      ...(overwrite ? { allowOverwrite: true } : {}),
    });
    const url = new URL(result.presignedUrl);
    // Signed PUT uses Vercel's control-plane /api/blob/ endpoint rather than
    // the private content hostname used by signed GET.
    if (url.protocol !== "https:" || url.origin !== "https://vercel.com" ||
        url.pathname !== "/api/blob/" || url.searchParams.get("pathname") !== key ||
        !url.searchParams.has("vercel-blob-delegation") ||
        !url.searchParams.has("vercel-blob-signature") ||
        !url.searchParams.has("vercel-blob-valid-until")) {
      throw Error("invalid upload destination");
    }
    return Response.json({ uploadUrl: result.presignedUrl, contentType: type, allowOverwrite: overwrite }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // Signing failures are storage-side (credentials, store state, Vercel API),
    // not a refused publisher: report them as such with the error type.
    const reason = (String(error?.name || "Error") + ": " + String(error?.message || "")).slice(0, 200);
    console.error("training gateway: signing failed:", reason);
    return Response.json({ error: "signing unavailable", reason }, { status: 502 });
  }
}};
