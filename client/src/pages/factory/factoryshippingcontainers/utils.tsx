/**
 * Pure helpers and lookup tables for the FactoryShippingContainers page.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */

import type { ShippingColId } from "./types";
import { formatUsd } from "@/lib/moneyDisplay";
import { StatusBadge } from "@/components/StatusBadge";

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

export function statusLabel(s: string) {
  return STATUS_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase();
}

/** StatusBadge kind for a shipping row; pending verification reads (and is coloured) as Verified. */
export function shippingStatusKind(s: string) {
  return s === "PENDING_VERIFICATION" ? "VERIFIED" : s;
}

/** The status pill of a shipping row, on the shared StatusBadge. */
export function ShippingStatusBadge({ status }: { status: string }) {
  return (
    <StatusBadge
      status={shippingStatusKind(status)}
      label={statusLabel(status)}
      showIcon={false}
      className="shipping-status whitespace-nowrap cursor-pointer"
    />
  );
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
  { id: "invoiceNumber", label: "Invoice #" },
  { id: "clientName", label: "Client" },
  { id: "status", label: "Status" },
  { id: "containerNumber", label: "Container #" },
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

/** Shipping grand total in USD (up to 3 decimals). */
export function shippingCostUsd(value: string | number | null): string {
  return formatUsd(Number(value), 0, 3);
}

/** Today's date in the browser's local time zone as YYYY-MM-DD. */
export function localIsoDate(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
