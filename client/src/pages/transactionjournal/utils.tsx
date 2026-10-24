/**
 * Pure helpers and lookup tables for the TransactionJournal page.
 *
 * Extracted from TransactionJournal.tsx during the Phase 4 god-file split.
 */
import { format } from "date-fns";
import {} from "lucide-react";

export function formatAmount(val: string | null | undefined) {
  if (!val) return "—";
  const n = parseFloat(val);
  if (isNaN(n) || n === 0) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(d: string) {
  try {
    return format(new Date(d), "dd MMM yyyy");
  } catch {
    return d;
  }
}

export const VOUCHER_TYPE_COLORS: Record<string, string> = {
  Offload: "bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30",
  Payment: "bg-red-100    text-red-800    dark:bg-red-900/30    dark:text-red-300",
  Receipt: "bg-green-100  text-green-800  dark:bg-green-900/30  dark:text-green-300",
  Journal: "bg-blue-100   text-blue-800   dark:bg-blue-900/30   dark:text-blue-300",
  Sales: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  Purchase: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  Contra: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "Credit Note": "bg-pink-100   text-pink-800   dark:bg-pink-900/30   dark:text-pink-300",
  "Debit Note": "bg-rose-100   text-rose-800   dark:bg-rose-900/30   dark:text-rose-300",
};

export const COMPANY_COLORS = [
  "bg-sky-100     text-sky-800     dark:bg-sky-900/30     dark:text-sky-300",
  "bg-violet-100  text-violet-800  dark:bg-violet-900/30  dark:text-violet-300",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  "bg-amber-100   text-amber-800   dark:bg-amber-900/30   dark:text-amber-300",
  "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
  "bg-teal-100    text-teal-800    dark:bg-teal-900/30    dark:text-teal-300",
];

export function companyColor(id: number) {
  return COMPANY_COLORS[id % COMPANY_COLORS.length];
}

// ─── Main Component ────────────────────────────────────────────────────────────
