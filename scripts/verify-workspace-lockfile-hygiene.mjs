#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache"]);
const foreignLocks = new Set(["yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"]);
const nestedLocks = [];
const foreign = [];

function walk(dir, rel = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, relative);
    else if (entry.isFile()) {
      if (entry.name === "package-lock.json" && relative !== "package-lock.json") nestedLocks.push(relative);
      if (foreignLocks.has(entry.name)) foreign.push(relative);
    }
  }
}

walk(root);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const hasWorkspaces = Object.prototype.hasOwnProperty.call(pkg, "workspaces");
const failures = [];
if (hasWorkspaces) failures.push("Root package.json declares workspaces, but this repository is managed as a single npm package.");
if (nestedLocks.length) failures.push(`Nested package-lock files are not allowed: ${nestedLocks.join(", ")}`);
if (foreign.length) failures.push(`Multiple package-manager lockfiles are not allowed: ${foreign.join(", ")}`);
if (!fs.existsSync(path.join(root, "package-lock.json"))) failures.push("Root package-lock.json is required.");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Workspace/lockfile hygiene OK: single root npm package with one package-lock.json.");
