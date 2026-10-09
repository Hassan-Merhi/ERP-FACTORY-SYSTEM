/** Retail accounting settings: default accounts, conflicts and the audited save (split out of retailFinancialService.ts). */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ledgerAccounts, retailAccountingSettings } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { db } from "../../db";
import { buildAuditChanges, writeAuditEvent, type AuditActor } from "../audit";
import { ensureSystemAccounts, systemAccountDefinition } from "../accounting/systemAccounts";

export interface RetailAccountingSettingsResolved {
  id: number;
  companyId: number;
  locationId: number | null;
  cashLedgerAccountId: number;
  cardLedgerAccountId: number;
  bankLedgerAccountId: number;
  bankAccountId: number | null;
  mobileLedgerAccountId: number;
  otherLedgerAccountId: number;
  salesRevenueLedgerAccountId: number;
  inventoryAssetLedgerAccountId: number;
  cogsLedgerAccountId: number;
  discountsLedgerAccountId: number;
  taxPayableLedgerAccountId: number;
  storeCreditLedgerAccountId: number;
}

/** The settings field each Retail default account fills, by registry code. */
const RETAIL_DEFAULT_ACCOUNTS = {
  cashLedgerAccountId: "RETAIL-CASH",
  cardLedgerAccountId: "RETAIL-CARD",
  bankLedgerAccountId: "RETAIL-BANK",
  mobileLedgerAccountId: "RETAIL-MOBILE",
  otherLedgerAccountId: "RETAIL-OTHER",
  salesRevenueLedgerAccountId: "RETAIL-SALES",
  inventoryAssetLedgerAccountId: "RETAIL-INVENTORY",
  cogsLedgerAccountId: "RETAIL-COGS",
  discountsLedgerAccountId: "RETAIL-DISCOUNTS",
  taxPayableLedgerAccountId: "RETAIL-TAX",
  storeCreditLedgerAccountId: "RETAIL-STORE-CREDIT",
} as const;

type RetailAccountField = keyof typeof RETAIL_DEFAULT_ACCOUNTS;

export interface RetailAccountConflict {
  code: string;
  accountId: number;
  issue: "type_differs" | "deleted";
  expectedType: string;
  actualType: string | null;
}

/**
 * A Retail default account exists with another type, or is deleted. The Retail
 * settings are refused instead of retyping or restoring it (posted history may
 * depend on it); the integrity diagnostic lists it under
 * system_accounts_needing_review.
 */
export class RetailAccountConflictError extends Error {
  readonly code = "RETAIL_ACCOUNT_CONFLICT";
  constructor(readonly conflicts: RetailAccountConflict[]) {
    super(
      `Retail accounting accounts conflict with existing accounts: ${conflicts
        .map((conflict) =>
          conflict.issue === "deleted"
            ? `${conflict.code} is deleted`
            : `${conflict.code} is typed ${conflict.actualType}, expected ${conflict.expectedType}`
        )
        .join("; ")}. Correct or choose these accounts in the Retail accounting settings.`
    );
  }
}

/**
 * The ids of the Retail default accounts for `fields`, created when missing
 * through the system account registry (wave 5 pattern, wave 17 C). An existing
 * account is never renamed, retyped, re-sub-typed or restored (the old helper
 * rewrote all four, and un-deleted the account); one with a conflicting type,
 * or deleted, refuses with RetailAccountConflictError.
 */
