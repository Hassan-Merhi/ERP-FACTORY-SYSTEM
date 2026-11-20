/**
 * Phase 4: verify the complete, reviewed correction without changing books.
 *
 * The existing Admin/Owner account editor, exact voucher reversal and FX
 * posting services own the writes. This checker never bypasses their audit,
 * period, or company protections and NEVER initiates a posting.
 */
import Decimal from "decimal.js";

export type FxRepairAuditLine = {
  voucherId: number;
  lineId: number;
  ledgerId: number | null;
  bankId: number | null;
  customerId: number | null;
  debitUsd: string;
  creditUsd: string;
  currency: string | null;
  nativeDebit: string | null;
  nativeCredit: string | null;
  rateConvention: string | null;
  accountCode: string | null;
  accountName: string | null;
  accountType: string | null;
};
export type FxRepairAuditVoucher = {
  id: number;
  voucherNumber: string;
  sourceType: string | null;
  reversalOfVoucherId: number | null;
  deleted: boolean;
  optional: boolean;
  lines: FxRepairAuditLine[];
};
export type FxRepairAuditBalance = {
  accountKey: string;
  bookClosingUsd: string;
  currentTranslatedUsd: string | null;
  nativeBalancesByCurrency: Record<string, string>;
  provisional: boolean;
};
export type FxRepairAuditResult = {
  status: "blocked" | "reclassify_fx_account" | "reverse_original" | "post_base_only" | "verified";
  blockers: string[];
  originalVoucherId: number;
  originalVoucherNumber: string | null;
  reversalVoucherId: number | null;
  replacementVoucherId: number | null;
  originalFxLossUsd: string;
  matchedAccountAdjustmentsUsd: Record<string, string>;
  untouchedNativeForeignBalances: Record<string, Record<string, string>>;
  readonly: true;
};

function money(v: string): Decimal {
  const value = new Decimal(v);
  if (!value.isFinite()) throw new Error("FX_REPAIR_NONFINITE_AMOUNT");
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
function signed(line: FxRepairAuditLine): Decimal {
  return money(line.debitUsd).minus(money(line.creditUsd));
}
function targetKey(line: FxRepairAuditLine): string | null {
  // Customer attribution wins over linked ledger; ledger wins over bank.
  if (line.customerId !== null) return `customer:${line.customerId}`;
  if (line.ledgerId !== null) return `ledger:${line.ledgerId}`;
  if (line.bankId !== null) return `bank:${line.bankId}`;
  return null;
}
function isFxCounter(line: FxRepairAuditLine): boolean {
  return (
    line.accountCode === "FX-REVALUATION" ||
    line.accountCode === "FXREVGAI" ||
    line.accountName?.trim().toLowerCase() === "fx revaluation gain/loss"
  );
}
function lineIdentity(line: FxRepairAuditLine, mirror = false): string {
  return JSON.stringify([
    line.ledgerId,
    line.bankId,
    line.customerId,
    line.currency,
    line.rateConvention,
    money(mirror ? line.creditUsd : line.debitUsd).toFixed(2),
    money(mirror ? line.debitUsd : line.creditUsd).toFixed(2),
    money(mirror ? line.nativeCredit ?? "0" : line.nativeDebit ?? "0").toFixed(2),
    money(mirror ? line.nativeDebit ?? "0" : line.nativeCredit ?? "0").toFixed(2),
  ]);
}
export function reversalMirrorsOriginal(
  original: readonly FxRepairAuditLine[],
  reversal: readonly FxRepairAuditLine[]
): boolean {
  if (original.length !== reversal.length || original.length < 2) return false;
  const copies = new Map<string, number>();
  for (const line of original) {
    const key = lineIdentity(line, true);
    copies.set(key, (copies.get(key) ?? 0) + 1);
  }
  for (const line of reversal) {
    const key = lineIdentity(line);
    const previous = copies.get(key) ?? 0;
    if (previous === 0) return false;
    copies.set(key, previous - 1);
  }
  return [...copies.values()].every((count) => count === 0);
}
function aggregate(
  lines: readonly FxRepairAuditLine[],
  only: (line: FxRepairAuditLine) => boolean
): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  for (const line of lines) {
    if (!only(line)) continue;
    const key = targetKey(line);
    if (key === null) continue;
    result.set(key, (result.get(key) ?? new Decimal(0)).plus(signed(line)));
  }
  return result;
}
function sameAdjustments(expected: ReadonlyMap<string, Decimal>, actual: ReadonlyMap<string, Decimal>): boolean {
  if (expected.size !== actual.size) return false;
  return [...expected.entries()].every(([key, value]) => actual.get(key)?.eq(value) === true);
}

/**
 * All monetary proof comes from posted voucher lines and translated closing
 * balances. Never infer that an unrelated journal with a similar memo repairs
 * the original, and never count native-currency-changing lines as a correction.
 */
