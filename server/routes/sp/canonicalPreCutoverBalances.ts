// Extracted from ./spGoldenCoastPhase3CutoverRoutes.ts to keep that module under the source-size cap.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_PHASE3_CUTOVER_DATE,
  type GoldenCoastPhase3CashAccount,
  type GoldenCoastPhase3RoleAccounts,
  goldenCoastPhase3VoucherNumber,
} from "../../services/accounting/goldenCoastPhase3Cutover";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "../../services/accounting/goldenCoastCutoverMarkers";

export const postingDependencies = createDatabasePostingDependencies();

export const phase3RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 25 });

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

const CUTOVER_ROLES = [
  "fresh_start_equity",
  "hassan_equity",
  "hassan_savings",
  "gc_sales_cash",
  "profit_pending_distribution",
  "stock_otw",
  "stock_in_hand",
  "container_reserve",
] as const satisfies readonly GoldenCoastAccountRole[];

export class GoldenCoastPhase3RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE3_CUTOVER_INVALID", status = 400) {
    super(message);
    this.name = "GoldenCoastPhase3RouteError";
    this.code = code;
    this.status = status;
  }
}

export function businessDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseCashAccount(value: unknown): GoldenCoastPhase3CashAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase3RouteError("cashAccount is required");
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase3RouteError('cashAccount.kind must be "ledger" or "bank"');
  }
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase3RouteError("cashAccount.id must be a positive integer");
  }
  return {
    kind: input.kind,
    id,
    ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
  };
}

function activeCanonicalAccount(
  accounts: readonly GoldenCoastLedgerRow[],
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) => account.subType === definition.subType && account.active === true && account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase3RouteError(
      matches.length === 0
        ? `Golden Coast Phase 2 role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast Phase 2 role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType}); repair duplicates before cutover`,
      "GC_PHASE3_PHASE2_NOT_READY",
      409
    );
  }
  return matches[0];
}

export function resolveRoleAccounts(accounts: readonly GoldenCoastLedgerRow[]): GoldenCoastPhase3RoleAccounts & {
  profitPendingDistributionAccountId: number;
} {
  return {
    freshStartEquityAccountId: activeCanonicalAccount(accounts, "fresh_start_equity").id,
    hassanEquityAccountId: activeCanonicalAccount(accounts, "hassan_equity").id,
    hassanSavingsAccountId: activeCanonicalAccount(accounts, "hassan_savings").id,
    gcSalesCashAccountId: activeCanonicalAccount(accounts, "gc_sales_cash").id,
    profitPendingDistributionAccountId: activeCanonicalAccount(accounts, "profit_pending_distribution").id,
    stockOtwAccountId: activeCanonicalAccount(accounts, "stock_otw").id,
    stockInHandAccountId: activeCanonicalAccount(accounts, "stock_in_hand").id,
    containerReserveAccountId: activeCanonicalAccount(accounts, "container_reserve").id,
  };
}

export async function validateCashAccountTx(
  tx: DatabaseTransaction | typeof db,
  companyId: number,
  account: GoldenCoastPhase3CashAccount
): Promise<void> {
  if (account.kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw new GoldenCoastPhase3RouteError("cashAccount must reference an active bank account in this company");
    }
    return;
  }

  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase3RouteError(
      "cashAccount must reference an active Cash/Bank ledger account in this company"
    );
  }
}

export async function existingCutoverVoucherTx(tx: DatabaseTransaction | typeof db, companyId: number) {
  const voucherNumber = goldenCoastPhase3VoucherNumber(companyId);
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.voucherNumber, voucherNumber)))
    .limit(1);
  return voucher ?? null;
}

export async function existingPositionCarryForwardVoucherTx(tx: DatabaseTransaction | typeof db, companyId: number) {
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherNumber, goldenCoastExistingPositionCarryForwardVoucherNumber(companyId)),
        isNull(vouchers.deletedAt)
      )
    )
    .limit(1);
  return voucher ?? null;
}

export async function canonicalPreCutoverBalances(
  tx: DatabaseTransaction | typeof db,
  companyId: number,
  accounts: readonly GoldenCoastLedgerRow[]
): Promise<Array<{ role: GoldenCoastAccountRole; accountId: number; debitMinusCreditUsd: string }>> {
  const resolved = CUTOVER_ROLES.map((role) => ({ role, account: activeCanonicalAccount(accounts, role) }));
  const ids = resolved.map(({ account }) => account.id);

  const openingRows = await tx
    .select({
      id: ledgerAccounts.id,
      openingBalance: ledgerAccounts.openingBalance,
      openingBalanceSide: ledgerAccounts.openingBalanceSide,
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, ids)));

  const rows = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      debit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}), 0)`,
      credit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}), 0)`,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        inArray(voucherEntries.ledgerAccountId, ids),
        sql`${vouchers.voucherDate} < ${GOLDEN_COAST_PHASE3_CUTOVER_DATE}`
      )
    )
    .groupBy(voucherEntries.ledgerAccountId);

  const openingById = new Map(
    openingRows.map((row) => {
      const absolute = Number(row.openingBalance ?? 0);
      return [Number(row.id), row.openingBalanceSide === "Cr" ? -absolute : absolute] as const;
    })
  );
  const voucherById = new Map(
    rows.map((row) => [Number(row.ledgerAccountId), Number(row.debit ?? 0) - Number(row.credit ?? 0)] as const)
  );

  return resolved.map(({ role, account }) => ({
    role,
    accountId: account.id,
    debitMinusCreditUsd: ((openingById.get(account.id) ?? 0) + (voucherById.get(account.id) ?? 0)).toFixed(2),
  }));
}
