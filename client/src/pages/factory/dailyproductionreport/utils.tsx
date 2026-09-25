/**
 * Pure helpers and lookup tables for the DailyProductionReport page.
 *
 * Extracted from DailyProductionReport.tsx during the Phase 4 god-file split.
 */
import type { BucketRow } from "./types";

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function monthEnd() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

export function lastMonthRange(): [string, string] {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

export function weekStart() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon...
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  return new Date(d.setDate(diff)).toISOString().slice(0, 10);
}

export function weekEnd() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? 0 : 7); // Sunday
  return new Date(d.setDate(diff)).toISOString().slice(0, 10);
}

export function yearStart() {
  return `${new Date().getFullYear()}-01-01`;
}

export function fmtMoney(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "$0";
  if (n === 0) return "$0";
  const r = Math.round(n * 100) / 100;
  if (Math.abs(r - Math.round(r)) < 0.005) return `$${Math.round(r).toLocaleString("en-US")}`;
  return `$${r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtRate(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "$0.000";
  // Backend keeps up to 10 decimal places for calculations; the UI intentionally
  // shows at most 4 without mutating the underlying value.
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 4 })}`;
}

export function fmtKg(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "0 kg";
  const r = Math.round(n * 10) / 10;
  return `${r.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} kg`;
}

export function fmtSalary(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function daysInCalendarMonth(isoDate: string): number {
  const [yr, mo] = isoDate.substring(0, 7).split("-").map(Number);
  return new Date(yr, mo, 0).getDate();
}

export function computeWorkerExpectedSalary(
  worker: { baseSalary: string; salaryType: string; transportAllowance: string; attendance: Record<string, string> },
  dates: { date: string; isWeekend: boolean }[]
): number {
  if (worker.salaryType !== "Monthly") return 0;
  const monthly = parseFloat(worker.baseSalary || "0");
  const transport = parseFloat(worker.transportAllowance || "0");
  const total = monthly + transport;
  if (!total || !dates.length) return 0;
  let earned = 0;
  for (const d of dates) {
    const dailyRate = monthly / daysInCalendarMonth(d.date);
    if (d.isWeekend) {
      earned += dailyRate;
    } else {
      const status = worker.attendance[d.date];
      if (status === "Present") earned += dailyRate;
      else if (status === "HalfDay") earned += dailyRate * 0.5;
      else if (status === "Leave") earned += dailyRate;
    }
  }
  // Add full monthly transport allowance (not prorated — it's a flat monthly benefit)
  earned += transport;
  return earned;
}

export const PIE_COLORS = [
  "#6366f1", // indigo   — Summer
  "#f59e0b", // amber    — Winter
  "#34d399", // emerald  — Bags
  "#fb923c", // orange   — Shoes
  "#f472b6", // pink     — Toys
  "#64748b", // slate    — Wipers/Garbage
  "#94a3b8", // gray     — Other
];

export const GROUP_ORDER = ["Summer", "Winter", "Bags", "Shoes", "Toys", "Wipers & Garbage"];

export function classifyCategory(name: string): string {
  const u = name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/ABO\s*SAMAR/.test(u)) return "__skip__";
  if (/SUMMER/.test(u)) return "Summer";
  if (/WINTER/.test(u)) return "Winter";
  // Wipers and garbage are tested before bags because "GARBAGE" contains "BAG":
  // in the other order every garbage line was charted as a bag, and the
  // "Wipers & Garbage" group this function is supposed to produce — the one
  // GROUP_ORDER below lists — was never returned at all.
  if (/WIPER|GARBAGE|RAG/.test(u)) return "Wipers & Garbage";
  if (/BAG/.test(u)) return "Bags";
  if (/SHOE/.test(u)) return "Shoes";
  if (/TOY/.test(u)) return "Toys";
  return "Other";
}

// ── Chart #1: detailed breakdown per sub-type ──────────────────────────────

export // ── Chart #1: detailed breakdown per sub-type ──────────────────────────────
const DETAILED_ORDER = [
  "Summer 1",
  "Summer 2",
  "Summer 3",
  "Summer 4",
  "Summer Crème",
  "Winter 1",
  "Winter 2",
  "Winter 3",
  "Winter 4",
  "Winter Crème",
  "Bags 1",
  "Bags 2",
  "Bags 3",
  "Bags 4",
  "Bags Crème",
  "Toys 1",
  "Toys 2",
  "Toys 3",
  "Toys 4",
  "Toys Crème",
  "Shoes 1",
  "Shoes 2",
  "Shoes 3",
  "Shoes 4",
  "Shoes Crème",
  "Wipers 1",
  "Wipers 2",
  "Wipers 3",
  "Wipers 4",
  "Wipers Crème",
  "Garbage 1",
  "Garbage 2",
  "Garbage 3",
  "Garbage 4",
  "Garbage Crème",
  "Other",
];

