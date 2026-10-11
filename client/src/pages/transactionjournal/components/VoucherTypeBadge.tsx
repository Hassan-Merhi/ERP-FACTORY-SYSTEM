/**
 * VoucherTypeBadge — extracted sub-component.
 *
 * Extracted from TransactionJournal.tsx during the Phase 4 god-file split.
 */

import { VOUCHER_TYPE_COLORS } from "../utils";

export function VoucherTypeBadge({ type }: { type: string }) {
  const cls = VOUCHER_TYPE_COLORS[type] || "bg-muted text-muted-foreground";
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${cls}`}>{type}</span>;
}

// ─── Company colour pill ───────────────────────────────────────────────────────
