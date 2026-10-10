import type { VoucherEntryInsertFields, VoucherInsertFields, VoucherWithEntries } from "./accountingTypes";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingDependencies,
  type CentralPostingResult,
  type PostingActor,
} from "./centralPostingEngine";
import { assertTransactionCompanyScope, type CompanyScopedTransaction } from "../security/transactionCompanyScope";
import type { DbTransaction } from "../../db";
import { sql } from "drizzle-orm";
import { assertNoInventoryCutoverTx } from "./perpetualInventory/cutoverRefusal";

/**
 * The immutable original voucher row, as locked inside the caller's
 * transaction. Only the fields an exact reversal inherits are named; the
 * loader may return further columns.
 */
export interface LockedVoucherRow {
  id: number | string;
  companyId: number | string;
  voucherType: string;
  voucherNumber?: string | null;
  totalAmount: string | number;
  deletedAt?: Date | string | null;
  locationId?: number | null;
  optional?: boolean | null;
  currency?: string | null;
  exchangeRate?: string | number | null;
  sourceModule?: string | null;
}

/** The immutable original entry row whose debit/credit sides are swapped. */
export interface LockedVoucherEntryRow {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  fixedAssetId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  customerId?: number | null;
  factorySupplierId?: number | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  narration?: string | null;
  transactionCurrency?: string | null;
  transactionDebitAmount?: string | number | null;
  transactionCreditAmount?: string | number | null;
  baseDebitAmount?: string | number | null;
  baseCreditAmount?: string | number | null;
  historicalExchangeRate?: string | number | null;
  rateConvention?: string | null;
}

export interface LockedVoucherForReversal extends VoucherWithEntries<LockedVoucherRow, LockedVoucherEntryRow> {
  isReversal?: boolean;
}

/**
 * Generic over the transaction handle so the PostgreSQL loader can be written
 * against the concrete drizzle transaction — and keep drizzle's own row typing —
 * while the reversal entry point below only requires a tenant-scoped handle.
 */
export interface VoucherReversalLoader<TTransaction = CompanyScopedTransaction> {
  loadOriginalForUpdate(input: {
    tx: TTransaction;
    companyId: number;
    voucherId: number;
  }): Promise<LockedVoucherForReversal | null>;
}

export interface ExactVoucherReversalRequest {
  companyId: number;
  originalVoucherId: number;
  reversalVoucherNumber: string;
  reversalDate: string;
  description?: string | null;
  actor?: PostingActor;
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PostingValidationError("VOUCHER_REVERSAL_INVALID", `${field} must be a positive integer`);
  }
  return id;
}

function requiredText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new PostingValidationError("VOUCHER_REVERSAL_INVALID", `${field} is required`);
  }
  return text;
}

function swapAmounts(entry: LockedVoucherEntryRow): VoucherEntryInsertFields {
  return {
    ledgerAccountId: entry.ledgerAccountId ?? null,
    bankAccountId: entry.bankAccountId ?? null,
    fixedAssetId: entry.fixedAssetId ?? null,
    supplierId: entry.supplierId ?? null,
    employeeId: entry.employeeId ?? null,
    customerId: entry.customerId ?? null,
    factorySupplierId: entry.factorySupplierId ?? null,
    debitAmount: String(entry.creditAmount ?? "0"),
    creditAmount: String(entry.debitAmount ?? "0"),
    narration: entry.narration ?? null,
    transactionCurrency: entry.transactionCurrency ?? null,
    transactionDebitAmount: entry.transactionCreditAmount == null ? null : String(entry.transactionCreditAmount),
    transactionCreditAmount: entry.transactionDebitAmount == null ? null : String(entry.transactionDebitAmount),
    baseDebitAmount: entry.baseCreditAmount == null ? null : String(entry.baseCreditAmount),
    baseCreditAmount: entry.baseDebitAmount == null ? null : String(entry.baseDebitAmount),
    historicalExchangeRate: entry.historicalExchangeRate == null ? null : String(entry.historicalExchangeRate),
    rateConvention: entry.rateConvention ?? null,
  };
}

