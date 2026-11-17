#!/usr/bin/env node
/**
 * Phase 4 semantic filename policy: read-only and deterministic.
 * Run: node scripts/verify-semantic-filename-policy.mjs [--json]
 * Fails when a renamed source path is resurrected or an active workflow/package
 * command references a missing tracked source file.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
}).split("\0").filter(Boolean);
const present = new Set(tracked);
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const numbered = /(?:phase|wave)[-_ ]?\d+/i;

// Only metadata, historical evidence, applied SQL and stage-specific test
// suites may keep numbered filenames. Runtime/client/scripts/build cannot.
const activePrefixes = ["client/", "build/", "scripts/", "server/"];
const historicalPrefixes = ["scripts/repairs/", "migrations/", "docs/", ".agents/"];
const allowedConfig = new Set([
  "config/i18n-phase14-baseline.json",
  "config/i18n-phase9-final-release.json",
  "vitest.config.phase9.ts",
  "deploy/lan/offline-phase6-evidence.example.json",
  "deploy/lan/phase7-install-writer-fence.sql",
  "deploy/lan/phase7-prepare-restricted-role.sql",
]);
const legacyWorkflowNames = new Set([
  ".github/workflows/edge-phase3-validate-once.yml",
  ".github/workflows/factory-blue-theme-phase5.yml",
  ".github/workflows/offline-phase5-acceptance.yml",
  ".github/workflows/offline-phase5-check.yml",
  ".github/workflows/offline-phase6-contract.yml",
  ".github/workflows/offline-phase7-contract.yml",
  ".github/workflows/offline-phase8-contract.yml",
  ".github/workflows/offline-phase9-contract.yml",
]);
const exceptions = [];
const problems = [];
const categories = { historical:0, test:0, workflow:0, persistedConfig:0 };
for (const p of tracked) {
  if (!numbered.test(path.posix.basename(p))) continue;
  if (historicalPrefixes.some(prefix=>p.startsWith(prefix))) {
    categories.historical++; exceptions.push({path:p,decision:"historical-preserve"});continue;
  }
  if ((p.startsWith("server/") && (/\.test\.[cm]?[jt]sx?$/.test(p)||p.includes("/__tests__/"))) ||
      (p.startsWith("tests/") && /\.test\.[cm]?[jt]sx?$/.test(p))) {
    categories.test++; exceptions.push({path:p,decision:"server-test-suite-identity"});continue;
  }
  if (legacyWorkflowNames.has(p)) {
    categories.workflow++; exceptions.push({path:p,decision:"existing-gha-workflow-identity"});continue;
  }
  if (allowedConfig.has(p)) {
    categories.persistedConfig++; exceptions.push({path:p,decision:"deployed-or-frozen-config-path"});continue;
  }
  problems.push({code:"NUMBERED_ACTIVE_FILENAME",path:p});
}
for (const expected of legacyWorkflowNames) if (!present.has(expected)) {
  problems.push({code:"MISSING_WORKFLOW_COMPATIBILITY_NAME",path:expected});
}
for (const expected of allowedConfig) if (!present.has(expected)) {
  problems.push({code:"MISSING_CONFIG_COMPATIBILITY_NAME",path:expected});
}

// Files in scripts and workflows are entry points; unlike source imports,
// TS does not verify that these commands actually refer to extant files.
const executableSources = tracked.filter(p=>p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p));
if (present.has("package.json")) executableSources.push("package.json");
const referencePattern = /(?:scripts|tests|server|client|build|shared|config|deploy)\/[A-Za-z0-9_./*-]+\.(?:json|mjs|cjs|tsx?|jsx?|sh|ya?ml)(?![A-Za-z0-9_.])/g;
const externalGeneratedReferences = new Set([
  // Generated at runtime by build tools; not source files.
  "config/route-manifest.js",
  "config/coverage-thresholds.js",
  "scripts/generate-icons.js",
  "tests/e2e/remote-support-harness/package.js",
  "tests/e2e/remote-support-harness/package-lock.js",
]);
const seenFailures = new Set();
let referencesChecked = 0;
for(const owner of executableSources) {
  const source = read(owner);
  for(const m of source.matchAll(referencePattern)){
    const candidate=m[0];
    if(candidate.includes("*") || candidate.includes("..") || externalGeneratedReferences.has(candidate)) continue;
    // Ignore paths mentioned exclusively in comments for the initial ratchet.
    const line = source.slice(source.lastIndexOf("\n",m.index)+1,source.indexOf("\n",m.index)<0?source.length:source.indexOf("\n",m.index));
    if (/^\s*(?:#|\/\/)/.test(line)) continue;
    referencesChecked++;
    if(present.has(candidate)) continue;
    const key=owner+" -> "+candidate;
    if(!seenFailures.has(key)) {
      problems.push({code:"DANGLING_ENTRYPOINT_REFERENCE",owner,path:candidate});
      seenFailures.add(key);
    }
  }
}
const result={schemaVersion:1,trackedFiles:tracked.length,scannedEntrypoints:executableSources.length,
  referencesChecked,numberedExceptions:categories,exceptionCount:exceptions.length,
  problems,exceptions};
if(process.argv.includes("--json")) console.log(JSON.stringify(result,null,2));
else {
  console.log("Semantic filename policy: "+tracked.length+" tracked files; "+executableSources.length+" entrypoint manifests; "+
    referencesChecked+" references; "+exceptions.length+" approved numbered exceptions");
  for(const item of problems)console.error(item.code+": "+(item.owner?item.owner+" -> ":"")+item.path);
}
if(problems.length)process.exitCode=1;
