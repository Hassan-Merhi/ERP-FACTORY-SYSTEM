/**
 * One-time, protected Preview-only verification of private Vercel Blob signed
 * upload, authenticated playback, byte ranges, and fixture deletion.
 * Never available in production or without the explicit preview opt-in.
 */
import { randomBytes, createHash, createHmac } from "node:crypto";
import { issueSignedToken, presignUrl, del, get, put, head, list } from "@vercel/blob";
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
    let directUploaded = false;
    const directKey = "training/videos/gateway-fixture/" + randomBytes(20).toString("hex") + ".webm";
    try {
      const putToken = await issueSignedToken({
        pathname: key, operations: ["put"], validUntil: Date.now() + 120000,
        allowedContentTypes: ["video/webm"], maximumSizeInBytes: 4096, allowOverwrite: false,
      });
      const putGrant = await presignUrl(putToken, {
        pathname: key, operation: "put", access: "private", validUntil: Date.now() + 90000,
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
        method: "PUT", body: fixture, headers: { "Content-Type": "video/webm", "x-content-type": "video/webm", "x-vercel-blob-access": "private", "x-add-random-suffix": "0", "x-allow-overwrite": "0" }, redirect: "error",
      });
      report.uploadStatus = putResult.status;
      if (!putResult.ok) throw Error("signed upload rejected: HTTP " + putResult.status);
      uploaded = true;
      report.uploadContentType = putResult.headers.get("content-type");
      const receiptText = await putResult.text();
      if ((report.uploadContentType || "").includes("json")) {
        try {
          const receipt = JSON.parse(receiptText);
          report.uploadReceiptKeys = Object.keys(receipt).slice(0, 10);
          report.uploadReceiptPath = typeof receipt.pathname === "string" ? receipt.pathname : null;
          report.uploadReceiptHost = typeof receipt.url === "string" ? new URL(receipt.url).hostname : null;
        } catch { report.uploadReceiptJsonValid = false; }
      } else {
        report.uploadReceiptKind = receiptText.trim().slice(0, 60);
      }
      report.uploadReceiptSize = typeof receiptText === "string" && receiptText.startsWith("{")
        ? (JSON.parse(receiptText).size ?? null) : null;
      try {
        const direct = await put(directKey, fixture, {
          access: "private", contentType: "video/webm", addRandomSuffix: false,
        });
        directUploaded = true;
        report.directPutHost = new URL(direct.url).hostname;
        report.directPutPathValid = direct.pathname === directKey;
        const directFromKey = await get(directKey, { access: "private", useCache: false });
        report.directSdkKeyStatus = directFromKey?.statusCode ?? null;
        if (directFromKey?.stream) {
          report.directSdkKeyHash = createHash("sha256")
            .update(Buffer.from(await new Response(directFromKey.stream).arrayBuffer())).digest("hex");
        }
        const directFromUrl = await get(direct.url, { access: "private", useCache: false });
        report.directSdkUrlStatus = directFromUrl?.statusCode ?? null;
        if (directFromUrl?.stream) {
          report.directSdkUrlHash = createHash("sha256")
            .update(Buffer.from(await new Response(directFromUrl.stream).arrayBuffer())).digest("hex");
        }
      } catch (directError) {
        report.directSdkError = directError instanceof Error ? directError.name : "Unknown storage error";
      }
      try {
        const listing = await list({ prefix: "training/videos/gateway-fixture/", limit: 100 });
        report.listHasSignedObject = listing.blobs.some((item) => item.pathname === key);
        report.listHasDirectObject = listing.blobs.some((item) => item.pathname === directKey);
      } catch (listingError) {
        report.listError = listingError instanceof Error ? listingError.name : "Unknown storage error";
      }
      try {
        const h = await head(key);
        report.headMatchesSignedKey = h?.pathname === key;
      } catch (headingError) {
        report.headError = headingError instanceof Error ? headingError.name : "Unknown storage error";
      }
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const stored = await get(key, { access: "private", useCache: false });
          report.sdkReadAttempts = attempt;
          report.sdkReadStatus = stored?.statusCode ?? null;
          if (stored?.stream) {
            const actualBytes = Buffer.from(await new Response(stored.stream).arrayBuffer());
            report.sdkReadSha256 = createHash("sha256").update(actualBytes).digest("hex");
            break;
          }
        } catch (storageError) {
          report.sdkReadError = storageError instanceof Error ? storageError.name : "Unknown storage error";
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

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
      if (signedResponse.status !== 200) {
        try {
          const diagnosticToken = await issueSignedToken({
            pathname: key, operations: ["get"], validUntil: Date.now() + 120000,
          });
          const grant = await presignUrl(diagnosticToken, {
            pathname: key, operation: "get", access: "private", validUntil: Date.now() + 60000,
          });
          const u = new URL(grant.presignedUrl);
          report.getHost = u.hostname;
          report.getPathPrefix = u.pathname.slice(0, 100);
          report.getQueryKeys = Array.from(u.searchParams.keys()).join(",");
        } catch (diagnosticError) {
          report.getDiagnostic = diagnosticError instanceof Error ? diagnosticError.name : "unknown error";
        }
        throw Error("valid gateway authorization was refused");
      }
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
      if (directUploaded) {
        try { await del(directKey); report.directCleanup = "deleted"; } catch { report.directCleanup = "failed"; }
      }
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