export function assessManualFxCorrection(input: {
  originalVoucherId: number;
  original: FxRepairAuditVoucher | null;
  reversals: readonly FxRepairAuditVoucher[];
  automaticFxVouchers: readonly FxRepairAuditVoucher[];
  balances: readonly FxRepairAuditBalance[];
}): FxRepairAuditResult {
  const { original, reversals, automaticFxVouchers, balances } = input;
  const blockers: string[] = [];
  const base: FxRepairAuditResult = {
    status: "blocked",
    blockers,
    originalVoucherId: input.originalVoucherId,
    originalVoucherNumber: original?.voucherNumber ?? null,
    reversalVoucherId: null,
    replacementVoucherId: null,
    originalFxLossUsd: "0.00",
    matchedAccountAdjustmentsUsd: {},
    untouchedNativeForeignBalances: {},
    readonly: true,
  };
  if (!original || original.id !== input.originalVoucherId) {
    blockers.push("ORIGINAL_VOUCHER_NOT_FOUND");
    return base;
  }
  if (original.deleted || original.optional || original.reversalOfVoucherId !== null ||
      original.sourceType !== "manual-journal") blockers.push("ORIGINAL_VOUCHER_NOT_POSTED_MANUAL");
  const counterLines = original.lines.filter(isFxCounter);
  const counter = counterLines.length === 1 ? counterLines[0] : null;
  if (!counter) blockers.push("ORIGINAL_FX_COUNTER_AMBIGUOUS");
  const cashLines = original.lines.filter(
    (line) =>
      !isFxCounter(line) &&
      line.currency?.trim().toUpperCase() === "USD" &&
      line.rateConvention === "IDENTITY" &&
      ["cash", "bank", "loan", "loans", "customer"].includes(line.accountType?.toLowerCase() ?? "") ||
      (!isFxCounter(line) && line.currency === "USD" && line.rateConvention === "IDENTITY" &&
       (line.bankId !== null || line.customerId !== null))
  );
  const originalByTarget = aggregate(cashLines, () => true);
  const originalLoss = counter ? signed(counter) : new Decimal(0);
  base.originalFxLossUsd = originalLoss.toFixed(2);
  base.matchedAccountAdjustmentsUsd = Object.fromEntries(
    [...originalByTarget.entries()].map(([key, value]) => [key, value.toFixed(2)])
  );
  if (originalByTarget.size === 0 || originalLoss.isZero()) blockers.push("ORIGINAL_FX_MOVEMENTS_MISSING");
  if (original.lines.length !== cashLines.length + counterLines.length ||
      ![...originalByTarget.values()].reduce((sum, value) => sum.plus(value), new Decimal(0))
        .plus(originalLoss).isZero()) blockers.push("ORIGINAL_FX_VOUCHER_NOT_BALANCED");
  if (counter && counter.accountType !== "Indirect Expense") {
    // Only reviewed account editing can repair this. This verifier never edits.
    if (blockers.length === 0) base.status = "reclassify_fx_account";
    return { ...base, blockers: [...blockers, "FX_COUNTER_TYPE_NOT_INDIRECT_EXPENSE"] };
  }
  if (blockers.length) return base;
  const liveReversals = reversals.filter((v) => !v.deleted && !v.optional);
  if (liveReversals.length > 1) {
    blockers.push("MULTIPLE_ACTIVE_REVERSALS");
    return base;
  }
  const reversal = liveReversals[0];
  if (!reversal) return { ...base, status: "reverse_original" };
  base.reversalVoucherId = reversal.id;
  if (reversal.reversalOfVoucherId !== original.id ||
      !reversalMirrorsOriginal(original.lines, reversal.lines)) {
    blockers.push("REVERSAL_DOES_NOT_EXACTLY_CANCEL_ORIGINAL");
    return base;
  }
  // Every automatic candidate must be a properly sourced, active journal.
  // Reject a duplicate matching correction even if one journal is valid.
  const candidates = automaticFxVouchers.filter((v) => !v.deleted && !v.optional);
  const matching: FxRepairAuditVoucher[] = [];
  for (const voucher of candidates) {
    if (voucher.sourceType !== "fx-unrealized-revaluation") continue;
    const baseLines = voucher.lines.filter((line) => line.rateConvention === "BASE_ONLY_REVALUATION");
    if (baseLines.length !== originalByTarget.size) continue;
    if (baseLines.some(
      (line) => line.currency === null || line.currency.toUpperCase() === "USD" ||
        money(line.nativeDebit ?? "0").abs().gt(0) || money(line.nativeCredit ?? "0").abs().gt(0)
    )) continue;
    const byTarget = aggregate(baseLines, () => true);
    if (!sameAdjustments(originalByTarget, byTarget)) continue;
    const offset = voucher.lines.filter(isFxCounter);
    if (offset.length !== 1 ||
        signed(offset[0]).toFixed(2) !== originalLoss.toFixed(2) ||
        offset[0].accountType !== "Indirect Expense" ||
        voucher.lines.length !== baseLines.length + 1) continue;
    matching.push(voucher);
  }
  if (matching.length > 1) {
    blockers.push("DUPLICATE_MATCHING_FX_JOURNALS");
    return base;
  }
  if (!matching.length) {
    const unsafe = candidates.some((v) =>
      v.lines.some((line) => {
        const key = targetKey(line);
        return key !== null && originalByTarget.has(key) && line.rateConvention !== "BASE_ONLY_REVALUATION";
      })
    );
    if (unsafe) {
      blockers.push("UNSAFE_FX_JOURNAL_ON_AFFECTED_ACCOUNT");
      return base;
    }
    return { ...base, status: "post_base_only" };
  }
  base.replacementVoucherId = matching[0].id;
  const byKey = new Map(balances.map((row) => [row.accountKey, row]));
  for (const key of originalByTarget.keys()) {
    const row = byKey.get(key);
    if (!row || row.provisional || row.currentTranslatedUsd === null) {
      blockers.push(`ACCOUNT_VALUATION_UNRESOLVED:${key}`);
      continue;
    }
    if (!money(row.currentTranslatedUsd).eq(money(row.bookClosingUsd))) {
      blockers.push(`CLOSING_TRANSLATION_MISMATCH:${key}`);
    }
    const foreign = Object.fromEntries(
      Object.entries(row.nativeBalancesByCurrency).filter(([currency]) => currency !== "USD")
    );
    if (Object.keys(foreign).length === 0) blockers.push(`FOREIGN_BALANCE_MISSING:${key}`);
    base.untouchedNativeForeignBalances[key] = foreign;
  }
  if (blockers.length) return base;
  return { ...base, status: "verified" };
}