async function defaultRetailAccountIds(
  tx: DbTransaction,
  companyId: number,
  fields: readonly RetailAccountField[] = Object.keys(RETAIL_DEFAULT_ACCOUNTS) as RetailAccountField[]
): Promise<Partial<Record<RetailAccountField, number>>> {
  if (!fields.length) return {};
  const codes = fields.map((field) => RETAIL_DEFAULT_ACCOUNTS[field]);
  const statuses = await ensureSystemAccounts(tx, companyId, codes);
  // An account matched only by name has another code; its type is checked here.
  const byNameIds = statuses.flatMap((status) => (status.state === "reused_by_name" ? [status.accountId] : []));
  const byNameTypes = new Map<number, string>();
  if (byNameIds.length) {
    const rows = await tx
      .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, byNameIds)));
    for (const row of rows) byNameTypes.set(row.id, String(row.accountType));
  }
  const conflicts: RetailAccountConflict[] = [];
  const ids = new Map<string, number>();
  for (const status of statuses) {
    const expectedType = systemAccountDefinition(status.code)?.accountType ?? "";
    if (status.state === "missing") throw new Error(`Could not resolve Retail accounting account ${status.code}`);
    if (status.state === "deleted") {
      conflicts.push({
        code: status.code,
        accountId: status.accountId,
        issue: "deleted",
        expectedType,
        actualType: null,
      });
      continue;
    }
    if (status.state === "type_differs") {
      conflicts.push({
        code: status.code,
        accountId: status.accountId,
        issue: "type_differs",
        expectedType,
        actualType: status.actualType,
      });
      continue;
    }
    if (status.state === "reused_by_name") {
      const actualType = byNameTypes.get(status.accountId) ?? null;
      if (actualType !== expectedType) {
        conflicts.push({
          code: status.code,
          accountId: status.accountId,
          issue: "type_differs",
          expectedType,
          actualType,
        });
        continue;
      }
    }
    ids.set(status.code, status.accountId);
  }
  if (conflicts.length) throw new RetailAccountConflictError(conflicts);
  return Object.fromEntries(fields.map((field) => [field, ids.get(RETAIL_DEFAULT_ACCOUNTS[field])]));
}

export async function ensureRetailAccountingSettingsTx(
  tx: DbTransaction,
  companyId: number,
  locationId?: number | null,
  /** Accounts a settings save is choosing: their defaults are not resolved. */
  chosen: Partial<Record<string, number | null>> = {}
): Promise<RetailAccountingSettingsResolved> {
  let [defaultRow] = await tx
    .select()
    .from(retailAccountingSettings)
    .where(and(eq(retailAccountingSettings.companyId, companyId), isNull(retailAccountingSettings.locationId)))
    .limit(1);

  if (!defaultRow) {
    [defaultRow] = await tx
      .insert(retailAccountingSettings)
      // Account ids are filled below from the registry defaults.
      .values({ companyId, locationId: null })
      .onConflictDoNothing()
      .returning();
    if (!defaultRow) {
      [defaultRow] = await tx
        .select()
        .from(retailAccountingSettings)
        .where(and(eq(retailAccountingSettings.companyId, companyId), isNull(retailAccountingSettings.locationId)))
        .limit(1);
    }
  }
  if (!defaultRow) throw new Error("Retail accounting settings could not be created");

  let current = defaultRow;
  if (locationId) {
    const [specific] = await tx
      .select()
      .from(retailAccountingSettings)
      .where(
        and(eq(retailAccountingSettings.companyId, companyId), eq(retailAccountingSettings.locationId, locationId))
      )
      .limit(1);
    if (specific) {
      current = specific;
    } else {
      const [createdSpecific] = await tx
        .insert(retailAccountingSettings)
        .values({
          companyId,
          locationId,
          cashLedgerAccountId: defaultRow.cashLedgerAccountId,
          cardLedgerAccountId: defaultRow.cardLedgerAccountId,
          bankLedgerAccountId: defaultRow.bankLedgerAccountId,
          bankAccountId: defaultRow.bankAccountId,
          mobileLedgerAccountId: defaultRow.mobileLedgerAccountId,
          otherLedgerAccountId: defaultRow.otherLedgerAccountId,
          salesRevenueLedgerAccountId: defaultRow.salesRevenueLedgerAccountId,
          inventoryAssetLedgerAccountId: defaultRow.inventoryAssetLedgerAccountId,
          cogsLedgerAccountId: defaultRow.cogsLedgerAccountId,
          discountsLedgerAccountId: defaultRow.discountsLedgerAccountId,
          taxPayableLedgerAccountId: defaultRow.taxPayableLedgerAccountId,
          storeCreditLedgerAccountId: defaultRow.storeCreditLedgerAccountId,
        })
        .onConflictDoNothing()
        .returning();
      current =
        createdSpecific ??
        (
          await tx
            .select()
            .from(retailAccountingSettings)
            .where(
              and(
                eq(retailAccountingSettings.companyId, companyId),
                eq(retailAccountingSettings.locationId, locationId)
              )
            )
            .limit(1)
        )[0];
    }
  }
  if (!current) throw new Error("Retail accounting settings could not be resolved");

  // Only the accounts the row does not name are resolved (and created when
  // missing); an account the row names is used as chosen.
  const row = current;
  const unset = (Object.keys(RETAIL_DEFAULT_ACCOUNTS) as RetailAccountField[]).filter(
    (field) => row[field] == null && chosen[field] == null
  );
  const generated = await defaultRetailAccountIds(tx, companyId, unset);
  const patch = Object.fromEntries(
    (Object.keys(RETAIL_DEFAULT_ACCOUNTS) as RetailAccountField[]).map((field) => [
      field,
      (row[field] ?? generated[field]) as number,
    ])
  ) as Record<RetailAccountField, number>;
  if (unset.length) {
    [current] = await tx
      .update(retailAccountingSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(retailAccountingSettings.id, current.id))
      .returning();
  }

  return {
    id: current.id,
    companyId,
    locationId: current.locationId ?? null,
    ...patch,
    bankAccountId: current.bankAccountId ?? null,
  };
}

