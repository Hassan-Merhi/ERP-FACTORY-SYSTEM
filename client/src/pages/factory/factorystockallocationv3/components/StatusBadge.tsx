/**
 * StatusBadge — extracted sub-component.
 *
 * Extracted from FactoryStockAllocationV3.tsx during the Phase 4 god-file split.
 */

import { STATUS_COLORS, STATUS_LABELS } from "../utils";

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLORS[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ─────────────────────── Scanning Detail Panel ───────────────────────
