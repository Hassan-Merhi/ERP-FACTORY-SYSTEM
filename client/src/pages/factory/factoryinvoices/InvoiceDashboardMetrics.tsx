import { BadgeCheck, Boxes, FileCheck2, FileText, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { CustomerOrder } from "./types";
import { cn } from "@/lib/utils";

const fmtNum = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const num = (value: string | number | null | undefined) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function Card({
  label, value, caption, totalValue, icon, tone,
}: {
  label: string;
  value: string;
  caption: string;
  totalValue?: string;
  icon: ReactNode;
  tone: "blue" | "green" | "amber" | "violet" | "cyan";
}) {
  const styles = {
    blue: ["border-blue-500/30 dark:from-[hsl(var(--factory-hue)_63%_17%)] dark:to-[hsl(var(--factory-hue)_55%_16%)]", "bg-blue-500/15 text-blue-700 dark:text-blue-300"],
    green: ["border-emerald-500/30 dark:from-[#10352d] dark:to-[#132b2d]", "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"],
    amber: ["border-amber-500/30 dark:from-[#382b19] dark:to-[#262622]", "bg-amber-500/15 text-amber-700 dark:text-amber-300"],
    violet: ["border-violet-500/30 dark:from-[hsl(var(--factory-hue)_42%_18%)] dark:to-[hsl(var(--factory-hue)_33%_16%)]", "bg-violet-500/15 text-violet-700 dark:text-violet-300"],
    cyan: ["border-cyan-500/30 dark:from-[hsl(var(--factory-hue)_59%_17%)] dark:to-[hsl(var(--factory-hue)_45%_16%)]", "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"],
  } as const;
  const [border, iconClass] = styles[tone];
  return (
    <div className={cn("min-w-0 rounded-xl border bg-gradient-to-br from-card to-muted/30 px-3.5 py-3 shadow-sm", border)}>
      <div className="flex items-center gap-2.5">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", iconClass)}>{icon}</div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <p className="truncate text-2xl font-bold tracking-tight tabular-nums text-foreground" title={value}>{value}</p>
        </div>
      </div>
      <p className="mt-2 truncate text-[11px] text-muted-foreground" title={caption}>{caption}</p>
      {totalValue && <p className="mt-1 truncate text-[11px] font-semibold tabular-nums text-foreground" title={`Total value: ${totalValue}`}>Total value: {totalValue}</p>}
    </div>
  );
}

const formatUsd = (orders: CustomerOrder[]) => {
  const amount = orders.reduce((sum, order) => sum + num(order.grandTotal), 0);
  return "$" + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function caption(orders: CustomerOrder[]) {
  const bales = orders.reduce((total, order) => total + num(order.totalQtyBales), 0);
  const kg = orders.reduce((total, order) => total + num(order.totalWeightKg), 0);
  return fmtNum(bales) + " bales · " + fmtNum(kg) + " kg";
}

/** All dashboard amounts are derived from the same invoice rows already in view. */
export function InvoiceDashboardMetrics({
  orders,
  hideTotalsUsd,
}: {
  orders: CustomerOrder[];
  hideTotalsUsd: boolean;
}) {
  const loading = orders.filter((order) => order.status === "LOADING");
  const verified = orders.filter((order) => order.status === "VERIFIED" || order.status === "PENDING_VERIFICATION");
  const finalized = orders.filter((order) => order.status === "FINALIZED");
  // Financial amounts follow the same visible order set and respect the USD visibility toggle.
  const displayValue = (statusOrders: CustomerOrder[]) => hideTotalsUsd ? undefined : formatUsd(statusOrders);

  return (
    <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 2xl:grid-cols-5" aria-label="Invoice summary metrics">
      <Card label="Total orders" value={fmtNum(orders.length)} caption={caption(orders)} totalValue={displayValue(orders)} icon={<FileText className="h-5 w-5" />} tone="blue" />
      <Card label="Verified" value={fmtNum(verified.length)} caption={caption(verified)} totalValue={displayValue(verified)} icon={<BadgeCheck className="h-5 w-5" />} tone="green" />
      <Card label="Loading" value={fmtNum(loading.length)} caption={caption(loading)} totalValue={displayValue(loading)} icon={<Boxes className="h-5 w-5" />} tone="amber" />
      <Card label="Finalized" value={fmtNum(finalized.length)} caption={caption(finalized)} totalValue={displayValue(finalized)} icon={<FileCheck2 className="h-5 w-5" />} tone="violet" />
      {!hideTotalsUsd && (
        <Card
          label="Total value"
          value={formatUsd(orders)}
          caption="Visible orders · USD"
          icon={<Wallet className="h-5 w-5" />}
          tone="cyan"
        />
      )}
    </section>
  );
}
