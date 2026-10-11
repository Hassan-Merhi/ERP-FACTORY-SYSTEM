/**
 * StatusBadge — extracted sub-component.
 *
 * Extracted from TransporterStatement.tsx during the Phase 4 god-file split.
 */
import { Badge } from "@/components/ui/badge";
import { fmtAmt } from "../utils";

export function StatusBadge({
  status,
  paidAmount,
  total,
}: {
  status: "unpaid" | "partial" | "paid" | null;
  paidAmount: string | null;
  total: string | null;
}) {
  if (!status) return null;
  if (status === "paid") {
    return (
      <Badge
        className="text-[11px] bg-green-600/10 text-green-700 dark:text-green-400 border-green-600/20"
        variant="outline"
      >
        Paid
      </Badge>
    );
  }
  if (status === "partial") {
    const remaining = parseFloat(total || "0") - parseFloat(paidAmount || "0");
    return (
      <Badge
        className="text-[11px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
        variant="outline"
      >
        Partial · {fmtAmt(remaining.toFixed(2))} left
      </Badge>
    );
  }
  return (
    <Badge className="text-[11px] bg-destructive/10 text-destructive border-destructive/20" variant="outline">
      Unpaid
    </Badge>
  );
}

// ─── Inline Due Date Editor ──────────────────────────────────────────────────
