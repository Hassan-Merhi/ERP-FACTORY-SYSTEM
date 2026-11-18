// Extracted from ./spGoldenCoastPhase7HadiTransferRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { accountingPostingRequests, bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { resultRows } from "../../lib/queryResult";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  type GoldenCoastPhase7CashAccount,
  goldenCoastPhase7IdempotencyKey,
  type GoldenCoastPhase7PostingRole,
  goldenCoastPhase7SourceId,
  type GoldenCoastPhase7TransferInput,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import {
  GoldenCoastPhase7RouteError,
  type DatabaseTransaction,
  type DbLike,
  type GoldenCoastPhase7CompanyPair,
} from "./spGoldenCoastPhase7HadiTransferRoutesResolveCompanyPair";

export async function validateCashAccount(
  conn: DbLike,
  companyId: number,
  account: GoldenCoastPhase7CashAccount,
  label: string
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
      throw new GoldenCoastPhase7RouteError(
        `${label} must reference an active bank account in company ${companyId}`,
        "GC_PHASE7_CASH_ACCOUNT_INVALID",
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
    throw new GoldenCoastPhase7RouteError(
      `${label} must reference an active Cash/Bank ledger account in company ${companyId}`,
      "GC_PHASE7_CASH_ACCOUNT_INVALID",
      400
    );
  }
}

export async function listCashAccounts(conn: DbLike, companyId: number) {
  const [ledgerRows, bankRows] = await Promise.all([
    conn
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
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
    ...bankRows.map((row) => ({ kind: "bank" as const, id: Number(row.id), name: row.name, type: "Bank Account" })),
  ];
}

/**
 * Raw signed debit-minus-credit on GC Sales Cash. The account is credit-normal,
 * so callers convert this through `gcSalesCashPayableBalance` before reporting
 * or planning against what is still owed.
 */
export async function gcSalesCashSignedBalance(conn: DbLike, companyId: number, accountId: number): Promise<string> {
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
          AND v.optional = false
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
    throw new GoldenCoastPhase7RouteError(
      "GC Sales Cash disappeared while Phase 7 balances were being read",
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.debit_minus_credit ?? "0");
}

/**
 * Only Phase 7 collection/remittance vouchers participate in this outstanding
 * amount. The shared intercompany accounts also carry unrelated HADI agent
 * activity, which must never become remittable sales cash by accident.
 */
export async function outstandingPhase7HadiCollections(conn: DbLike, companyId: number): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      COALESCE(SUM(CASE
        WHEN split_part(apr.source_id, ':', 1) = 'collect_via_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      -
      COALESCE(SUM(CASE
        WHEN split_part(apr.source_id, ':', 1) = 'remit_from_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
    )::text AS outstanding
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id
    WHERE apr.company_id = ${companyId}
      AND apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
  `);
  return String(resultRows(query)[0]?.outstanding ?? "0");
}

async function findPostedVoucher(
  tx: DatabaseTransaction,
  markerCompanyId: number,
  idempotencyKey: string
): Promise<{ voucher: typeof vouchers.$inferSelect; sourceId: string } | null> {
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, markerCompanyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, markerCompanyId)))
    .limit(1);
  if (!voucher || voucher.deletedAt != null) {
    throw new GoldenCoastPhase7RouteError(
      `Phase 7 idempotency marker ${idempotencyKey} references a missing or deleted voucher`,
      "GC_PHASE7_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

export async function findReplayedTransfer(
  tx: DatabaseTransaction,
  pair: GoldenCoastPhase7CompanyPair,
  transfer: GoldenCoastPhase7TransferInput,
  transferDigest: string
) {
  const roles: Array<{ role: GoldenCoastPhase7PostingRole; markerCompanyId: number }> = [
    { role: "golden_coast", markerCompanyId: pair.goldenCoastCompanyId },
    { role: "hadi", markerCompanyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: GoldenCoastPhase7PostingRole;
    markerCompanyId: number;
    marker: Awaited<ReturnType<typeof findPostedVoucher>>;
  }> = [];
  for (const { role, markerCompanyId } of roles) {
    await assertTransactionCompanyScope(tx, markerCompanyId);
    found.push({
      role,
      markerCompanyId,
      marker: await findPostedVoucher(
        tx,
        markerCompanyId,
        goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, transfer.clientRequestId, role)
      ),
    });
  }
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const posted = found.filter((item) => item.marker != null);
  if (posted.length === 0) return null;
  if (posted.length !== roles.length) {
    throw new GoldenCoastPhase7RouteError(
      `Phase 7 transfer ${transfer.clientRequestId} has a partially recorded cross-company posting pair`,
      "GC_PHASE7_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  for (const item of found) {
    const expectedSourceId = goldenCoastPhase7SourceId(transfer.operation, transferDigest, item.role);
    if (item.marker?.sourceId !== expectedSourceId) {
      throw new GoldenCoastPhase7RouteError(
        `Phase 7 transfer ${transfer.clientRequestId} was already posted with different economic data; use a new clientRequestId`,
        "GC_PHASE7_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  return Promise.all(
    found.map(async (item) => {
      const voucher = (item.marker as { voucher: typeof vouchers.$inferSelect }).voucher;
      return { role: item.role, voucher, entries: await loadVoucherEntries(tx, voucher.id) };
    })
  );
}
