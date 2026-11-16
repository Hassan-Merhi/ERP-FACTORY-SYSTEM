import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { routeIdentity, validateRouteAccessCoverage } from "../scripts/verify-route-access-coverage.mjs";

const snapshot = JSON.parse(fs.readFileSync(new URL("../config/route-manifest.json", import.meta.url), "utf8"));
const manifest = JSON.parse(fs.readFileSync(new URL("../config/route-access-manifest.json", import.meta.url), "utf8"));

test("every registered route is declared, including deliberate duplicate registrations", () => {
  assert.equal(manifest.rules.length, snapshot.routes.length);
  assert.deepEqual(validateRouteAccessCoverage(snapshot, manifest), []);
  assert.equal(new Set(manifest.rules.map((rule) => rule.id)).size, snapshot.routes.length);
});

test("inherited application middleware mount inventory cannot silently drift", () => {
  assert.equal(manifest.middlewareMounts.length, snapshot.middlewareMounts.length);
  const changed = { ...snapshot, middlewareMounts: [...snapshot.middlewareMounts, "USE /api/factory [unexpectedScope]"] };
  assert.ok(
    validateRouteAccessCoverage(changed, manifest).includes(
      "Inherited middleware mount snapshot differs from registered middleware"
    )
  );
});

test("deleting any one declared registration fails coverage", () => {
  for (const index of [0, Math.floor(manifest.rules.length / 2), manifest.rules.length - 1]) {
    const id = manifest.rules[index].id;
    const rules = manifest.rules.filter((rule) => rule.id !== id);
    assert.ok(
      validateRouteAccessCoverage(snapshot, { ...manifest, rules }).includes("Missing access declaration: " + id),
      "Missing route " + id + " must fail"
    );
  }
});

test("a changed route guard cannot inherit an old declaration", () => {
  const modified = { ...snapshot, routes: [...snapshot.routes] };
  modified.routes[0] = modified.routes[0].replace("[stockTransferOrderWaWebhookHandler]", "[<anonymous>]");
  const expected = routeIdentity(modified.routes[0], 0);
  assert.ok(validateRouteAccessCoverage(modified, manifest).includes("Missing access declaration: " + expected));
});

test("delegated rules cannot become direct grants by changing one field", () => {
  const index = manifest.rules.findIndex((rule) => rule.companyScope === "delegated");
  assert.notEqual(index, -1);
  const rules = [...manifest.rules];
  rules[index] = { ...rules[index], permission: "allow" };
  assert.ok(
    validateRouteAccessCoverage(snapshot, { ...manifest, rules }).includes(
      "Invalid legacy delegation: " + rules[index].id
    )
  );
});

test("legacy guard-chain evidence cannot drift independently of registration", () => {
  const index = manifest.rules.findIndex((rule) => rule.companyScope === "delegated");
  assert.notEqual(index, -1);
  const rules = [...manifest.rules];
  rules[index] = { ...rules[index], originalGuardChain: ["removed-auth-guard"] };
  assert.ok(
    validateRouteAccessCoverage(snapshot, { ...manifest, rules }).includes(
      "Legacy handler chain drift: " + rules[index].id
    )
  );
});

test("reviewed declarations require cited source evidence", () => {
  const reviewed = manifest.rules.filter((rule) => rule.status === "reviewed");
  assert.ok(reviewed.length > 0);
  const rules = manifest.rules.map((rule) =>
    rule.id === reviewed[0].id ? { ...rule, evidence: [] } : rule
  );
  assert.ok(
    validateRouteAccessCoverage(snapshot, { ...manifest, rules }).includes(
      "Reviewed rule lacks evidence: " + reviewed[0].id
    )
  );
});
