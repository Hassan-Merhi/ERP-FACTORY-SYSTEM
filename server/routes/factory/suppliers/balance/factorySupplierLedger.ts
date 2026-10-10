/**
 * Factory supplier balances on the one balance engine (accounting audit
 * wave 13, owner decision 3).
 *
 *   - Primary balance: the ledger, from the engine (kind "factorySupplier"),
 *     in USD base: the supplier's opening plus the posted lines the engine
 *     attributes to it in the voucher company (a factory-supplier-tagged line
 *     on a ledger account, bank, fixed asset, ERP supplier or employee belongs
 *     to that target). Shown Cr positive: what we owe the supplier.
 *   - Beside it, the native balance per currency of the same lines, from the
 *     lines' transaction columns (a legacy line without them is in its
 *     voucher's currency).
 *   - "Not yet in the ledger" memo lines (balances/unpostedMemo.ts):
 *     container goods, supplier-paid freight and commission with no journal.
 *     Listed and totalled separately, never added to the ledger balance.
 *
 * The operational container formula the pages used to show as the balance is
 * kept by the routes only as a labelled memo (`operationalMemo`).
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import type { DatabaseOrTransaction } from "../../../../db";
import { MoneyDecimal, toMoney } from "../../../../lib/money";
import {
  getPartyBalances,
  type PartyBalanceMemoLine,
} from "../../../../services/accounting/balances/ledgerBalanceEngine";
import { higherPriorityTargetsAbsent } from "../../../../services/accounting/balances/partyLineRules";
import { MEMO_SOURCE_LABELS } from "../../../../services/accounting/balances/unpostedMemo";

export const FACTORY_SUPPLIER_NOT_IN_LEDGER_LABEL =
  "Not yet in the ledger — container amounts with no journal, shown for information, not part of the ledger balance";
export const FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL =
  "Operational container figure (containers, freight, commission, charges, payments and FX transfers) — memo only, not the ledger balance";

export interface FactorySupplierNativeBalance {
  currencyCode: string;
  /** Native debits and credits of the owned lines. */
  debit: string;
  credit: string;
  /** Cr positive: what we owe in this currency. */
  balance: string;
  /** Cr positive: the ledger's USD base of the same lines. */
  usdBalance: string;
  /** usdBalance / balance when both are non-zero (null otherwise): the lines' effective rate. */
  effectiveFxRateToUsd: string | null;
  /**
   * Lines whose USD columns still hold the native amount (legacy foreign
   * currency lines without base columns, wave 6 repair not yet applied): the
   * ledger's USD figure for them is not a converted amount.
   */
  legacyUnconvertedLines: number;
}

export interface FactorySupplierLedgerView {
  supplierId: number;
  balanceBasis: "ledger";
  /** Ledger balance in USD base, Cr positive (we owe the supplier). */
  ledgerBalanceUsd: string;
  ledgerBalanceSide: "Cr" | "Dr";
  /** Opening with its side, Cr positive. */
  openingBalanceUsd: string;
  nativeBalances: FactorySupplierNativeBalance[];
  /** True when a line's USD figure is a native amount (see legacyUnconvertedLines). */
  ledgerFxUnresolved: boolean;
  notInLedger: {
    label: string;
    /** USD, Cr positive; lines without a confirmed rate are listed but not totalled. */
    total: string;
    /** True when a memo line has no confirmed rate. */
    unresolved: boolean;
    lines: Array<PartyBalanceMemoLine & { sourceLabel: string }>;
  };
}

interface NativeRow {
  party_id: number;
  currency: string;
  debit: string;
  credit: string;
  usd_net: string;
  legacy: string;
}

const ZERO = new MoneyDecimal(0);