export const DETAILED_COLORS: Record<string, string> = {
  "Summer 1": "#312e81",
  "Summer 2": "#4338ca",
  "Summer 3": "#6366f1",
  "Summer 4": "#818cf8",
  "Summer Crème": "#a5b4fc",
  "Winter 1": "#92400e",
  "Winter 2": "#b45309",
  "Winter 3": "#d97706",
  "Winter 4": "#f59e0b",
  "Winter Crème": "#fcd34d",
  "Bags 1": "#064e3b",
  "Bags 2": "#047857",
  "Bags 3": "#059669",
  "Bags 4": "#34d399",
  "Bags Crème": "#6ee7b7",
  "Toys 1": "#831843",
  "Toys 2": "#9d174d",
  "Toys 3": "#db2777",
  "Toys 4": "#ec4899",
  "Toys Crème": "#f9a8d4",
  "Shoes 1": "#4c1d95",
  "Shoes 2": "#5b21b6",
  "Shoes 3": "#7c3aed",
  "Shoes 4": "#8b5cf6",
  "Shoes Crème": "#c4b5fd",
  "Wipers 1": "#0f172a",
  "Wipers 2": "#1e293b",
  "Wipers 3": "#334155",
  "Wipers 4": "#64748b",
  "Wipers Crème": "#94a3b8",
  "Garbage 1": "#713f12",
  "Garbage 2": "#854d0e",
  "Garbage 3": "#a16207",
  "Garbage 4": "#ca8a04",
  "Garbage Crème": "#eab308",
  Other: "#d1d5db",
};

export function classifyDetailed(name: string): string {
  const u = name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/ABO\s*SAMAR/.test(u)) return "__skip__";
  let cat: string;
  if (/SUMMER/.test(u)) cat = "Summer";
  else if (/WINTER/.test(u)) cat = "Winter";
  // Before bags, for the same reason as classifyCategory above: "GARBAGE"
  // contains "BAG", and classifyByGrade already orders it this way, so the two
  // charts disagreed about the same line.
  else if (/WIPER/.test(u)) cat = "Wipers";
  else if (/GARBAGE|RAG/.test(u)) cat = "Garbage";
  else if (/BAG/.test(u)) cat = "Bags";
  else if (/TOY/.test(u)) cat = "Toys";
  else if (/SHOE/.test(u)) cat = "Shoes";
  else return "Other";

  if (/CREME|CRÈME|BIG\s*SIZE/.test(u)) return `${cat} Crème`;
  if (/\b4\b/.test(u)) return `${cat} 4`;
  if (/\b3\b/.test(u)) return `${cat} 3`;
  if (/\b2\b/.test(u)) return `${cat} 2`;
  if (/\b1\b/.test(u)) return `${cat} 1`;
  return cat === "Other" ? "Other" : `${cat} 1`;
}

// ── Chart #2: by grade (Summer+Winter merged into grade numbers) ────────────

export // ── Chart #2: by grade (Summer+Winter merged into grade numbers) ────────────
const GRADE_ORDER = [
  "Grade #1",
  "Grade #2",
  "Grade #3",
  "Grade #4",
  "Grade Crème",
  "Bags",
  "Toys",
  "Shoes",
  "Wipers & Garbage",
  "Other",
];

export const GRADE_COLORS: Record<string, string> = {
  "Grade #1": "#4338ca",
  "Grade #2": "#d97706",
  "Grade #3": "#0891b2",
  "Grade #4": "#7c3aed",
  "Grade Crème": "#a78bfa",
  Bags: "#059669",
  Toys: "#db2777",
  Shoes: "#ea580c",
  "Wipers & Garbage": "#64748b",
  Other: "#d1d5db",
};

export function classifyByGrade(name: string): string {
  if (name === "__WIPERS_GARBAGE__") return "Wipers & Garbage";
  const u = name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/ABO\s*SAMAR/.test(u)) return "__skip__";
  if (/WIPER|GARBAGE|RAG/.test(u)) return "Wipers & Garbage";
  if (/BAG/.test(u)) return "Bags";
  if (/TOY/.test(u)) return "Toys";
  if (/SHOE/.test(u)) return "Shoes";
  if (/CREME|CRÈME|BIG\s*SIZE/.test(u)) return "Grade Crème";
  if (/\b4\b/.test(u)) return "Grade #4";
  if (/\b3\b/.test(u)) return "Grade #3";
  if (/\b2\b/.test(u)) return "Grade #2";
  if (/\b1\b/.test(u)) return "Grade #1";
  return "Other";
}

export function fmtL(n: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n);
}

export function fmtNL(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function fmtML(n: number): string {
  if (n === 0) return "$0";
  const r = Math.round(n * 100) / 100;
  return r % 1 === 0
    ? "$" + new Intl.NumberFormat("en-US").format(r)
    : "$" + new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(r);
}

export function groupByCategory(rows: BucketRow[]): { category: string; items: BucketRow[] }[] {
  const map = new Map<string, BucketRow[]>();
  for (const row of rows) {
    const cat = row.categoryName || "—";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(row);
  }
  return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
}
