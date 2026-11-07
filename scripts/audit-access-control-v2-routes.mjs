#!/usr/bin/env node
/**
 * Enumerate EVERY registered Express route and its Phase 1 V2 review state.
 * Read-only: does not touch DB, permissions, users, role assignments, or UI.
 *
 * Usage:
 *   node scripts/audit-access-control-v2-routes.mjs
 *   node scripts/audit-access-control-v2-routes.mjs --json   # full inventory
 *   node scripts/audit-access-control-v2-routes.mjs --strict # release readiness gate
 *
 * --strict FAILS until all registered business routes are reviewed/verified.
 * A route absent from the candidate map must never become implicitly allowed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(resolve(root, "config/route-manifest.json"), "utf8")
);
const review = JSON.parse(
  readFileSync(resolve(root, "config/access-control-v2-route-review.json"), "utf8")
);

if (manifest.formatVersion !== 1 || review.formatVersion !== 1) {
  throw new Error("Unsupported permission/route manifest format");
}
if (!Array.isArray(manifest.routes) || !Array.isArray(manifest.middlewareMounts) || !review.routes || typeof review.routes !== "object") {
  throw new Error("Malformed route inventory input");
}

if (manifest.routes.length !== manifest.routeCount || manifest.middlewareMounts.length !== manifest.middlewareMountCount) throw new Error("Route manifest count drift");
const passiveMethods = new Set(["GET", "HEAD", "OPTIONS"]);
// Any uncommon Express method can mutate state; never implicitly treat it as read-only.
const signatures = new Set();
const inventory = [];
for (const [index, raw] of manifest.routes.entries()) {
  const matched = /^([A-Z-]+) (\/\S+) \[(.*)\]$/.exec(raw);
  if (!matched) throw new Error(`Cannot read route-manifest entry #${index}: ${raw}`);
  const [, method, path, guardChain] = matched;
  const signature = `${method} ${path}`;
  signatures.add(signature);
  const candidate = review.routes[signature];
  inventory.push({
    signature,
    domain: path.startsWith("/api/factory/") ? "factory"
      : path.startsWith("/api/properties/") || path.startsWith("/api/erp/rental/") ? "properties"
      : path.startsWith("/api/pos/") || path.startsWith("/api/retail/") ? "retail-or-pos"
      : path.startsWith("/api/sp/") ? "supplier-partner"
      : path.startsWith("/api/") ? "erp-or-platform" : "other",
    guardChain,
    mayWrite: !passiveMethods.has(method),
    action: candidate?.action ?? null,
    resource: candidate?.resource ?? null,
    reviewState: candidate?.status ?? "unreviewed",
  });
}

// Review mappings not present in the registered route manifest are stale and
// must be removed rather than treated as live enforcement data.
const stale = Object.keys(review.routes).filter((key) => !signatures.has(key));
const invalid = Object.entries(review.routes)
  .filter(([, value]) =>
    !value ||
    typeof value !== "object" ||
    value.status !== "candidate" ||
    typeof value.action !== "string" ||
    typeof value.resource !== "string"
  ).map(([key]) => key);
const writes = inventory.filter((row) => row.mayWrite);
const unreviewedWrites = writes.filter((row) => row.reviewState === "unreviewed");
const counts = {};
for (const row of inventory) {
  const key = `${row.domain}:${row.reviewState}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
const summary = {
  registeredRoutes: inventory.length,
  middlewareMounts: manifest.middlewareMounts.length,
  uniqueSignatures: signatures.size,
  candidateRegistrations: inventory.filter((row) => row.reviewState === "candidate").length,
  uniqueCandidates: Object.keys(review.routes).length,
  possibleWriteRegistrations: writes.length,
  unreviewedWriteRegistrations: unreviewedWrites.length,
  staleCandidates: stale,
  invalidCandidates: invalid,
  reviewStateByDomain: counts,
  sampleUnreviewedWrites: unreviewedWrites.slice(0, 30).map((row) => row.signature),
  enforcementReady: false, // no handler/action validation or deployment yet
};
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ summary, inventory }, null, 2) + "\n");
} else {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (stale.length || invalid.length) process.exitCode = 1;
if (process.argv.includes("--strict") && (unreviewedWrites.length > 0 || !summary.enforcementReady)) {
  process.exitCode = 1;
}
