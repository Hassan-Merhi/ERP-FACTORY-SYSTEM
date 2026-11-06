import { createRemoteJWKSet, jwtVerify } from "jose";
import { issueSignedToken, presignUrl } from "@vercel/blob";

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
  try {
    const { payload } = await jwtVerify(authorization.slice(7), jwks, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: "erp-training-private-publisher-v1",
      algorithms: ["RS256"],
    });
    const events = workflows[payload.workflow_ref] || [];
    if (String(payload.repository_id) !== "1087409074" ||
        payload.repository !== "Hassan-Merhi/ERP-FACTORY-SYSTEM" ||
        payload.ref !== "refs/heads/main" || payload.environment !== "training-publication" ||
        !events.includes(payload.event_name)) {
      return Response.json({ error: "publisher not permitted" }, { status: 403 });
    }
    const body = await request.json();
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
  } catch {
    return Response.json({ error: "publisher authorization failed" }, { status: 403 });
  }
}};
