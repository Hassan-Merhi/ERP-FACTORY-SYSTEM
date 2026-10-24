import { Badge } from "@/components/ui/badge";
import type { BaleItem } from "./types";

// Use the same display status in filters, desktop tables, and mobile cards.
// An in-stock bale currently assigned to loading must be shown as Loading.
export function getBaleHistoryDisplayStatus(bale: BaleItem): string {
  if (bale.status === "IN_STOCK" && bale.isInLoadingOrder) return "LOADING";
  if (bale.status === "REMOVED") return "DELETED";
  return bale.status;
}

const statusAppearance: Record<string, { label: string; className: string }> = {
  IN_STOCK: {
    label: "In Stock",
    className: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  LOADING: {
    label: "Loading",
    className: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  SOLD: {
    label: "Sold",
    className: "border-blue-500/50 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  },
  RESERVED_FOR_ORDER: {
    label: "Reserved for Order",
    className: "border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  DISPATCHED: {
    label: "Dispatched",
    className: "border-cyan-500/50 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  },
  DELETED: {
    label: "Deleted",
    className: "border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  },
};

export function BaleHistoryStatusBadge({ bale }: { bale: BaleItem }) {
  const status = getBaleHistoryDisplayStatus(bale);
  const appearance = statusAppearance[status];

  return (
    <Badge
      variant="outline"
      className={`w-fit text-[11px] px-1.5 py-0.5 font-medium no-default-active-elevate ${appearance?.className ?? ""}`}
    >
      {appearance?.label ?? status.replace(/_/g, " ")}
    </Badge>
  );
}
