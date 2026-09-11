/**
 * Shared state and helpers for the balanceRepairRoutes routes.
 *
 * Extracted verbatim from the former single-file balanceRepairRoutes.ts.
 */
import { db } from "../../db";
import { ledgerAccounts } from "../../../shared/schema";
import { eq, and, isNull } from "drizzle-orm";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function parseNum(v: unknown): number {
  return parseFloat(String(v ?? "0")) || 0;
}

export async function findOrCreateLedgerAccount(
  companyId: number,
  name: string,
  accountType: string,
  code: string,
  subType?: string
): Promise<number> {
  const [existing] = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    );
  if (existing) return existing.id;
  const [created] = await db
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: `${code}-${Date.now()}`,
      name,
      accountType: accountType,
      subType: subType ?? null,
      active: true,
    })
    .returning();
  return created.id;
}

// ── Types shared between scan & apply ────────────────────────────────────────

export interface LedgerDrift {
  id: number;
  contractId: number;
  year: number;
  month: number;
  module: string;
  tenantName: string;
  unitLabel: string;
  storedPaid: number;
  computedPaid: number;
  diff: number;
}

export interface VoucherEntryMissing {
  paymentId: number;
  voucherId: number;
  contractId: number;
  module: string;
  tenantName: string;
  unitLabel: string;
  amount: number;
  paymentDate: string;
  cashAccountId: number | null;
  cashAccountName: string;
  unitType: string; // SHOP or WAREHOUSE
  issue: "EMPTY_VOUCHER" | "SOFT_DELETED_VOUCHER";
}

export interface OrphanedTransfer {
  transferId: number;
  description: string;
  amount: number;
  transferDate: string;
  fromCompanyName: string;
  toCompanyName: string;
  orphanedSide: "FROM" | "TO";
  orphanedVoucherId: number;
  issue: "SOFT_DELETED" | "EMPTY_ENTRIES";
}

export interface DepositFlagMismatch {
  contractId: number;
  tenantName: string;
  unitLabel: string;
  module: string;
  guaranteeAmount: number;
  voucherAmount?: number;
  flagValue: boolean;
  voucherExists: boolean;
  issue: "STALE_FLAG" | "MISSING_FLAG" | "AMOUNT_MISMATCH";
}

export interface ScanResult {
  ledgerDrifts: LedgerDrift[];
  voucherEntryMissing: VoucherEntryMissing[];
  orphanedTransfers: OrphanedTransfer[];
  depositFlagMismatches: DepositFlagMismatch[];
  totalDiscrepancies: number;
}

// Snapshot for undo
export interface ApplySnapshot {
  ledgerSnapshots: { id: number; oldPaid: number; newPaid: number }[];
  voucherEntriesAdded: number[]; // voucherEntry ids that were inserted (we delete them on undo)
  vouchersUndeleted: { id: number }[]; // vouchers that had deletedAt cleared
  orphanedVouchersDeleted: {
    id: number;
    voucherNumber: string;
    companyId: number;
    totalAmount: string;
    voucherType: string;
    voucherDate: string;
    description: string | null;
    entries: { ledgerAccountId: number | null; debitAmount: string; creditAmount: string; narration: string | null }[];
  }[];
  transfersDeleted: {
    id: number;
    transferType: string;
    fromCompanyId: number;
    toCompanyId: number;
    transferDate: string;
    amount: string;
    fromLedgerAccountId: number;
    toLedgerAccountId: number;
    fromVoucherId: number | null;
    toVoucherId: number | null;
    description: string | null;
    sourcePaymentId: number | null;
  }[];
  depositSnapshots: {
    contractId: number;
    oldFlag: boolean;
    newFlag: boolean;
    oldPostedAmount: number;
    newPostedAmount: number;
  }[];
}
