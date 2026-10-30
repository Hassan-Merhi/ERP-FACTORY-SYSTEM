/**
 * Phase 4: project verified live monetary USD translations onto a Net Position
 * response. Report-only: NEVER mutate a voucher, company currency or book data.
 *
 * Matching is by canonical ownership kind:id (not code/name). An account row
 * is replaced only when its signed book USD equals the valuation's historical
 * USD base to within display rounding. Unknown/mismatched rows are retained.
 */
import Decimal from "decimal.js";
import type { MonetaryFxValuationResult, MonetaryFxValuationRow } from "./monetaryFxValuationService";

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

type PositionSide = "forUs" | "onUs";
export function monetaryReportRowKey(row: MonetaryNetPositionAccount): string | null {
  if (row.partyKind === "customer" && Number.isSafeInteger(row.partyId)) return `customer:${row.partyId}`;
  if (row.partyKind === "bank" && Number.isSafeInteger(row.partyId)) return `bank:${row.partyId}`;
  if (row.bankAccountId != null && Number.isSafeInteger(row.bankAccountId)) return `bank:${row.bankAccountId}`;
  // A linked customer may also carry an id, but that ledger belongs to the
  // customer. Never match customer/employee/supplier parties to a ledger id.
  if (row.partyKind) return null;
  if (row.id != null && Number.isSafeInteger(row.id)) return `ledger:${row.id}`;
  return null;
}

const money = (x: Decimal.Value) => new Decimal(x).toDecimalPlaces(2).toNumber();

/** Display rounding tolerance between a report row and the valuation's book figure. */
const BOOK_MATCH_TOLERANCE = "0.03";

/**
 * A report row may present the same posted lines on either book basis: the
 * historical base amounts (6 dp, Net Position) or the posted debit/credit
 * amounts (2 dp per line, the balance engine's `closing` used by the Accounts
 * list, the Customers list and the Factory Net Position). Both are the same
 * ledger; neither is a translated figure. A row is replaced only when its
 * signed value equals one of them within display rounding.
 */
export function reportRowMatchesBook(signedRowValue: Decimal, val: MonetaryFxValuationRow): boolean {
  if (!signedRowValue.isFinite()) return false;
  const candidates = [val.historicalBaseUsd, val.bookClosingUsd];
  return candidates.some((book) => {
    if (book === null || book === undefined) return false;
    const decimal = new Decimal(book);
    return decimal.isFinite() && decimal.minus(signedRowValue).abs().lte(BOOK_MATCH_TOLERANCE);
  });
}

/**
 * The classifier labels a liability-type account (Loan/Loans) that is in debit
 * as "<type> Deposits" on the What We Have side. When a translated balance
 * moves a row to the other side, the category must follow the side.
 */
