// ── Golden Coast Phase 2: canonical Supplier Partner balance-sheet roles ──────
//
// Phase 2 owns the *account setup* layer that later Golden Coast phases (POS,
// container offload, special-location deductions, settlement and month close)
// depend on. It deliberately contains no posting logic: everything here is a
// pure function over plain ledger-account rows so the planner can be unit
// tested without a database, matching the Phase 1 module style.
//
// Design rules:
//  * Roles are identified by a stable `subType`, never by account name.
//  * Existing Supplier Partner / Phase 1 roles are REUSED, not duplicated. A
//    role may adopt a legacy `subType` so historical vouchers keep pointing at
//    the same ledger account id.
//  * Provisioning is idempotent and repair-only: it never deletes or rewrites
//    historical ledger accounts or vouchers.
//  * Opening balances (the $100,000 partner targets) are recorded here as
//    configuration targets only. The September 1, 2026 cutover posting is a
//    later phase.

import {
  GOLDEN_COAST_PHASE2_ACCOUNT_DEFS,
  GoldenCoastPhase2SetupError,
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
  type GoldenCoastProvisioningPlan,
  type GoldenCoastRolePlanItem,
  type GoldenCoastSettingsKey,
} from "./getGoldenCoastAccountDefinition";
export {
  GOLDEN_COAST_PHASE2_ACCOUNT_DEFS,
  GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES,
  GoldenCoastPhase2SetupError,
  getGoldenCoastAccountDefinition,
} from "./getGoldenCoastAccountDefinition";
export type {
  GoldenCoastAccountDefinition,
  GoldenCoastAccountRole,
  GoldenCoastLedgerRow,
  GoldenCoastProvisioningPlan,
  GoldenCoastRepair,
  GoldenCoastRepairField,
  GoldenCoastRoleAction,
  GoldenCoastRolePlanItem,
  GoldenCoastSettingsKey,
} from "./getGoldenCoastAccountDefinition";

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertCompanyId(companyId: number): number {
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new GoldenCoastPhase2SetupError("companyId must be a positive integer");
  }
  return companyId;
}

/**
 * Company isolation guard. Phase 2 setup must never look at, adopt or repair an
 * account belonging to another company, so a foreign row is a hard error rather
 * than a silently skipped one.
 */
function assertCompanyScoped(companyId: number, accounts: readonly GoldenCoastLedgerRow[]): void {
  const foreign = accounts.find((account) => Number(account.companyId) !== companyId);
  if (foreign) {
    throw new GoldenCoastPhase2SetupError(
      `Ledger account ${foreign.id} belongs to company ${foreign.companyId}, not company ${companyId}`
    );
  }
}

function isLive(account: GoldenCoastLedgerRow): boolean {
  return account.active === true && account.deletedAt == null;
}

/** Lowest id wins so the oldest (most posted-against) account stays canonical. */
function byIdAscending(a: GoldenCoastLedgerRow, b: GoldenCoastLedgerRow): number {
  return a.id - b.id;
}

function pickForSubType(accounts: readonly GoldenCoastLedgerRow[], subType: string): GoldenCoastLedgerRow[] {
  return accounts.filter((account) => account.subType === subType).sort(byIdAscending);
}

// ── Planner ──────────────────────────────────────────────────────────────────

/**
 * Computes the idempotent provisioning plan for one company. Pure: it reads
 * ledger rows and returns the intended changes without touching the database.
 */
