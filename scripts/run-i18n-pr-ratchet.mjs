#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const [baseSha, outputDirArg = "artifacts/i18n-audit"] = process.argv.slice(2);
if (!baseSha) {
  console.error("Usage: node scripts/run-i18n-pr-ratchet.mjs <base-sha> [output-dir]");
  process.exit(2);
}

if (!/^[0-9a-f]{40}$/.test(baseSha)) {
  console.error("Base SHA must be an exact 40-character lowercase hexadecimal commit.");
  process.exit(2);
}

const workspace = process.cwd();
const outputDir = path.resolve(workspace, outputDirArg);
fs.mkdirSync(outputDir, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const currentJson = path.join(outputDir, "report.json");
const currentMarkdown = path.join(outputDir, "report.md");
const baseJson = path.join(outputDir, "base-report.json");
const baseMarkdown = path.join(outputDir, "base-report.md");
const baseWorktree = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "i18n-base-"));

try {
  run(process.execPath, [
    "scripts/audit-i18n-phase14.mjs",
    "--no-enforce",
    "--json-out",
    currentJson,
    "--markdown-out",
    currentMarkdown,
  ]);

  run("git", ["worktree", "add", "--detach", baseWorktree, baseSha]);

  run(
    process.execPath,
    [
      "scripts/audit-i18n-phase14.mjs",
      "--no-enforce",
      "--json-out",
      baseJson,
      "--markdown-out",
      baseMarkdown,
    ],
    { cwd: baseWorktree }
  );

  run(process.execPath, [
    "scripts/verify-i18n-pr-ratchet.mjs",
    baseJson,
    currentJson,
  ]);
} finally {
  spawnSync("git", ["worktree", "remove", "--force", baseWorktree], {
    stdio: "ignore",
  });
}
