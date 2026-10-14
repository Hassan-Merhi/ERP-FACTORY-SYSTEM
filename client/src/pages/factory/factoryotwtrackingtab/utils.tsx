/**
 * Pure helpers and lookup tables for the FactoryOtwTrackingTab page.
 *
 * Extracted from FactoryOtwTrackingTab.tsx during the Phase 4 god-file split.
 */

import type {ContainerWithSupplier} from "./types";

export const STATUS_ACTIVE = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);

// ── Currency helpers ────────────────────────────────────────────────────────

export // ── Currency helpers ────────────────────────────────────────────────────────
const CCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  AUD: "A$",
  CAD: "C$",
  CHF: "CHF",
  JPY: "¥",
  CNY: "¥",
  AED: "AED",
  SAR: "SAR",
  LBP: "LL",
};

export function ccySym(code: string | null | undefined): string {
  if (!code) return "$";
  return CCY_SYMBOLS[code] || code;
}

export function num(v: string | null | undefined): number {
  const n = parseFloat(v ?? "");
  return isNaN(n) ? 0 : n;
}

export function fmtAmt(symbol: string, amount: number): string {
  if (amount === 0) return "—";
  return `${symbol} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const plain = d.slice(0, 10);
  const [y, m, day] = plain.split("-");
  if (!y || !m || !day) return "—";
  const monthName = MONTH_NAMES[parseInt(m, 10) - 1] ?? m;
  return `${day} ${monthName} ${y.slice(2)}`;
}

export function containerCost(c: ContainerWithSupplier): { symbol: string; amount: number } {
  const ccy = c.currencyCode || "USD";
  const symbol = ccySym(ccy);
  const amount = num(c.finalPayableAmount) > 0 ? num(c.finalPayableAmount) : num(c.ratePerKg) * num(c.totalKg);
  return { symbol, amount };
}

export function calcDelayDays(c: ContainerWithSupplier): number {
  if (!c.arrivalDate) return 0;
  const plain = c.arrivalDate.slice(0, 10);
  const parts = plain.split("-").map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return 0;
  const [y, m, day] = parts;
  const eta = new Date(y, m - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - eta.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

export function isOverdue(c: ContainerWithSupplier): boolean {
  return calcDelayDays(c) > 0;
}

// ── Summary Card (mirrors ERP SummaryCard) ───────────────────────────────────

