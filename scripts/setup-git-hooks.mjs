#!/usr/bin/env node
/**
 * Point git at the committed hooks directory (scripts/git-hooks) so the
 * pre-push type-check gate installs automatically on `npm install`.
 *
 * Safe / idempotent:
 *  - Normalizes the Express 5 route-param declaration after dependency install
 *    so the existing server keeps its flat-string request-param contract.
 *  - No-ops hook wiring silently outside a git work tree (e.g. CI checkouts,
 *    tarball installs).
 *  - Only sets core.hooksPath; never overwrites existing hook files.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = "scripts/git-hooks";

function normalizeExpressRouteParamTypes() {
  const typeFile = join(
    repoRoot,
    "node_modules",
    "@types",
    "express-serve-static-core",
    "index.d.ts",
  );

  if (!existsSync(typeFile)) return;

  const source = readFileSync(typeFile, "utf8");
  let next = source;

  next = next.replace(
    /(export interface ParamsDictionary \{\r?\n\s*\[key: string\]:) string \| string\[\];/,
    "$1 string;",
  );
  next = next.replace(
    /\{ \[P in GetRouteParameter<Rest>\]: string\[\] \}/g,
    "{ [P in GetRouteParameter<Rest>]: string }",
  );

  if (next.includes("[key: string]: string | string[];")) {
    throw new Error("Express route-param compatibility patch did not match ParamsDictionary");
  }

  if (next !== source) {
    writeFileSync(typeFile, next, "utf8");
    console.log("express types: restored flat-string route parameter compatibility");
  }
}

try {
  normalizeExpressRouteParamTypes();
} catch (err) {
  console.error(`express types: compatibility setup failed (${err?.message ?? err})`);
  process.exit(1);
}

// CI checkouts are disposable and monitored for source writes. Hook wiring is
// a local developer convenience, so do not mutate checkout metadata in CI.
if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
  process.exit(0);
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

try {
  // Bail quietly if this is not a git work tree.
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") process.exit(0);
} catch {
  process.exit(0);
}

try {
  git(["config", "core.hooksPath", hooksDir]);
  const hookPath = join(repoRoot, hooksDir, "pre-push");
  if (existsSync(hookPath)) chmodSync(hookPath, 0o755);
  console.log(`git hooks: core.hooksPath -> ${hooksDir} (pre-push type-check gate active)`);
} catch (err) {
  // Never fail an install because hook wiring did not take.
  console.warn(`git hooks: setup skipped (${err?.message ?? err})`);
}
