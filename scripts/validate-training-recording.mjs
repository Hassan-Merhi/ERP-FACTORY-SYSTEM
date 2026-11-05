/**
 * Validates the recorder's review artifact before anything is published.
 *
 * For every requested topic the report entry must be a captured recording of
 * the expected source commit, the four files must exist, the captions must be
 * WebVTT, and the MP4 must decode completely as H.264/yuv420p with an AAC
 * narration track between one and twenty minutes. Nothing here uploads.
 *
 *   TRAINING_REVIEW_DIR   directory holding report.json and one folder per topic
 *   TRAINING_SOURCE_SHA   commit the recording must come from
 *   TRAINING_TOPICS       comma-separated topic ids (default: every captured topic)
 *   TRAINING_VALIDATION_OUTPUT  optional path for the JSON list of valid topics
 */
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const MIN_DURATION_SECONDS = 60;
export const MAX_DURATION_SECONDS = 1200;
const TOPIC_ID = /^[a-z0-9-]{1,80}$/;
const FILES = ["screen.mp4", "captions.vtt", "guide.md", "screenshot.png"];

export function readReport(root) {
  const report = JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8"));
  if (!Array.isArray(report)) throw new Error("Missing recording report");
  return report;
}

export function captured(report, sha) {
  return report
    .filter((entry) => entry && entry.status === "captured" && entry.requiresReview === true && entry.sourceSha === sha)
    .map((entry) => entry.topic)
    .filter((topic) => TOPIC_ID.test(topic));
}

export function guideSteps(guideText) {
  if (guideText.length > 30_000) throw new Error("Guide is unexpectedly large");
  const steps = guideText.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => line.replace(/^\d+\. /, "").trim());
  if (!steps.length || steps.length > 20) throw new Error("Guide must contain numbered steps");
  return steps;
}

export async function probe(video) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt:format=duration", "-of", "json", video,
  ]);
  const result = JSON.parse(stdout);
  const stream = result.streams?.find((item) => item.codec_type === "video");
  const audio = result.streams?.find((item) => item.codec_type === "audio");
  const duration = Number(result.format?.duration);
  if (stream?.codec_name !== "h264" || stream?.pix_fmt !== "yuv420p" || audio?.codec_name !== "aac" ||
      !Number.isFinite(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw new Error("Training recording must decode as a narrated 1-20 minute H.264/yuv420p + AAC MP4");
  }
  await execFile("ffmpeg", ["-hide_banner", "-v", "error", "-xerror", "-i", video, "-f", "null", "-"]);
  return duration;
}

export async function validateTopic(root, topic, sha, report) {
  if (!TOPIC_ID.test(topic)) throw new Error("Invalid topic id");
  const entry = report.find((item) => item && item.topic === topic);
  if (!entry || entry.sourceSha !== sha || entry.status !== "captured" || entry.requiresReview !== true) {
    throw new Error(topic + ": no successful recording of commit " + sha);
  }
  for (const file of FILES) {
    const full = path.join(root, topic, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size < 16) {
      throw new Error(topic + ": missing or empty recording file " + file);
    }
  }
  if (!fs.readFileSync(path.join(root, topic, "captions.vtt"), "utf8").startsWith("WEBVTT")) {
    throw new Error(topic + ": invalid captions");
  }
  const steps = guideSteps(fs.readFileSync(path.join(root, topic, "guide.md"), "utf8"));
  const durationSeconds = await probe(path.join(root, topic, "screen.mp4"));
  return { topic, durationSeconds, guideSteps: steps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const root = process.env.TRAINING_REVIEW_DIR || "";
  const sha = process.env.TRAINING_SOURCE_SHA || "";
  if (!root || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("TRAINING_REVIEW_DIR and TRAINING_SOURCE_SHA are required");
  const report = readReport(root);
  const requested = (process.env.TRAINING_TOPICS || "").split(",").map((value) => value.trim()).filter(Boolean);
  const topics = requested.length ? requested : captured(report, sha);
  if (!topics.length) throw new Error("No captured recording of commit " + sha + " to validate");
  const valid = [];
  for (const topic of topics) {
    const result = await validateTopic(root, topic, sha, report);
    valid.push(result);
    console.log("Validated " + topic + ": " + Math.round(result.durationSeconds) + "s narrated MP4, " + result.guideSteps.length + " guide steps");
  }
  const output = process.env.TRAINING_VALIDATION_OUTPUT;
  if (output) fs.writeFileSync(output, JSON.stringify(valid, null, 2));
}
