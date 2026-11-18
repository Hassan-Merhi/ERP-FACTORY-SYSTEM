// Extracted from ./spGoldenCoastPhase10SalesCashSettlementRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { resultRows } from "../../lib/queryResult";
import {
  goldenCoastPhase10IdempotencyKey,
  type GoldenCoastPhase10SettlementInput,
  goldenCoastPhase10SourceId,
} from "../../services/accounting/goldenCoastPhase10SalesCashSettlement";
import type { DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import {
  GoldenCoastPhase10RouteError,
  type DatabaseTransaction,
} from "./spGoldenCoastPhase10SalesCashSettlementRoutesValidatePaymentAccount";

export async function listPaymentAccounts(conn: DbLike, companyId: number) {
  const [ledgerRows, bankRows] = await Promise.all([
    conn
      .select({
        id: ledgerAccounts.id,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt),
          inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
        )
      )
      .orderBy(asc(ledgerAccounts.name)),
    conn
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt)))
      .orderBy(asc(bankAccounts.name)),
  ]);
  return [
    ...ledgerRows.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: row.name,
      type: row.accountType,
    })),
    ...bankRows.map((row) => ({
      kind: "bank" as const,
      id: Number(row.id),
      name: row.name,
      type: "Bank Account",
    })),
  ];
}

/**
 * Signed Dr-minus-Cr balance; negative means GC Sales Cash is payable. Callers
 * convert it through `gcSalesCashPayableBalance` before reasoning about what is
 * still owed.
 */
export async function gcSalesCashDebitBalance(
  conn: DbLike,
  companyId: number,
  accountId: number,
  cutoffDate?: string
): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      CASE
        WHEN la.opening_balance_side = 'Cr' THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND COALESCE(v.optional, false) = false
          AND (
            ${cutoffDate ?? null}::date IS NULL
            OR COALESCE(v.effective_date, v.voucher_date) <= ${cutoffDate ?? null}::date
          )
      ), 0)
    )::text AS debit_minus_credit
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  const row = resultRows(query)[0];
  if (!row) {
    throw new GoldenCoastPhase10RouteError(
      "GC Sales Cash disappeared while its balance was being read",
      "GC_PHASE10_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.debit_minus_credit ?? "0");
}

function amountEquals(left: unknown, right: string): boolean {
  try {
    return new Decimal(String(left ?? "0")).equals(new Decimal(right));
  } catch {
    return false;
  }
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

export async function findReplayedSettlement(
  tx: DatabaseTransaction,
  companyId: number,
  settlement: GoldenCoastPhase10SettlementInput,
  gcSalesCashAccountId: number,
  settlementDigest: string
) {
  const idempotencyKey = goldenCoastPhase10IdempotencyKey(companyId, settlement.clientRequestId);
  const [marker] = await tx
    .select({
      voucherId: accountingPostingRequests.voucherId,
      sourceId: accountingPostingRequests.sourceId,
    })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const expectedSourceId = goldenCoastPhase10SourceId(settlementDigest);
  if (String(marker.sourceId ?? "") !== expectedSourceId) {
    throw new GoldenCoastPhase10RouteError(
      "clientRequestId was already used for a different Fresh Start payment payload",
      "GC_PHASE10_IDEMPOTENCY_CONFLICT",
      409
    );
  }

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(
      and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt))
    )
    .limit(1);
  if (!voucher) {
    throw new GoldenCoastPhase10RouteError(
      "The Phase 10 idempotency marker references a missing or deleted voucher",
      "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  const entries = await loadVoucherEntries(tx, Number(voucher.id));
  const chargesFee = new Decimal(settlement.transferFeeUsd).greaterThan(0);
  const cashOutflowUsd = new Decimal(settlement.amountUsd).plus(settlement.transferFeeUsd).toFixed(2);
  if (entries.length !== (chargesFee ? 3 : 2) || !amountEquals(voucher.totalAmount, cashOutflowUsd)) {
    throw new GoldenCoastPhase10RouteError(
      "The persisted Phase 10 voucher no longer matches its idempotency marker",
      "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  // A Phase 10 payment debits the payable and credits the paying cash account.
  const salesCashDebit = entries.find(
    (entry) =>
      Number(entry.ledgerAccountId ?? 0) === gcSalesCashAccountId &&
      amountEquals(entry.debitAmount, settlement.amountUsd) &&
      amountEquals(entry.creditAmount, "0")
  );
  const paymentCredit = entries.find((entry) => {
    const targetMatches =
      settlement.paymentAccount.kind === "bank"
        ? Number(entry.bankAccountId ?? 0) === settlement.paymentAccount.id
        : Number(entry.ledgerAccountId ?? 0) === settlement.paymentAccount.id;
    // The paying account funds the settlement AND any transfer fee.
    return targetMatches && amountEquals(entry.debitAmount, "0") && amountEquals(entry.creditAmount, cashOutflowUsd);
  });
  const feeDebit = !chargesFee
    ? true
    : entries.some(
        (entry) =>
          Number(entry.ledgerAccountId ?? 0) !== gcSalesCashAccountId &&
          amountEquals(entry.debitAmount, settlement.transferFeeUsd) &&
          amountEquals(entry.creditAmount, "0")
      );
  if (!salesCashDebit || !paymentCredit || !feeDebit) {
    throw new GoldenCoastPhase10RouteError(
      "The persisted Phase 10 voucher entries no longer match the requested Fresh Start payment routing",
      "GC_PHASE10_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, entries };
}
