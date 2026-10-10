/**
 * A customer's figures on the factory customer pages (accounting audit wave 10).
 *
 * The ledger balance comes from the one balance engine
 * (services/accounting/balances/ledgerBalanceEngine.ts), on the trial
 * balance's rules. Amounts that never reached the ledger — factory invoices
 * finalized before the perpetual cut-over or in another currency, factory POS
 * credit sales and deposits, other cache-only customer_balances rows — are the
 * engine's memo lines (balances/unpostedMemo.ts), reported separately.
 *
 * These pages used to add those operational amounts into one balance. For
 * backward compatibility `balance` / `balanceSide` keep that combined meaning
 * (what the customer owes including the amounts not yet in the ledger) and are
 * now computed as ledger balance + memo total, labelled by `balanceBasis`; the
 * split is in `ledgerBalance` / `ledgerBalanceSide` and `notInLedgerTotal`.
 */
import type Decimal from "decimal.js";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getPartyBalances, type PartyBalanceMemoLine } from "../../../services/accounting/balances/ledgerBalanceEngine";

export interface CustomerLedgerAndMemo {
  /** Engine closing, debit positive. */
  ledger: Decimal;
  /** Engine opening (customer record), debit positive. */
  masterOpening: Decimal;
  /** Sum of the memo lines with a USD amount, debit positive. */
  memoTotal: Decimal;
  memoLines: PartyBalanceMemoLine[];
}

const ZERO = new MoneyDecimal(0);

/** Ledger closing and memo lines of the given customers of a company, as of a day (all posted without). */
export async function getCustomerLedgerAndMemo(
  companyId: number,
  ids: readonly number[],
  asOf?: string | null
): Promise<Map<number, CustomerLedgerAndMemo>> {
  const out = new Map<number, CustomerLedgerAndMemo>();
  if (ids.length === 0) return out;
  const { parties } = await getPartyBalances(db, { companyId, kind: "customer", ids, asOf, memo: true });
  for (const party of parties) {
    if (party.id === null) continue;
    out.set(party.id, {
      ledger: toMoney(party.closing),
      masterOpening: toMoney(party.masterOpening),
      memoTotal: toMoney(party.memoTotal),
      memoLines: party.memoLines,
    });
  }
  return out;
}

function sideOf(value: Decimal): "Dr" | "Cr" {
  return value.isNegative() && !value.isZero() ? "Cr" : "Dr";
}

/** The response fields of a customer: combined balance (labelled) plus the split. */
export function splitBalanceFields(figures: CustomerLedgerAndMemo | undefined) {
  const ledger = figures?.ledger ?? ZERO;
  const memo = figures?.memoTotal ?? ZERO;
  const combined = ledger.plus(memo);
  return {
    /** Combined: ledger balance + amounts not yet in the ledger (backward-compatible meaning). */
    balance: combined.abs().toNumber(),
    balanceSide: sideOf(combined),
    balanceBasis: "ledger+notInLedger" as const,
    ledgerBalance: ledger.abs().toNumber(),
    ledgerBalanceSide: sideOf(ledger),
    /** Debit positive. */
    notInLedgerTotal: memo.toNumber(),
    notInLedgerCount: figures?.memoLines.length ?? 0,
  };
}
