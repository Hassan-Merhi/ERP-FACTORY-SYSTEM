// Extracted from ./spGoldenCoastSetupRoutes.ts to keep that module under the source-size cap.
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { companies, companySettings, ledgerAccounts } from "@shared/schema";
import { db } from "../../db";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import {
  GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES,
  type GoldenCoastLedgerRow,
  type GoldenCoastSettingsKey,
  type GoldenCoastSettingsSnapshot,
} from "../../services/accounting/goldenCoastAccounts";
import {
  type GoldenCoastPhase13IntercompanyDefinition,
  type GoldenCoastPhase13LedgerRow,
  planGoldenCoastPhase13IntercompanyAccount,
} from "../../services/accounting/goldenCoastIntercompany";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";

// ── Golden Coast account + readiness provisioning ────────────────────────────
// Phase 2 owns the canonical Golden Coast balance-sheet roles. Phase 13 extends
// this same Admin setup action with the reciprocal Golden Coast ↔ HADI
// intercompany accounts needed by Phase 7. No HADI transfer workflow is changed
// here; setup only provisions/repairs the accounts that Phase 7 already expects.

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type DbLike = DatabaseTransaction | typeof db;

export const goldenCoastRequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 25 });

export interface GoldenCoastCompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

export class GoldenCoastSetupRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GoldenCoastSetupRouteError";
    this.code = code;
    this.status = status;
  }
}

/** Loads every Phase 2 role candidate, including inactive/soft-deleted rows. */
export async function loadGoldenCoastAccounts(tx: DbLike, companyId: number): Promise<GoldenCoastLedgerRow[]> {
  const rows = await tx
    .select({
      id: ledgerAccounts.id,
      companyId: ledgerAccounts.companyId,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      subType: ledgerAccounts.subType,
      isHidden: ledgerAccounts.isHidden,
      active: ledgerAccounts.active,
      deletedAt: ledgerAccounts.deletedAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.subType, [...GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES])
      )
    );

  return rows.map((row) => ({ ...row, id: Number(row.id), companyId: Number(row.companyId) }));
}

/** Every live account name in one company, used to avoid unique-name clashes. */
export async function loadCompanyAccountNames(tx: DbLike, companyId: number): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  return new Map(rows.map((row) => [row.name, Number(row.id)]));
}

export async function loadGoldenCoastSettings(tx: DbLike, companyId: number): Promise<GoldenCoastSettingsSnapshot> {
  const [row] = await tx
    .select({
      spPosPayableAccountId: companySettings.spPosPayableAccountId,
      spPosProfitAccountId: companySettings.spPosProfitAccountId,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, companyId))
    .limit(1);
  return row ?? {};
}

export async function bindGoldenCoastSettings(
  tx: DatabaseTransaction,
  companyId: number,
  bindings: Partial<Record<GoldenCoastSettingsKey, number>>
): Promise<GoldenCoastSettingsKey[]> {
  const current = await loadGoldenCoastSettings(tx, companyId);
  const changed: GoldenCoastSettingsKey[] = [];
  const updates: Partial<Record<GoldenCoastSettingsKey, number>> = {};

  for (const [key, accountId] of Object.entries(bindings) as Array<[GoldenCoastSettingsKey, number]>) {
    if (Number(current[key] ?? 0) === Number(accountId)) continue;
    updates[key] = accountId;
    changed.push(key);
  }
  if (changed.length === 0) return changed;

  const [existing] = await tx
    .select({ id: companySettings.id })
    .from(companySettings)
    .where(eq(companySettings.companyId, companyId))
    .limit(1);

  if (existing) {
    await tx
      .update(companySettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(companySettings.companyId, companyId));
  } else {
    await tx.insert(companySettings).values({ companyId, ...updates });
  }

  return changed;
}

