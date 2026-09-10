/**
 * Shared TypeScript types for the accounting service layer.
 *
 * Phase 10 — Central Accounting Engine
 * These types mirror the Drizzle schema shapes but are defined here so that
 * service helpers can be imported without pulling in the full schema module.
 *
 * Phase 1 multi-currency update:
 * VoucherEntryInsertFields now accepts all dual-currency fields.
 * Callers should supply a NormalizedEntryAmounts object (from currencyAmounts.ts)
 * for any CFA or non-USD voucher so the posting service can persist all fields.
 */

import type { voucherEntries, vouchers } from "@shared/schema";

/** Minimal shape needed to insert a voucher row. */
export interface VoucherInsertFields {
  companyId: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  totalAmount: string;
  description?: string | null;
  locationId?: number | null;
  optional?: boolean;
  currency?: string | null;
  exchangeRate?: string | null;
  effectiveDate?: string | null;
  sourceModule?: string | null;
}

/** Minimal shape needed to insert a voucher entry row. */
export interface VoucherEntryInsertFields {
  // ── Account linkage (one or more populated depending on entry type) ─────────
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  fixedAssetId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  customerId?: number | null;
  factorySupplierId?: number | null;

  // ── Backward-compatible amount fields ────────────────────────────────────────
  // For new vouchers these MUST equal the historical base-currency (USD) amounts.
  // For USD vouchers they also equal the transaction amounts.
  // Legacy rows that pre-date the dual-currency schema may still hold
  // transaction-currency CFA amounts here — the backfill script corrects those.
  debitAmount?: string;
  creditAmount?: string;

  narration?: string | null;

  // ── Dual-currency fields (nullable; populated for all new writes) ─────────────
  // Prefer supplying a NormalizedEntryAmounts object via the posting service
  // rather than setting these individually, to avoid consistency errors.

  /** ISO-4217 transaction currency code (e.g. "XOF", "USD"). */
  transactionCurrency?: string | null;
  /** Original CFA (or other non-USD) debit amount at posting time (6 dp). */
  transactionDebitAmount?: string | null;
  /** Original CFA (or other non-USD) credit amount at posting time (6 dp). */
  transactionCreditAmount?: string | null;
  /** Historical base-currency (USD) debit (6 dp). Must equal debitAmount for new rows. */
  baseDebitAmount?: string | null;
  /** Historical base-currency (USD) credit (6 dp). Must equal creditAmount for new rows. */
  baseCreditAmount?: string | null;
  /**
   * Exchange rate used at posting time (10 dp).
   * For TRANSACTION_PER_BASE: CFA per USD.
   * For IDENTITY: 1.
   */
  historicalExchangeRate?: string | null;
  /**
   * Rate convention:
   *   IDENTITY             – transaction IS base (USD vouchers)
   *   TRANSACTION_PER_BASE – rate = CFA per USD
   *   BASE_PER_TRANSACTION – reserved
   */
  rateConvention?: string | null;
}

/** Shape returned by insertVoucherWithEntriesTx. */
export interface VoucherWithEntries<V = unknown, E = unknown> {
  voucher: V;
  entries: E[];
}

/**
 * The persisted rows the posting engine hands back.
 *
 * Both of its return paths — a fresh insert and an idempotent replay — read the
 * real `vouchers` / `voucher_entries` rows, so the result can name them instead
 * of leaving callers to assert `CentralPostingResult<any, any>`. The import is
 * type-only, so this module still pulls in no runtime schema code.
 */
export type PostedVoucher = typeof vouchers.$inferSelect;

export type PostedVoucherEntry = typeof voucherEntries.$inferSelect;

export type PostedVoucherWithEntries = VoucherWithEntries<PostedVoucher, PostedVoucherEntry>;
