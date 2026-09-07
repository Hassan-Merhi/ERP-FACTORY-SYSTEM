#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache"]);
const lockNames = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const packageDirs = new Map();
const orphanLocks = [];

function walk(dir, rel = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const packagePath = path.join(dir, "package.json");

  if (files.has("package.json")) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const locks = lockNames.filter((name) => files.has(name));
    packageDirs.set(rel || ".", { pkg, locks });
  } else {
    for (const lock of lockNames) {
      if (files.has(lock)) orphanLocks.push(rel ? `${rel}/${lock}` : lock);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredDirs.has(entry.name)) continue;
    walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
  }
}

walk(root);

const failures = [];
const rootBoundary = packageDirs.get(".");
if (!rootBoundary) failures.push("Root package.json is required.");
else {
  if (Object.prototype.hasOwnProperty.call(rootBoundary.pkg, "workspaces")) {
    failures.push("Root package.json must not declare npm workspaces; standalone package boundaries are managed independently.");
  }
  if (rootBoundary.locks.length !== 1 || rootBoundary.locks[0] !== "package-lock.json") {
    failures.push(`Root package must use exactly package-lock.json; found ${rootBoundary.locks.length ? rootBoundary.locks.join(", ") : "no lockfile"}.`);
  }
}

for (const [dir, boundary] of packageDirs) {
  if (dir === ".") continue;
  if (boundary.locks.length === 0) continue;
  if (boundary.locks.length > 1) {
    failures.push(`Package boundary ${dir} has multiple lockfiles: ${boundary.locks.join(", ")}.`);
    continue;
  }
  if (boundary.locks[0] === "package-lock.json" && boundary.pkg.private !== true) {
    failures.push(`Standalone npm package boundary ${dir} must set private: true before keeping its own package-lock.json.`);
  }
}

if (orphanLocks.length) failures.push(`Lockfiles without a sibling package.json are not allowed: ${orphanLocks.join(", ")}`);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

const standalone = [...packageDirs.entries()].filter(([dir, boundary]) => dir !== "." && boundary.locks.length > 0);
console.log(`Workspace/lockfile hygiene OK: npm root plus ${standalone.length} explicit standalone package boundar${standalone.length === 1 ? "y" : "ies"}; one lockfile per boundary.`);
