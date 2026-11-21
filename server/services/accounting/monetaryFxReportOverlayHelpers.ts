// Extracted from ./monetaryFxReportOverlay.ts
import Decimal from "decimal.js";
import type { MonetaryFxValuationResult, MonetaryFxValuationRow } from "./monetaryFxValuationService";
import { BOOK_MATCH_TOLERANCE, reportRowMatchesBook } from "./monetaryFxBookMatch";

export type MonetaryNetPositionAccount = {
  id?: number;
  bankAccountId?: number;
  partyKind?: string;
  partyId?: number | null;
  name: string;
  code?: string | null;
  category?: string;
  value: number;
  currencyRevalued?: boolean;
  [key: string]: unknown;
};

export type MonetaryNetPositionSide = {
  accounts: MonetaryNetPositionAccount[];
  total: number;
  breakdown?: Array<{ name: string; value: number }>;
};

export type MonetaryNetPositionPayload = {
  forUs?: MonetaryNetPositionSide;
  onUs?: MonetaryNetPositionSide;
  forUsTotal?: number;
  onUsTotal?: number;
  netPosition?: number;
  netWorth?: number;
  netPositionLabel?: string;
  equity?: { total?: number; includedInNetPosition?: boolean };
  netPositionBreakdown?: Record<string, unknown>;
  currency?: Record<string, unknown>;
  currencyRevaluation?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PositionSide = "forUs" | "onUs";

export const money = (x: Decimal.Value) => new Decimal(x).toDecimalPlaces(2).toNumber();

/**
 * The classifier labels a liability-type account (Loan/Loans) that is in debit
 * as "<type> Deposits" on the What We Have side. When a translated balance
 * moves a row to the other side, the category must follow the side.
 */
export function categoryForSide(
  category: string | undefined,
  val: MonetaryFxValuationRow,
  side: PositionSide
): string | undefined {
  if (!category) return category;
  const suffix = " Deposits";
  if (side === "onUs" && category.endsWith(suffix)) return category.slice(0, -suffix.length);
  if (side === "forUs" && val.category === "loan" && !category.endsWith(suffix)) return `${category}${suffix}`;
  return category;
}

/**
 * Adjusts a side's category breakdown in place: the report's own breakdown
 * names (which can differ from account categories for computed stock lines)
 * are kept; only the categories of replaced rows move by their deltas.
 */
export function adjustBreakdown(
  breakdown: Array<{ name: string; value: number }> | undefined,
  deltas: Map<string, Decimal>
): Array<{ name: string; value: number }> | undefined {
  if (!breakdown) return breakdown;
  const next = breakdown.map((entry) => ({ ...entry }));
  for (const [name, delta] of deltas) {
    if (delta.isZero()) continue;
    const entry = next.find((candidate) => candidate.name === name);
    if (entry) entry.value = money(new Decimal(entry.value).plus(delta));
    else next.push({ name, value: money(delta) });
  }
  return next.filter((entry) => Math.abs(entry.value) >= 0.005).sort((a, b) => b.value - a.value);
}

/** Keeps the report's own label vocabulary ("We have more than we owe" / "Net Assets"). */
export function netPositionLabelFor(previous: string | undefined, netPosition: number): string {
  const owe = /we owe more|we have more/i.test(previous ?? "");
  if (owe) return netPosition >= 0 ? "We have more than we owe" : "We owe more than we have";
  return netPosition >= 0 ? "Net Assets" : "Net Liabilities";
}

export interface MonetaryReportOverlayDiagnostic {
  key: string;
  reason: "unresolved" | "missing_in_report" | "duplicate_report_row" | "historical_usd_mismatch";
}

export interface MonetaryReportOverlayResult {
  payload: MonetaryNetPositionPayload;
  appliedKeys: string[];
  skipped: MonetaryReportOverlayDiagnostic[];
  currentMonetaryTranslationDifferenceUsd: string;
  ledgerForUsDelta: number;
  ledgerOnUsDelta: number;
}

/**
 * Decorate current Accounts-list rows with translated USD, preserving the
 * native/report metadata. Do not transform date-scoped or period rows.
 * linked-customer ledgers use customer:id; noncash fixed assets are excluded.
 */
export function applyCurrentAccountsFxOverlay<
  T extends {
    type: string;
    accountId: number;
    customerId?: number | null;
    balance: string;
    balanceSide: string;
    /** Customer-linked rows: the Parties display projection the Accounts page shows instead of `balance`. */
    partyBalance?: string;
    partyBalanceSide?: string;
    partyLedgerBalance?: string;
    notInLedgerTotal?: string | number;
    heldUnfinalizedCharges?: number;
  },
>(
  rows: T[],
  valuation: MonetaryFxValuationResult
): Array<
  T & {
    historicalBalanceUsd?: string;
    currentTranslatedUsd?: string;
    nativeBalancesByCurrency?: Record<string, string>;
    monetaryFxProvisional?: boolean;
    currencyRevalued?: boolean;
  }
> {
  const valuations = new Map(valuation.accounts.map((v) => [v.accountKey, v]));
  return rows.map((row) => {
    const key =
      row.type === "bank"
        ? `bank:${row.accountId}`
        : row.type === "ledger" && row.customerId != null
          ? `customer:${row.customerId}`
          : row.type === "ledger"
            ? `ledger:${row.accountId}`
            : null;
    if (!key) return row;
    const val: MonetaryFxValuationRow | undefined = valuations.get(key);
    if (!val || val.eligibility === "needs_review") return row;
    if (val.provisional || val.currentTranslatedUsd === null || val.historicalBaseUsd === null) {
      return { ...row, monetaryFxProvisional: true };
    }
    const book = new Decimal(row.balance).mul(row.balanceSide === "Cr" ? -1 : 1);
    if (!reportRowMatchesBook(book, val)) {
      return { ...row, monetaryFxProvisional: true };
    }
    // A customer-linked row is DISPLAYED through its Parties projection
    // (partyBalance), which can include operational amounts not yet in the
    // ledger and held unfinalized charges. Those have no single proven original
    // currency: when they are present the row keeps its book figures and is
    // marked provisional; otherwise the projection follows the ledger.
    if (row.partyBalance !== undefined) {
      const memo = new Decimal(row.notInLedgerTotal ?? 0);
      const held = new Decimal(row.heldUnfinalizedCharges ?? 0);
      const party = new Decimal(row.partyBalance).mul(row.partyBalanceSide === "Cr" ? -1 : 1);
      if (!memo.abs().lt("0.005") || !held.abs().lt("0.005") || !party.minus(book).abs().lte(BOOK_MATCH_TOLERANCE)) {
        return { ...row, monetaryFxProvisional: true };
      }
    }
    const current = new Decimal(val.currentTranslatedUsd);
    const balance = current.abs().toDecimalPlaces(2).toFixed(2);
    const balanceSide = current.isNegative() ? "Cr" : "Dr";
    return {
      ...row,
      historicalBalanceUsd: book.toDecimalPlaces(6).toFixed(6),
      balance,
      balanceSide,
      ...(row.partyBalance !== undefined
        ? { partyBalance: balance, partyBalanceSide: balanceSide, partyLedgerBalance: balance }
        : {}),
      currentTranslatedUsd: val.currentTranslatedUsd,
      nativeBalancesByCurrency: val.nativeBalancesByCurrency,
      currencyRevalued: true,
    };
  });
}

/**
 * Customer-list/Factory Parties presentation projection. It cannot reprice
 * nonledger operational memos or held-unfinalized charges; those rows keep
 * their existing historical USD and expose provisional metadata.
 */
export function applyCurrentCustomerFxOverlay<
  T extends {
    id: number;
    balance: number;
    balanceSide: string;
    notInLedgerTotal?: number;
    heldUnfinalizedCharges?: number;
  },
>(
  rows: T[],
  valuation: MonetaryFxValuationResult
): Array<
  T & {
    historicalBalanceUsd?: string;
    currentTranslatedUsd?: string;
    nativeBalancesByCurrency?: Record<string, string>;
    monetaryFxProvisional?: boolean;
    currencyRevalued?: boolean;
  }
> {
  const customers = new Map(
    valuation.accounts.filter((val) => val.accountKind === "customer").map((val) => [val.id, val])
  );
  return rows.map((row) => {
    const val = customers.get(row.id);
    if (!val) return row;
    if (
      val.provisional ||
      val.currentTranslatedUsd === null ||
      val.historicalBaseUsd === null ||
      Math.abs(row.notInLedgerTotal ?? 0) >= 0.005 ||
      Math.abs(row.heldUnfinalizedCharges ?? 0) >= 0.005
    )
      return { ...row, monetaryFxProvisional: true };
    const signedBook = new Decimal(row.balance).mul(row.balanceSide === "Cr" ? -1 : 1);
    if (!reportRowMatchesBook(signedBook, val)) {
      return { ...row, monetaryFxProvisional: true };
    }
    const translated = new Decimal(val.currentTranslatedUsd);
    const nextBalance = translated.abs().toDecimalPlaces(2).toNumber();
    const nextSide = translated.isNegative() ? "Cr" : "Dr";
    return {
      ...row,
      balance: nextBalance,
      balanceSide: nextSide,
      // Factory Party ledger components share this single book ownership;
      // operational memo stays zero on the eligible path.
      ...("ledgerBalance" in row
        ? {
            ledgerBalance: nextBalance,
            ledgerBalanceSide: nextSide,
            generalLedgerBalance: nextBalance,
            generalLedgerBalanceSide: nextSide,
          }
        : {}),
      historicalBalanceUsd: signedBook.toDecimalPlaces(6).toFixed(6),
      currentTranslatedUsd: val.currentTranslatedUsd,
      nativeBalancesByCurrency: val.nativeBalancesByCurrency,
      currencyRevalued: true,
    };
  });
}
