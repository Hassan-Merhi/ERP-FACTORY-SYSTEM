// Extracted from ./goldenCoastPosAccounting.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, eq, ilike, inArray, isNull } from "drizzle-orm";
import { bankAccounts, companies, ledgerAccounts, locations, voucherEntries, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import type { CentralPostingResult } from "../accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";

/**
 * The standard POS sale remains the source document. These postings only move
 * the cash and payable balances required by Golden Coast's HADI arrangement.
 * They intentionally use a separate source type so legacy Phase 5/6 vouchers
 * are never mistaken for the new itemized POS flow.
 */
export const GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE = "golden-coast-pos-settlement";

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

type CashTarget = { kind: "ledger" | "bank"; id: number; name: string };

type SettlementRole = "payable_reclass" | "gc_cash_transfer" | "hadi_cash_receipt";

export const postingDependencies = createDatabasePostingDependencies();

export function money(value: number | string): string {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function digest(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
}

export function sourceId(clientSaleId: string, saleDigest: string, revision: string, role: SettlementRole): string {
  return `${clientSaleId}:${saleDigest}:${revision}:${role}`;
}

export function idempotencyKey(
  companyId: number,
  clientSaleId: string,
  revision: string,
  role: SettlementRole
): string {
  return `${GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE}:${companyId}:${clientSaleId}:${revision}:${role}`;
}

export function target(account: CashTarget): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

export async function activeSingleAccount(
  tx: DbTransaction,
  companyId: number,
  subType: string,
  label: string,
  accountTypes?: readonly string[]
): Promise<{ id: number; name: string }> {
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}`
        : `${label} is ambiguous; repair duplicate active ${subType} accounts first`
    );
  }
  if (accountTypes && !accountTypes.includes(rows[0].accountType)) {
    throw new Error(`${label} must have account type ${accountTypes.join(" or ")}`);
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

export async function resolveCashTarget(
  tx: DbTransaction,
  companyId: number,
  kind: "cash" | "bank",
  accountId: number
): Promise<CashTarget> {
  if (kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, accountId),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) throw new Error(`Payment bank account ${accountId} is not active in company ${companyId}`);
    return { kind, id: Number(row.id), name: String(row.name) };
  }

  const [row] = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, accountId),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) throw new Error(`Payment cash account ${accountId} is not active in company ${companyId}`);
  return { kind: "ledger", id: Number(row.id), name: String(row.name) };
}

export async function findMatchingHadiCashTarget(
  tx: DbTransaction,
  companyId: number,
  name: string
): Promise<CashTarget> {
  const [ledger] = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        ilike(ledgerAccounts.name, name),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(1);
  if (ledger) return { kind: "ledger", id: Number(ledger.id), name: String(ledger.name) };

  const [bank] = await tx
    .select({ id: bankAccounts.id, name: bankAccounts.name })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.companyId, companyId),
        ilike(bankAccounts.name, name),
        eq(bankAccounts.active, true),
        isNull(bankAccounts.deletedAt)
      )
    )
    .orderBy(asc(bankAccounts.id))
    .limit(1);
  if (bank) return { kind: "bank", id: Number(bank.id), name: String(bank.name) };
  throw new Error(`HADI has no active Cash/Bank account named "${name}" to receive Golden Coast POS cash`);
}

export async function findHadiPostingLocation(tx: DbTransaction, companyId: number): Promise<number> {
  const [location] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt)))
    .orderBy(asc(locations.id))
    .limit(1);
  if (!location) throw new Error("HADI has no active location for the Golden Coast POS cash receipt");
  return Number(location.id);
}

export async function resolvePair(tx: DbTransaction, companyId: number): Promise<{ parentCompanyId: number }> {
  const [company] = await tx
    .select({ parentCompanyId: companies.parentCompanyId, active: companies.active })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const parentCompanyId = Number(company?.parentCompanyId ?? 0);
  if (!company?.active || !Number.isInteger(parentCompanyId) || parentCompanyId <= 0 || parentCompanyId === companyId) {
    throw new Error("Golden Coast must have an active, distinct parent HADI company");
  }
  const [parent] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, parentCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!parent) throw new Error("Golden Coast parent HADI company is missing or inactive");
  return { parentCompanyId };
}