export function planGoldenCoastAccountProvisioning(input: {
  companyId: number;
  accounts: readonly GoldenCoastLedgerRow[];
  /**
   * Every live account name already used in this company, as name -> account id.
   * `uq_ledger_accounts_company_name_active` makes (company_id, name) unique
   * among non-deleted rows, so a rename or an insert that collides would abort
   * the whole provisioning transaction. Supplying this lets the planner avoid
   * the collision instead. Omitting it keeps the previous behaviour.
   */
  existingNames?: ReadonlyMap<string, number> | null;
}): GoldenCoastProvisioningPlan {
  const companyId = assertCompanyId(input.companyId);
  const accounts = input.accounts ?? [];
  assertCompanyScoped(companyId, accounts);
  const existingNames = input.existingNames ?? null;

  // Names this plan will consume, so two roles cannot claim the same name in
  // one run either.
  const claimedNames = new Set<string>();
  const nameIsFree = (name: string, ownerId: number | null): boolean => {
    if (claimedNames.has(name)) return false;
    if (!existingNames) return true;
    const holder = existingNames.get(name);
    return holder === undefined || (ownerId !== null && holder === ownerId);
  };

  const claimedAccountIds = new Set<number>();
  const items: GoldenCoastRolePlanItem[] = [];
  const warnings: string[] = [];

  for (const definition of GOLDEN_COAST_PHASE2_ACCOUNT_DEFS) {
    const item: GoldenCoastRolePlanItem = {
      role: definition.role,
      subType: definition.subType,
      code: definition.code,
      name: definition.name,
      accountType: definition.accountType,
      requiresVisible: definition.requiresVisible,
      openingBalanceTargetUsd: definition.openingBalanceTargetUsd ?? null,
      ownershipSharePct: definition.ownershipSharePct ?? null,
      settingsKey: definition.settingsKey ?? null,
      action: "create",
      accountId: null,
      repairs: [],
      warnings: [],
      duplicateAccountIds: [],
    };

    const canonical = pickForSubType(accounts, definition.subType).filter(
      (account) => !claimedAccountIds.has(account.id)
    );
    let match = canonical.find(isLive) ?? canonical[0] ?? null;
    let adopted = false;

    if (!match) {
      for (const legacySubType of definition.legacySubTypes) {
        const legacy = pickForSubType(accounts, legacySubType).filter((account) => !claimedAccountIds.has(account.id));
        const candidate = legacy.find(isLive) ?? legacy[0] ?? null;
        if (candidate) {
          match = candidate;
          adopted = true;
          break;
        }
      }
    }

    if (match) {
      const resolved = match;
      claimedAccountIds.add(resolved.id);
      claimedNames.add(resolved.name);
      item.accountId = resolved.id;
      item.code = resolved.code;

      // Any other live account on the same canonical sub type is reported but
      // never mutated or removed — Phase 2 does not destroy ledger history.
      const duplicates = canonical.filter((account) => account.id !== resolved.id && isLive(account));
      if (duplicates.length > 0) {
        item.duplicateAccountIds = duplicates.map((account) => account.id);
        item.warnings.push(
          `${duplicates.length} additional account(s) share subType "${definition.subType}" and were left untouched: ${duplicates
            .map((account) => `#${account.id} ${account.name}`)
            .join(", ")}`
        );
      }

      if (adopted) {
        item.repairs.push({
          field: "subType",
          from: resolved.subType,
          to: definition.subType,
          reason: `Adopt legacy account as the ${definition.role} role instead of creating a duplicate`,
        });
      }

      if (!definition.acceptedAccountTypes.includes(resolved.accountType)) {
        item.repairs.push({
          field: "accountType",
          from: resolved.accountType,
          to: definition.accountType,
          reason: `Role ${definition.role} requires account type ${definition.accountType}`,
        });
      }

      if (resolved.name !== definition.name) {
        if (definition.legacyNames.includes(resolved.name) && nameIsFree(definition.name, resolved.id)) {
          claimedNames.add(definition.name);
          item.repairs.push({
            field: "name",
            from: resolved.name,
            to: definition.name,
            reason: "Rename legacy Supplier Partner account to its Golden Coast role name",
          });
        } else if (definition.legacyNames.includes(resolved.name)) {
          // Renaming would collide with another live account in this company.
          item.name = resolved.name;
          item.warnings.push(
            `Account #${resolved.id} kept the name "${resolved.name}": another active account is already named "${definition.name}"`
          );
        } else {
          item.name = resolved.name;
          item.warnings.push(
            `Account #${resolved.id} uses the custom name "${resolved.name}"; Phase 2 kept it instead of renaming to "${definition.name}"`
          );
        }
      }

      if (definition.requiresVisible && resolved.isHidden) {
        item.repairs.push({
          field: "isHidden",
          from: true,
          to: false,
          reason: "Golden Coast requires this account to be readable on the balance sheet",
        });
      }

      if (!resolved.active) {
        item.repairs.push({
          field: "active",
          from: false,
          to: true,
          reason: "Required Golden Coast role was inactive",
        });
      }
      if (resolved.deletedAt != null) {
        item.repairs.push({
          field: "deletedAt",
          from: String(resolved.deletedAt),
          to: null,
          reason: "Required Golden Coast role was soft deleted",
        });
      }

      item.action = adopted ? "adopt" : item.repairs.length > 0 ? "repair" : "none";
    }

    if (item.accountId === null) {
      // Nothing existing to adopt: make sure the name we plan to insert cannot
      // trip the (company_id, name) unique index.
      if (!nameIsFree(item.name, null)) {
        const disambiguated = `${item.name} (${definition.code})`;
        item.warnings.push(
          `Another active account is already named "${item.name}"; creating the ${definition.role} account as "${disambiguated}"`
        );
        item.name = disambiguated;
      }
      claimedNames.add(item.name);
    }

    warnings.push(...item.warnings);
    items.push(item);
  }

  const createRoles = items.filter((item) => item.action === "create").map((item) => item.role);
  const adoptRoles = items.filter((item) => item.action === "adopt").map((item) => item.role);
  const repairRoles = items.filter((item) => item.action === "repair").map((item) => item.role);

  return {
    companyId,
    items,
    createRoles,
    adoptRoles,
    repairRoles,
    warnings,
    isClean: createRoles.length === 0 && adoptRoles.length === 0 && repairRoles.length === 0,
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

export type GoldenCoastRoleStatusCode = "ok" | "missing" | "needs_repair";

export interface GoldenCoastRoleStatus {
  role: GoldenCoastAccountRole;
  subType: string;
  expectedName: string;
  expectedAccountType: string;
  status: GoldenCoastRoleStatusCode;
  accountId: number | null;
  code: string | null;
  name: string | null;
  accountType: string | null;
  isHidden: boolean | null;
  openingBalanceTargetUsd: string | null;
  ownershipSharePct: string | null;
  settingsKey: GoldenCoastSettingsKey | null;
  settingsBound: boolean | null;
  issues: string[];
  warnings: string[];
}

export interface GoldenCoastSetupStatus {
  companyId: number;
  isConfigured: boolean;
  requiredRoleCount: number;
  configuredRoleCount: number;
  missingRoles: GoldenCoastAccountRole[];
  invalidRoles: GoldenCoastAccountRole[];
  roles: GoldenCoastRoleStatus[];
  warnings: string[];
  /** Company-settings columns that do not yet point at the canonical account. */
  unboundSettingsKeys: GoldenCoastSettingsKey[];
}

export interface GoldenCoastSettingsSnapshot {
  spPosPayableAccountId?: number | null;
  spPosProfitAccountId?: number | null;
}

/**
 * Reports whether every canonical Phase 2 role is provisioned correctly for the
 * company, and exactly what is wrong when it is not.
 */
export function summarizeGoldenCoastAccountSetup(input: {
  companyId: number;
  accounts: readonly GoldenCoastLedgerRow[];
  settings?: GoldenCoastSettingsSnapshot | null;
  existingNames?: ReadonlyMap<string, number> | null;
}): GoldenCoastSetupStatus {
  const plan = planGoldenCoastAccountProvisioning({
    companyId: input.companyId,
    accounts: input.accounts,
    existingNames: input.existingNames,
  });
  const byId = new Map(input.accounts.map((account) => [account.id, account]));
  const settings = input.settings ?? {};

  const roles: GoldenCoastRoleStatus[] = plan.items.map((item) => {
    const account = item.accountId == null ? null : (byId.get(item.accountId) ?? null);
    const issues = item.repairs.map((repair) => repair.reason);
    const settingsBound =
      item.settingsKey == null
        ? null
        : account != null && Number(settings[item.settingsKey] ?? 0) === Number(account.id);

    if (settingsBound === false) {
      issues.push(`Company setting ${item.settingsKey} does not point at the ${item.role} account`);
    }

    const status: GoldenCoastRoleStatusCode = account == null ? "missing" : issues.length > 0 ? "needs_repair" : "ok";

    return {
      role: item.role,
      subType: item.subType,
      expectedName: getGoldenCoastAccountDefinition(item.role).name,
      expectedAccountType: getGoldenCoastAccountDefinition(item.role).accountType,
      status,
      accountId: account?.id ?? null,
      code: account?.code ?? null,
      name: account?.name ?? null,
      accountType: account?.accountType ?? null,
      isHidden: account?.isHidden ?? null,
      openingBalanceTargetUsd: item.openingBalanceTargetUsd,
      ownershipSharePct: item.ownershipSharePct,
      settingsKey: item.settingsKey,
      settingsBound,
      issues,
      warnings: item.warnings,
    };
  });

  const missingRoles = roles.filter((role) => role.status === "missing").map((role) => role.role);
  const invalidRoles = roles.filter((role) => role.status === "needs_repair").map((role) => role.role);
  const unboundSettingsKeys = roles
    .filter((role) => role.settingsKey != null && role.settingsBound === false)
    .map((role) => role.settingsKey as GoldenCoastSettingsKey);

  return {
    companyId: plan.companyId,
    isConfigured: missingRoles.length === 0 && invalidRoles.length === 0,
    requiredRoleCount: roles.length,
    configuredRoleCount: roles.filter((role) => role.status === "ok").length,
    missingRoles,
    invalidRoles,
    roles,
    warnings: plan.warnings,
    unboundSettingsKeys,
  };
}
