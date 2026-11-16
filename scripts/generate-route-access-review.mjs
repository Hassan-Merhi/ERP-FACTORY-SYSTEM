/**
 * Phase 2: deterministic review worklist from the full ordered Express
 * route snapshot. Candidate V2 mappings are evidence, NOT approved rules.
 *
 * node scripts/generate-route-access-review.mjs --check
 * node scripts/generate-route-access-review.mjs --write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const source = load("config/route-manifest.json");
const v2 = load("config/access-control-v2-route-review.json");
const outputPath = path.join(root, "config/route-access-review.json");
const rows = source.routes.map((registration, index) => {
  const match = /^(\S+) (\S+) \[([^\]]*)\]$/.exec(registration);
  if (!match) throw new Error(`Malformed registration at index ${index}: ${registration}`);
  const [, method, routePath, guards] = match;
  const v2Candidate = v2.routes?.[`${method} ${routePath}`];
  return {
    id: `${index}:${registration}`,
    status: "unreviewed",
    existingGuards: guards.split(" > "),
    ...(v2Candidate ? {
      candidate: {
        resource: v2Candidate.resource,
        action: v2Candidate.action,
        source: "config/access-control-v2-route-review.json",
        status: "candidate",
      },
    } : {}),
  };
});

const review = {
  formatVersion: 1,
  description: "Non-enforcing review ledger. NO authorization is implied by an entry. Each registration must be inspected before declaring companyScope, permission and roles in config/route-access-manifest.json.",
  routeCount: rows.length,
  entries: rows,
};
const serialized = JSON.stringify(review, null, 2) + "\n";
if (process.argv.includes("--write")) {
  fs.writeFileSync(outputPath, serialized);
  console.log(`Wrote ${rows.length} unreviewed route registrations to ${outputPath}`);
} else if (process.argv.includes("--check")) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== serialized) {
    console.error("Route access review ledger is missing or out of date. Regenerate with --write.");
    process.exitCode = 1;
  } else {
    console.log(`Review ledger synchronized: ${rows.length} registrations`);
  }
} else {
  console.log(JSON.stringify({
    registrations: rows.length,
    candidateMappings: rows.filter(row => row.candidate).length,
    awaitingReview: rows.filter(row => row.status === "unreviewed").length,
  }, null, 2));
}
