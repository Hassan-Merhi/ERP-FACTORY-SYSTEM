/**
 * Pure helpers and lookup tables for the FactoryShippingContainers page.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */

import type {ShippingColId} from "./types";

export const LIST_KEY = "/api/factory/shipping-container-rows";

// ─── Status helpers ────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<string, string> = {
  LOADING: "Loading",
  PENDING_VERIFICATION: "Verified",
  VERIFIED: "Verified",
  FINALIZED: "Finalized",
  DRAFT: "Draft",
  CANCELLED: "Cancelled",
};

export const STATUS_COLORS: Record<string, string> = {
  LOADING: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  PENDING_VERIFICATION: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  VERIFIED: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  FINALIZED: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

export function statusLabel(s: string) {
  return STATUS_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase();
}

export function statusColor(s: string) {
  return STATUS_COLORS[s] ?? "bg-gray-100 text-gray-600";
}

export const STATUS_ORDER: Record<string, number> = {
  LOADING: 0,
  PENDING_VERIFICATION: 1,
  VERIFIED: 2,
  FINALIZED: 3,
  DRAFT: 4,
  CANCELLED: 5,
};

/** Format YYYY-MM-DD or ISO timestamp → dd/mm/yy, returns "—" for empty */

export /** Format YYYY-MM-DD or ISO timestamp → dd/mm/yy, returns "—" for empty */
function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const plain = d.slice(0, 10);
  const parts = plain.split("-");
  if (parts.length !== 3) return "—";
  const [y, m, day] = parts;
  return `${day}/${m}/${y.slice(2)}`;
}

// ─── Column visibility config ──────────────────────────────────────────────────

export // ─── Column visibility config ──────────────────────────────────────────────────
const SHIPPING_COLS = [
  { id: "orderDate", label: "Order Date" },
  { id: "status", label: "Status" },
  { id: "destination", label: "Destination" },
  { id: "eta", label: "ETA" },
  { id: "arrived", label: "Arrived" },
  { id: "finalized", label: "Finalized" },
  { id: "shippingCo", label: "Shipping Co." },
  { id: "documents", label: "Documents" },
  { id: "containerCost", label: "Container Cost" },
  { id: "ciNumber", label: "CI No." },
  { id: "note", label: "Note" },
  { id: "anything", label: "Anything" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "done", label: "Done" },
] as const;

export const DEFAULT_COL_VIS: Record<ShippingColId, boolean> = Object.fromEntries(
  SHIPPING_COLS.map((c) => [c.id, true])
) as Record<ShippingColId, boolean>;

// ─── Sticky column helpers ─────────────────────────────────────────────────────

export // ─── Sticky column helpers ─────────────────────────────────────────────────────
const stickyHeadBase = "sticky z-20 bg-background border-r border-border/50 text-xs";

export const stickyCellBase = "sticky z-10 bg-background border-r border-border/50";

export const INV_LEFT = 0;

export const CLI_LEFT = 130;

export const CTR_LEFT = 130 + 144; // 274

// ─── Document count indicator ──────────────────────────────────────────────────

export const AVAIL_KEY = "/api/factory/shipping-availability";