/** Native per-currency sums of the supplier's owned lines (same lines as the engine). */
async function loadNativeBalances(
  executor: DatabaseOrTransaction,
  companyId: number,
  ids: readonly number[],
  asOf: string | null | undefined
): Promise<Map<number, FactorySupplierNativeBalance[]>> {
  const out = new Map<number, FactorySupplierNativeBalance[]>();
  if (ids.length === 0) return out;
  const owned = sql.raw(higherPriorityTargetsAbsent("ve", "factory_supplier_id"));
  const cut = asOf ? sql` AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}::date` : sql``;
  const normalized = sql`(NULLIF(ve.transaction_currency, '') IS NOT NULL
      AND ve.base_debit_amount IS NOT NULL AND ve.base_credit_amount IS NOT NULL)`;
  const result = await executor.execute<NativeRow & Record<string, unknown>>(sql`
    SELECT n.party_id, n.currency,
           COALESCE(SUM(n.debit), 0)::text AS debit,
           COALESCE(SUM(n.credit), 0)::text AS credit,
           COALESCE(SUM(n.usd_net), 0)::text AS usd_net,
           COUNT(*) FILTER (WHERE n.legacy_foreign)::text AS legacy
      FROM (
        SELECT ve.factory_supplier_id AS party_id,
               CASE WHEN ${normalized} THEN UPPER(ve.transaction_currency)
                    ELSE UPPER(COALESCE(NULLIF(v.currency, ''), 'USD')) END AS currency,
               CASE WHEN ${normalized} THEN COALESCE(ve.transaction_debit_amount, 0)
                    ELSE COALESCE(ve.debit_amount, 0) END AS debit,
               CASE WHEN ${normalized} THEN COALESCE(ve.transaction_credit_amount, 0)
                    ELSE COALESCE(ve.credit_amount, 0) END AS credit,
               COALESCE(ve.credit_amount, 0) - COALESCE(ve.debit_amount, 0) AS usd_net,
               (NOT ${normalized} AND UPPER(COALESCE(NULLIF(v.currency, ''), 'USD')) <> 'USD') AS legacy_foreign
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false${cut}
           AND ve.factory_supplier_id IN (${sql.join(
             ids.map((id) => sql`${id}`),
             sql`, `
           )})
           AND ${owned}
      ) n
     GROUP BY n.party_id, n.currency
     ORDER BY n.party_id, n.currency
  `);
  for (const row of result.rows) {
    const partyId = Number(row.party_id);
    const debit = toMoney(row.debit);
    const credit = toMoney(row.credit);
    const balance = credit.minus(debit);
    const usd = toMoney(row.usd_net);
    const list = out.get(partyId) ?? [];
    list.push({
      currencyCode: row.currency,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balance: balance.toFixed(2),
      usdBalance: usd.toFixed(2),
      effectiveFxRateToUsd:
        row.currency === "USD" ? "1" : !balance.isZero() && !usd.isZero() ? usd.dividedBy(balance).toFixed(6) : null,
      legacyUnconvertedLines: Number(row.legacy) || 0,
    });
    out.set(partyId, list);
  }
  return out;
}

/**
 * Ledger views of the company's factory suppliers (or of `ids`), as of `asOf`
 * (everything posted when omitted). Every master of the company is returned,
 * zero or not.
 */
export async function loadFactorySupplierLedgerViews(
  executor: DatabaseOrTransaction,
  companyId: number,
  options: { ids?: readonly number[]; asOf?: string | null } = {}
): Promise<Map<number, FactorySupplierLedgerView>> {
  const views = new Map<number, FactorySupplierLedgerView>();
  if (options.ids && options.ids.length === 0) return views;
  const { parties } = await getPartyBalances(executor, {
    companyId,
    kind: "factorySupplier",
    ids: options.ids,
    asOf: options.asOf ?? null,
    memo: true,
  });
  const ids = parties.map((party) => party.id).filter((id): id is number => id !== null);
  const native = await loadNativeBalances(executor, companyId, ids, options.asOf);
  for (const party of parties) {
    if (party.id === null) continue;
    const owed = toMoney(party.closing).negated();
    const nativeBalances = (native.get(party.id) ?? []).sort((a, b) =>
      a.currencyCode === "USD" ? 1 : b.currencyCode === "USD" ? -1 : a.currencyCode.localeCompare(b.currencyCode)
    );
    const memoOwed = toMoney(party.memoTotal).negated();
    views.set(party.id, {
      supplierId: party.id,
      balanceBasis: "ledger",
      ledgerBalanceUsd: owed.toFixed(2),
      ledgerBalanceSide: owed.isNegative() ? "Dr" : "Cr",
      openingBalanceUsd: toMoney(party.masterOpening).negated().toFixed(2),
      nativeBalances,
      ledgerFxUnresolved: nativeBalances.some((bucket) => bucket.legacyUnconvertedLines > 0),
      notInLedger: {
        label: FACTORY_SUPPLIER_NOT_IN_LEDGER_LABEL,
        total: memoOwed.toFixed(2),
        unresolved: party.memoLines.some((line) => line.amount === null),
        lines: party.memoLines.map((line) => ({ ...line, sourceLabel: MEMO_SOURCE_LABELS[line.source] })),
      },
    });
  }
  return views;
}

