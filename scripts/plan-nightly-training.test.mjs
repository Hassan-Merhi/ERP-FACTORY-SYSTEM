import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
test("planner refuses non-SHA revision", () => {
  const r = spawnSync(process.execPath, ["scripts/plan-nightly-training.mjs"], {
    env: { ...process.env, TRAINING_BASELINE_SHA: "not-a-sha" },
    encoding: "utf8"
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid baseline/);
});
test("first run selects all approved tours", () => {
  const r = spawnSync(process.execPath, ["scripts/plan-nightly-training.mjs"], {
    env: { ...process.env, TRAINING_BASELINE_SHA: "" },
    encoding: "utf8"
  });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(fs.readFileSync("artifacts/training-plan/plan.json", "utf8"));
  assert.equal(plan.selectedTopics.length, 16);
});
test("a narration-only change regenerates every tour", () => {
  const source = fs.readFileSync("scripts/plan-nightly-training.mjs", "utf8");
  const pattern = /scripts\\\/training-narration\(\?:-tts\)\?\\\.\(\?:mjs\|py\)/;
  assert.match(source, pattern, "classifier treats the narration modules as all-topic dependencies");
  const regex = new RegExp(source.match(/if \((\/\^\(training\\\/.*?\/)\.test\(f\)\)/)[1].slice(1, -1));
  for (const f of ["scripts/training-narration.mjs", "scripts/training-narration-tts.py", "scripts/record-training-guides.mjs"]) assert.ok(regex.test(f), f);
  assert.ok(!regex.test("scripts/other.mjs"));
});
