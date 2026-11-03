/**
 * Records an explicitly approved private object in the shared manifest.
 * Workflow has a protected environment gate and creates a PR; no live
 * publication happens until that PR is reviewed and merged/deployed.
 */
import fs from "node:fs";
const path = "shared/publishedTrainingMedia.json";
const topic = process.env.TRAINING_PUBLISH_TOPIC || "";
const sha = process.env.TRAINING_SOURCE_SHA || "";
const approvedBy = process.env.TRAINING_APPROVED_BY || "";
const guidePath = process.env.TRAINING_APPROVED_GUIDE_PATH || "";
if (!/^[a-z0-9-]{1,80}$/.test(topic) || !/^[a-f0-9]{40}$/.test(sha) ||
    !/^[\w-]{1,80}$/.test(approvedBy)) {
  throw new Error("Invalid published training metadata");
}
const catalog = fs.readFileSync("scripts/record-training-guides.mjs", "utf8");
if (!catalog.includes('"' + topic + '": {')) throw new Error("Unrecognized recording tour ID");
if (!guidePath || !fs.existsSync(guidePath)) throw new Error("Approved guide file required");
const guideText = fs.readFileSync(guidePath, "utf8");
if (guideText.length > 15_000) throw new Error("Guide is unexpectedly large");
const guideSteps = guideText.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, "").trim());
if (!guideSteps.length || guideSteps.length > 20) throw new Error("Guide must contain reviewed steps");
const current = JSON.parse(fs.readFileSync(path, "utf8"));
current[topic] = {
  videoKey: "training/videos/" + topic + "/" + sha + ".mp4",
  captionsKey: "training/videos/" + topic + "/" + sha + ".vtt",
  screenshotKey: "training/videos/" + topic + "/" + sha + ".png",
  guideSteps,
  sourceSha: sha,
  publishedAt: new Date().toISOString(),
  approvedBy
};
fs.writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
console.log("Prepared approved media manifest entry for " + topic + " from " + sha);
