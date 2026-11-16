/**
 * Coverage verifier for the proposed manifest-driven route access boundary.
 *
 * Route identities use the registration ordinal because Express intentionally
 * registers duplicate method/path pairs as prerequisite, fallthrough, and
 * terminal handlers. Collapsing them to a Map would hide coverage gaps.
 *
 * Usage: node scripts/verify-route-access-coverage.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function routeIdentity(entry, index) {
  const match = /^(\S+) (\S+) \[/.exec(entry);
  if (!match) throw new Error(`Malformed route manifest entry #${index}: ${entry}`);
  return `${index}:${match[1]} ${match[2]}`;
}

export function validateRouteAccessCoverage(routeSnapshot, accessSnapshot) {
  const errors = [];
  if (!Array.isArray(routeSnapshot?.routes)) errors.push("Route snapshot has no routes array");
  if (!Array.isArray(accessSnapshot?.rules)) errors.push("Access snapshot has no rules array");
  if (errors.length) return errors;

  const expected = routeSnapshot.routes.map(routeIdentity);
  const seen = new Set();
  const allowedScopes = new Set(["active-company", "explicit-company", "global", "public", "service"]);
  for (const rule of accessSnapshot.rules) {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string") {
      errors.push("Invalid access rule: missing string id");
      continue;
    }
    if (seen.has(rule.id)) errors.push(`Duplicate access declaration: ${rule.id}`);
    seen.add(rule.id);
    if (!allowedScopes.has(rule.companyScope)) errors.push(`Invalid company scope: ${rule.id}`);
    if (!Array.isArray(rule.roles) || rule.roles.length === 0 ||
        rule.roles.some(role => typeof role !== "string" || !role.trim())) {
      errors.push(`Missing/invalid role declaration: ${rule.id}`);
    }
    if (typeof rule.permission !== "string" || !rule.permission.trim()) {
      errors.push(`Missing permission declaration: ${rule.id}`);
    }
  }

  const expectedSet = new Set(expected);
  for (const id of expected) if (!seen.has(id)) errors.push(`Missing access declaration: ${id}`);
  for (const id of seen) if (!expectedSet.has(id)) errors.push(`Stale access declaration: ${id}`);
  return errors;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  try {
    const errors = validateRouteAccessCoverage(
      read("config/route-manifest.json"),
      read("config/route-access-manifest.json")
    );
    if (errors.length) {
      console.error(`Route access coverage failed (${errors.length} errors):\n${errors.slice(0, 30).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log("All registered routes have explicit, structurally valid access declarations.");
    }
  } catch (error) {
    console.error(`Route access coverage failed: ${error.message}`);
    process.exitCode = 1;
  }
}
