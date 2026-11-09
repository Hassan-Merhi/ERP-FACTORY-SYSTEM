#!/usr/bin/env node
/**
 * Phase 2 read-only inventory of Factory client query/cache boundaries.
 *
 * From repository root:
 *   node scripts/audit-factory-phase2.mjs
 *   node scripts/audit-factory-phase2.mjs --strict
 *
 * "strict" exits nonzero on unscoped source keys, for manual review.
 * Not a proof of data isolation: dynamic keys, queryFn closures, manual fetches,
 * async company transitions, server authorization and runtime caches need tests.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["client/src/pages/factory", "client/src/factory", "client/src/components", "client/src/hooks", "client/src/contexts", "client/src/lib"];
const files = [];
function visit(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) visit(p);
    else if (/\.(?:ts|tsx|js|jsx)$/.test(ent.name) && !/\.(?:test|spec)\.[jt]sx?$/.test(ent.name)) files.push(p);
  }
}
for (const root of roots) visit(root);
files.sort();
const findings = [];
const stats = { scannedFiles: files.length, withFactoryReferences: 0, companyQueryKeyOccurrences: 0, unscopedFactoryReadKeys: 0, unscopedFactoryAccessKeys: 0, possibleFailOpenAccess: 0, readOnlyDataQueryKeys: 0, invalidationPrefixes: 0 };
function record(kind, path, line, snippet) {
  findings.push({ kind, file: path, line, snippet: snippet.trim().slice(0, 220) });
}
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("/api/factory/")) continue;
  stats.withFactoryReferences++;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const path = relative(".", file).replaceAll("\\", "/");
    if (line.includes("companyQueryKey(")) stats.companyQueryKeyOccurrences++;
    if (/queryKey\s*:\s*\[\s*["'\x60]\/api\/factory\//.test(line)) {
      stats.unscopedFactoryReadKeys++;
      record("unscoped-factory-query", path, i + 1, line);
      if (line.includes("/api/factory/my-access")) {
        stats.unscopedFactoryAccessKeys++;
        record("unscoped-access-query", path, i + 1, line);
      }
    }
    if (/queryKey\s*:\s*\[\s*["'\x60]\/api\/locations/.test(line)) {
      stats.readOnlyDataQueryKeys++;
      record("unscoped-location-query", path, i + 1, line);
    }
    if (/myAccess\s*\?\.\s*hiddenCostFields\s*\?\?\s*\[\]|!myAccess\s*\|\|/.test(line)) {
      stats.possibleFailOpenAccess++;
      record("review-fail-open-access", path, i + 1, line);
    }
    if (/invalidateQueries|setQueriesData/.test(line) && !/queryKey:/.test(line)) stats.invalidationPrefixes++;
  }
}
const byKind = Object.fromEntries([...new Set(findings.map((f) => f.kind))].map((k) => [k, findings.filter((f) => f.kind === k).length]));
const summary = {
  auditType: "STATIC_SOURCE_ONLY",
  ...stats,
  findingCounts: byKind,
  currentPolicy: "Review findings; shared company-switch cancellation does not prove UI, mutation or server isolation.",
  notVerified: ["TypeScript", "unit tests", "A-to-B-to-A delayed queries", "server 403 responses", "local state", "company-scoped mutations"],
};
console.log(JSON.stringify(summary, null, 2));
for (const finding of findings) console.log(JSON.stringify(finding));
if (process.argv.includes("--strict") && (stats.unscopedFactoryReadKeys || stats.possibleFailOpenAccess || stats.readOnlyDataQueryKeys)) {
  console.error("PHASE_2_SOURCE_AUDIT_REQUIRES_REVIEW: unscoped keys or fail-open patterns found.");
  process.exitCode = 1;
}
