/**
 * Pure helpers and lookup tables for the PropertyRentalPage page.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */

import { formatMoneyDisplay, formatMoneyNumber } from "@/lib/moneyDisplay";
import { getCurrencyDisplayMetadata } from "@shared/currencyCatalog";

export const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const CURRENCIES = ["USD", "EUR", "CFA"] as const;

export function currencySymbol(currency: string): string {
  return getCurrencyDisplayMetadata(currency).prefix;
}

export function fmtMoneyCurrency(v: string | number | null | undefined, currency = "USD"): string {
  return formatMoneyDisplay(v, { currency });
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function billingDayLabel(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    const day = d.getUTCDate();
    return `${ordinal(day)} of each month`;
  } catch {
    return null;
  }
}

export const fmtMoney = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

function clampPaymentAllocationPeriod(
  year: number,
  month: number,
  contractStartDate?: string
): { year: number; month: number } {
  if (!contractStartDate) return { year, month };
  const start = new Date(contractStartDate + "T00:00:00Z");
  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth() + 1;
  if (year < startYear || (year === startYear && month < startMonth)) {
    return { year: startYear, month: startMonth };
  }
  return { year, month };
}

// ── Context (avoids prop-drilling apiBase through every sub-component) ──

export // ──────────────────────────────────────────────────────────
// TAB 1: PAYMENT
// ──────────────────────────────────────────────────────────
function buildPaymentAllocations(
  totalAmount: number,
  rentalAmount: number,
  paymentDate: string,
  ledger?: Array<{ year: number; month: number; expectedAmount: string; paidAmount: string }>,
  contractStartDate?: string
): Array<{ year: number; month: number; chunk: number }> {
  if (!totalAmount || !rentalAmount || !paymentDate) return [];

  const now = new Date();
  const nowYear = now.getFullYear(),
    nowMonth = now.getMonth() + 1;

  // Build ledger map for skipping already-paid months
  const ledgerMap = new Map<string, { paid: number; expected: number }>();
  if (ledger) {
    for (const r of ledger) {
      ledgerMap.set(`${r.year}-${r.month}`, { paid: parseFloat(r.paidAmount), expected: parseFloat(r.expectedAmount) });
    }
  }

  // Find earliest outstanding past/current month — mirrors server findEarliestOutstandingMonth
  let ay: number, am: number;
  if (ledger && ledger.length > 0) {
    const sorted = [...ledger].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
    const earliest = sorted.find((r) => {
      const clamped = clampPaymentAllocationPeriod(r.year, r.month, contractStartDate);
      if (clamped.year !== r.year || clamped.month !== r.month) return false;
      const isPastOrCurrent = r.year < nowYear || (r.year === nowYear && r.month <= nowMonth);
      if (!isPastOrCurrent) return false;
      return Math.max(0, parseFloat(r.expectedAmount) - parseFloat(r.paidAmount)) > 0.005;
    });
    if (earliest) {
      ay = earliest.year;
      am = earliest.month;
    } else {
      const pd = new Date(paymentDate + "T00:00:00Z");
      ay = pd.getUTCFullYear();
      am = pd.getUTCMonth() + 1;
    }
  } else {
    const pd = new Date(paymentDate + "T00:00:00Z");
    ay = pd.getUTCFullYear();
    am = pd.getUTCMonth() + 1;
  }

  const clampedStart = clampPaymentAllocationPeriod(ay, am, contractStartDate);
  ay = clampedStart.year;
  am = clampedStart.month;

  const allocations: Array<{ year: number; month: number; chunk: number }> = [];
  let remaining = totalAmount;
  let skipped = 0;
  while (remaining > 0.005) {
    const key = `${ay}-${am}`;
    const existing = ledgerMap.get(key);
    const isFuture = ay > nowYear || (ay === nowYear && am > nowMonth);
    const alreadyPaid = existing
      ? isFuture
        ? existing.paid >= rentalAmount
        : existing.paid >= existing.expected
      : false;
    if (alreadyPaid) {
      am++;
      if (am > 12) {
        am = 1;
        ay++;
      }
      if (++skipped > 120) break;
      continue;
    }
    skipped = 0;
    const chunk = rentalAmount > 0 ? Math.min(remaining, rentalAmount) : remaining;
    allocations.push({ year: ay, month: am, chunk: Math.round(chunk * 100) / 100 });
    remaining = Math.round((remaining - chunk) * 100) / 100;
    am++;
    if (am > 12) {
      am = 1;
      ay++;
    }
    if (allocations.length >= 120) break;
  }
  return allocations;
}
