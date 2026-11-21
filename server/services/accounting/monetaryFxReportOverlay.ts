/**
 * Phase 4: project verified live monetary USD translations onto a Net Position
 * response. Report-only: NEVER mutate a voucher, company currency or book data.
 *
 * Matching is by canonical ownership kind:id (not code/name). An account row
 * is replaced only when its signed book USD equals the valuation's historical
 * USD base to within display rounding. Unknown/mismatched rows are retained.
 */
import Decimal from "decimal.js";
import type { MonetaryFxValuationResult } from "./monetaryFxValuationService";
import { reportRowMatchesBook } from "./monetaryFxBookMatch";
import {
  money,
  categoryForSide,
  adjustBreakdown,
  netPositionLabelFor,
  type MonetaryNetPositionAccount,
  type MonetaryNetPositionPayload,
  type PositionSide,
  type MonetaryReportOverlayDiagnostic,
  type MonetaryReportOverlayResult,
} from "./monetaryFxReportOverlayHelpers";
export {
  applyCurrentAccountsFxOverlay,
  applyCurrentCustomerFxOverlay,
  type MonetaryNetPositionAccount,
  type MonetaryNetPositionSide,
  type MonetaryNetPositionPayload,
  type MonetaryReportOverlayDiagnostic,
  type MonetaryReportOverlayResult,
} from "./monetaryFxReportOverlayHelpers";

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

