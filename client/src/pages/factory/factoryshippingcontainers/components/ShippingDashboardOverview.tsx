import { CalendarDays, CircleAlert, ClipboardList, DollarSign, FileCheck2, PackageCheck, Truck } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DisplayRow } from "../types";

export function isShippingEtaOverdue(row: DisplayRow, today: string): boolean {
  const eta = (row._trackedEta || row.eta || "").slice(0, 10);
  return Boolean(eta && /^\d{4}-\d{2}-\d{2}$/.test(eta) && eta < today && !row.containerArrivedDate && row.status !== "CANCELLED");
}

interface ShippingDashboardOverviewProps {
  rows: DisplayRow[];
  today: string;
  dateFrom: string;
  dateTo: string;
  onDateFrom: (value: string) => void;
  onDateTo: (value: string) => void;
  onOpenInvoicing: () => void;
  allowNewOrder: boolean;
  showOrderValue: boolean;
}

function Metric({
  label,
  value,
  caption,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  caption: string;
  icon: ReactNode;
  tone: "blue" | "emerald" | "amber" | "rose" | "violet" | "cyan";
}) {
  const tones = {
    blue: ["border-blue-500/35", "bg-blue-500/15 text-blue-600 dark:text-blue-300"],
    emerald: ["border-emerald-500/35", "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"],
    amber: ["border-amber-500/35", "bg-amber-500/15 text-amber-600 dark:text-amber-300"],
    rose: ["border-rose-500/35", "bg-rose-500/15 text-rose-600 dark:text-rose-300"],
    violet: ["border-violet-500/35", "bg-violet-500/15 text-violet-600 dark:text-violet-300"],
    cyan: ["border-cyan-500/35", "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"],
  } as const;
  const [border, iconStyle] = tones[tone];
  return (
    <div className={"relative min-w-0 overflow-hidden rounded-xl border bg-card px-3 py-3 shadow-sm dark:bg-[#102036] " + border}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={"flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " + iconStyle}>{icon}</span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-muted-foreground" title={label}>{label}</p>
          <p className="truncate text-xl font-extrabold leading-tight tracking-tight tabular-nums text-foreground" title={String(value)}>{value}</p>
        </div>
      </div>
      <p className="mt-1.5 truncate text-[10px] text-muted-foreground" title={caption}>{caption}</p>
    </div>
  );
}

/** Compact overview with only persisted/derived current shipping values. */
export function ShippingDashboardOverview({
  rows, today, dateFrom, dateTo, onDateFrom, onDateTo, onOpenInvoicing, allowNewOrder, showOrderValue,
}: ShippingDashboardOverviewProps) {
  const loading = rows.filter((row) => row.status === "LOADING").length;
  const notFinalized = rows.filter((row) => !row.finalizedDate && row.status !== "CANCELLED").length;
  const delayed = rows.filter((row) => isShippingEtaOverdue(row, today)).length;
  const withDocs = rows.filter((row) => row.documentCount > 0).length;
  const total = rows.reduce((sum, row) => {
    const amount = Number(row.grandTotal ?? 0);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-2xl border border-blue-500/20 bg-gradient-to-r from-blue-50 via-slate-50 to-violet-50 p-3.5 dark:from-[#0d2039] dark:via-[#101c34] dark:to-[#1a1640] sm:p-4">
        <div className="pointer-events-none absolute -right-6 -top-10 h-28 w-64 rounded-full bg-blue-500/10 blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/20">
              <Truck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Shipping</h2>
              <p className="text-xs text-muted-foreground sm:text-sm">Track orders, containers and deliveries from factory to destination</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-background/65 px-2.5 py-1.5">
              <CalendarDays className="h-4 w-4 text-blue-500" />
              <label className="sr-only" htmlFor="shipping-date-from">Orders from date</label>
              <Input id="shipping-date-from" aria-label="Orders from date" type="date" value={dateFrom} onChange={(e) => onDateFrom(e.target.value)}
                className="h-7 w-[124px] border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0" />
              <span className="text-xs text-muted-foreground">to</span>
              <label className="sr-only" htmlFor="shipping-date-to">Orders to date</label>
              <Input id="shipping-date-to" aria-label="Orders to date" type="date" value={dateTo} onChange={(e) => onDateTo(e.target.value)}
                className="h-7 w-[124px] border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0" />
              {(dateFrom || dateTo) && (
                <Button variant="ghost" size="sm" className="h-7 px-1.5 text-xs" onClick={() => { onDateFrom(""); onDateTo(""); }}>
                  Clear
                </Button>
              )}
            </div>
            {allowNewOrder && (
              <Button className="h-10 rounded-xl bg-blue-600 px-4 text-white shadow-sm shadow-blue-500/20 hover:bg-blue-500"
                onClick={onOpenInvoicing} data-testid="button-shipping-open-invoicing">
                <ClipboardList className="mr-1.5 h-4 w-4" /> New Order
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Metric label="Active orders" value={rows.length} caption="Open shipping records" icon={<ClipboardList className="h-5 w-5" />} tone="blue" />
        <Metric label="Loading" value={loading} caption="Currently loading" icon={<Truck className="h-5 w-5" />} tone="emerald" />
        <Metric label="Not finalized" value={notFinalized} caption="Order status pending" icon={<PackageCheck className="h-5 w-5" />} tone="amber" />
        <Metric label="Overdue ETA" value={delayed} caption="ETA passed, not arrived" icon={<CircleAlert className="h-5 w-5" />} tone="rose" />
        <Metric label="With documents" value={withDocs} caption="At least one uploaded" icon={<FileCheck2 className="h-5 w-5" />} tone="violet" />
        {showOrderValue && (
          <Metric label="Total order value" value={"$" + total.toLocaleString(undefined, { maximumFractionDigits: 0 })} caption="Sum of listed order totals (USD)" icon={<DollarSign className="h-5 w-5" />} tone="cyan" />
        )}
      </div>
    </div>
  );
}
