/**
 * Permissions Control Center V2 — effective permission evaluator (pure).
 *
 * Combines, for one person in one company:
 *   1. system-level hard restrictions (company membership, protected system
 *      resources, View Only / Create Only / ERP Tester locks);
 *   2. the legacy role semantics that are enforced today (module-level view of
 *      role_feature_permissions);
 *   3. the V2 role rules and individual user overrides.
 *
 * Precedence: membership > hard restriction > (when the company's V2 policy is
 * active AND the operator enforcement switch is on) legacy AND V2 > legacy.
 *
 * V2 is restrict-only. An "allow" rule or override can never widen what the
 * legacy system allows, so activating V2 can only remove access, never add it.
 * While a company is in shadow mode (the default) the effective decision is
 * exactly today's legacy decision and V2 is reported as `proposed` only.
 *
 * Admin and Developer are system-managed and never evaluated through V2.
 * The legacy column is module-level: route, page, tab, location, cashbox,
 * accounting-period and record-state guards on the server still apply on top
 * of every decision here.
 */
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  CREATE_ONLY_ROLE,
  evaluateAccessControl,
  type AccessControlAction,
  type AccessControlDecisionReason,
  type AccessControlResource,
  type AccessDecision,
} from "./accessControlV2";
import type { CreateOnlyVerifiedCreateName } from "./createOnlyRolePolicy";

export type V2PolicyMode = "shadow" | "active" | "rolled_back";

export const READ_ACTIONS: ReadonlySet<AccessControlAction> = new Set(["view", "export"]);

/** Resource that each handler-verified Create Only create adds records to. */
export const CREATE_ONLY_VERIFIED_CREATE_RESOURCES: Readonly<
  Record<CreateOnlyVerifiedCreateName, AccessControlResource>
> = {
  suppliers: "erp.suppliers",
  customers: "erp.customers",
  stockItems: "erp.stock_items",
  factoryBaleBatch: "factory.bales",
  factoryCustomerOrders: "factory.customer_orders",
  rentalUnits: "properties.units",
  rentalContracts: "properties.contracts",
  retailProducts: "retail.stock_items",
  spSales: "erp.sales",
};

const CREATE_ONLY_CREATE_RESOURCES: ReadonlySet<AccessControlResource> = new Set(
  Object.values(CREATE_ONLY_VERIFIED_CREATE_RESOURCES)
);

/** Legacy module feature key that gates each resource today. */
export function legacyModuleForResource(resource: AccessControlResource): string {
  if (resource.startsWith("factory.")) return "mod_factory";
  if (resource.startsWith("retail.")) return "mod_pos";
  if (resource.startsWith("properties.")) return "mod_properties";
  if (resource.startsWith("system.")) return "mod_settings";
  if (resource === "erp.accounts" || resource === "erp.vouchers") return "mod_accounting";
  if (resource === "erp.analytics") return "mod_analytics";
  if (
    resource === "erp.stock_items" ||
    resource === "erp.stock_transfers" ||
    resource === "erp.inventory" ||
    resource === "erp.containers"
  ) {
    return "mod_inventory";
  }
  return "mod_erp";
}

export const LEGACY_MODULE_KEYS: readonly string[] = [
  ...new Set(ACCESS_CONTROL_RESOURCES.map((resource) => legacyModuleForResource(resource))),
];

export interface V2RuleRow {
  resource: string;
  action: string;
  decision: AccessDecision;
}

export interface EffectivePermissionInput {
  companyId: number;
  userId: string;
  /** Canonical company role from user_company_roles; null when not a member. */
  role: string | null;
  /** Legacy module result for each LEGACY_MODULE_KEYS entry (role semantics already applied). */
  legacyModules: Readonly<Record<string, boolean>>;
  v2: {
    available: boolean;
    mode: V2PolicyMode;
    revision: number;
    roleRules: readonly V2RuleRow[];
    userRules: readonly V2RuleRow[];
  };
  /** Operator switch PERMISSIONS_V2_ENFORCEMENT=enabled. */
  enforcementEnabled: boolean;
}

export type EffectiveDecisionSource = "not_member" | "system_role" | "hard_restriction" | "legacy" | "v2_active";

export interface EffectiveDecision {
  allowed: boolean;
  source: EffectiveDecisionSource;
  /** What today's (legacy) system allows at module level. */
  legacyAllowed: boolean;
  /** What the V2 role rules and user overrides would allow. */
  proposedAllowed: boolean;
  proposedReason: AccessControlDecisionReason | "system_role" | "v2_unavailable";
  /** Where the explicit V2 decision came from, if any. */
  ruleSource: "user_override" | "role_rule" | null;
}

export interface EffectivePermissionMatrix {
  companyId: number;
  userId: string;
  role: string | null;
  mode: V2PolicyMode;
  revision: number;
  v2Available: boolean;
  /** True only when V2 decisions currently restrict this company. */
  enforced: boolean;
  legacyBasis: "module";
  decisions: Record<AccessControlResource, Record<AccessControlAction, EffectiveDecision>>;
  summary: { allowed: number; denied: number; divergent: number };
}

const SYSTEM_ROLES = new Set(["Admin", "Developer"]);
const ADMIN_ONLY_SYSTEM: ReadonlySet<AccessControlResource> = new Set(["system.users", "system.maintenance"]);

/**
 * System-level restrictions that no role rule or override can lift.
 * Returns true when the action must be denied.
 */
