/**
 * Phase 1: V2 access-control contract (shadow-mode only).
 *
 * No existing middleware imports this module yet. It must not alter production
 * permissions until every relevant business API has an explicit route/action
 * classification and a reviewed migration is complete.
 *
 * The action is the BUSINESS operation, not the HTTP verb: POST endpoints may
 * edit, finalize, reverse, or delete an existing record.
 */

export const ACCESS_CONTROL_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "approve",
  "finalize",
  "void",
  "reverse",
  "import",
  "export",
  "manage_settings",
  "manage_users",
  "repair",
] as const;

export type AccessControlAction = (typeof ACCESS_CONTROL_ACTIONS)[number];
export type AccessDecision = "allow" | "deny" | "inherit";

/**
 * Permission scopes are stable business entities, NOT frontend route names.
 * Additional scopes may be introduced only with an explicit API ownership map.
 */
export const ACCESS_CONTROL_RESOURCES = [
  "erp.vouchers",
  "erp.accounts",
  "erp.suppliers",
  "erp.customers",
  "erp.stock_items",
  "erp.inventory",
  "erp.stock_transfers",
  "erp.purchase_orders",
  "erp.containers",
  "erp.sales",
  "erp.payroll",
  "erp.analytics",
  "factory.raw_stock",
  "factory.mix_batches",
  "factory.production",
  "factory.bales",
  "factory.containers",
  "factory.customer_orders",
  "factory.accounting",
  "factory.employees",
  "factory.payroll",
  "factory.analytics",
  "retail.stock_items",
  "retail.stock_imports",
  "retail.pos",
  "retail.transfers",
  "properties.units",
  "properties.contracts",
  "properties.payments",
  "properties.analytics",
  "system.users",
  "system.settings",
  "system.maintenance",
] as const;

export type AccessControlResource = (typeof ACCESS_CONTROL_RESOURCES)[number];

const OPERATIONAL_RESOURCES: ReadonlySet<AccessControlResource> = new Set(
  ACCESS_CONTROL_RESOURCES.filter((scope) => !scope.startsWith("system."))
);

const CREATE_ONLY_CREATABLE_RESOURCES: ReadonlySet<AccessControlResource> = new Set([
  "erp.vouchers",
  "erp.accounts",
  "erp.suppliers",
  "erp.customers",
  "erp.stock_items",
  "erp.stock_transfers",
  "erp.purchase_orders",
  "erp.containers",
  "erp.sales",
  "factory.raw_stock",
  "factory.mix_batches",
  "factory.production",
  "factory.bales",
  "factory.containers",
  "factory.customer_orders",
  "factory.employees",
  "retail.stock_items",
  "retail.stock_imports",
  "retail.pos",
  "retail.transfers",
  "properties.units",
  "properties.contracts",
  "properties.payments",
]);

export const CREATE_ONLY_ROLE = "Create Only" as const;

/**
 * Hard policy defaults cannot be granted through the role settings UI, even
 * through a user override. For the Create Only role, existing records are
 * immutable, including the records that user originally created.
 */
const CREATE_ONLY_HARD_DENIED_ACTIONS: ReadonlySet<AccessControlAction> = new Set([
  "edit",
  "delete",
  "approve",
  "finalize",
  "void",
  "reverse",
  "import",
  "manage_settings",
  "manage_users",
  "repair",
]);

export interface AccessControlEvaluationInput {
  role: string;
  companyId: number | null;
  isAssignedToCompany: boolean;
  /** Approved cross-company support path for the Developer role only. */
  developerSupportBypass?: boolean;
  resource: AccessControlResource;
  action: AccessControlAction;

  /** Hard denials include closed accounting periods, resource-state checks,
   * company isolation, privileged maintenance, and existing security guards. */
  hardDenied?: boolean;

  /** For a POST creating a new record, true if it ALSO mutates an existing
   * entity: movement of stock, changing container status, rewriting vouchers,
   * etc. Such a route must be separately classified, not called "create". */
  touchesExistingRecord?: boolean;

  /** V2 explicit policies; legacy roles will be evaluated in shadow mode. */
  roleDecision?: AccessDecision;
  userDecision?: AccessDecision;

  /** Canonical result of existing permissions, for parity comparisons only. */
  legacyAllowed?: boolean;
}

export type AccessControlDecisionReason =
  | "invalid_company_scope"
  | "hard_denial"
  | "immutable_existing_record"
  | "create_only_protected_action"
  | "create_only_not_creatable"
  | "create_only_not_operational"
  | "user_override"
  | "role_override"
  | "create_only_default"
  | "legacy_policy"
  | "unconfigured";

export interface AccessControlEvaluation {
  allowed: boolean;
  reason: AccessControlDecisionReason;
}

function createOnlyDefault(
  resource: AccessControlResource,
  action: AccessControlAction
): boolean {
  if (!OPERATIONAL_RESOURCES.has(resource)) return false;
  if (action === "view" || action === "export") return true;
  if (action === "create") return CREATE_ONLY_CREATABLE_RESOURCES.has(resource);
  return false;
}

/**
 * Pure, conservative policy evaluator. Does not query storage or approve a
 * request on its own; the future server integration supplies the canonical
 * company assignment, hard-denial flags and a mapped business operation.
 *
 * Effective order:
 * company scope > hard guard > protected Create Only rule >
 * user override > role override > Create Only template / legacy parity.
 */
export function evaluateAccessControl(input: AccessControlEvaluationInput): AccessControlEvaluation {
  const validCompany = typeof input.companyId === "number" && Number.isSafeInteger(input.companyId) && input.companyId > 0;
  const assignedOrSupport = input.isAssignedToCompany || (input.role === "Developer" && input.developerSupportBypass === true);
  if (!validCompany || !assignedOrSupport) {
    return { allowed: false, reason: "invalid_company_scope" };
  }

  if (input.hardDenied) return { allowed: false, reason: "hard_denial" };

  // A "create" request is only such if it cannot rewrite an existing record.
  if (input.role === CREATE_ONLY_ROLE && input.action === "create" && input.touchesExistingRecord) {
    return { allowed: false, reason: "immutable_existing_record" };
  }

  if (input.role === CREATE_ONLY_ROLE) {
    if (CREATE_ONLY_HARD_DENIED_ACTIONS.has(input.action)) {
      return { allowed: false, reason: "create_only_protected_action" };
    }
    if (!OPERATIONAL_RESOURCES.has(input.resource)) {
      return { allowed: false, reason: "create_only_not_operational" };
    }
    if (input.action === "create" && !CREATE_ONLY_CREATABLE_RESOURCES.has(input.resource)) {
      return { allowed: false, reason: "create_only_not_creatable" };
    }
  }

  if (input.userDecision && input.userDecision !== "inherit") {
    return { allowed: input.userDecision === "allow", reason: "user_override" };
  }
  if (input.roleDecision && input.roleDecision !== "inherit") {
    return { allowed: input.roleDecision === "allow", reason: "role_override" };
  }
  if (input.role === CREATE_ONLY_ROLE) {
    return { allowed: createOnlyDefault(input.resource, input.action), reason: "create_only_default" };
  }

  if (typeof input.legacyAllowed === "boolean") {
    return { allowed: input.legacyAllowed, reason: "legacy_policy" };
  }

  return { allowed: false, reason: "unconfigured" };
}
