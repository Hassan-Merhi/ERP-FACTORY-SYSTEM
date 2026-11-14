/** Balance-sheet FX display translation; never posts journals or vouchers. */
import Decimal from "decimal.js";
import type { MonetaryFxValuationResult } from "./monetaryFxValuationService";
import type { MonetaryReportOverlayDiagnostic } from "./monetaryFxReportOverlay";
import { reportRowMatchesBook } from "./monetaryFxBookMatch";

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
