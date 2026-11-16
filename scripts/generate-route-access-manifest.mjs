/**
 * Generate the transitional, non-enforcing access declarations for every
 * registered Express handler. "delegated" does NOT mean allowed: it means that
 * the existing tenant/session/route policy remains the sole authority until
 * the entry has been reviewed and migrated to the unified middleware.
 *
 * node scripts/generate-route-access-manifest.mjs --write
 * node scripts/generate-route-access-manifest.mjs --check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeIdentity, validateRouteAccessCoverage } from "./verify-route-access-coverage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const snapshot = read("config/route-manifest.json");
const review = read("config/route-access-review.json");
const sourceReviewed = read("config/route-access-reviewed.json");
const output = path.join(root, "config/route-access-manifest.json");

const byId = new Map(review.entries.map((entry) => [entry.id, entry]));
if (byId.size !== review.entries.length) throw new Error("Duplicate review ledger identities");
const confirmed = new Map(sourceReviewed.rules.map((rule) => [rule.id, rule]));
if (confirmed.size !== sourceReviewed.rules.length) throw new Error("Duplicate reviewed access policies");
const rules = snapshot.routes.map((registration, index) => {
  const id = routeIdentity(registration, index);
  const reviewEntry = byId.get(id);
  if (!reviewEntry) throw new Error("Route has no review ledger entry: " + id);
  const verified = confirmed.get(id);
  if (verified) {
    if (verified.status !== "reviewed" || !Array.isArray(verified.evidence) || !verified.evidence.length) {
      throw new Error("Reviewed access policy has no evidence: " + id);
    }
    return { ...verified };
  }
  return {
    id,
    companyScope: "delegated",
    permission: "delegated",
    roles: ["delegated"],
    enforcement: "legacy-delegated",
    status: "unreviewed",
    originalGuardChain: reviewEntry.existingGuards,
    ...(reviewEntry.policyEvidence ? { operationalPolicyEvidence: reviewEntry.policyEvidence } : {}),
    ...(reviewEntry.tenantEvidence ? { tenantEvidence: reviewEntry.tenantEvidence } : {}),
    ...(reviewEntry.scopeEvidence ? { scopeEvidence: reviewEntry.scopeEvidence } : {}),
    ...(reviewEntry.candidate ? { v2Candidate: reviewEntry.candidate } : {}),
    // The exact registered chain is captured in id to detect guard loss.
    // This is not evidence that the chain itself is sufficient.
  };
});
for (const id of confirmed.keys()) {
  if (!byId.has(id)) throw new Error("Stale approved rule: " + id);
}
const manifest = {
  formatVersion: 1,
  description: "TRANSITIONAL / NON-ENFORCING: every Express registration is declared; unreviewed entries explicitly delegate to existing runtime security and MUST NOT be used to authorize requests.",
  routeCount: rules.length,
  middlewareMountCount: snapshot.middlewareMounts.length,
  middlewareMounts: snapshot.middlewareMounts,
  reviewedCount: rules.filter((rule) => rule.status === "reviewed").length,
  rules,
};
const errors = validateRouteAccessCoverage(snapshot, manifest);
if (errors.length) throw new Error(errors.slice(0, 15).join("\n"));
const serialized = JSON.stringify(manifest, null, 2) + "\n";

if (process.argv.includes("--write")) {
  fs.writeFileSync(output, serialized);
  console.log("Wrote " + rules.length + " route access declarations (" + manifest.reviewedCount + " independently reviewed)");
} else if (process.argv.includes("--check")) {
  if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== serialized) {
    console.error("Route access declaration snapshot out of sync; regenerate with --write.");
    process.exitCode = 1;
  } else {
    console.log("Route access declarations synchronized: " + rules.length);
  }
} else {
  console.log(JSON.stringify({ routes: rules.length, reviewed: manifest.reviewedCount, delegated: rules.length - manifest.reviewedCount }));
}