export async function getRetailAccountingSettings(companyId: number, locationId?: number | null) {
  return db.transaction((tx) => ensureRetailAccountingSettingsTx(tx, companyId, locationId));
}

export type RetailAccountingSettingsPatch = Partial<{
  cashLedgerAccountId: number | null;
  cardLedgerAccountId: number | null;
  bankLedgerAccountId: number | null;
  bankAccountId: number | null;
  mobileLedgerAccountId: number | null;
  otherLedgerAccountId: number | null;
  salesRevenueLedgerAccountId: number | null;
  inventoryAssetLedgerAccountId: number | null;
  cogsLedgerAccountId: number | null;
  discountsLedgerAccountId: number | null;
  taxPayableLedgerAccountId: number | null;
  storeCreditLedgerAccountId: number | null;
}>;

const SETTINGS_AUDIT_FIELDS = [...Object.keys(RETAIL_DEFAULT_ACCOUNTS), "bankAccountId"] as const;

/**
 * Saves a Retail settings row with its audit (old and new accounts) in the
 * same transaction (wave 17 C). The defaults of the accounts the save leaves
 * unset are resolved first; a conflicting default refuses the whole save
 * (RetailAccountConflictError) and nothing is written.
 */
export async function saveRetailAccountingSettings(
  companyId: number,
  locationId: number | null,
  patch: RetailAccountingSettingsPatch,
  actor: AuditActor & { userId: string | number }
) {
  return db.transaction(async (tx) => {
    const condition = locationId
      ? and(eq(retailAccountingSettings.companyId, companyId), eq(retailAccountingSettings.locationId, locationId))
      : and(eq(retailAccountingSettings.companyId, companyId), isNull(retailAccountingSettings.locationId));
    const [stored] = await tx.select().from(retailAccountingSettings).where(condition).limit(1).for("update");
    await ensureRetailAccountingSettingsTx(tx, companyId, locationId, patch);
    const [updated] = await tx
      .update(retailAccountingSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(condition)
      .returning();
    const pick = (row: Record<string, unknown> | undefined) =>
      row ? Object.fromEntries(SETTINGS_AUDIT_FIELDS.map((field) => [field, row[field] ?? null])) : null;
    const changes = buildAuditChanges(pick(stored), pick(updated), [...SETTINGS_AUDIT_FIELDS]);
    await writeAuditEvent(
      {
        ...actor,
        companyId,
        action: stored ? "update" : "create",
        tableName: "retail_accounting_settings",
        recordId: updated?.id ?? null,
        recordIdentifier: locationId ? `location ${locationId}` : "company default",
        changes,
      },
      tx
    );
    return updated;
  });
}
