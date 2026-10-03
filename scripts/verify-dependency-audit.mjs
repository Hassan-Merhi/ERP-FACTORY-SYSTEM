#!/usr/bin/env node
/**
 * verify-dependency-audit.mjs
 *
 * Fails the build on any high or critical vulnerability in the production
 * dependency tree, except for advisories explicitly accepted below.
 *
 * This replaces a bare `npm audit --audit-level=critical`, which let every
 * high-severity finding through silently because npm has no way to accept a
 * single advisory. Here an exception must be written down, justified, and
 * given a review date — so "we looked at it and accepted it" and "nobody has
 * looked at it" stop being indistinguishable.
 *
 * Usage:  node scripts/verify-dependency-audit.mjs [--include-dev]
 *
 * By default only the production tree is audited, matching what actually ships.
 * --include-dev widens it to build and test tooling, for the scheduled sweep.
 */
import { execFileSync } from "child_process";

const includeDev = process.argv.includes("--include-dev");
const scope = includeDev ? "all dependencies" : "production dependencies";

/**
 * Vulnerabilities we have reviewed and accepted, keyed by package name.
 *
 * Every entry needs:
 *   reason    — why this is not exploitable here, or why we cannot act yet
 *   reviewOn  — YYYY-MM-DD to re-check; the build warns once this passes
 *
 * An entry is NOT a way to silence a finding you have not investigated. If
 * an upstream fix appears, this script tells you to drop the exception.
 */
// One advisory, one dependency path: tailwindcss -> chokidar / fast-glob / micromatch -> braces.
const BRACES_BUILD_ONLY = {
  reason:
    "braces has no patched release (GHSA-vfj7-8cjw-p6xm affects every version). It is reached only through tailwindcss 3, which runs at build time to scan this repository's own content globs; build tools are kept in dependencies because Render installs with NODE_ENV=production. No request input ever becomes a glob pattern, and the server bundle does not load tailwindcss, chokidar, fast-glob, micromatch or braces (scripts/verify-runtime-dependencies.mjs). npm's only remedy is the tailwindcss 4 major upgrade, tracked separately.",
  reviewOn: "2026-11-03",
};

const ACCEPTED = {
  braces: BRACES_BUILD_ONLY,
  chokidar: BRACES_BUILD_ONLY,
  "fast-glob": BRACES_BUILD_ONLY,
  micromatch: BRACES_BUILD_ONLY,
  tailwindcss: BRACES_BUILD_ONLY,
};

const BLOCKING = new Set(["high", "critical"]);

const auditArgs = includeDev ? ["audit", "--json"] : ["audit", "--omit=dev", "--json"];

let raw;
try {
  raw = execFileSync("npm", auditArgs, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (error) {
  // npm audit exits non-zero when it finds anything, but still prints the
  // report on stdout. Only a missing/!unparseable report is a real failure.
  raw = error.stdout;
  if (!raw) {
    console.error("❌  DEPENDENCY AUDIT FAILED");
    console.error(`   Could not run \`npm ${auditArgs.join(" ")}\`.`);
    console.error(`   ${error.message}`);
    process.exit(1);
  }
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("❌  DEPENDENCY AUDIT FAILED");
  console.error("   `npm audit --json` did not return parseable JSON.");
  process.exit(1);
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const blocking = [];
const accepted = [];

for (const vulnerability of vulnerabilities) {
  if (!BLOCKING.has(vulnerability.severity)) continue;
  const exception = ACCEPTED[vulnerability.name];
  if (exception) accepted.push({ vulnerability, exception });
  else blocking.push(vulnerability);
}

const today = new Date().toISOString().slice(0, 10);
let warned = false;

for (const { vulnerability, exception } of accepted) {
  console.log(`ℹ️   Accepted: ${vulnerability.name} (${vulnerability.severity})`);
  console.log(`    ${exception.reason}`);

  if (exception.reviewOn < today) {
    console.log(`::warning::Audit exception for "${vulnerability.name}" was due for review on ${exception.reviewOn}.`);
    warned = true;
  }

  // fixAvailable turns truthy once upstream ships a patch — at which point
  // the exception is obsolete and should be deleted rather than carried.
  if (vulnerability.fixAvailable) {
    console.log(
      `::warning::A fix is now available for "${vulnerability.name}". Apply it and remove the exception from scripts/verify-dependency-audit.mjs.`
    );
    warned = true;
  }
}

// An exception for something that no longer appears is dead weight — it will
// silently pre-approve the package if it ever returns.
for (const name of Object.keys(ACCEPTED)) {
  if (!accepted.some(({ vulnerability }) => vulnerability.name === name)) {
    console.log(
      `::warning::"${name}" has no high/critical advisory anymore. Remove its exception from scripts/verify-dependency-audit.mjs.`
    );
    warned = true;
  }
}

if (blocking.length > 0) {
  console.error("\n❌  DEPENDENCY AUDIT FAILED");
  console.error(`   ${blocking.length} unreviewed high/critical vulnerability(ies) in ${scope}:\n`);

  for (const vulnerability of blocking) {
    const advisories = (vulnerability.via ?? [])
      .filter((entry) => typeof entry === "object")
      .map((entry) => `${entry.title} (${entry.url})`);

    console.error(`   • ${vulnerability.name} — ${vulnerability.severity}`);
    for (const advisory of advisories) console.error(`     ${advisory}`);
    console.error(
      vulnerability.fixAvailable
        ? `     Fix: run \`npm audit fix${includeDev ? "" : " --omit=dev"}\` and commit the lockfile.\n`
        : "     No upstream fix. Replace the dependency, or add a reviewed exception\n" +
            "     to ACCEPTED in scripts/verify-dependency-audit.mjs.\n"
    );
  }

  process.exit(1);
}

const summary = `no unreviewed high/critical vulnerabilities in ${scope} (${accepted.length} accepted)`;
console.log(warned ? `⚠️   Dependency audit passed — ${summary}, with warnings above.` : `✅  Dependency audit passed — ${summary}.`);
