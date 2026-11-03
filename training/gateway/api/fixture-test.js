/**
 * One-time, protected Preview-only verification of private Vercel Blob signed
 * upload, authenticated playback, byte ranges, and fixture deletion.
 * Never available in production or without the explicit preview opt-in.
 */
import { randomBytes, createHash, createHmac } from "node:crypto";
import { issueSignedToken, presignUrl, del } from "@vercel/blob";
import signer from "./sign.js";
const store = "store_TXyFGTsySrCeQhOj";
const fixture = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIIEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggHy7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIk0t5u340ITycgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QdzWUA4JCwgRC6gRCagQJVsIRVuYEBElTDZ0B/c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS43LjEwM3Nz2mPAi2PFiJNLebt+NCE8Z8ilRaOHRU5DT0RFUkSHmExhdmM2MS4xOS4xMDEgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnXF54EAo6uBAACAgkmDQgAA8AD2ADgkHBhCAAAwYAAAEL///DrE/////5+sf///bZAAo5OBAfQAhgBAkpwASUAAAyAAAEJAHFO7a5G7j7OBALeK94EB8YIBqPCBAw==", "base64");
export default {
  async fetch(request) {
    if (process.env.VERCEL_ENV !== "preview" || process.env.TRAINING_GATEWAY_FIXTURE_ENABLED !== "true") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (request.method !== "GET" || process.env.BLOB_STORE_ID !== store || fixture.length !== 568) {
      return Response.json({ error: "test prerequisites missing" }, { status: 503 });
    }
    const sha = randomBytes(20).toString("hex");
    const key = "training/videos/gateway-fixture/" + sha + ".webm";
    const host = "txyfgtsysrceqhoj.private.blob.vercel-storage.com";
    const report = { bytes: fixture.length, expectedSha256: createHash("sha256").update(fixture).digest("hex") };
    let uploaded = false;
    try {
      const putToken = await issueSignedToken({
        pathname: key, operations: ["put"], validUntil: Date.now() + 120000,
        allowedContentTypes: ["video/webm"], maximumSizeInBytes: 4096, allowOverwrite: false,
      });
      const putGrant = await presignUrl(putToken, {
        pathname: key, operation: "put", validUntil: Date.now() + 90000,
      });
      const putUrl = new URL(putGrant.presignedUrl);
      if (putUrl.protocol !== "https:" || putUrl.origin !== "https://vercel.com" ||
          putUrl.pathname !== "/api/blob/" || putUrl.searchParams.get("pathname") !== key ||
          !putUrl.searchParams.has("vercel-blob-delegation") ||
          !putUrl.searchParams.has("vercel-blob-signature") ||
          !putUrl.searchParams.has("vercel-blob-valid-until")) {
        throw Error("untrusted signed Blob PUT destination");
      }
      const putResult = await fetch(putUrl, {
        method: "PUT", body: fixture, headers: { "Content-Type": "video/webm" }, redirect: "error",
      });
      report.uploadStatus = putResult.status;
      if (!putResult.ok) throw Error("signed upload rejected: HTTP " + putResult.status);
      uploaded = true;

      const raw = await fetch("https://" + host + "/" + key, { redirect: "error" });
      report.unauthenticatedReadStatus = raw.status;
      if (raw.ok) throw Error("PRIVATE object unexpectedly public");

      const signerSecret = process.env.TRAINING_GATEWAY_READ_SECRET || "";
      if (signerSecret.length < 40) throw Error("preview gateway authentication not configured");
      const time = Date.now().toString();
      const signature = createHmac("sha256", signerSecret)
        .update("GET\n" + key + "\n" + time).digest("hex");
      const signedResponse = await signer.fetch(new Request("https://preview.invalid/api/sign?key=" + encodeURIComponent(key), {
        headers: { "x-training-time": time, "x-training-signature": signature },
      }));
      report.gatewayAuthorizedStatus = signedResponse.status;
      if (signedResponse.status !== 200) throw Error("valid gateway authorization was refused");
      const signedResult = await signedResponse.json();
      const readUrl = new URL(signedResult.url);
      if (readUrl.hostname !== host || readUrl.pathname !== "/" + key) throw Error("untrusted GET destination");

      const read = await fetch(readUrl, { redirect: "error" });
      report.authorizedReadStatus = read.status;
      const bytes = Buffer.from(await read.arrayBuffer());
      report.actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (read.status !== 200 || !bytes.equals(fixture)) throw Error("signed playback differs from fixture");

      const ranged = await fetch(readUrl, { headers: { Range: "bytes=0-63" }, redirect: "error" });
      report.rangeStatus = ranged.status;
      const fragment = Buffer.from(await ranged.arrayBuffer());
      report.rangeBytes = fragment.length;
      if (ranged.status !== 206 || !fragment.equals(fixture.subarray(0, 64))) {
        throw Error("video byte-range playback failed");
      }
      report.result = "PASS";
    } catch (error) {
      report.result = "FAIL";
      report.reason = error instanceof Error ? error.message.slice(0, 180) : "Unknown storage error";
    } finally {
      if (uploaded) {
        try { await del(key); report.cleanup = "deleted"; } catch { report.cleanup = "failed"; }
      } else {
        report.cleanup = "no object uploaded";
      }
    }
    return Response.json(report, { status: report.result === "PASS" && report.cleanup === "deleted" ? 200 : 500,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  },
};