export async function resolveCompanyPair(conn: DbLike, companyId: number): Promise<GoldenCoastCompanyPair> {
  const [goldenCoast] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);
  if (!goldenCoast) {
    throw new GoldenCoastSetupRouteError(
      "The selected Golden Coast company is missing or inactive",
      "GC_PHASE13_COMPANY_INVALID",
      409
    );
  }

  const hadiCompanyId = Number(goldenCoast.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new GoldenCoastSetupRouteError(
      "Golden Coast must have a distinct active parent HADI company configured before intercompany setup can complete",
      "GC_PHASE13_PARENT_COMPANY_INVALID",
      409
    );
  }

  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi) {
    throw new GoldenCoastSetupRouteError(
      "The configured Golden Coast parent HADI company is missing or inactive",
      "GC_PHASE13_PARENT_COMPANY_INVALID",
      409
    );
  }

  return {
    goldenCoastCompanyId: Number(goldenCoast.id),
    goldenCoastCompanyName: String(goldenCoast.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

export function isHadiCompanyAuthorized(pair: GoldenCoastCompanyPair): boolean {
  return getCompanyRequestRuntimeContext()?.authorizedCompanyIds?.includes(pair.hadiCompanyId) === true;
}

export function assertHadiCompanyAuthorized(pair: GoldenCoastCompanyPair): void {
  if (isHadiCompanyAuthorized(pair)) return;
  throw new GoldenCoastSetupRouteError(
    `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies membership first`,
    "GC_PHASE13_HADI_SCOPE_UNAUTHORIZED",
    403
  );
}

export async function loadIntercompanyCandidates(
  conn: DbLike,
  companyId: number,
  definition: GoldenCoastPhase13IntercompanyDefinition
): Promise<GoldenCoastPhase13LedgerRow[]> {
  const rows = await conn
    .select({
      id: ledgerAccounts.id,
      companyId: ledgerAccounts.companyId,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      subType: ledgerAccounts.subType,
      isHidden: ledgerAccounts.isHidden,
      active: ledgerAccounts.active,
      deletedAt: ledgerAccounts.deletedAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        or(
          eq(ledgerAccounts.subType, definition.subType),
          eq(ledgerAccounts.code, definition.code),
          eq(ledgerAccounts.name, definition.name)
        )
      )
    );
  return rows.map((row) => ({ ...row, id: Number(row.id), companyId: Number(row.companyId) }));
}

export async function applyIntercompanyPlan(
  tx: DatabaseTransaction,
  companyId: number,
  definition: GoldenCoastPhase13IntercompanyDefinition
): Promise<{ role: string; action: string; accountId: number; fields: string[] }> {
  const accounts = await loadIntercompanyCandidates(tx, companyId, definition);
  const plan = planGoldenCoastPhase13IntercompanyAccount({ companyId, definition, accounts });

  if (plan.accountId == null) {
    const [codeClash] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, definition.code)))
      .limit(1);
    const liveNames = await loadCompanyAccountNames(tx, companyId);
    const code = codeClash ? `${definition.code}-${companyId}` : definition.code;
    const name = liveNames.has(definition.name) ? `${definition.name} (${definition.code})` : definition.name;
    const [inserted] = await tx
      .insert(ledgerAccounts)
      .values({
        companyId,
        code,
        name,
        accountType: definition.accountType,
        subType: definition.subType,
        isHidden: false,
        active: true,
      })
      .returning({ id: ledgerAccounts.id });
    return { role: definition.role, action: "create", accountId: Number(inserted.id), fields: [] };
  }

  if (plan.repairs.length > 0) {
    const patch: Record<string, unknown> = {};
    for (const repair of plan.repairs) patch[repair.field] = repair.to;
    await tx
      .update(ledgerAccounts)
      .set(patch)
      .where(and(eq(ledgerAccounts.id, plan.accountId), eq(ledgerAccounts.companyId, companyId)));
  }

  return {
    role: definition.role,
    action: plan.action,
    accountId: plan.accountId,
    fields: plan.repairs.map((repair) => repair.field),
  };
}
