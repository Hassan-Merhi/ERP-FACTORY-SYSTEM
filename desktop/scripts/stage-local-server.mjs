#!/usr/bin/env node
// Full offline mode (Phase A3b): stage the ERP server for the desktop app's
// local copy into desktop/build/erp-server. Run on the operating system you
// are building for (Windows or Mac): the embedded PostgreSQL binaries and the
// server's native packages are installed for that system.
//
//   npm run build            (repository root: builds dist/)
//   cd desktop && npm run stage:offline && npm run build:all   (or build:mac)

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EMBEDDED_POSTGRES = "embedded-postgres@18.6.0-beta.19";
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktop, "..");
const out = path.join(desktop, "build", "erp-server");

if (!existsSync(path.join(repo, "dist", "index.js"))) {
  console.error("dist/index.js is missing: run `npm run build` in the repository root first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of [
  "dist",
  "migrations",
  "scripts/db",
  "scripts/pc-sync",
  "server/lib/databaseSsl.mjs",
  "server/schema",
  "server/offline/pcSync/tablePolicy.mjs",
  "config/pc-sync-table-policy.json",
  "package.json",
  "package-lock.json",
]) {
  cpSync(path.join(repo, item), path.join(out, item), { recursive: true });
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args) => execFileSync(npm, args, { cwd: out, stdio: "inherit", shell: process.platform === "win32" });
run(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
run(["install", "--no-save", "--no-audit", "--no-fund", EMBEDDED_POSTGRES]);
console.log(`Staged ${out}`);