function categoryForSide(category: string | undefined, val: MonetaryFxValuationRow, side: PositionSide): string | undefined {
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
function adjustBreakdown(
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
function netPositionLabelFor(previous: string | undefined, netPosition: number): string {
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

/** Mutates only the caller's disposable/JSON-cloned report, not its cached source. */
export function applyVerifiedMonetaryFxOverlay(
  payload: MonetaryNetPositionPayload,
  valuation: MonetaryFxValuationResult
): MonetaryReportOverlayResult {
  const appliedKeys: string[] = [];
  const skipped: MonetaryReportOverlayDiagnostic[] = [];
  if (!payload?.forUs || !payload.onUs) {
    return { payload, appliedKeys, skipped, currentMonetaryTranslationDifferenceUsd: "0.000000", ledgerForUsDelta: 0, ledgerOnUsDelta: 0 };
  }
  const sides = { forUs: payload.forUs, onUs: payload.onUs };
  const totals = {
    forUs: new Decimal(payload.forUs.total ?? payload.forUsTotal ?? 0),
    onUs: new Decimal(payload.onUs.total ?? payload.onUsTotal ?? 0),
  };
  let appliedDifference = new Decimal(0);
  let ledgerForUsDelta = new Decimal(0);
  let ledgerOnUsDelta = new Decimal(0);
  const breakdownDeltas = { forUs: new Map<string, Decimal>(), onUs: new Map<string, Decimal>() };
  const moveBreakdown = (side: PositionSide, category: string | undefined, delta: Decimal) => {
    const name = category || "Other";
    breakdownDeltas[side].set(name, (breakdownDeltas[side].get(name) ?? new Decimal(0)).plus(delta));
  };
  for (const val of valuation.accounts) {
    if (val.eligibility === "needs_review") continue;
    const current = val.currentTranslatedUsd;
    if (val.provisional || current === null || val.historicalBaseUsd === null) {
      skipped.push({ key: val.accountKey, reason: "unresolved" });
      continue;
    }
    const matches: Array<{ side: PositionSide; row: MonetaryNetPositionAccount }> = [];
    for (const side of ["forUs", "onUs"] as const) {
      for (const row of sides[side].accounts) {
        if (monetaryReportRowKey(row) === val.accountKey) matches.push({ side, row });
      }
    }
    if (matches.length !== 1) {
      skipped.push({ key: val.accountKey, reason: matches.length ? "duplicate_report_row" : "missing_in_report" });
      continue;
    }
    const { side: oldSide, row: oldRow } = matches[0];
    const signedOld = new Decimal(oldRow.value).mul(oldSide === "forUs" ? 1 : -1);
    const historical = new Decimal(val.historicalBaseUsd);
    // Net Position can use different book attribution for old unmatched rows
    // or supplier-partner custom exclusions. Never silently overwrite those.
    if (!reportRowMatchesBook(signedOld, val)) {
      skipped.push({ key: val.accountKey, reason: "historical_usd_mismatch" });
      continue;
    }
    const translated = new Decimal(current);
    if (!translated.isFinite()) {
      skipped.push({ key: val.accountKey, reason: "unresolved" });
      continue;
    }
    sides[oldSide].accounts = sides[oldSide].accounts.filter((row) => row !== oldRow);
    totals[oldSide] = totals[oldSide].minus(oldRow.value);
    moveBreakdown(oldSide, oldRow.category, new Decimal(oldRow.value).negated());
    if (val.accountKind !== "customer") {
      if (oldSide === "forUs") ledgerForUsDelta = ledgerForUsDelta.minus(oldRow.value);
      else ledgerOnUsDelta = ledgerOnUsDelta.minus(oldRow.value);
    }
    if (!translated.isZero()) {
      const targetSide: PositionSide = translated.gte(0) ? "forUs" : "onUs";
      const value = money(translated.abs());
      const category = oldRow.category !== undefined ? categoryForSide(oldRow.category, val, targetSide) : undefined;
      moveBreakdown(targetSide, category, new Decimal(value));
      sides[targetSide].accounts.push({
        ...oldRow,
        ...(category !== undefined ? { category } : {}),
        value,
        currencyRevalued: true,
        monetaryFxCategory: val.category,
        nativeBalancesByCurrency: val.nativeBalancesByCurrency,
        historicalBaseBalance: val.historicalBaseUsd,
        currentTranslatedBaseBalance: current,
        translationDifference: val.translationDifferenceUsd,
      });
      totals[targetSide] = totals[targetSide].plus(value);
      if (val.accountKind !== "customer") {
        if (targetSide === "forUs") ledgerForUsDelta = ledgerForUsDelta.plus(value);
        else ledgerOnUsDelta = ledgerOnUsDelta.plus(value);
      }
    }
    appliedDifference = appliedDifference.plus(translated.minus(historical));
    appliedKeys.push(val.accountKey);
  }

  // No successful replacements: preserve the source report exactly, including
  // specialized operational breakdowns, labels and signed category rules.
  if (appliedKeys.length === 0) {
    return { payload, appliedKeys, skipped, currentMonetaryTranslationDifferenceUsd: "0.000000", ledgerForUsDelta: 0, ledgerOnUsDelta: 0 };
  }
  for (const side of ["forUs", "onUs"] as const) {
    const entry = sides[side];
    entry.total = money(totals[side]);
    entry.accounts = entry.accounts
      .filter((row) => Math.abs(row.value) >= 0.005)
      .sort((a, b) => b.value - a.value);
    entry.breakdown = adjustBreakdown(entry.breakdown, breakdownDeltas[side]);
  }
  payload.forUsTotal = sides.forUs.total;
  payload.onUsTotal = sides.onUs.total;
  // Supplier-partner reports include equity in the net position; the
  // translation must not erase that contribution.
  const equityContribution = payload.equity?.includedInNetPosition === true
    ? new Decimal(payload.equity.total ?? 0) : new Decimal(0);
  const netPosition = money(totals.forUs.minus(totals.onUs).plus(equityContribution));
  payload.netPosition = netPosition;
  payload.netWorth = netPosition;
  payload.netPositionLabel = netPositionLabelFor(payload.netPositionLabel, netPosition);
  if (payload.netPositionBreakdown) {
    for (const [side, breakdownKey] of [["forUs", "assets"], ["onUs", "liabilities"]] as const) {
      const breakdown = payload.netPositionBreakdown[breakdownKey];
      if (breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)) {
        Object.assign(breakdown, { total: sides[side].total, breakdown: sides[side].breakdown });
      }
    }
    payload.netPositionBreakdown.netPosition = payload.netPosition;
  }
  return {
    payload,
    appliedKeys,
    skipped,
    currentMonetaryTranslationDifferenceUsd: appliedDifference.toDecimalPlaces(6).toFixed(6),
    ledgerForUsDelta: money(ledgerForUsDelta),
    ledgerOnUsDelta: money(ledgerOnUsDelta),
  };
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
  }
>(
  rows: T[],
  valuation: MonetaryFxValuationResult
): Array<T & {
  historicalBalanceUsd?: string;
  currentTranslatedUsd?: string;
  nativeBalancesByCurrency?: Record<string, string>;
  monetaryFxProvisional?: boolean;
  currencyRevalued?: boolean;
}> {
  const valuations = new Map(valuation.accounts.map((v) => [v.accountKey, v]));
  return rows.map((row) => {
    const key = row.type === "bank" ? `bank:${row.accountId}`
      : row.type === "ledger" && row.customerId != null ? `customer:${row.customerId}`
      : row.type === "ledger" ? `ledger:${row.accountId}` : null;
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
  T extends { id: number; balance: number; balanceSide: string; notInLedgerTotal?: number; heldUnfinalizedCharges?: number }
>(
  rows: T[],
  valuation: MonetaryFxValuationResult
): Array<T & {
  historicalBalanceUsd?: string;
  currentTranslatedUsd?: string;
  nativeBalancesByCurrency?: Record<string, string>;
  monetaryFxProvisional?: boolean;
  currencyRevalued?: boolean;
}> {
  const customers = new Map(
    valuation.accounts.filter((val) => val.accountKind === "customer")
      .map((val) => [val.id, val])
  );
  return rows.map((row) => {
    const val = customers.get(row.id);
    if (!val) return row;
    if (
      val.provisional || val.currentTranslatedUsd === null || val.historicalBaseUsd === null ||
      Math.abs(row.notInLedgerTotal ?? 0) >= 0.005 ||
      Math.abs(row.heldUnfinalizedCharges ?? 0) >= 0.005
    ) return { ...row, monetaryFxProvisional: true };
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
      ...("ledgerBalance" in row ? {
        ledgerBalance: nextBalance,
        ledgerBalanceSide: nextSide,
        generalLedgerBalance: nextBalance,
        generalLedgerBalanceSide: nextSide,
      } : {}),
      historicalBalanceUsd: signedBook.toDecimalPlaces(6).toFixed(6),
      currentTranslatedUsd: val.currentTranslatedUsd,
      nativeBalancesByCurrency: val.nativeBalancesByCurrency,
      currencyRevalued: true,
    };
  });
}

/**
 * Balance Sheet (/api/reports/balance-sheet, current, no as-of date): the
 * statement is built on the trial balance, so every monetary line replaced by
 * its current-rate USD must be balanced by a reporting-only equity line of the
 * same total ("Unrealized FX translation"). Nothing is posted: the line is a
 * presentation of translation differences that a later, separately designed
 * FX gain/loss journal might book. `difference` (the trial balance's own
 * unexplained difference) is unchanged by construction.
 */
export interface MonetaryBalanceSheetLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  balance: string;
  currencyRevalued?: boolean;
  monetaryFxCategory?: string;
  historicalBookUsd?: string;
  currentTranslatedUsd?: string;
  nativeBalancesByCurrency?: Record<string, string>;
  journalPosted?: boolean;
}
export interface MonetaryBalanceSheetPayload {
  asOfDate: string | null;
  assets: { lines: MonetaryBalanceSheetLine[]; total: string };
  liabilities: { lines: MonetaryBalanceSheetLine[]; total: string };
  equity: { lines: MonetaryBalanceSheetLine[]; currentEarnings: string; total: string };
  unclassified: { lines: MonetaryBalanceSheetLine[]; total: string };
  difference: string;
  balanced: boolean;
}
export const BALANCE_SHEET_FX_TRANSLATION_CODE = "FX_TRANSLATION_CURRENT_RATE";
export const BALANCE_SHEET_FX_TRANSLATION_NAME =
  "Unrealized FX translation (current rate, reporting only, not posted)";

export interface MonetaryBalanceSheetOverlayResult {
  payload: MonetaryBalanceSheetPayload;
  appliedKeys: string[];
  skipped: MonetaryReportOverlayDiagnostic[];
  translationDifferenceUsd: string;
}

function balanceSheetLineKey(line: MonetaryBalanceSheetLine): string | null {
  if (line.id === null || !Number.isSafeInteger(line.id)) return null;
  if (line.kind === "ledger" || line.kind === "bank" || line.kind === "customer") return `${line.kind}:${line.id}`;
  return null;
}

export function applyCurrentBalanceSheetFxOverlay(
  payload: MonetaryBalanceSheetPayload,
  valuation: MonetaryFxValuationResult
): MonetaryBalanceSheetOverlayResult {
  const appliedKeys: string[] = [];
  const skipped: MonetaryReportOverlayDiagnostic[] = [];
  const none = (): MonetaryBalanceSheetOverlayResult => ({
    payload, appliedKeys, skipped, translationDifferenceUsd: "0.000000",
  });
  if (payload.asOfDate || !payload.assets || !payload.liabilities || !payload.equity) return none();
  const sum = (lines: MonetaryBalanceSheetLine[]) =>
    lines.reduce((total, line) => total.plus(line.balance), new Decimal(0));
  const assets = [...payload.assets.lines];
  const liabilities = [...payload.liabilities.lines];
  let difference = new Decimal(0);
  for (const val of valuation.accounts) {
    if (val.eligibility === "needs_review") continue;
    if (val.provisional || val.currentTranslatedUsd === null || val.historicalBaseUsd === null) {
      skipped.push({ key: val.accountKey, reason: "unresolved" });
      continue;
    }
    const matches: Array<{ side: "assets" | "liabilities"; line: MonetaryBalanceSheetLine }> = [];
    for (const line of assets) if (balanceSheetLineKey(line) === val.accountKey) matches.push({ side: "assets", line });
    for (const line of liabilities) if (balanceSheetLineKey(line) === val.accountKey) matches.push({ side: "liabilities", line });
    if (matches.length !== 1) {
      skipped.push({ key: val.accountKey, reason: matches.length ? "duplicate_report_row" : "missing_in_report" });
      continue;
    }
    const { side, line } = matches[0];
    const signedBook = new Decimal(line.balance).mul(side === "assets" ? 1 : -1);
    if (!reportRowMatchesBook(signedBook, val)) {
      skipped.push({ key: val.accountKey, reason: "historical_usd_mismatch" });
      continue;
    }
    const translated = new Decimal(val.currentTranslatedUsd);
    if (!translated.isFinite()) {
      skipped.push({ key: val.accountKey, reason: "unresolved" });
      continue;
    }
    const remove = (list: MonetaryBalanceSheetLine[]) => list.splice(list.indexOf(line), 1);
    remove(side === "assets" ? assets : liabilities);
    // The displayed (2 dp) figure is what the equity line must balance.
    const displayed = translated.toDecimalPlaces(2);
    const replaced: MonetaryBalanceSheetLine = {
      ...line,
      balance: displayed.abs().toFixed(2),
      currencyRevalued: true,
      monetaryFxCategory: val.category,
      historicalBookUsd: signedBook.toDecimalPlaces(2).toFixed(2),
      currentTranslatedUsd: val.currentTranslatedUsd,
      nativeBalancesByCurrency: val.nativeBalancesByCurrency,
    };
    if (!displayed.isZero()) (displayed.gte(0) ? assets : liabilities).push(replaced);
    difference = difference.plus(displayed.minus(signedBook));
    appliedKeys.push(val.accountKey);
  }
  if (appliedKeys.length === 0) return none();

  const equityLines = [...payload.equity.lines];
  const rounded = difference.toDecimalPlaces(2);
  if (!rounded.isZero()) {
    equityLines.push({
      kind: "fxTranslation",
      id: null,
      code: BALANCE_SHEET_FX_TRANSLATION_CODE,
      name: BALANCE_SHEET_FX_TRANSLATION_NAME,
      accountType: "Equity",
      balance: rounded.toFixed(2),
      currencyRevalued: true,
      journalPosted: false,
    });
  }
  const assetsTotal = sum(assets);
  const liabilitiesTotal = sum(liabilities);
  const equityTotal = sum(equityLines).plus(payload.equity.currentEarnings);
  const unclassifiedTotal = new Decimal(payload.unclassified?.total ?? 0);
  const nextDifference = assetsTotal.minus(liabilitiesTotal).minus(equityTotal).minus(unclassifiedTotal);
  return {
    payload: {
      ...payload,
      assets: { ...payload.assets, lines: assets, total: assetsTotal.toFixed(2) },
      liabilities: { ...payload.liabilities, lines: liabilities, total: liabilitiesTotal.toFixed(2) },
      equity: { ...payload.equity, lines: equityLines, total: equityTotal.toFixed(2) },
      // The trial balance's own unexplained difference is untouched: the
      // equity line above balances every replaced monetary line exactly.
      difference: nextDifference.toFixed(2),
      balanced: nextDifference.isZero(),
    },
    appliedKeys,
    skipped,
    translationDifferenceUsd: difference.toDecimalPlaces(6).toFixed(6),
  };
}
