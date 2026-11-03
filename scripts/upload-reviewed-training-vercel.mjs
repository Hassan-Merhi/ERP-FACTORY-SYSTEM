/**
 * Run only in the reviewed main-branch GitHub Actions publication environment.
 * Request a GitHub OIDC JWT, have the Vercel gateway verify its identity,
 * obtain one signed PUT URL per approved immutable media object, and upload
 * directly without any reusable Vercel Blob credential.
 */
import fs from "node:fs/promises";
import path from "node:path";

const gateway = "https://erp-training-storage-access.vercel.app";
const topic = process.env.TOPIC || "";
const sha = process.env.TRAINING_SOURCE_SHA || "";
const root = process.env.RUNNER_TEMP || "";
if (!/^[a-z0-9-]{1,80}$/.test(topic) || !/^[a-f0-9]{40}$/.test(sha) || !root ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
  throw new Error("Missing reviewed publisher identity, artifact or source SHA");
}
const identityUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
identityUrl.searchParams.set("audience", "erp-training-private-publisher-v1");
const jwtResp = await fetch(identityUrl, {
  headers: { Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
  redirect: "error",
});
if (!jwtResp.ok) throw new Error("Unable to obtain the GitHub OIDC publisher identity");
const jwt = (await jwtResp.json()).value;
if (typeof jwt !== "string" || jwt.length < 200) throw new Error("Invalid GitHub OIDC identity");

const files = [
  ["screen.webm", ".webm", "video/webm", 100 * 1024 * 1024],
  ["captions.vtt", ".vtt", "text/vtt", 512 * 1024],
  ["screenshot.png", ".png", "image/png", 10 * 1024 * 1024],
];
const receipts = [];
for (const [filename, ext, contentType, limit] of files) {
  const file = path.join(root, "review", topic, filename);
  const bytes = await fs.readFile(file);
  if (bytes.length < 16 || bytes.length > limit) throw new Error("Invalid reviewed file " + filename);
  const key = "training/videos/" + topic + "/" + sha + ext;
  const grantResp = await fetch(gateway + "/api/upload-url", {
    method: "POST",
    headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" },
    body: JSON.stringify({ key, bytes: bytes.length }),
    redirect: "error",
  });
  if (!grantResp.ok) throw new Error("The protected gateway refused the reviewed media upload: " + filename);
  const grant = await grantResp.json();
  if (grant.contentType !== contentType || typeof grant.uploadUrl !== "string") {
    throw new Error("Gateway returned unexpected upload requirements");
  }
  const url = new URL(grant.uploadUrl);
  if (url.protocol !== "https:" || url.origin !== "https://vercel.com" ||
      url.pathname !== "/api/blob/" || url.searchParams.get("pathname") !== key ||
      !url.searchParams.has("vercel-blob-delegation") ||
      !url.searchParams.has("vercel-blob-signature") ||
      !url.searchParams.has("vercel-blob-valid-until")) {
    throw new Error("Gateway returned an untrusted upload destination");
  }
  const upload = await fetch(url, {
    method: "PUT", body: bytes, headers: { "Content-Type": contentType }, redirect: "error",
  });
  if (!upload.ok) throw new Error("Private storage rejected " + filename + ": HTTP " + upload.status);
  receipts.push({ key, bytes: bytes.length });
}
await fs.writeFile(path.join(root, "review", topic, "approved-upload-report.json"),
  JSON.stringify({ provider: "Vercel private Blob via OIDC", sourceSha: sha, topic, uploaded: receipts }, null, 2));
console.log("Approved private training upload completed:", receipts.length, "files");
