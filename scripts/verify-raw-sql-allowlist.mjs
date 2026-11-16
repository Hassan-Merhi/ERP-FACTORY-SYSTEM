#!/usr/bin/env node
/**
 * Raw SQL review gate (npm run check:raw-sql). Fails closed.
 *
 * Scans every TypeScript / JavaScript / SQL source under the scan roots with
 * scripts/lib/raw-sql-scanner.mjs. Every SQL construction site whose dynamic
 * parts cannot be mechanically proven static or numeric must carry a manual,
 * source-bound review entry in docs/security/raw-sql-allowlist.json.
 *
 * The gate fails on:
 *   - an unreviewed site (new code, or an existing site whose normalized
 *     expression / enclosing function changed -> new fingerprint);
 *   - a stale approval (site removed or changed) or an approval for a site that
 *     no longer needs one (now provably static);
 *   - duplicate ids, malformed entries, unknown classifications, generic or
 *     short justifications, and approvals whose documented dynamic inputs do
 *     not exactly match the dynamic parts the scanner extracted;
 *   - a register (docs/security/raw-sql-audit-findings.json) that is out of
 *     date with the source tree;
 *   - a missing / empty scan root.
 *
 * Modes:
 *   node scripts/verify-raw-sql-allowlist.mjs                 check (CI)
 *   node scripts/verify-raw-sql-allowlist.mjs --inventory     print raw inventory JSON
 *   node scripts/verify-raw-sql-allowlist.mjs --write-register  regenerate the register
 *   --root <dir>  scan a different repository root (used by the checker's tests)
 */
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { scanSource } from "./lib/raw-sql-scanner.mjs";
import { validateAllowlist, buildRegister, SCAN_ROOTS, ROOT_FILES } from "./lib/raw-sql-allowlist.mjs";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const repoRoot = resolve(rootArg >= 0 ? args[rootArg + 1] : ".");
const allowlistPath = join(repoRoot, "docs/security/raw-sql-allowlist.json");
const registerPath = join(repoRoot, "docs/security/raw-sql-audit-findings.json");

const SCANNED = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/;
const IGNORED_EXT = /\.(?:d\.ts|json|md|txt|png|jpe?g|gif|svg|webp|ico|csv|xlsx|snap|html|css|ya?ml|map|lock|sh|ps1|bat|pdf|woff2?|ttf|mp4|webm|mp3|wav|zip|gz|tsbuildinfo|example|env|sample|log|controlled|meta)$/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "__snapshots__"]);

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const files = [];
const unknownExtensions = new Map();
async function walk(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (SKIP_DIRS.has(item.name)) continue;
    const path = join(folder, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.name.endsWith(".d.ts")) continue;
    else if (SCANNED.test(item.name)) files.push(path);
    else if (!IGNORED_EXT.test(item.name)) {
      const ext = item.name.includes(".") ? item.name.slice(item.name.lastIndexOf(".")) : "(none)";
      unknownExtensions.set(ext, (unknownExtensions.get(ext) ?? 0) + 1);
    }
  }
}

const rootErrors = [];
const perRoot = {};
for (const root of SCAN_ROOTS) {
  const abs = join(repoRoot, root);
  if (!(await exists(abs))) { rootErrors.push(`SCAN ROOT MISSING ${root}`); continue; }
  const before = files.length;
  await walk(abs);
  perRoot[root] = files.length - before;
  if (perRoot[root] === 0) rootErrors.push(`SCAN ROOT EMPTY ${root}`);
}
for (const f of ROOT_FILES) if (await exists(join(repoRoot, f))) files.push(join(repoRoot, f));

const findings = [];
for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const path = relative(repoRoot, file).replaceAll("\\", "/");
  findings.push(...scanSource(path, source));
}

const summarize = (list) => {
  const byKind = {};
  for (const f of list) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return byKind;
};

if (args.includes("--inventory")) {
  console.log(JSON.stringify({
    scannedFiles: files.length, perRoot, unknownExtensions: Object.fromEntries(unknownExtensions),
    found: findings.length, byKind: summarize(findings),
    autoVerified: findings.filter((f) => f.autoVerified).length,
    requiresReview: findings.filter((f) => !f.autoVerified).length,
    findings,
  }, null, 2));
  process.exit(rootErrors.length ? 1 : 0);
}

let allowlist;
try {
  allowlist = JSON.parse(await readFile(allowlistPath, "utf8"));
} catch (error) {
  console.error(`Cannot read ${allowlistPath}: ${error.message}`);
  process.exit(1);
}
const result = validateAllowlist(findings, allowlist);
const register = buildRegister(findings, allowlist, { scannedFiles: files.length, perRoot });

if (args.includes("--write-register")) {
  await writeFile(registerPath, JSON.stringify(register, null, 2) + "\n");
  console.log(`Wrote ${relative(repoRoot, registerPath)} (${register.summary.totalSites} sites)`);
}

const errors = [...rootErrors, ...result.errors];
if (!args.includes("--write-register")) {
  let committed = null;
  try { committed = JSON.parse(await readFile(registerPath, "utf8")); } catch { /* missing */ }
  const want = JSON.stringify(register.findings.map((f) => [f.id, f.disposition]));
  const have = committed ? JSON.stringify((committed.findings ?? []).map((f) => [f.id, f.disposition])) : null;
  if (want !== have) errors.push("REGISTER OUT OF DATE docs/security/raw-sql-audit-findings.json — run: node scripts/verify-raw-sql-allowlist.mjs --write-register");
}

console.log(JSON.stringify({
  scannedFiles: files.length, perRoot, found: findings.length, byKind: summarize(findings),
  autoVerified: result.autoVerified, reviewed: result.reviewed, outstanding: result.outstanding,
  unknownExtensions: Object.fromEntries(unknownExtensions), errors,
}, null, 2));
if (errors.length) process.exitCode = 1;