/** The Cr-positive ledger balance of a view as a Decimal (zero when absent). */
export function ledgerOwed(view: FactorySupplierLedgerView | undefined): Decimal {
  return view ? toMoney(view.ledgerBalanceUsd) : ZERO;
}

/** An empty view for a supplier the engine did not return (no master in the company). */
export function emptyFactorySupplierLedgerView(supplierId: number): FactorySupplierLedgerView {
  return {
    supplierId,
    balanceBasis: "ledger",
    ledgerBalanceUsd: "0.00",
    ledgerBalanceSide: "Cr",
    openingBalanceUsd: "0.00",
    nativeBalances: [],
    ledgerFxUnresolved: false,
    notInLedger: { label: FACTORY_SUPPLIER_NOT_IN_LEDGER_LABEL, total: "0.00", unresolved: false, lines: [] },
  };
}

export interface FactorySupplierLedgerLine {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherType: string | null;
  /** COALESCE(effective_date, voucher_date), YYYY-MM-DD. */
  date: string;
  description: string;
  /** USD base (the engine's columns). */
  debitUsd: string;
  creditUsd: string;
  /** Native currency and amounts of the line. */
  currency: string;
  nativeDebit: string;
  nativeCredit: string;
  /** Cr positive, USD, after this line (opening included). */
  runningBalanceUsd: string;
}

/**
 * The supplier's ledger lines (exactly the lines the engine attributes to it),
 * oldest first, with a USD running balance from the ledger opening, so the
 * last running balance equals the view's ledgerBalanceUsd.
 */
export async function loadFactorySupplierLedgerLines(
  executor: DatabaseOrTransaction,
  companyId: number,
  supplierId: number,
  openingUsd: Decimal,
  asOf?: string | null
): Promise<FactorySupplierLedgerLine[]> {
  const owned = sql.raw(higherPriorityTargetsAbsent("ve", "factory_supplier_id"));
  const cut = asOf ? sql` AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}::date` : sql``;
  const result = await executor.execute<Record<string, unknown>>(sql`
    SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number, v.voucher_type,
           COALESCE(v.effective_date, v.voucher_date)::text AS booked_on,
           COALESCE(NULLIF(TRIM(ve.narration), ''), v.description, '') AS description,
           COALESCE(ve.debit_amount, 0)::text AS debit_usd, COALESCE(ve.credit_amount, 0)::text AS credit_usd,
           CASE WHEN NULLIF(ve.transaction_currency, '') IS NOT NULL AND ve.base_debit_amount IS NOT NULL
                     AND ve.base_credit_amount IS NOT NULL
                THEN UPPER(ve.transaction_currency) ELSE UPPER(COALESCE(NULLIF(v.currency, ''), 'USD')) END AS currency,
           COALESCE(ve.transaction_debit_amount, ve.debit_amount, 0)::text AS native_debit,
           COALESCE(ve.transaction_credit_amount, ve.credit_amount, 0)::text AS native_credit
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false${cut}
       AND ve.factory_supplier_id = ${supplierId} AND ${owned}
     ORDER BY COALESCE(v.effective_date, v.voucher_date), v.id, ve.id
  `);
  let running = openingUsd;
  return result.rows.map((row) => {
    const debit = toMoney(row.debit_usd as string);
    const credit = toMoney(row.credit_usd as string);
    running = running.plus(credit).minus(debit);
    return {
      entryId: Number(row.entry_id),
      voucherId: Number(row.voucher_id),
      voucherNumber: String(row.voucher_number ?? ""),
      voucherType: (row.voucher_type as string | null) ?? null,
      date: String(row.booked_on ?? "").slice(0, 10),
      description: String(row.description ?? ""),
      debitUsd: debit.toFixed(2),
      creditUsd: credit.toFixed(2),
      currency: String(row.currency ?? "USD"),
      nativeDebit: toMoney(row.native_debit as string).toFixed(2),
      nativeCredit: toMoney(row.native_credit as string).toFixed(2),
      runningBalanceUsd: running.toFixed(2),
    };
  });
}
