#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverDuoRouteInventory } from "./lib/iphone-duo-route-inventory.mjs";

const inventory = await discoverDuoRouteInventory();
const required = {
  erp: ["/tracking", "/daybook", "/accounts", "/vouchers", "/stock-query"],
  factory: ["/factory/stock-entry", "/factory/stock-allocation-v5", "/factory/monthly-production-matrix", "/factory/production-bonuses"],
  properties: ["/properties/dashboard", "/properties/rentals", "/properties/vouchers"],
  "supplier-partner": ["/sp", "/sp/reports"],
  "retail-admin": ["/retail/inventory", "/retail/pos", "/retail/reports"],
  pos: ["/pos-containers", "/pos-daybook", "/pos-transfer-orders"],
  "retail-pos": ["/retail/pos", "/retail/stock-count"],
};
const issues = [];
for (const [workspace, routes] of Object.entries(required)) {
  const group = inventory.groups.find((entry) => entry.workspace === workspace);
  if (!group) { issues.push("Missing workspace: " + workspace); continue; }
  for (const route of routes) {
    if (!group.static.includes(route)) issues.push(workspace + ": missing " + route);
  }
  if (!group.static.length) issues.push(workspace + ": empty route inventory");
  if (group.static.some((route) => /:\w+|\*/.test(route))) issues.push(workspace + ": parameterized route in static set");
  if (new Set(group.static).size !== group.static.length) issues.push(workspace + ": duplicate static route");
}
const expectedUnresolved = inventory.groups.reduce((total, group) => total + group.parameterized.length, 0);
if (inventory.unresolved.length !== expectedUnresolved) issues.push("Parameterized route accounting mismatch");
if (inventory.unresolved.some((item) => !item.category || !item.workspace || !item.route)) {
  issues.push("Unresolved route lacks a diagnostic classification");
}
const report = {
  status: issues.length ? "failed" : "inventory-verified",
  workspaces: inventory.summary,
  staticRoutes: inventory.summary.reduce((n, item) => n + item.staticRoutes, 0),
  detailRoutesRequiringFixtures: expectedUnresolved,
  issues,
};
const output = path.resolve(process.env.ERP_DUO_INVENTORY_OUTPUT || "artifacts/iphone-duo-phase1/route-inventory.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(issues, [], "iPhone Duo route inventory verification failed");
