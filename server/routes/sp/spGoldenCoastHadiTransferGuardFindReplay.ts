// Extracted from ./spGoldenCoastHadiTransferGuard.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { accountingPostingRequests, voucherEntries, vouchers } from "@shared/schema";
import { resultRows } from "../../lib/queryResult";
import { GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE } from "../../services/accounting/goldenCoastFreshStartHadiPayment";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  type GoldenCoastPhase7CashAccount,
  goldenCoastPhase7IdempotencyKey,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
  goldenCoastPhase7SourceId,
  type GoldenCoastPhase7TransferInput,
} from "../../services/accounting/goldenCoastHadiTransfer";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import {
  GoldenCoastPhase16HadiError,
  type CompanyPair,
  type DatabaseTransaction,
} from "./goldenCoastLegacyHadiRetiredPayload";

/**
 * Sale-time HADI collections use the Phase 7 source type. Phase 16 remittance
 * must subtract both earlier remittances and any direct HADI→Fresh Start
 * payments, because both consume the same pool of HADI-held Golden Coast sale
 * proceeds. Phase 10 direct GC payment intentionally does not reduce this pool.
 */
export async function trackedHadiSalesCash(tx: DatabaseTransaction, companyId: number): Promise<Decimal> {
  await assertTransactionCompanyScope(tx, companyId);
  const result = await tx.execute(sql`
    SELECT GREATEST(
      COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'collect_via_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      - COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'remit_from_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      - COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'payment'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0),
      0
    )::text AS outstanding
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id
    WHERE apr.company_id = ${companyId}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
      AND apr.source_type IN (${GOLDEN_COAST_PHASE7_SOURCE_TYPE}, ${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE})
  `);
  const parsed = new Decimal(String(resultRows(result)[0]?.outstanding ?? "0"));
  if (!parsed.isFinite() || parsed.lt(0)) {
    throw new GoldenCoastPhase16HadiError("Tracked HADI sales cash is invalid", "GC_PHASE16_BALANCE_INVALID", 409);
  }
  return parsed;
}

function amountEquals(left: unknown, right: unknown): boolean {
  try {
    return new Decimal(String(left ?? "0")).eq(new Decimal(String(right ?? "0")));
  } catch {
    return false;
  }
}

function entryMatchesCashTarget(
  entry: typeof voucherEntries.$inferSelect,
  account: GoldenCoastPhase7CashAccount
): boolean {
  return account.kind === "bank"
    ? Number(entry.bankAccountId ?? 0) === account.id
    : Number(entry.ledgerAccountId ?? 0) === account.id;
}

export async function findReplay(
  tx: DatabaseTransaction,
  pair: CompanyPair,
  transfer: GoldenCoastPhase7TransferInput,
  accounts: GoldenCoastPhase7RoleAccounts,
  digest: string
): Promise<Array<{
  role: GoldenCoastPhase7PostingRole;
  voucher: typeof vouchers.$inferSelect;
  entries: (typeof voucherEntries.$inferSelect)[];
}> | null> {
  const roles: Array<{ role: GoldenCoastPhase7PostingRole; companyId: number }> = [
    { role: "golden_coast", companyId: pair.goldenCoastCompanyId },
    { role: "hadi", companyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: GoldenCoastPhase7PostingRole;
    companyId: number;
    voucher: typeof vouchers.$inferSelect;
    entries: (typeof voucherEntries.$inferSelect)[];
  }> = [];
  let markers = 0;

  for (const item of roles) {
    await assertTransactionCompanyScope(tx, item.companyId);
    const key = goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, transfer.clientRequestId, item.role);
    const [marker] = await tx
      .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
      .from(accountingPostingRequests)
      .where(
        and(eq(accountingPostingRequests.companyId, item.companyId), eq(accountingPostingRequests.idempotencyKey, key))
      )
      .limit(1);
    if (!marker) continue;
    markers += 1;
    if (String(marker.sourceId) !== goldenCoastPhase7SourceId("remit_from_hadi", digest, item.role)) {
      throw new GoldenCoastPhase16HadiError(
        "clientRequestId was already used for different HADI remittance routing",
        "GC_PHASE16_IDEMPOTENCY_CONFLICT",
        409
      );
    }
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.id, Number(marker.voucherId)),
          eq(vouchers.companyId, item.companyId),
          isNull(vouchers.deletedAt)
        )
      )
      .limit(1);
    if (!voucher || !amountEquals(voucher.totalAmount, transfer.amountUsd)) {
      throw new GoldenCoastPhase16HadiError(
        "HADI remittance replay marker points to a missing or altered voucher",
        "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
    if (entries.length !== 2) {
      throw new GoldenCoastPhase16HadiError(
        "HADI remittance replay voucher entries were altered",
        "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    const amount = transfer.amountUsd;
    if (item.role === "golden_coast") {
      const cashDebit = entries.find(
        (entry) =>
          transfer.goldenCoastCashAccount != null &&
          entryMatchesCashTarget(entry, transfer.goldenCoastCashAccount) &&
          amountEquals(entry.debitAmount, amount) &&
          amountEquals(entry.creditAmount, "0")
      );
      const icCredit = entries.find(
        (entry) =>
          Number(entry.ledgerAccountId ?? 0) === accounts.goldenCoastHadiIntercompanyAccountId &&
          amountEquals(entry.debitAmount, "0") &&
          amountEquals(entry.creditAmount, amount)
      );
      if (!cashDebit || !icCredit) {
        throw new GoldenCoastPhase16HadiError(
          "Golden Coast remittance replay entries were altered",
          "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
          409
        );
      }
    } else {
      const icDebit = entries.find(
        (entry) =>
          Number(entry.ledgerAccountId ?? 0) === accounts.hadiGoldenCoastIntercompanyAccountId &&
          amountEquals(entry.debitAmount, amount) &&
          amountEquals(entry.creditAmount, "0")
      );
      const cashCredit = entries.find(
        (entry) =>
          entryMatchesCashTarget(entry, transfer.hadiCashAccount) &&
          amountEquals(entry.debitAmount, "0") &&
          amountEquals(entry.creditAmount, amount)
      );
      if (!icDebit || !cashCredit) {
        throw new GoldenCoastPhase16HadiError(
          "HADI remittance replay entries were altered",
          "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
          409
        );
      }
    }
    found.push({ role: item.role, companyId: item.companyId, voucher, entries });
  }

  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  if (markers === 0) return null;
  if (markers !== roles.length) {
    throw new GoldenCoastPhase16HadiError(
      "HADI remittance has a partial cross-company replay pair",
      "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return found.map(({ role, voucher, entries }) => ({ role, voucher, entries }));
}
