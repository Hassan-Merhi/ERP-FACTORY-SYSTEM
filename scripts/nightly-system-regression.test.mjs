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


test("reviewable training videos narrate every visible control as H.264 + AAC MP4 within the duration ceiling", () => {
  const recorder = read("scripts/record-training-guides.mjs");
  const rows = recorder.split("\n").filter((line) => /^  "(?:factory|erp)-[^"]+": .*steps: \[/.test(line));
  assert.equal(rows.length, 16, "all current training topics need a script");
  for (const row of rows) {
    const match = row.match(/steps: (\[.*\]) \},?$/);
    assert.ok(match, "training script needs a machine-readable step array");
    assert.equal(JSON.parse(match[1]).length, 5, "every topic should explain five distinct stages");
  }
  for (const required of [
    "CAPTURE_FPS = 2", "MIN_DURATION_SECONDS = 60", "MAX_DURATION_SECONDS = 1200",
    "TRAINING_TTS_MODEL must point to the Piper voice",
    "training-narration-tts.py", 'from "./training-narration.mjs"',
    "describeControl(row)", "enumerateScreen", "locateAndScroll", "paintOverlay",
    'path.join(dir, "screen.mp4")', '"libx264"', '"yuv420p"', '"+faststart"',
    '"-c:a", "aac"', 'audio?.codec_name !== "aac"',
    'await execFile("ffprobe"', '"-xerror"',
    "page.screenshot({", 'type: "jpeg"', "encodeAndValidate(framesDir",
    "await fs.rm(framesDir", "await fs.rm(clipsDir", "Number(video.nb_frames)",
    "joinWavClips(segments.map(",
  ]) {
    assert.ok(recorder.includes(required), required);
  }
  assert.ok(!recorder.includes("page.screencast("), "avoid unbounded CDP/FFmpeg piping and EPIPE");
  assert.ok(!recorder.includes("screen.webm"), "do not upload incomplete WebM recordings");
  assert.ok(recorder.includes('["GET", "HEAD", "OPTIONS"]'), "prevent writes while recording");
  // Clicks are limited to login, already-visible tabs, and reversible demos
  // (typing into a search box, opening a dropdown/filter menu) that are undone.
  assert.equal((recorder.match(/\.click\(/g) || []).length, 8, "login, onboarding, tab replay and reversible demo clicks only");
  assert.ok(recorder.includes('page.keyboard.press("Escape")'), "opened menus are closed again");
  assert.ok(recorder.includes('page.keyboard.press("Backspace")'), "typed demo text is cleared again");
  assert.ok(recorder.includes("function demoFor(row)") && recorder.includes('return null;'), "demos are an allow-list, not arbitrary clicking");
  assert.ok(recorder.includes('id="trl-cursor"'), "an animated cursor shows where to look");
  const narration = read("scripts/training-narration.mjs");
  assert.ok(!/anthropic|openai|fetch\(/i.test(narration), "narration is deterministic, not generated by a remote model");
  const tts = read("scripts/training-narration-tts.py");
  assert.ok(tts.includes("from piper import PiperVoice"));
  assert.ok(!/urllib|requests|http/.test(tts), "voice synthesis makes no network calls");
  const review = read(".github/workflows/publish-training-video.yml");
  const uploader = read("scripts/upload-reviewed-training-vercel.mjs");
  const manifest = read("scripts/register-published-training.mjs");
  const api = read("server/routes/trainingMediaRoutes.ts");
  const gateway = read("training/gateway/api/upload-url.js");
  const signer = read("training/gateway/api/sign.js");
  assert.ok(review.includes('"screen.mp4"'));
  assert.ok(review.includes('video?.codec_name !== "h264"'));
  assert.ok(review.includes('audio?.codec_name !== "aac"'), "published videos must carry the narration track");
  assert.ok(review.includes("duration < 60 || duration > 1200"));
  assert.ok(uploader.includes('["screen.mp4", ".mp4", "video/mp4"'));
  assert.ok(manifest.includes('sha + ".mp4"'));
  assert.ok(gateway.includes("video/mp4"));
  assert.ok(signer.includes("webm|mp4|vtt|png"));
  assert.ok(api.includes('key.endsWith(".mp4") ? "video/mp4"'));
});

test("the recording workflow installs the offline narration voice with pinned checksums", () => {
  const workflow = read(".github/workflows/training-videos.yml");
  assert.ok(workflow.includes("piper-tts==1.8.0"));
  assert.ok(workflow.includes("TRAINING_TTS_MODEL"));
  assert.ok(workflow.includes("sha256sum -c"), "voice files are verified before use");
  assert.ok(workflow.includes("4ba07d8549906668ee855fd9abf9faf66c5db74742712ff026a159f7277fca9f"), "en_US-lessac-medium.onnx checksum");
  assert.ok(workflow.includes("efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0"), "en_US-lessac-medium.onnx.json checksum");
  assert.ok(workflow.includes("timeout-minutes: 180"), "sixteen narrated tours need more than the old 40 minutes");
});

test("training publication still requires protected approval and a successful source recorder job", () => {
  const workflow = read(".github/workflows/publish-training-video.yml");
  assert.ok(workflow.includes("environment: training-publication"));
  assert.ok(workflow.includes('TRAINING_PUBLICATION_APPROVAL_ENABLED:'));
  assert.ok(workflow.includes('run.head_branch !== "main"'));
  assert.ok(workflow.includes('"push", "schedule", "workflow_dispatch"'));
  assert.ok(workflow.includes('job.name === "record / record-training"'));
  assert.ok(workflow.includes('recorder[0].conclusion !== "success"'));
  assert.ok(workflow.includes('entry.sourceSha !== process.env.TRAINING_SOURCE_SHA'));
  assert.ok(workflow.includes('["screen.mp4", "captions.vtt", "guide.md", "screenshot.png"]'));
  assert.ok(workflow.includes('video?.codec_name !== "h264"'));
});

test("training PR smoke crosses Factory to ERP and only records after verified company switching", () => {
  const workflow = read(".github/workflows/training-videos.yml");
  const recorder = read("scripts/record-training-guides.mjs");
  assert.ok(workflow.includes("'factory-overview,erp-tracking'"));
  const switcher = recorder.slice(recorder.indexOf("async function selectFixtureCompany"), recorder.indexOf("async function encodeAndValidate"));
  assert.ok(switcher.indexOf('page.goto(base + "/my-settings"') < switcher.indexOf('fetch("/api/auth/set-company"'));
  assert.ok(switcher.includes("for (let attempt = 1; attempt <= 3; attempt++)"));
  assert.ok(switcher.includes('Number(active.companyId) === companyId'));
  assert.ok(switcher.includes('localStorage.getItem("selectedCompanyId") === String(companyId)'));
  assert.ok(switcher.includes('throw new Error("Fixture session company would not settle'));
});
