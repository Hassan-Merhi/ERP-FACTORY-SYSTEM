#!/usr/bin/env node
/**
 * Phase 1 300/500 source-size policy.
 * - Files in application roots at 301-500: warning, not failure.
 * - New application files above 500: failure.
 * - Legacy files above 500 as of the frozen reference commit: cannot grow.
 * - On pull requests, files above 500 also cannot grow versus merge-base.
 * - Generated data, tests, translations, migrations and tooling are reported
 *   separately; no blanket exemption inside application paths.
 *
 * Run: node scripts/audit-file-lines.mjs [--compare-ref SHA] [--output FILE]
 * Uses only Node and Git; never modifies application files.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(projectRoot, "config/code-line-policy.json");

export function countPhysicalLines(content) {
  if (!content) return 0;
  const pieces = content.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  return pieces.length - (/(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/.test(content) ? 1 : 0);
}

export function classifySourceFile(file, policy) {
  const normalized = file.replaceAll("\\", "/");
  if (!policy.extensions.includes(path.posix.extname(normalized).toLowerCase())) return null;
  if (/(^|\/)(generated|__generated__)\//.test(normalized) || /\.generated\./.test(normalized)) return "generated";
  if (normalized.startsWith("client/src/i18n/") || normalized.startsWith("server/i18n/")) return "translation";
  if (
    normalized.startsWith("tests/") ||
    normalized.startsWith("client/tests/") ||
    normalized.startsWith("server/tests/") ||
    /(\.test\.|\.spec\.|\/__tests__\/)/.test(normalized)
  ) return "test";
  if (normalized.startsWith("scripts/") || normalized.startsWith(".github/")) return "tooling";
  if (
    normalized.startsWith("server/startup-schema/") ||
    normalized.startsWith("server/migrations/") ||
    normalized.startsWith("drizzle/") ||
    normalized.startsWith("migrations/")
  ) return "schema_migration";
  if (policy.applicationRoots.some((prefix) => normalized.startsWith(prefix))) return "application";
  return "other";
}

export function evaluateApplicationFile({ lines, legacyLines, comparedLines, warningAbove = 300, hardCapAbove = 500 }) {
  if (lines <= warningAbove) return { status: "ok", reason: null };
  if (lines <= hardCapAbove) return { status: "warning", reason: null };
  if (legacyLines === null || legacyLines === undefined || legacyLines <= hardCapAbove) {
    return { status: "failure", reason: "New or previously compliant application file exceeds the hard cap" };
  }
  if (lines > legacyLines) {
    return { status: "failure", reason: "Legacy file exceeds its frozen reference size of " + legacyLines + " lines" };
  }
  if (comparedLines === null) {
    return { status: "failure", reason: "Oversized file was newly added or restored since the comparison base" };
  }
  if (comparedLines !== undefined && lines > comparedLines) {
    return { status: "failure", reason: "Oversized file grew from " + comparedLines + " to " + lines + " lines versus merge-base" };
  }
  return { status: "grandfathered", reason: null };
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function contentAtRef(ref, file) {
  try {
    return git(["show", ref + ":" + file]);
  } catch (error) {
    if (error.status === 128 && /(?:path .* does not exist|exists on disk, but not in|Path .* does not exist)/i.test(String(error.stderr))) {
      return null;
    }
    throw new Error("Cannot read " + file + " from Git ref " + ref + ": " + String(error.stderr || error.message));
  }
}

function main() {
  const policy = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (policy.warningAbove !== 300 || policy.hardCapAbove !== 500) {
    throw new Error("Phase 1 policy thresholds are frozen at 300/500; changing them needs a reviewed policy update.");
  }
  if (!/^[a-f0-9]{40}$/.test(policy.referenceCommit)) throw new Error("Invalid pinned baseline commit.");
  const args = process.argv.slice(2);
  let compareRef = null;
  let output = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--compare-ref" && args[i + 1]) compareRef = args[++i];
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
    else throw new Error("Unknown or incomplete argument: " + args[i]);
  }
  git(["rev-parse", "--verify", policy.referenceCommit + "^{commit}"]);
  let comparisonCommit = null;
  if (compareRef) {
    git(["rev-parse", "--verify", compareRef + "^{commit}"]);
    comparisonCommit = git(["merge-base", "HEAD", compareRef]).trim();
    if (!comparisonCommit) throw new Error("Cannot find merge-base with " + compareRef);
  }

  const names = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const totals = { sourceFiles: 0, application: 0, applicationOk: 0, applicationWarning: 0, applicationGrandfathered: 0, applicationFailures: 0, excludedOversize: 0 };
  const categories = {};
  const records = [];
  const failures = [];

  for (const file of names) {
    const category = classifySourceFile(file, policy);
    if (!category) continue;
    const absolute = path.join(projectRoot, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const content = fs.readFileSync(absolute, "utf8");
    if (content.includes("\0")) continue;
    const lines = countPhysicalLines(content);
    totals.sourceFiles += 1;
    const tally = categories[category] ??= { total: 0, over500: 0, warnings: 0 };
    tally.total += 1;
    if (lines > 500) tally.over500 += 1;
    if (lines > 300 && lines <= 500) tally.warnings += 1;
    if (category !== "application") {
      if (lines > 500) totals.excludedOversize += 1;
      continue;
    }
    totals.application += 1;
    let legacyLines = undefined;
    let comparedLines = undefined;
    if (lines > policy.hardCapAbove) {
      const legacyText = contentAtRef(policy.referenceCommit, file);
      legacyLines = legacyText === null ? null : countPhysicalLines(legacyText);
      if (comparisonCommit) {
        const previousText = contentAtRef(comparisonCommit, file);
        comparedLines = previousText === null ? null : countPhysicalLines(previousText);
      }
    }
    const checked = evaluateApplicationFile({
      lines, legacyLines, comparedLines,
      warningAbove: policy.warningAbove, hardCapAbove: policy.hardCapAbove
    });
    records.push({ file, lines, status: checked.status, legacyLines, comparedLines, reason: checked.reason });
    if (checked.status === "ok") totals.applicationOk += 1;
    else if (checked.status === "warning") totals.applicationWarning += 1;
    else if (checked.status === "grandfathered") totals.applicationGrandfathered += 1;
    else {
      totals.applicationFailures += 1;
      failures.push({ file, lines, reason: checked.reason });
    }
  }

  records.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const report = { version: policy.version, referenceCommit: policy.referenceCommit, comparisonCommit, thresholds: { warningAbove: 300, hardCapAbove: 500 }, totals, categories, failures, records };
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(projectRoot, output)), { recursive: true });
    fs.writeFileSync(path.resolve(projectRoot, output), JSON.stringify(report, null, 2) + "\n");
  }
  const summaryLines = [
    "## ERP + Factory source-size policy (300 warning / 500 cap)",
    "",
    "Reference: " + policy.referenceCommit + "; compared base: " + (comparisonCommit || "not supplied"),
    "",
    "| Metric | Count |", "| --- | ---: |",
    "| Application files scanned | " + totals.application + " |",
    "| <=300 lines | " + totals.applicationOk + " |",
    "| 301-500 lines (warning) | " + totals.applicationWarning + " |",
    "| Grandfathered over 500 (no growth allowed) | " + totals.applicationGrandfathered + " |",
    "| Violations | " + totals.applicationFailures + " |",
    "| Non-application over 500 (tracked, exempt from cap) | " + totals.excludedOversize + " |",
    "",
    "Full file inventory is in the JSON build artifact (where enabled).",
    ""
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join("\n"));
  }
  console.log(summaryLines.join("\n"));
  for (const record of records.filter((item) => item.status === "warning").slice(0, 15)) {
    console.warn("WARNING: " + record.file + " has " + record.lines + " lines (warning above 300)");
  }
  for (const entry of failures.slice(0, 50)) {
    console.error("ERROR: " + entry.file + " (" + entry.lines + " lines): " + entry.reason);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error("::error file=" + entry.file + "::" + entry.reason + " (" + entry.lines + " lines)");
    }
  }
  if (failures.length > 50) console.error("... and " + (failures.length - 50) + " additional violations (see JSON).");
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
