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

// Read explicit, source-authored operational policies as evidence, without
// attempting to infer permissions from paths or silently activating them.
const operationalSource = fs.readFileSync(
  path.join(root, "server/services/security/operationalPermissionRoutePolicy.ts"),
  "utf8"
);
const operationalBody = operationalSource.split("export const OPERATIONAL_ROUTE_PERMISSIONS:")[1]?.split(
  "export const OPERATIONAL_PERMISSION_FREE_ROUTES"
)[0];
if (!operationalBody) throw new Error("Operational permission source has changed: review extraction must be updated");
const definitionsBody = operationalSource.split("export const OPERATIONAL_PERMISSIONS = {")[1]?.split(
  "} as const satisfies"
)[0];
if (!definitionsBody) throw new Error("Operational policy definitions have changed");
const definitions = new Map();
for (const [, name, objectBody] of definitionsBody.matchAll(/(?:^|\n)\s{2}(\w+):\s*\{([\s\S]*?)\},/g)) {
  const readString = (key) => new RegExp(key + ':\\s*"([^"]+)"').exec(objectBody)?.[1];
  const readRoles = (key) => {
    const bracket = new RegExp(key + ':\\s*\\[([^\\]]*)\\]').exec(objectBody)?.[1];
    return bracket ? [...bracket.matchAll(/"([^"]+)"/g)].map((match) => match[1]) : undefined;
  };
  const permissionKey = readString("permissionKey");
  const permissionType = readString("permissionType");
  if (!permissionKey || !permissionType) throw new Error(`Missing policy definition for ${name}`);
  definitions.set(name, {
    permissionKey,
    permissionType,
    ...(objectBody.includes("developerOnly: true") ? { developerOnly: true } : {}),
    ...(readRoles("deniedRoles") ? { deniedRoles: readRoles("deniedRoles") } : {}),
    ...(readRoles("permissionBypassRoles") ? { permissionBypassRoles: readRoles("permissionBypassRoles") } : {}),
  });
}
if (definitions.size < 5) throw new Error("Operational permission definition extraction incomplete");
const operationalEvidence = new Map();
const policyGroups = [...operationalBody.matchAll(/(?:^|\n)\s{2}(\w+):\s*\[([\s\S]*?)\],/g)];
if (policyGroups.length < 5) throw new Error("Operational permission extraction lost most groups");
for (const [, policyName, declarations] of policyGroups) {
  const withoutComments = declarations.replace(/\/\/[^\n]*/g, "");
  for (const match of withoutComments.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]+)"/g)) {
    const routeKey = match[1];
    const list = operationalEvidence.get(routeKey) ?? [];
    const policyDefinition = definitions.get(policyName);
    if (!policyDefinition) throw new Error(`Unknown operational permission: ${policyName}`);
    list.push({
      kind: "operational-permission-policy",
      policyName,
      ...policyDefinition,
      source: "server/services/security/operationalPermissionRoutePolicy.ts",
      status: "source-evidence-only",
    });
    operationalEvidence.set(routeKey, list);
  }
}

const rows = source.routes.map((registration, index) => {
  const match = /^(\S+) (\S+) \[([^\]]*)\]$/.exec(registration);
  if (!match) throw new Error(`Malformed registration at index ${index}: ${registration}`);
  const [, method, routePath, guards] = match;
  const key = `${method} ${routePath}`;
  const v2Candidate = v2.routes?.[key];
  const policyEvidence = operationalEvidence.get(key);
  return {
    id: `${index}:${registration}`,
    status: "unreviewed",
    existingGuards: guards.split(" > "),
    ...(policyEvidence ? { policyEvidence } : {}),
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
    operationalPolicyMatches: rows.filter(row => row.policyEvidence).length,
    awaitingReview: rows.filter(row => row.status === "unreviewed").length,
  }, null, 2));
}