/**
 * Builds an exact accounting reversal from a row that was locked inside the
 * caller's transaction. Financial amounts, currency metadata, ownership
 * targets, location and source module are inherited from the immutable original;
 * callers may only supply reversal identity/date/description.
 */
export function buildExactVoucherReversal(input: {
  companyId: number;
  originalVoucherId: number;
  original: LockedVoucherForReversal;
  reversalVoucherNumber: string;
  reversalDate: string;
  description?: string | null;
}): { voucher: VoucherInsertFields; entries: VoucherEntryInsertFields[] } {
  const companyId = positiveId(input.companyId, "companyId");
  const originalVoucherId = positiveId(input.originalVoucherId, "originalVoucherId");
  const originalVoucher = input.original?.voucher;

  if (!originalVoucher || Number(originalVoucher.id) !== originalVoucherId) {
    throw new PostingValidationError(
      "VOUCHER_REVERSAL_ORIGINAL_MISMATCH",
      "Locked original voucher does not match the requested voucher"
    );
  }
  if (Number(originalVoucher.companyId) !== companyId) {
    throw new PostingValidationError(
      "VOUCHER_REVERSAL_COMPANY_MISMATCH",
      "Locked original voucher belongs to a different company"
    );
  }
  if (originalVoucher.deletedAt != null) {
    throw new PostingValidationError(
      "VOUCHER_REVERSAL_ORIGINAL_DELETED",
      "Deleted vouchers cannot be reversed through the exact reversal path"
    );
  }
  if (input.original.isReversal) {
    throw new PostingValidationError(
      "VOUCHER_REVERSAL_CHAIN_FORBIDDEN",
      "A reversal voucher cannot itself be reversed"
    );
  }
  if (!Array.isArray(input.original.entries) || input.original.entries.length < 2) {
    throw new PostingValidationError(
      "VOUCHER_REVERSAL_ENTRIES_MISSING",
      "Original voucher does not contain a reversible balanced entry set"
    );
  }

  const reversalVoucherNumber = requiredText(input.reversalVoucherNumber, "reversalVoucherNumber");
  const reversalDate = requiredText(input.reversalDate, "reversalDate");

  const voucher: VoucherInsertFields = {
    companyId,
    voucherNumber: reversalVoucherNumber,
    voucherType: String(originalVoucher.voucherType),
    voucherDate: reversalDate,
    totalAmount: String(originalVoucher.totalAmount),
    description: input.description ?? `Exact reversal of ${String(originalVoucher.voucherNumber ?? originalVoucherId)}`,
    locationId: originalVoucher.locationId ?? null,
    optional: Boolean(originalVoucher.optional),
    currency: originalVoucher.currency ?? null,
    exchangeRate: originalVoucher.exchangeRate == null ? null : String(originalVoucher.exchangeRate),
    effectiveDate: reversalDate,
    sourceModule: originalVoucher.sourceModule ?? null,
  };

  return {
    voucher,
    entries: input.original.entries.map(swapAmounts),
  };
}

/**
 * Transaction-owned exact reversal entry point. The transaction-local company
 * scope is asserted before the original row is read/locked, then its accounting
 * sides are swapped and posted through the same balanced/idempotent/audited
 * central posting boundary as new writes.
 */
