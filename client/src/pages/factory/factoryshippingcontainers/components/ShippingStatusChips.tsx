import { CheckCircle2, CircleAlert, ClipboardCheck, FileX2, PackageCheck, Ship, Truck } from "lucide-react";
import type { ReactNode } from "react";
import type { DisplayRow } from "../types";
import { isShippingEtaOverdue } from "./ShippingDashboardOverview";
import type { DocsFilter } from "./FilterPanel";

export type ShippingQuickMode = "all" | "overdue" | "arrived";
export type ShippingQuickSelection = "all" | "LOADING" | "VERIFIED" | "FINALIZED" | "overdue" | "arrived" | "missing" | "has";

export function ShippingStatusChips({
  rows, today, filterStatus, filterDocs, quickMode, onSelect,
}: {
  rows: DisplayRow[];
  today: string;
  filterStatus: string;
  filterDocs: DocsFilter;
  quickMode: ShippingQuickMode;
  onSelect: (selection: ShippingQuickSelection) => void;
}) {
  const selected: ShippingQuickSelection = quickMode === "overdue" ? "overdue"
    : quickMode === "arrived" ? "arrived"
    : filterDocs === "missing" ? "missing"
    : filterDocs === "has" ? "has"
    : filterStatus === "LOADING" ? "LOADING"
    : filterStatus === "VERIFIED" ? "VERIFIED"
    : filterStatus === "FINALIZED" ? "FINALIZED" : "all";

  const items: Array<{ id: ShippingQuickSelection; label: string; count: number; icon: ReactNode; active: string; idle: string }> = [
    { id: "all", label: "All", count: rows.length, icon: <Ship className="h-3.5 w-3.5" />, active: "border-blue-500 bg-blue-600 text-white", idle: "border-blue-500/30 text-blue-700 dark:text-blue-300" },
    { id: "LOADING", label: "Loading", count: rows.filter((r) => r.status === "LOADING").length, icon: <Truck className="h-3.5 w-3.5" />, active: "border-blue-500 bg-blue-600 text-white", idle: "border-blue-500/30 text-blue-700 dark:text-blue-300" },
    { id: "VERIFIED", label: "Verified", count: rows.filter((r) => r.status === "VERIFIED" || r.status === "PENDING_VERIFICATION").length, icon: <ClipboardCheck className="h-3.5 w-3.5" />, active: "border-violet-500 bg-violet-600 text-white", idle: "border-violet-500/30 text-violet-700 dark:text-violet-300" },
    { id: "FINALIZED", label: "Finalized", count: rows.filter((r) => r.status === "FINALIZED").length, icon: <PackageCheck className="h-3.5 w-3.5" />, active: "border-emerald-500 bg-emerald-600 text-white", idle: "border-emerald-500/30 text-emerald-700 dark:text-emerald-300" },
    { id: "arrived", label: "Arrived", count: rows.filter((r) => Boolean(r.containerArrivedDate)).length, icon: <CheckCircle2 className="h-3.5 w-3.5" />, active: "border-teal-500 bg-teal-600 text-white", idle: "border-teal-500/30 text-teal-700 dark:text-teal-300" },
    { id: "overdue", label: "Overdue", count: rows.filter((r) => isShippingEtaOverdue(r, today)).length, icon: <CircleAlert className="h-3.5 w-3.5" />, active: "border-rose-500 bg-rose-600 text-white", idle: "border-rose-500/30 text-rose-700 dark:text-rose-300" },
    { id: "has", label: "With docs", count: rows.filter((r) => r.documentCount > 0).length, icon: <ClipboardCheck className="h-3.5 w-3.5" />, active: "border-emerald-500 bg-emerald-600 text-white", idle: "border-emerald-500/30 text-emerald-700 dark:text-emerald-300" },
    { id: "missing", label: "No documents", count: rows.filter((r) => r.documentCount === 0).length, icon: <FileX2 className="h-3.5 w-3.5" />, active: "border-amber-500 bg-amber-600 text-white", idle: "border-amber-500/30 text-amber-700 dark:text-amber-300" },
  ];
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Shipping quick filters">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          aria-pressed={selected === item.id}
          data-testid={"shipping-chip-" + item.id}
          className={"inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-semibold transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " + (selected === item.id ? item.active : "bg-card " + item.idle)}
        >
          {item.icon}
          {item.label}
          <span className={selected === item.id ? "rounded-md bg-white/20 px-1.5 py-0.5 tabular-nums" : "rounded-md bg-muted px-1.5 py-0.5 text-foreground/75 tabular-nums"}>{item.count}</span>
        </button>
      ))}
    </nav>
  );
}