export function isHardRestricted(role: string, resource: AccessControlResource, action: AccessControlAction): boolean {
  if (SYSTEM_ROLES.has(role)) return false;
  if (resource.startsWith("system.")) {
    if (role !== "Owner") return true;
    // Owners keep their legacy company settings; user management and
    // maintenance stay with Admin/Developer.
    if (ADMIN_ONLY_SYSTEM.has(resource)) return true;
  }
  if (action === "manage_users" || action === "repair") return true;
  if (role === "View Only") return !READ_ACTIONS.has(action);
  if (role === CREATE_ONLY_ROLE) {
    if (READ_ACTIONS.has(action)) return false;
    return !(action === "create" && CREATE_ONLY_CREATE_RESOURCES.has(resource));
  }
  if (role === "ERP Tester" && action === "manage_settings") return true;
  return false;
}

function legacyDecision(
  role: string,
  resource: AccessControlResource,
  action: AccessControlAction,
  legacyModules: Readonly<Record<string, boolean>>
): boolean {
  if (SYSTEM_ROLES.has(role)) return true;
  if (isHardRestricted(role, resource, action)) return false;
  return legacyModules[legacyModuleForResource(resource)] === true;
}

function ruleIndex(rows: readonly V2RuleRow[]): Map<string, AccessDecision> {
  const index = new Map<string, AccessDecision>();
  for (const row of rows) {
    if (row.decision === "allow" || row.decision === "deny" || row.decision === "inherit") {
      index.set(`${row.resource}\u0000${row.action}`, row.decision);
    }
  }
  return index;
}

export function computeEffectivePermissions(input: EffectivePermissionInput): EffectivePermissionMatrix {
  const { role } = input;
  const roleRules = ruleIndex(input.v2.roleRules);
  const userRules = ruleIndex(input.v2.userRules);
  const enforced =
    input.v2.available &&
    input.v2.mode === "active" &&
    input.enforcementEnabled &&
    role !== null &&
    !SYSTEM_ROLES.has(role);
  const decisions = {} as EffectivePermissionMatrix["decisions"];
  const summary = { allowed: 0, denied: 0, divergent: 0 };

  for (const resource of ACCESS_CONTROL_RESOURCES) {
    const row = {} as Record<AccessControlAction, EffectiveDecision>;
    for (const action of ACCESS_CONTROL_ACTIONS) {
      let decision: EffectiveDecision;
      if (role === null) {
        decision = {
          allowed: false,
          source: "not_member",
          legacyAllowed: false,
          proposedAllowed: false,
          proposedReason: "invalid_company_scope",
          ruleSource: null,
        };
      } else if (SYSTEM_ROLES.has(role)) {
        decision = {
          allowed: true,
          source: "system_role",
          legacyAllowed: true,
          proposedAllowed: true,
          proposedReason: "system_role",
          ruleSource: null,
        };
      } else {
        const legacyAllowed = legacyDecision(role, resource, action, input.legacyModules);
        const hard = isHardRestricted(role, resource, action);
        const key = `${resource}\u0000${action}`;
        const userDecision = userRules.get(key);
        const roleDecision = roleRules.get(key);
        let proposedAllowed = legacyAllowed;
        let proposedReason: EffectiveDecision["proposedReason"] = "v2_unavailable";
        if (input.v2.available) {
          const evaluation = evaluateAccessControl({
            role,
            companyId: input.companyId,
            isAssignedToCompany: true,
            resource,
            action,
            hardDenied: hard,
            // Only Create Only depends on handler review; its verified creates
            // and reads are the reviewed operations.
            routeVerified: role !== CREATE_ONLY_ROLE || !hard,
            roleDecision,
            userDecision,
            legacyAllowed,
          });
          // Restrict-only: V2 never allows more than the legacy system does.
          proposedAllowed = evaluation.allowed && legacyAllowed;
          proposedReason = evaluation.reason;
        }
        const ruleSource =
          userDecision && userDecision !== "inherit"
            ? "user_override"
            : roleDecision && roleDecision !== "inherit"
              ? "role_rule"
              : null;
        decision = hard
          ? {
              allowed: false,
              source: "hard_restriction",
              legacyAllowed,
              proposedAllowed: false,
              proposedReason,
              ruleSource,
            }
          : enforced
            ? {
                allowed: proposedAllowed,
                source: "v2_active",
                legacyAllowed,
                proposedAllowed,
                proposedReason,
                ruleSource,
              }
            : { allowed: legacyAllowed, source: "legacy", legacyAllowed, proposedAllowed, proposedReason, ruleSource };
      }
      if (decision.allowed) summary.allowed += 1;
      else summary.denied += 1;
      if (decision.legacyAllowed !== decision.proposedAllowed) summary.divergent += 1;
      row[action] = decision;
    }
    decisions[resource] = row;
  }

  return {
    companyId: input.companyId,
    userId: input.userId,
    role,
    mode: input.v2.mode,
    revision: input.v2.revision,
    v2Available: input.v2.available,
    enforced,
    legacyBasis: "module",
    decisions,
    summary,
  };
}

/** One decision from a matrix; unknown resource/action pairs are denied. */
export function effectiveDecisionFor(
  matrix: EffectivePermissionMatrix,
  resource: string,
  action: string
): EffectiveDecision | null {
  const row = (matrix.decisions as Record<string, Record<string, EffectiveDecision> | undefined>)[resource];
  return row?.[action] ?? null;
}
