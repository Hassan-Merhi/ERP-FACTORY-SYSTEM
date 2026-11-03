import { createHmac, timingSafeEqual } from "node:crypto";
import { issueSignedToken, presignUrl } from "@vercel/blob";

const store = "store_TXyFGTsySrCeQhOj";
const allowed = /^training\/videos\/[a-z0-9-]{1,80}\/[0-9a-f]{40}\.(?:webm|vtt|png)$/;
const host = "txyfgtsysrceqhoj.private.blob.vercel-storage.com";

export default { async fetch(request) {
  if (request.method !== "GET") return Response.json({ error: "method" }, { status: 405 });
  const key = new URL(request.url, "https://gateway.invalid").searchParams.get("key") || "";
  if (!allowed.test(key)) return Response.json({ error: "invalid key" }, { status: 400 });
  const secret = process.env.TRAINING_GATEWAY_READ_SECRET || "";
  const time = request.headers.get("x-training-time") || "";
  const signature = request.headers.get("x-training-signature") || "";
  if (secret.length < 40 || !/^\d{13}$/.test(time) || !/^[a-f0-9]{64}$/.test(signature) ||
      Math.abs(Date.now() - Number(time)) > 120000) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const expected = createHmac("sha256", secret).update("GET\n" + key + "\n" + time).digest("hex");
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (process.env.BLOB_STORE_ID !== store) return Response.json({ error: "store unavailable" }, { status: 503 });
  try {
    const token = await issueSignedToken({ pathname: key, operations: ["get"], validUntil: Date.now() + 100000 });
    const result = await presignUrl(token, { pathname: key, operation: "get", access: "private", validUntil: Date.now() + 60000 });
    const url = new URL(result.presignedUrl);
    if (url.host !== host || url.pathname !== "/" + key) throw Error("Invalid storage response");
    return Response.json({ url: result.presignedUrl }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "signing unavailable" }, { status: 502 });
  }
}};
