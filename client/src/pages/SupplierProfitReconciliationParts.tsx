// Extracted from ./SupplierProfitReconciliation.tsx
import { type ReactNode } from "react";

export type Options = {
  suppliers: { id: number; name: string; stock_group_id: number | null }[];
  groups: { id: number; name: string }[];
};

export type Report = {
  supplier: { id: number; name: string };
  totals: {
    salesRevenue: number;
    storedProfit: number;
    offloadedBase: number;
    offloadingCharges: number;
    currentStock: number;
    otwBase: number;
    otwContainers: number;
    offloadedContainers: number;
    modeledProfit: number;
    modeledVsRecordedGap: number;
  };
  warnings: string[];
};

export type Period = "all" | "day" | "month" | "year" | "custom";

export const dollars = (n: number | string | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n ?? 0));

const isoLocal = (d: Date) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");

export const today = () => isoLocal(new Date());

export const firstDay = (p: string) => (p && /^\d{4}-\d{2}$/.test(p) ? p + "-01" : "");

export const lastDay = (p: string) => {
  if (!/^\d{4}-\d{2}$/.test(p)) return "";
  const [year, month] = p.split("-").map(Number);
  return isoLocal(new Date(year, month, 0));
};

export function SummaryRow({
  label,
  value,
  emphasis = false,
  attention = false,
}: {
  label: ReactNode;
  value: string;
  emphasis?: boolean;
  attention?: boolean;
}) {
  return (
    <div
      className={
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border/60 px-3 py-3 last:border-b-0 sm:px-4 " +
        (emphasis ? "bg-muted/40 font-semibold " : "") +
        (attention ? "text-amber-700 dark:text-amber-400" : "")
      }
    >
      <span className="text-sm">{label}</span>
      <span className="font-mono text-sm tabular-nums sm:text-base">{value}</span>
    </div>
  );
}

export function SummarySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <h3 className="border-b bg-muted/50 px-4 py-2 text-xs font-bold uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}