/** Mutates only the caller's disposable/JSON-cloned report, not its cached source. */
export function applyVerifiedMonetaryFxOverlay(
  payload: MonetaryNetPositionPayload,
  valuation: MonetaryFxValuationResult,
  options: { showFxAsRows?: boolean; skipAccountKeys?: ReadonlySet<string> } = {}
): MonetaryReportOverlayResult {
  const appliedKeys: string[] = [];
  const skipped: MonetaryReportOverlayDiagnostic[] = [];
  if (!payload?.forUs || !payload.onUs) {
    return {
      payload,
      appliedKeys,
      skipped,
      currentMonetaryTranslationDifferenceUsd: "0.000000",
      ledgerForUsDelta: 0,
      ledgerOnUsDelta: 0,
    };
  }
  const sides = { forUs: payload.forUs, onUs: payload.onUs };
  const totals = {
    forUs: new Decimal(payload.forUs.total ?? payload.forUsTotal ?? 0),
    onUs: new Decimal(payload.onUs.total ?? payload.onUsTotal ?? 0),
  };
  let appliedDifference = new Decimal(0);
  let ledgerForUsDelta = new Decimal(0);
  let ledgerOnUsDelta = new Decimal(0);
  // The Net Position option exposes one actual FX Gain/Loss account row per
  // side, keeping the historic original accounts untouched. Source balances
  // plus these signed currency deltas equal the same current-rate Net Position
  // as the existing replacement projection; there is no double counting.
  const fxAccountRows = {
    gain: {
      total: new Decimal(0),
      breakdown: [] as Array<{ label: string; native: string; usd: number; sourceKey?: string }>,
    },
    loss: {
      total: new Decimal(0),
      breakdown: [] as Array<{ label: string; native: string; usd: number; sourceKey?: string }>,
    },
  };
  const breakdownDeltas = { forUs: new Map<string, Decimal>(), onUs: new Map<string, Decimal>() };
  const moveBreakdown = (side: PositionSide, category: string | undefined, delta: Decimal) => {
    const name = category || "Other";
    breakdownDeltas[side].set(name, (breakdownDeltas[side].get(name) ?? new Decimal(0)).plus(delta));
  };
  for (const val of valuation.accounts) {
    if (options.skipAccountKeys?.has(val.accountKey)) continue;
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
    // In itemized mode the original monetary row stays at its book amount,
    // so balance-matching alone would allow a second projection to post the
    // same display FX delta again. Enforce read-time idempotence explicitly.
    if (options.showFxAsRows && oldRow.currencyRevalued) continue;
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
    if (options.showFxAsRows) {
      // Net Position's source cash row can be built from six-decimal base
      // amounts, while the ledger balance engine uses posted debit/credit
      // cents. After an actual FX revaluation, the translated balance can
      // ALREADY equal posted ledger cents, even though the source book row
      // differs by 1 cent. That difference is not another unrealized FX gain.
      // In this narrowly reconciled case move the cent to its actual cash
      // account instead of inventing a synthetic FX Gain/Loss row.
      const postedBook = new Decimal(val.bookClosingUsd);
      const translatedCents = translated.toDecimalPlaces(2);
      const postedCents = postedBook.toDecimalPlaces(2);
      let displayedBook = signedOld;
      if (
        translatedCents.eq(postedCents) &&
        !signedOld.eq(postedCents) &&
        postedCents.abs().gt(0) &&
        postedCents.isPositive() === signedOld.isPositive()
      ) {
        const newValue = money(postedCents.abs());
        const oldValue = oldRow.value;
        const displayDelta = new Decimal(newValue).minus(oldValue);
        oldRow.value = newValue;
        totals[oldSide] = totals[oldSide].plus(displayDelta);
        moveBreakdown(oldSide, oldRow.category, displayDelta);
        if (val.accountKind !== "customer") {
          if (oldSide === "forUs") ledgerForUsDelta = ledgerForUsDelta.plus(displayDelta);
          else ledgerOnUsDelta = ledgerOnUsDelta.plus(displayDelta);
        }
        displayedBook = postedCents;
      }
      // Remaining FX is only the translation difference after posted-book
      // reconciliation, never the six-decimal-vs-two-decimal book variance.
      const visibleDifference = money(translated.minus(displayedBook));
      if (Math.abs(visibleDifference) >= 0.005) {
        const gain = visibleDifference > 0;
        const bucket = gain ? fxAccountRows.gain : fxAccountRows.loss;
        bucket.total = bucket.total.plus(Math.abs(visibleDifference));
        const native = Object.entries(val.nativeBalancesByCurrency)
          .filter(([currency, amount]) => currency !== "USD" && !new Decimal(amount).isZero())
          .map(([currency, amount]) => `${amount} ${currency}`)
          .join(", ");
        bucket.breakdown.push({
          label: `${val.accountKind === "customer" ? "Customer" : val.category === "loan" ? "Loan" : "Account"}: ${oldRow.name}`,
          native,
          usd: Math.abs(visibleDifference),
          sourceKey: val.accountKey,
        });
      }
      oldRow.currencyRevalued = true;
      oldRow.monetaryFxCategory = val.category;
      oldRow.nativeBalancesByCurrency = val.nativeBalancesByCurrency;
      oldRow.historicalBaseBalance = val.historicalBaseUsd;
      oldRow.currentTranslatedBaseBalance = current;
      oldRow.translationDifference = val.translationDifferenceUsd;
      appliedDifference = appliedDifference.plus(translated.minus(historical));
      appliedKeys.push(val.accountKey);
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
    return {
      payload,
      appliedKeys,
      skipped,
      currentMonetaryTranslationDifferenceUsd: "0.000000",
      ledgerForUsDelta: 0,
      ledgerOnUsDelta: 0,
    };
  }
  if (options.showFxAsRows) {
    for (const [side, bucket, code, name, category] of [
      ["forUs", fxAccountRows.gain, "FX_UNREALIZED_GAIN", "Unrealized FX Gains", "Exchange Rate Gains"],
      ["onUs", fxAccountRows.loss, "FX_UNREALIZED_LOSS", "Unrealized FX Losses", "Exchange Rate Losses"],
    ] as const) {
      const amount = money(bucket.total);
      if (amount < 0.005) continue;
      const existing = sides[side].accounts.find((row) => row.code === code);
      if (existing) {
        existing.value = money(new Decimal(existing.value).plus(amount));
        const previous = Array.isArray(existing.breakdown)
          ? (existing.breakdown as Array<{ label: string; native: string; usd: number }>)
          : [];
        existing.breakdown = [...previous, ...bucket.breakdown];
      } else {
        sides[side].accounts.push({ name, code, category, value: amount, breakdown: bucket.breakdown });
      }
      totals[side] = totals[side].plus(amount);
      moveBreakdown(side, category, new Decimal(amount));
    }
  }
  for (const side of ["forUs", "onUs"] as const) {
    const entry = sides[side];
    entry.total = money(totals[side]);
    entry.accounts = entry.accounts.filter((row) => Math.abs(row.value) >= 0.005).sort((a, b) => b.value - a.value);
    entry.breakdown = adjustBreakdown(entry.breakdown, breakdownDeltas[side]);
  }
  payload.forUsTotal = sides.forUs.total;
  payload.onUsTotal = sides.onUs.total;
  // Supplier-partner reports include equity in the net position; the
  // translation must not erase that contribution.
  const equityContribution =
    payload.equity?.includedInNetPosition === true ? new Decimal(payload.equity.total ?? 0) : new Decimal(0);
  const netPosition = money(totals.forUs.minus(totals.onUs).plus(equityContribution));
  payload.netPosition = netPosition;
  payload.netWorth = netPosition;
  payload.netPositionLabel = netPositionLabelFor(payload.netPositionLabel, netPosition);
  if (payload.netPositionBreakdown) {
    for (const [side, breakdownKey] of [
      ["forUs", "assets"],
      ["onUs", "liabilities"],
    ] as const) {
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

export { reportRowMatchesBook } from "./monetaryFxBookMatch";
export {
  applyCurrentBalanceSheetFxOverlay,
  BALANCE_SHEET_FX_TRANSLATION_CODE,
  BALANCE_SHEET_FX_TRANSLATION_NAME,
  type MonetaryBalanceSheetLine,
  type MonetaryBalanceSheetPayload,
  type MonetaryBalanceSheetOverlayResult,
} from "./monetaryFxBalanceSheetOverlay";
