import { createRemoteJWKSet, jwtVerify } from "jose";
import { issueSignedToken, presignUrl } from "@vercel/blob";

const store = "store_TXyFGTsySrCeQhOj";
const allowed = /^training\/videos\/[a-z0-9-]{1,80}\/[0-9a-f]{40}\.(webm|vtt|png)$/;
const jwks = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const workflow = "Hassan-Merhi/ERP-FACTORY-SYSTEM/.github/workflows/publish-training-video.yml@refs/heads/main";

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
    if (String(payload.repository_id) !== "1087409074" ||
        payload.repository !== "Hassan-Merhi/ERP-FACTORY-SYSTEM" ||
        payload.ref !== "refs/heads/main" || payload.environment !== "training-publication" ||
        payload.event_name !== "workflow_dispatch" || payload.workflow_ref !== workflow) {
      return Response.json({ error: "publisher not permitted" }, { status: 403 });
    }
    const body = await request.json();
    const key = typeof body?.key === "string" ? body.key : "";
    const size = body?.bytes;
    if (!allowed.test(key) || !Number.isInteger(size) || size < 16) {
      return Response.json({ error: "invalid upload" }, { status: 400 });
    }
    const ext = key.slice(key.lastIndexOf("."));
    const limit = ext === ".webm" ? 100 * 1024 * 1024 : ext === ".png" ? 10 * 1024 * 1024 : 512 * 1024;
    if (size > limit) return Response.json({ error: "upload too large" }, { status: 413 });
    const type = ext === ".webm" ? "video/webm" : ext === ".vtt" ? "text/vtt" : "image/png";
    const token = await issueSignedToken({
      pathname: key, operations: ["put"], validUntil: Date.now() + 12 * 60000,
      allowedContentTypes: [type], maximumSizeInBytes: size, allowOverwrite: false,
    });
    const result = await presignUrl(token, {
      pathname: key, operation: "put", validUntil: Date.now() + 10 * 60000,
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
    return Response.json({ uploadUrl: result.presignedUrl, contentType: type }, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "publisher authorization failed" }, { status: 403 });
  }
}};
