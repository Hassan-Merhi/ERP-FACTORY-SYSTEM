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

/** One report per recording shard (report.json, or report-<n>.json when sharded). */
export function readReport(root) {
  const files = fs.readdirSync(root).filter((name) => /^report(-\d+)?\.json$/.test(name)).sort();
  if (!files.length) throw new Error("Missing recording report");
  const report = [];
  for (const name of files) {
    const part = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    if (!Array.isArray(part)) throw new Error("Malformed recording report " + name);
    report.push(...part);
  }
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

/**
 * Top-level MP4 box order. Apple's players (iPhone/iPad/Mac Safari) stream an
 * MP4 over HTTP byte ranges and need the index (moov) before the media (mdat).
 */
export function topLevelBoxes(video) {
  const fd = fs.openSync(video, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    const boxes = [];
    let offset = 0;
    while (offset + 8 <= size && boxes.length < 64) {
      fs.readSync(fd, header, 0, 16, offset);
      let length = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      else if (length === 0) length = size - offset;
      if (length < 8) throw new Error("Corrupt MP4 box " + JSON.stringify(type));
      boxes.push(type);
      offset += length;
    }
    return boxes;
  } finally {
    fs.closeSync(fd);
  }
}

/** Rejects files Apple's players refuse even though desktop FFmpeg decodes them. */
export function assertAppleCompatible(boxes, stream) {
  const moov = boxes.indexOf("moov");
  const mdat = boxes.indexOf("mdat");
  if (boxes[0] !== "ftyp" || moov < 0 || mdat < 0 || moov > mdat) {
    throw new Error("Training recording must be fast-start (ftyp, moov before mdat); found " + boxes.join(","));
  }
  const width = Number(stream.width);
  const height = Number(stream.height);
  const [num, den] = String(stream.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = den ? num / den : 0;
  if (!["Main", "High", "Constrained Baseline", "Baseline"].includes(stream.profile) ||
      !(Number(stream.level) > 0 && Number(stream.level) <= 42) ||
      !(width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0 && width <= 1920 && height <= 1080) ||
      !(fps >= 10 && fps <= 60) || stream.codec_tag_string !== "avc1") {
    throw new Error("Training recording is not Apple-playable H.264: " + describeStream(stream));
  }
}

function describeStream(stream) {
  return [stream.codec_tag_string, stream.profile, "L" + stream.level, stream.width + "x" + stream.height,
    stream.avg_frame_rate + "fps"].join(" ");
}

export async function probe(video) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries",
    "stream=codec_type,codec_name,codec_tag_string,profile,level,width,height,avg_frame_rate,pix_fmt:format=duration",
    "-of", "json", video,
  ]);
  const result = JSON.parse(stdout);
  const stream = result.streams?.find((item) => item.codec_type === "video");
  const audio = result.streams?.find((item) => item.codec_type === "audio");
  const duration = Number(result.format?.duration);
  if (stream?.codec_name !== "h264" || stream?.pix_fmt !== "yuv420p" || audio?.codec_name !== "aac" ||
      !Number.isFinite(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw new Error("Training recording must decode as a narrated 1-20 minute H.264/yuv420p + AAC MP4");
  }
  const boxes = topLevelBoxes(video);
  process.stdout.write(path.basename(path.dirname(video)) + " layout " + boxes.join(",") + "; " + describeStream(stream) + "\n");
  assertAppleCompatible(boxes, stream);
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
  const route = typeof entry.route === "string" && /^\/[a-z0-9][a-z0-9/_-]{0,119}$/.test(entry.route) ? entry.route : undefined;
  return { topic, durationSeconds, guideSteps: steps, route };
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
