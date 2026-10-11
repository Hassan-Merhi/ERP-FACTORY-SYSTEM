/**
 * Net position reconciled to the balance sheet (accounting audit phase 27,
 * RP-12).
 *
 * The net position ("what we have − what we owe") is built from the ledger
 * plus valuation lines the ledger does not carry before the perpetual
 * cut-over: stock on the floor at its operational valuation, containers on the
 * way at their invoice total, prepaid rent and rent payable, and a supplier
 * partner's equity. This reconciliation states it as
 *
 *   net position = balance-sheet net assets (assets − liabilities)
 *                + each labelled memo line (not in the ledger)
 *                + the unexplained remainder (listed, never plugged),
 *
 * in exact decimals, so the two figures can be compared line by line. The
 * remainder is what the net position classifies differently from the balance
 * sheet (accounts it leaves out, such as the ledger's own inventory accounts
 * while the operational valuation replaces them, and currency translation in
 * the live view).
 */
import type Decimal from "decimal.js";

import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";
import { buildClassifiedBalanceSheet } from "./classifiedBalanceSheet";

export interface NetPositionMemoInput {
  label: string;
  /** Signed contribution to the net position (an asset positive, a liability negative). */
  amount: MoneyInput;
}

export interface NetPositionReconciliation {
  asOf: string;
  netPosition: string;
  balanceSheetNetAssets: string;
  memoLines: Array<{ label: string; amount: string }>;
  memoTotal: string;
  /** netPosition − (balance-sheet net assets + memo total). */
  unexplained: string;
  reconciled: boolean;
}

/** Net-position line codes and categories that are valuation lines, not ledger balances. */
export const NET_POSITION_MEMO_CODES: ReadonlySet<string> = new Set([
  "STOCK_OTW",
  "PREPAID_RENT",
  "RENT_PAYABLE",
  "COMPUTED",
]);
export const NET_POSITION_MEMO_CATEGORIES: ReadonlySet<string> = new Set([
  "Inventory",
  "In Transit",
  "Stock OTW",
  "Prepaid Rent",
  "Rent Payable",
]);

export function reconcileNetPosition(
  asOf: string,
  netPosition: MoneyInput,
  balanceSheetNetAssets: MoneyInput,
  memo: NetPositionMemoInput[]
): NetPositionReconciliation {
  const lines = memo
    .map((line) => ({ label: line.label, amount: toMoney(line.amount) }))
    .filter((line) => !line.amount.isZero());
  const memoTotal = lines.reduce((sum: Decimal, line) => sum.plus(line.amount), new MoneyDecimal(0));
  const position = toMoney(netPosition);
  const netAssets = toMoney(balanceSheetNetAssets);
  const unexplained = position.minus(netAssets).minus(memoTotal);
  return {
    asOf,
    netPosition: position.toFixed(2),
    balanceSheetNetAssets: netAssets.toFixed(2),
    memoLines: lines.map((line) => ({ label: line.label, amount: line.amount.toFixed(2) })),
    memoTotal: memoTotal.toFixed(2),
    unexplained: unexplained.toFixed(2),
    reconciled: unexplained.isZero(),
  };
}

interface NetPositionAccountLine {
  name?: string;
  label?: string;
  code?: string | null;
  value: number;
  category?: string;
}

/**
 * The memo lines of a net position's account lists: valuation lines by code
 * or category, assets (forUs) positive, liabilities (onUs) negative.
 */
export function netPositionMemoLines(
  forUs: readonly NetPositionAccountLine[],
  onUs: readonly NetPositionAccountLine[],
  equityContribution: number
): NetPositionMemoInput[] {
  const isMemo = (line: NetPositionAccountLine) =>
    (line.code != null && NET_POSITION_MEMO_CODES.has(line.code)) ||
    (line.category != null && NET_POSITION_MEMO_CATEGORIES.has(line.category));
  const label = (line: NetPositionAccountLine) =>
    `${line.label ?? line.name ?? line.code ?? "Line"} (memo, not in the ledger)`;
  // The lines arrive as the report's JavaScript numbers; String() keeps the
  // value the report printed and the sums below are exact.
  const memo: NetPositionMemoInput[] = [
    ...forUs.filter(isMemo).map((line) => ({ label: label(line), amount: String(line.value) })),
    ...onUs.filter(isMemo).map((line) => ({ label: label(line), amount: toMoney(String(line.value)).negated() })),
  ];
  if (equityContribution !== 0) {
    memo.push({ label: "Supplier-partner equity included in the net position", amount: String(equityContribution) });
  }
  return memo;
}

/** The reconciliation of a net position figure with its lists, as of a date. */
export async function reconcileNetPositionToBalanceSheet(
  companyId: number,
  asOf: string,
  netPosition: number,
  forUs: readonly NetPositionAccountLine[],
  onUs: readonly NetPositionAccountLine[],
  equityContribution = 0
): Promise<NetPositionReconciliation> {
  const sheet = await buildClassifiedBalanceSheet(companyId, asOf);
  return reconcileNetPosition(
    asOf,
    String(netPosition),
    sheet.totals.netAssets,
    netPositionMemoLines(forUs, onUs, equityContribution)
  );
}
