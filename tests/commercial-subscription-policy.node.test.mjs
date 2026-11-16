import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PLAN_CATALOG,
  planFor,
  canTransition,
  applySubscriptionEvent,
  evaluateEntitlement,
  canAccessAccount,
} from "../server/services/commercial/subscriptionPolicy.mjs";

const acme = "tenant_acme_0001";
const beta = "tenant_beta_0002";
const subscription = (overrides = {}) => ({
  tenantId: acme,
  plan: "business",
  status: "active",
  sequence: 2,
  ...overrides,
});
const entitlement = (overrides = {}) => ({
  accountId: acme,
  resourceAccountId: acme,
  subscription: subscription(),
  module: "inventory",
  activeUsers: 4,
  activeCompanies: 1,
  ...overrides,
});
test("plan catalog is explicit and rejects nonexistent tiers", () => {
  assert.equal(Object.keys(PLAN_CATALOG).length, 4);
  assert.equal(planFor("retail").userLimit, 5);
  assert.equal(planFor("enterprise").companyLimit, null);
  assert.throws(() => planFor("invalid"));
});
test("commercial access is denied across unrelated customer accounts", () => {
  assert.equal(evaluateEntitlement(entitlement({ resourceAccountId: beta })).allowed, false);
  assert.equal(evaluateEntitlement(entitlement({ subscription: subscription({ tenantId: beta }) })).allowed, false);
  assert.equal(canAccessAccount({ principalAccountIds: [acme], targetAccountId: beta }), false);
  assert.equal(canAccessAccount({ principalAccountIds: [acme], targetAccountId: acme }), true);
  assert.equal(canAccessAccount({ principalAccountIds: undefined, targetAccountId: acme }), false);
});
test("subscription, feature and usage limits fail closed", () => {
  assert.equal(evaluateEntitlement(entitlement()).allowed, true);
  assert.equal(evaluateEntitlement(entitlement({ subscription: null })).allowed, false);
  for (const status of ["incomplete", "past_due", "paused", "expired", "canceled"]) {
    assert.equal(evaluateEntitlement(entitlement({ subscription: subscription({ status }) })).allowed, false, status);
  }
  assert.equal(evaluateEntitlement(entitlement({ subscription: subscription({ status: "trialing" }) })).allowed, true);
  assert.equal(evaluateEntitlement(entitlement({ module: "factory" })).allowed, false);
  assert.equal(evaluateEntitlement(entitlement({ activeUsers: 16 })).allowed, false);
  assert.equal(evaluateEntitlement(entitlement({ activeCompanies: 4 })).allowed, false);
  assert.equal(evaluateEntitlement(entitlement({ activeUsers: -1 })).allowed, false);
  assert.equal(evaluateEntitlement(entitlement({ activeUsers: NaN })).allowed, false);
  assert.equal(
    evaluateEntitlement(
      entitlement({
        subscription: subscription({ plan: "enterprise" }),
        activeCompanies: 50,
        activeUsers: 300,
        module: "factory",
      })
    ).allowed,
    true
  );
});
test("state transitions deny invalid cancellation and unknown statuses", () => {
  assert.equal(canTransition("active", "past_due"), true);
  assert.equal(canTransition("past_due", "active"), true);
  assert.equal(canTransition("active", "canceled"), true);
  assert.equal(canTransition("canceled", "active"), false);
  assert.throws(() => canTransition("active", "made_up"));
  const current = subscription();
  const accepted = applySubscriptionEvent(current, {
    tenantId: acme,
    eventId: "event_000001",
    sequence: 3,
    status: "past_due",
    plan: "business",
  });
  assert.equal(accepted.status, "past_due");
  assert.equal(accepted.sequence, 3);
  const stale = applySubscriptionEvent(accepted, {
    tenantId: acme,
    eventId: "event_000000",
    sequence: 2,
    status: "active",
    plan: "business",
  });
  assert.equal(stale.ignored, true);
  assert.equal(stale.status, "past_due");
  assert.throws(
    () =>
      applySubscriptionEvent(current, {
        tenantId: beta,
        eventId: "event_000001",
        sequence: 3,
        status: "past_due",
        plan: "business",
      }),
    /Cross-tenant/
  );
  assert.throws(
    () =>
      applySubscriptionEvent(subscription({ status: "canceled" }), {
        tenantId: acme,
        eventId: "event_000002",
        sequence: 3,
        status: "active",
        plan: "business",
      }),
    /Invalid subscription transition/
  );
});
test("staged commercial SQL provides hard-deny RLS until authorized boundary exists", async () => {
  const sql = await readFile(
    new URL("../server/services/commercial/commercial-schema.preview.sql", import.meta.url),
    "utf8"
  );
  for (const table of [
    "commercial_accounts",
    "commercial_account_companies",
    "commercial_account_members",
    "commercial_subscriptions",
    "commercial_subscription_events",
  ]) {
    assert.ok(sql.includes("ALTER TABLE " + table + " FORCE ROW LEVEL SECURITY"), table);
  }
  assert.doesNotMatch(sql, /CREATE\s+POLICY\s+/i);
  assert.match(sql, /UNIQUE\(provider,provider_event_id\)/);
  assert.match(sql, /company_id INTEGER PRIMARY KEY/);
});