export async function reverseVoucherExactlyTx<TTransaction extends CompanyScopedTransaction = CompanyScopedTransaction>(
  tx: TTransaction,
  request: ExactVoucherReversalRequest,
  loader: VoucherReversalLoader<TTransaction>,
  dependencies: CentralPostingDependencies
): Promise<CentralPostingResult> {
  const companyId = positiveId(request.companyId, "companyId");
  const originalVoucherId = positiveId(request.originalVoucherId, "originalVoucherId");

  await assertTransactionCompanyScope(tx, companyId);

  const original = await loader.loadOriginalForUpdate({ tx, companyId, voucherId: originalVoucherId });

  if (!original) {
    throw new PostingValidationError(
      "VOUCHER_REVERSAL_ORIGINAL_NOT_FOUND",
      `Voucher ${originalVoucherId} was not found in company ${companyId}`
    );
  }

  const reversal = buildExactVoucherReversal({
    companyId,
    originalVoucherId,
    original,
    reversalVoucherNumber: request.reversalVoucherNumber,
    reversalDate: request.reversalDate,
    description: request.description,
  });

  return postBalancedVoucherTx(
    // The generic is intentionally structural (callers only owe company-scope
    // assertions); every caller passes the drizzle transaction the central
    // posting boundary writes through.
    tx as unknown as DbTransaction,
    {
      ...reversal,
      source: {
        sourceType: "voucher-reversal",
        sourceId: String(originalVoucherId),
        idempotencyKey: `voucher-reversal:${companyId}:${originalVoucherId}`,
      },
      actor: request.actor,
    },
    dependencies
  );
}

/** Voucher types that move stock (wave 11). */
export const STOCK_DOCUMENT_VOUCHER_TYPES: ReadonlySet<string> = new Set([
  "Stock Transfer",
  "StockTransfer",
  "Transfer",
  "Production",
  "Consumption",
  "Mixed",
  "Stock Adjustment",
  "Sales",
  "Credit Note",
  "Debit Note",
]);

/** Number prefixes of the linked journals that carry stock (wave 8 / 11). */
export const STOCK_JOURNAL_PREFIXES: readonly string[] = [
  "COGS-",
  "STOCK-IN-",
  "GIT-PO-",
  "GL-FACTORY-STOCK-",
  "INV-GL-",
  "FPOS-COGS-",
  "INV-MOVE-",
  "GL-INVENTORY-OPENING-",
];

/** Ledger accounts that carry stock value under perpetual inventory. */
const STOCK_ACCOUNT_CODES = [
  "INVENTORY",
  "GOODS_IN_TRANSIT",
  "FACTORY_RAW_MATERIAL_STOCK",
  "FACTORY_WIP",
  "FACTORY_FINISHED_GOODS",
] as const;

/**
 * Whether a voucher is a stock document or a linked stock journal: a stock
 * voucher type, a stock journal number, a voucher with sales items, or any
 * voucher with a line on a stock account.
 */
export async function isStockVoucherTx(tx: DbTransaction, companyId: number, voucherId: number): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT v.voucher_type, v.voucher_number,
           EXISTS (SELECT 1 FROM sales_items si WHERE si.voucher_id = v.id) AS has_sales_items,
           EXISTS (
             SELECT 1 FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
              WHERE ve.voucher_id = v.id AND la.company_id = v.company_id AND la.code IN (${sql.join(
                STOCK_ACCOUNT_CODES.map((code) => sql`${code}`),
                sql`, `
              )})
           ) AS has_stock_lines
      FROM vouchers v WHERE v.id = ${voucherId} AND v.company_id = ${companyId}
  `);
  const row = result.rows[0] as
    | { voucher_type: string; voucher_number: string | null; has_sales_items: boolean; has_stock_lines: boolean }
    | undefined;
  if (!row) return false;
  return (
    STOCK_DOCUMENT_VOUCHER_TYPES.has(row.voucher_type) ||
    STOCK_JOURNAL_PREFIXES.some((prefix) => (row.voucher_number ?? "").startsWith(prefix)) ||
    row.has_sales_items ||
    row.has_stock_lines
  );
}

/**
 * Wave 11: an exact reversal of a stock document or a linked stock journal
 * swaps its ledger lines but moves no stock, so after the company's
 * perpetual-inventory cut-over it would part the ledger from the sub-ledger.
 * It is refused then (409 PERPETUAL_INVENTORY_ACTIVE); other vouchers, and
 * every voucher before the cut-over, reverse as before.
 */
export async function assertExactReversalAllowedTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<void> {
  if (!(await isStockVoucherTx(tx, companyId, voucherId))) return;
  await assertNoInventoryCutoverTx(tx, companyId, "exact-voucher-reversal");
}
