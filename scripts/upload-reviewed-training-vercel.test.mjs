import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeManifest, MANIFEST_KEY } from "./upload-reviewed-training-vercel.mjs";

const sha = "7f3e07f2cbfc67e31df7eb08b195c8164f2c1f46";
const older = "a48020f7c3838135ec05232b5ac30d11e20e1dca";

test("a re-recorded topic replaces its entry and untouched topics survive", () => {
  const current = {
    "erp-pos": { videoKey: "training/videos/erp-pos/" + older + ".mp4", sourceSha: older },
    "factory-overview": { videoKey: "training/videos/factory-overview/" + older + ".mp4", sourceSha: older },
  };
  const next = mergeManifest(current, [{ topic: "factory-overview", durationSeconds: 1191.5, guideSteps: ["Open it."] }], sha, "nightly-audit", "2026-11-06T02:30:00.000Z");
  assert.deepEqual(Object.keys(next), ["erp-pos", "factory-overview"]);
  assert.equal(next["erp-pos"].sourceSha, older, "topics not recorded tonight keep their published video");
  assert.equal(next["factory-overview"].videoKey, "training/videos/factory-overview/" + sha + ".mp4");
  assert.equal(next["factory-overview"].captionsKey, "training/videos/factory-overview/" + sha + ".vtt");
  assert.equal(next["factory-overview"].screenshotKey, "training/videos/factory-overview/" + sha + ".png");
  assert.equal(next["factory-overview"].durationSeconds, 1192);
  assert.equal(next["factory-overview"].publishedBy, "nightly-audit");
  assert.deepEqual(next["factory-overview"].guideSteps, ["Open it."]);
});

test("an empty or missing manifest starts from nothing and rejects bad topic ids", () => {
  assert.deepEqual(Object.keys(mergeManifest(undefined, [{ topic: "erp-pos", durationSeconds: 90, guideSteps: [] }], sha, "x")), ["erp-pos"]);
  assert.throws(() => mergeManifest({}, [{ topic: "../etc", durationSeconds: 90, guideSteps: [] }], sha, "x"), /Invalid topic id/);
  assert.equal(MANIFEST_KEY, "training/manifest/current.json");
});
