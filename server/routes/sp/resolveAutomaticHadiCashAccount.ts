// Extracted from ./goldenCoastAutoHadi.ts to keep that module under the source-size cap.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
} from "../../services/accounting/goldenCoastHadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import * as core from "./goldenCoastAutoHadiCore";

export const postingDependencies = createDatabasePostingDependencies();

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

type AutomaticCashCandidate = core.GoldenCoastAutomaticHadiAccount & {
  source: "cash-ledger" | "bank-ledger" | "bank-account";
};

export type GoldenCoastAutomaticHadiPostingRole = GoldenCoastPhase7PostingRole | "sales_payable";

export interface GoldenCoastAutomaticHadiResult extends Omit<core.GoldenCoastAutomaticHadiResult, "postings"> {
  postings: Array<{
    role: GoldenCoastAutomaticHadiPostingRole;
    voucher: PersistedPostingResult["voucher"];
    entries: PersistedPostingResult["entries"];
  }>;
}

export function assertHadiAuthorized(pair: core.GoldenCoastAutomaticHadiPair): void {
  const requestContext = getCompanyRequestRuntimeContext();
  if (!requestContext?.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this POS request; submit targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies access before the sale posts.`,
      "GC_PHASE6_AUTO_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function activeIntercompanyAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: "sp_hadi_intercompany" | "hadi_sp_intercompany",
  label: string
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

  if (rows.length !== 1 || rows[0].accountType !== "Intercompany") {
    throw new core.GoldenCoastPhase6AutoHadiError(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}; run Golden Coast setup first.`
        : rows.length > 1
          ? `${label} is ambiguous; repair duplicate active ${subType} accounts first.`
          : `${label} must have account type Intercompany, not ${rows[0].accountType}.`,
      "GC_PHASE6_AUTO_HADI_INTERCOMPANY_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

export async function resolveAutomaticRoleAccounts(
  tx: DatabaseTransaction,
  pair: core.GoldenCoastAutomaticHadiPair,
  gcSalesCashAccountId: number
): Promise<GoldenCoastPhase7RoleAccounts> {
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const goldenCoastIntercompany = await activeIntercompanyAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany account"
  );

  await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
  const hadiIntercompany = await activeIntercompanyAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany account"
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  return {
    gcSalesCashAccountId,
    goldenCoastHadiIntercompanyAccountId: goldenCoastIntercompany.id,
    hadiGoldenCoastIntercompanyAccountId: hadiIntercompany.id,
  };
}

export async function resolveAutomaticHadiCashAccount(
  tx: DatabaseTransaction,
  hadiCompanyId: number
): Promise<core.GoldenCoastAutomaticHadiAccount> {
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  const cashLedgers = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, hadiCompanyId),
        eq(ledgerAccounts.accountType, "Cash"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id));
  const bankLedgers = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, hadiCompanyId),
        eq(ledgerAccounts.accountType, "Bank"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id));
  const banks = await tx
    .select({ id: bankAccounts.id, name: bankAccounts.name })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.companyId, hadiCompanyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt))
    )
    .orderBy(asc(bankAccounts.id));

  return core.selectGoldenCoastAutomaticHadiCashAccount({
    cashLedgers: cashLedgers.map((row): AutomaticCashCandidate => ({
      kind: "ledger",
      id: Number(row.id),
      name: String(row.name),
      source: "cash-ledger",
    })),
    fallbackAccounts: [
      ...bankLedgers.map((row): AutomaticCashCandidate => ({
        kind: "ledger",
        id: Number(row.id),
        name: String(row.name),
        source: "bank-ledger",
      })),
      ...banks.map((row): AutomaticCashCandidate => ({
        kind: "bank",
        id: Number(row.id),
        name: String(row.name),
        source: "bank-account",
      })),
    ],
  });
}

export async function outstandingAutomaticHadiCollections(
  tx: DatabaseTransaction,
  companyId: number
): Promise<Decimal> {
  await assertTransactionCompanyScope(tx, companyId);
  const query = await tx.execute(sql`
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
  const outstanding = new Decimal(String(resultRows(query)[0]?.outstanding ?? "0"));
  if (!outstanding.isFinite() || outstanding.lessThan(0)) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection history is inconsistent: remittances exceed collections.",
      "GC_PHASE6_AUTO_HADI_HISTORY_INVALID",
      409
    );
  }
  return outstanding;
}

export async function findPostedVoucher(
  tx: DatabaseTransaction,
  companyId: number,
  idempotencyKey: string
): Promise<{ voucher: typeof vouchers.$inferSelect; sourceId: string } | null> {
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId)))
    .limit(1);
  if (!voucher || voucher.deletedAt != null) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      `Automatic HADI idempotency marker ${idempotencyKey} references a missing or deleted voucher.`,
      "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}
