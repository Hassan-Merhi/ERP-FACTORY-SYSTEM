/**
 * Pure helpers and lookup tables for the FactoryWorkerDetail page.
 *
 * Extracted from FactoryWorkerDetail.tsx during the Phase 4 god-file split.
 */

import { formatUsd } from "@/lib/moneyDisplay";

export const PAYROLL_STATUS: Record<string, { label: string; className: string }> = {
  DRAFT: { label: "Draft", className: "border-amber-400 text-amber-700 dark:text-amber-400" },
  APPROVED: { label: "Approved", className: "border-blue-400 text-blue-700 dark:text-blue-400" },
  PAID: { label: "Paid", className: "border-green-500 text-green-700 dark:text-green-400" },
};

export const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
];

export function getAvatarColor(name: string) {
  let hash = 0;
  for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "$0.00" : formatUsd(n, 2);
}

export function fmtNum(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toFixed(2);
}
