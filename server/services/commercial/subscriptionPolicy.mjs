/**
 * Commercial SaaS subscription policy.
 *
 * This module is intentionally pure, feature-flag independent and has no
 * database/network access. It MUST NOT be treated as proof of ERP tenant
 * separation. Existing operational APIs remain unchanged until the
 * commercial account security boundary passes integration testing.
 */
export const PLAN_CATALOG = Object.freeze({
  retail: Object.freeze({
    key: "retail",
    modules: ["retail", "pos", "inventory", "reports"],
    userLimit: 5,
    companyLimit: 1,
  }),
  business: Object.freeze({
    key: "business",
    modules: ["erp", "pos", "inventory", "accounting", "purchasing", "reports"],
    userLimit: 15,
    companyLimit: 3,
  }),
  factory: Object.freeze({
    key: "factory",
    modules: ["erp", "factory", "inventory", "accounting", "dispatch", "reports"],
    userLimit: 30,
    companyLimit: 3,
  }),
  enterprise: Object.freeze({
    key: "enterprise",
    modules: [
      "erp",
      "pos",
      "retail",
      "inventory",
      "accounting",
      "purchasing",
      "factory",
      "dispatch",
      "logistics",
      "reports",
      "multi_company",
    ],
    userLimit: null,
    companyLimit: null,
  }),
});
export const SUBSCRIPTION_STATUSES = Object.freeze([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "expired",
]);
const activeStates = new Set(["trialing", "active"]);
const transitions = Object.freeze({
  incomplete: ["trialing", "active", "canceled"],
  trialing: ["active", "past_due", "canceled", "expired"],
  active: ["past_due", "paused", "canceled", "expired"],
  past_due: ["active", "paused", "canceled", "expired"],
  paused: ["active", "canceled", "expired"],
  canceled: [],
  expired: [],
});
const tokenPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/;
function assertId(value, label) {
  if (typeof value !== "string" || !tokenPattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}
function assertStatus(value) {
  if (!SUBSCRIPTION_STATUSES.includes(value)) throw new TypeError("Unknown subscription status");
  return value;
}
export function planFor(key) {
  if (!Object.hasOwn(PLAN_CATALOG, key)) throw new TypeError("Unknown commercial plan");
  return PLAN_CATALOG[key];
}
export function canTransition(previous, next) {
  assertStatus(previous);
  assertStatus(next);
  return previous === next || transitions[previous].includes(next);
}
export function applySubscriptionEvent(current, event) {
  if (!current || !event || typeof current !== "object" || typeof event !== "object")
    throw new TypeError("Missing event/state");
  assertId(current.tenantId, "tenant ID");
  assertId(event.tenantId, "tenant ID");
  if (current.tenantId !== event.tenantId) throw new Error("Cross-tenant subscription event rejected");
  assertId(event.eventId, "event ID");
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) throw new TypeError("Invalid event sequence");
  if (!Number.isSafeInteger(current.sequence) || current.sequence < 0) throw new TypeError("Invalid current sequence");
  const old = assertStatus(current.status),
    next = assertStatus(event.status);
  const currentPlan = planFor(current.plan),
    newPlan = planFor(event.plan);
  if (event.sequence <= current.sequence) return Object.freeze({ ...current, ignored: true, reason: "stale_sequence" });
  if (!canTransition(old, next)) throw new Error(`Invalid subscription transition: ${old} -> ${next}`);
  // A provider webhook MUST have authenticated/verified its signature and
  // performed atomic event-id deduplication before calling this function.
  return Object.freeze({
    tenantId: current.tenantId,
    plan: newPlan.key,
    status: next,
    sequence: event.sequence,
    lastEventId: event.eventId,
    ignored: false,
  });
}
export function evaluateEntitlement({
  accountId,
  resourceAccountId,
  subscription,
  module,
  activeUsers,
  activeCompanies,
}) {
  assertId(accountId, "account ID");
  assertId(resourceAccountId, "resource account ID");
  if (accountId !== resourceAccountId) return Object.freeze({ allowed: false, reason: "account_mismatch" });
  if (!subscription || subscription.tenantId !== accountId)
    return Object.freeze({ allowed: false, reason: "subscription_missing_or_mismatched" });
  if (!activeStates.has(assertStatus(subscription.status)))
    return Object.freeze({ allowed: false, reason: "subscription_inactive" });
  const plan = planFor(subscription.plan);
  if (typeof module !== "string" || !plan.modules.includes(module))
    return Object.freeze({ allowed: false, reason: "module_not_in_plan" });
  if (
    !Number.isSafeInteger(activeUsers) ||
    activeUsers < 0 ||
    !Number.isSafeInteger(activeCompanies) ||
    activeCompanies < 0
  )
    return Object.freeze({ allowed: false, reason: "invalid_usage" });
  if (plan.userLimit !== null && activeUsers > plan.userLimit)
    return Object.freeze({ allowed: false, reason: "user_limit" });
  if (plan.companyLimit !== null && activeCompanies > plan.companyLimit)
    return Object.freeze({ allowed: false, reason: "company_limit" });
  return Object.freeze({ allowed: true, reason: "entitled" });
}
export function canAccessAccount({ principalAccountIds, targetAccountId }) {
  assertId(targetAccountId, "target account ID");
  if (!Array.isArray(principalAccountIds)) return false;
  return principalAccountIds.some((id) => typeof id === "string" && id === targetAccountId);
}
