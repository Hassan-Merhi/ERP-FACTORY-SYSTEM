import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");

test("scheduled nightly work includes both transaction and full-system runs", () => {
  const parent = read(".github/workflows/nightly-training-audit.yml");
  assert.ok(parent.includes("  transactions:"));
  assert.ok(parent.includes("  whole-system:"));
  assert.ok(parent.includes("nightly-system-regression.yml"));
  assert.ok(parent.includes("needs: [transactions, whole-system]"));
});

test("full-system suite covers actual browser, backend and frontend behavior", () => {
  const workflow = read(".github/workflows/nightly-system-regression.yml");
  for (const name of ["backend", "frontend", "rendered-pages", "audits", "coverage-ratchet"]) {
    assert.ok(workflow.includes("  " + name + ":"), name);
  }
  for (const name of ["test:backend:coverage", "test:frontend:coverage", "verify-factory-mobile-browser.mjs",
    "verify-erp-mobile-program.mjs", "audit:coverage-ratchet"]) {
    assert.ok(workflow.includes(name), name);
  }
});

test("disposable fixture is mandatory for synthetic financial reconciliation", () => {
  const script = read("scripts/verify-nightly-transaction-reconciliation.mjs");
  assert.ok(script.includes("ERP_E2E_DISPOSABLE_DB"));
  assert.ok(script.includes("TRAINING_SANDBOX_VERIFIED"));
  assert.ok(script.includes("heliumdb"));
  assert.ok(script.includes("localhost"));
});

test("nightly accounting distinguishes POS revenue from explicit journal credits", () => {
  const verifier = read("scripts/verify-nightly-transaction-reconciliation.mjs");
  assert.ok(verifier.includes("posSalesGrossUsd"));
  assert.ok(verifier.includes("journalCreditNetUsd"));
  assert.ok(verifier.includes("cashNetCents, posGrossCents + journalCreditCents"));
});

test("recording verifies real HTML, the active route and content after client-side navigation", () => {
  const recorder = read("scripts/record-training-guides.mjs");
  assert.ok(recorder.includes("if (response && !response.ok())"));
  assert.ok(recorder.includes('http.type.includes("text/html")'));
  assert.ok(recorder.includes('page.waitForSelector("#main-content"'));
  assert.ok(recorder.includes("main.textContent.trim().length > 20"));
  assert.ok(recorder.includes("if (actualPath !== tour.route)"));
  assert.ok(recorder.includes('["GET", "HEAD", "OPTIONS"]'));
});

test("nightly inventory audit captures real data and a clearly unreviewed classification worksheet", () => {
  const workflow = read(".github/workflows/nightly-system-regression.yml");
  assert.ok(workflow.includes("run-program6c-inventory-review.mjs --report="));
  assert.ok(workflow.includes("generate-program6c-inventory-classifications.mjs --report="));
  assert.ok(!workflow.includes("npm run audit:inventory-contracts:validate"));
});


test("reviewable training videos use five explained steps, H.264 MP4 and a 60-second ceiling", () => {
  const recorder = read("scripts/record-training-guides.mjs");
  const rows = recorder.split("\n").filter((line) => /^  "(?:factory|erp)-[^"]+": .*steps: \[/.test(line));
  assert.equal(rows.length, 16, "all current training topics need a script");
  for (const row of rows) {
    const match = row.match(/steps: (\[.*\]) \},?$/);
    assert.ok(match, "training script needs a machine-readable step array");
    assert.equal(JSON.parse(match[1]).length, 5, "every topic should explain five distinct stages");
  }
  for (const required of [
    "CAPTION_HOLD_MS = 9_000", "MAX_DURATION_SECONDS = 60",
    'path.join(dir, "screen.mp4")', '"libx264"', '"yuv420p"', '"+faststart"',
    'await execFile("ffprobe"', '"-xerror"', "await fs.unlink(sourceWebm)"
  ]) {
    assert.ok(recorder.includes(required), required);
  }
  const review = read(".github/workflows/publish-training-video.yml");
  const uploader = read("scripts/upload-reviewed-training-vercel.mjs");
  const manifest = read("scripts/register-published-training.mjs");
  const api = read("server/routes/trainingMediaRoutes.ts");
  const gateway = read("training/gateway/api/upload-url.js");
  const signer = read("training/gateway/api/sign.js");
  assert.ok(review.includes('"screen.mp4"'));
  assert.ok(review.includes('video?.codec_name !== "h264"'));
  assert.ok(uploader.includes('["screen.mp4", ".mp4", "video/mp4"'));
  assert.ok(manifest.includes('sha + ".mp4"'));
  assert.ok(gateway.includes("video/mp4"));
  assert.ok(signer.includes("webm|mp4|vtt|png"));
  assert.ok(api.includes('key.endsWith(".mp4") ? "video/mp4"'));
});
