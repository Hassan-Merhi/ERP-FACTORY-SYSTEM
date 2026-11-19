// Extracted from ./spGoldenCoastSalesCashSettlementRoutes.ts to keep that module under the source-size cap.
import type { Request } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, ledgerAccounts } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import type { PostingActor } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
} from "../../services/accounting/goldenCoastAccounts";
import type { GoldenCoastPhase10CashAccount } from "../../services/accounting/goldenCoastSalesCashSettlement";
import { type DbLike, goldenCoastPhase3VoucherNumber } from "./spGoldenCoastCutoverFifoRoutes";

export const postingDependencies = createDatabasePostingDependencies();

export const phase10RequestBudget = privilegedRequestBudget({
  maxBodyBytes: 16 * 1024,
  maxCollectionItems: 10,
});

const PHASE10_ROLE = "gc_sales_cash" as const satisfies GoldenCoastAccountRole;

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class GoldenCoastPhase10RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE10_SETTLEMENT_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase10RouteError";
    this.code = code;
    this.status = status;
  }
}

export function actorFromRequest(req: Request): PostingActor {
  const reference = typeof req.body?.reference === "string" ? req.body.reference.trim() : "";
  return {
    userId: req.user?.id ?? req.session.userId ?? null,
    username: req.session.username ?? null,
    reason: reference || "Golden Coast Phase 10 Fresh Start payment",
  };
}

export async function assertPhase10CutoverPosted(conn: DbLike, companyId: number): Promise<void> {
  const result = await conn.execute(sql`
    SELECT id
    FROM vouchers
    WHERE company_id = ${companyId}
      AND voucher_number = ${goldenCoastPhase3VoucherNumber(companyId)}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!resultRows(result)[0]) {
    throw new GoldenCoastPhase10RouteError(
      "Golden Coast Phase 3 cutover must be posted before Phase 10 Fresh Start payment",
      "GC_PHASE10_NOT_READY",
      409
    );
  }
}

export async function resolveGcSalesCashAccount(
  conn: DbLike,
  companyId: number
): Promise<{ id: number; name: string; accountType: string }> {
  const definition = getGoldenCoastAccountDefinition(PHASE10_ROLE);
  const rows = await conn
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, definition.subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    throw new GoldenCoastPhase10RouteError(
      rows.length === 0
        ? "GC Sales Cash is not configured; run Golden Coast account setup first"
        : "GC Sales Cash is ambiguous; repair duplicate canonical accounts before paying Fresh Start",
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  const account = {
    id: Number(rows[0].id),
    name: String(rows[0].name),
    accountType: String(rows[0].accountType),
  };
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase10RouteError(
      `GC Sales Cash must use account type ${definition.acceptedAccountTypes.join(" or ")}, not ${account.accountType}`,
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

const SHARED_CHARGES_SUBTYPE = "sp_shared_charges";

/**
 * Resolves the Shared Charges expense account a transfer fee is booked to. It
 * is only required when a settlement actually carries a fee, so callers pass
 * `required: false` for readiness reporting.
 */
export async function resolveSharedChargesAccount(
  conn: DbLike,
  companyId: number,
  required: boolean
): Promise<{ id: number; name: string } | null> {
  const rows = await conn
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, SHARED_CHARGES_SUBTYPE),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    if (!required) return null;
    throw new GoldenCoastPhase10RouteError(
      rows.length === 0
        ? "Shared Charges is not configured; a transfer fee cannot be booked"
        : "Shared Charges is ambiguous; repair duplicate accounts before charging a transfer fee",
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: String(rows[0].name) };
  const accountType = String(rows[0].accountType);
  if (!["Direct Expense", "Expense"].includes(accountType)) {
    if (!required) return null;
    throw new GoldenCoastPhase10RouteError(
      `Shared Charges must be an expense account, not ${accountType}`,
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

export async function validatePaymentAccount(
  conn: DbLike,
  companyId: number,
  account: GoldenCoastPhase10CashAccount
): Promise<void> {
  if (account.kind === "bank") {
    const [row] = await conn
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
      throw new GoldenCoastPhase10RouteError(
        "paymentAccount must reference an active bank account in the selected Golden Coast company",
        "GC_PHASE10_PAYMENT_ACCOUNT_INVALID",
        400
      );
    }
    return;
  }

  const [row] = await conn
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
    throw new GoldenCoastPhase10RouteError(
      "paymentAccount must reference an active Cash/Bank ledger account in the selected Golden Coast company",
      "GC_PHASE10_PAYMENT_ACCOUNT_INVALID",
      400
    );
  }
}
