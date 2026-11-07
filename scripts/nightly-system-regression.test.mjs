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
    "CAPTURE_FPS = 2", "MIN_DURATION_SECONDS = 60", "TRAINING_MAX_SECONDS || 1200",
    // Every page of the training companies, split across parallel shards.
    "async function discoverTours(page)", "TRAINING_SHARD", "function topicIdForRoute(route)",
    "TRAINING_TTS_MODEL must point to the Piper voice",
    "training-narration-tts.py", 'from "./training-narration.mjs"',
    "describeControl(row)", "enumerateScreen", "locateAndScroll", "paintOverlay", 'from "./training-screen.mjs"',
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
  // Page discovery also expands collapsed sidebar sections, which only reveals links.
  assert.equal((recorder.match(/\.click\(/g) || []).length, 10, "login, onboarding, sidebar section expansion, tab replay, layer opening and reversible demo clicks only");
  assert.ok(recorder.includes("const NEVER_CLICK = ") && recorder.includes("function explorable(row)") && recorder.includes("!NEVER_CLICK.test(label)"), "destructive, printing and exporting buttons are explained but never pressed");
  assert.ok(recorder.includes("function pickTarget(rows)") && recorder.includes('row.role === "option"'), "only a list choice or an explicit select/import entry is demonstrated inside a layer");
  assert.ok(recorder.includes("MAX_LAYERS = ") && recorder.includes("layerOnly: true") && recorder.includes("hiddenControlsExplained"), "hidden menus, lists and dialogs are opened and their controls explained");
  assert.ok(recorder.includes("explainsSharedChrome") && recorder.includes("sharedChromeNarration("), "the shared top bar and sidebar are explained once per mode, not in every video");
  assert.ok(recorder.includes('window.print = () => undefined') && recorder.includes('"Browser.setDownloadBehavior", { behavior: "deny" }'), "printing, pop-ups and downloads are neutralised");
  assert.ok(recorder.includes("parentPath: [...tabPath]") && recorder.includes("for (const parent of next.parentPath) await clickTab(page, parent);"), "nested tab strips restore their parent tab before exploration");
  assert.ok(recorder.includes('segment.tabPath.join("/") !== appliedPath'), "replay re-applies the whole tab path whenever it branches");
  assert.ok(recorder.includes('page.keyboard.press("Escape")'), "opened menus are closed again");
  assert.ok(recorder.includes('page.keyboard.press("Backspace")'), "typed demo text is cleared again");
  assert.ok(recorder.includes("function demoFor(row)") && recorder.includes('return null;'), "demos are an allow-list, not arbitrary clicking");
  const screen = read("scripts/training-screen.mjs");
  assert.ok(recorder.includes("class CursorTrack") && recorder.includes("overlay@cur") && recorder.includes("sendcmd=f=") && recorder.includes("OUTPUT_FPS = 12"), "the pointer is composited at the full output frame rate so it glides");
  assert.ok(screen.includes("export const CURSOR_SVG") && recorder.includes("omitBackground: true"), "the pointer image is rendered from the SVG once per run");
  assert.ok(screen.includes("export const LAYER_SELECTOR") && screen.includes("export function openLayerType()"), "overlay layers are detected before Escape is pressed");
  const narration = read("scripts/training-narration.mjs");
  assert.ok(!/anthropic|openai|fetch\(/i.test(narration), "narration is deterministic, not generated by a remote model");
  const tts = read("scripts/training-narration-tts.py");
  assert.ok(tts.includes("from piper import PiperVoice"));
  assert.ok(!/urllib|requests|http/.test(tts), "voice synthesis makes no network calls");
  const validator = read("scripts/validate-training-recording.mjs");
  const uploader = read("scripts/upload-reviewed-training-vercel.mjs");
  const api = read("server/routes/trainingMediaRoutes.ts");
  const gateway = read("training/gateway/api/upload-url.js");
  const signer = read("training/gateway/api/sign.js");
  assert.ok(validator.includes('"screen.mp4"'));
  assert.ok(validator.includes('stream?.codec_name !== "h264"'));
  assert.ok(validator.includes('audio?.codec_name !== "aac"'), "published videos must carry the narration track");
  assert.ok(validator.includes("MIN_DURATION_SECONDS = 60") && validator.includes("MAX_DURATION_SECONDS = 1200"));
  assert.ok(validator.includes('"-xerror"'), "every published video is fully decoded first");
  assert.ok(uploader.includes('["screen.mp4", ".mp4", "video/mp4"'));
  assert.ok(uploader.includes('sha + ".mp4"'));
  assert.ok(gateway.includes("video/mp4"));
  assert.ok(signer.includes("webm|mp4|vtt|png"));
  assert.ok(api.includes('key.endsWith(".mp4")') && api.includes('"video/mp4"') && api.includes('"video/webm"'));
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

test("nightly publication is automatic but only for validated recordings of the audited main commit", () => {
  const parent = read(".github/workflows/nightly-training-audit.yml");
  const publish = parent.slice(parent.indexOf("\n  publish:\n"), parent.indexOf("\n  notify:\n"));
  assert.ok(publish.includes("needs: [plan, record]"));
  assert.ok(publish.includes("needs.record.result == 'success' && github.ref == 'refs/heads/main'"));
  assert.ok(publish.includes("environment: training-publication"));
  assert.ok(publish.includes("group: training-publisher"));
  assert.ok(publish.includes("id-token: write") && !publish.includes("contents: write"), "the publisher never needs a repository write token");
  assert.ok(publish.includes("TRAINING_PUBLICATION_APPROVAL_ENABLED: ${{ vars.TRAINING_PUBLICATION_APPROVAL_ENABLED }}"));
  assert.ok(publish.includes("TRAINING_SOURCE_SHA: ${{ github.sha }}"), "only this run's own commit can be published");
  assert.ok(publish.includes("pattern: real-erp-training-${{ github.run_id }}-shard-*"), "only this run's own shards are published");
  assert.ok(publish.includes("merge-multiple: true"));
  assert.ok(publish.includes("node scripts/validate-training-recording.mjs"));
  assert.ok(publish.includes("node scripts/upload-reviewed-training-vercel.mjs"));
  assert.ok(parent.includes("needs: [plan, record, publish]"));
  const validator = read("scripts/validate-training-recording.mjs");
  assert.ok(validator.includes('entry.sourceSha !== sha'));
  assert.ok(validator.includes('entry.status !== "captured"'));
  assert.ok(validator.includes('["screen.mp4", "captions.vtt", "guide.md", "screenshot.png"]'));
  assert.ok(validator.includes('startsWith("WEBVTT")'));
  const uploader = read("scripts/upload-reviewed-training-vercel.mjs");
  assert.ok(uploader.includes("export function mergeManifest("), "re-recorded topics replace their entry and the rest survive");
  assert.ok(uploader.includes('"x-allow-overwrite": overwrite ? "1" : "0"'), "only the manifest may be overwritten");
  const gateway = read("training/gateway/api/upload-url.js");
  assert.ok(gateway.includes("nightly-training-audit.yml@refs/heads/main"));
  assert.ok(gateway.includes('payload.environment !== "training-publication"'));
  assert.ok(gateway.includes("allowOverwrite: overwrite") && gateway.includes("const overwrite = key === manifestKey"));
  // Clean-up: the gateway, not the publisher, decides what is superseded.
  assert.ok(gateway.includes('body?.operation === "prune"') && gateway.includes("async function pruneSuperseded()"));
  assert.ok(gateway.includes('refusing to prune against an empty manifest'), "never prune against a missing manifest");
  assert.ok(gateway.includes("pruneGraceMs") && gateway.includes("keep.has(blob.pathname)"), "live and in-flight media survive");
  assert.ok(gateway.includes("supersedeGraceMs") && gateway.includes("replacedAt > supersededCutoff"), "a just-replaced recording outlives the ERP's manifest cache");
  assert.ok(!/del\([^)]*manifestKey/.test(gateway), "the manifest itself is never deleted");
  assert.ok(uploader.includes('grant(jwt, { operation: "prune" })'), "each publication removes superseded media");
  const api = read("server/routes/trainingMediaRoutes.ts");
  assert.ok(api.includes("export async function loadPublishedTrainingRegistry()") && api.includes("MANIFEST_TTL_MS"), "the ERP re-reads the manifest without a deploy");
  assert.ok(api.includes('app.get("/api/training/media", requireAuth'));
});

test("manual re-publication of one topic still validates the source recorder job", () => {
  const workflow = read(".github/workflows/publish-training-video.yml");
  assert.ok(workflow.includes("environment: training-publication"));
  assert.ok(workflow.includes('TRAINING_PUBLICATION_APPROVAL_ENABLED:'));
  assert.ok(workflow.includes('run.head_branch !== "main"'));
  assert.ok(workflow.includes('"push", "schedule", "workflow_dispatch"'));
  assert.ok(workflow.includes("(record \\/ )?record-training( \\(\\d+\\))?$"), "every recording shard is checked");
  assert.ok(workflow.includes('recorder.some((job) => job.status !== "completed" || job.conclusion !== "success")'));
  assert.ok(workflow.includes("node scripts/validate-training-recording.mjs"));
  assert.ok(workflow.includes("node scripts/upload-reviewed-training-vercel.mjs"));
  assert.ok(!workflow.includes("gh pr create"), "publication no longer waits for a manifest pull request and deploy");
});

test("training PR smoke crosses Factory to ERP and only records after verified company switching", () => {
  const workflow = read(".github/workflows/training-videos.yml");
  const recorder = read("scripts/record-training-guides.mjs");
  assert.ok(workflow.includes("'factory-overview,erp-tracking'"));
  assert.ok(workflow.includes("name: real-erp-training-${{ github.run_id }}-shard-${{ matrix.shard }}"), "each shard keeps its own artifact");
  assert.ok(workflow.includes("TRAINING_SHARD: ${{ matrix.shard }}/"));
  const switcher = recorder.slice(recorder.indexOf("async function selectFixtureCompany"), recorder.indexOf("async function encodeAndValidate"));
  assert.ok(switcher.indexOf('page.goto(base + "/my-settings"') < switcher.indexOf('fetch("/api/auth/set-company"'));
  assert.ok(switcher.includes("for (let attempt = 1; attempt <= 3; attempt++)"));
  assert.ok(switcher.includes('Number(active.companyId) === companyId'));
  assert.ok(switcher.includes('localStorage.getItem("selectedCompanyId") === String(companyId)'));
  assert.ok(switcher.includes('throw new Error("Fixture session company would not settle'));
});
