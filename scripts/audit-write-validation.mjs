#!/usr/bin/env node
/**
 * audit-write-validation.mjs
 *
 * Lists every write route (POST/PUT/PATCH/DELETE) whose input is not checked
 * against a Zod schema, and holds that number to a ratchet that can only fall.
 *
 * A route counts as validated when its handler chain in
 * config/route-manifest.json contains `validateRequest`, the middleware from
 * server/lib/validateRequest.ts. The manifest is generated from the live
 * Express app and tests/route-manifest.test.ts fails CI when it drifts, so
 * this audit reads what is actually registered, without booting the server.
 *
 * Routes are counted once per method + path. Some paths are registered more
 * than once on purpose (a permission or prerequisite layer that calls next()
 * in front of the real handler); the route is validated when any of its
 * registrations carries validateRequest.
 *
 * A schema parsed inside the handler does not count. It is invisible to this
 * audit and to the strictness check, and converting it is a small change.
 *
 * Usage:
 *   npm run audit:write-validation              summary by risk tier
 *   npm run audit:write-validation -- --list    every unvalidated route
 *   npm run audit:write-validation -- --tier 1  routes in one tier
 *   node scripts/audit-write-validation.mjs --json
 *   UPDATE_WRITE_VALIDATION_BASELINE=1 npm run audit:write-validation
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "config/route-manifest.json");
const configPath = path.join(projectRoot, "config/write-validation-ratchet.json");

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const VALIDATOR_NAME = "validateRequest";

/** "POST /api/x/:id [requireAuth > validateRequest > <anonymous>]" → parts. */
export function parseManifestEntry(entry) {
  const match = /^([A-Z-]+) (\S+) \[(.*)\]$/.exec(entry);
  if (!match) throw new Error(`Unrecognised route manifest entry: ${entry}`);
  return { method: match[1], path: match[2], guards: match[3] ? match[3].split(" > ") : [] };
}

export function tierFor(routePath, tiers) {
  const tier = tiers.find((candidate) => candidate.prefixes.some((prefix) => routePath.startsWith(prefix)));
  if (!tier) throw new Error(`No tier matches ${routePath}; the last tier must match "/".`);
  return tier.name;
}

/**
 * @param {{ manifest?: { routes: string[] }, config?: { maxUnvalidated: number, tiers: Array<{ name: string, prefixes: string[] }> } }} [input]
 */
export function auditWriteValidation(input = {}) {
  const manifest = input.manifest ?? JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const config = input.config ?? JSON.parse(fs.readFileSync(configPath, "utf8"));

  /** @type {Map<string, { method: string, path: string, validated: boolean }>} */
  const routes = new Map();
  for (const entry of manifest.routes) {
    const route = parseManifestEntry(entry);
    if (!WRITE_METHODS.has(route.method)) continue;
    const key = `${route.method} ${route.path}`;
    const validated = route.guards.includes(VALIDATOR_NAME);
    const existing = routes.get(key);
    if (existing) existing.validated ||= validated;
    else routes.set(key, { method: route.method, path: route.path, validated });
  }

  const tiers = config.tiers.map((tier) => ({ name: tier.name, total: 0, unvalidated: [] }));
  const byName = new Map(tiers.map((tier) => [tier.name, tier]));
  for (const [key, route] of routes) {
    const tier = byName.get(tierFor(route.path, config.tiers));
    tier.total += 1;
    if (!route.validated) tier.unvalidated.push(key);
  }

  const unvalidated = tiers.reduce((sum, tier) => sum + tier.unvalidated.length, 0);
  return {
    totalWriteRoutes: routes.size,
    validated: routes.size - unvalidated,
    unvalidated,
    maxUnvalidated: config.maxUnvalidated,
    tiers: tiers.map((tier) => ({ ...tier, unvalidated: tier.unvalidated.sort() })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const result = auditWriteValidation();

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(
      `Write-route input validation: ${result.validated}/${result.totalWriteRoutes} validated, ` +
        `${result.unvalidated} without a schema (ratchet ${result.maxUnvalidated}).`
    );
    const tierArg = args.indexOf("--tier");
    const onlyTier = tierArg >= 0 ? args[tierArg + 1] : null;
    for (const tier of result.tiers) {
      if (onlyTier && !tier.name.startsWith(onlyTier)) continue;
      console.log(`  ${tier.name.padEnd(24)} ${String(tier.unvalidated.length).padStart(4)} / ${tier.total}`);
      if (args.includes("--list") || onlyTier) for (const route of tier.unvalidated) console.log(`      ${route}`);
    }
  }

  if (process.env.UPDATE_WRITE_VALIDATION_BASELINE === "1") {
    if (result.unvalidated > result.maxUnvalidated) {
      console.error(
        `Refusing to raise the ratchet from ${result.maxUnvalidated} to ${result.unvalidated}. ` +
          `Add validateRequest to the new write routes instead.`
      );
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.maxUnvalidated = result.unvalidated;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Ratchet set to ${result.unvalidated}.`);
    return;
  }

  if (result.unvalidated > result.maxUnvalidated) {
    console.error(
      `\n${result.unvalidated - result.maxUnvalidated} write route(s) added without validateRequest. ` +
        `Mount validateRequest({ body, params, query }) from server/lib/validateRequest.ts on them. ` +
        `Run with --list to see every unvalidated route.`
    );
    process.exit(1);
  }
  if (result.unvalidated < result.maxUnvalidated) {
    console.error(
      `\nThe count fell from ${result.maxUnvalidated} to ${result.unvalidated}. Lock the gain in: ` +
        `UPDATE_WRITE_VALIDATION_BASELINE=1 npm run audit:write-validation`
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
