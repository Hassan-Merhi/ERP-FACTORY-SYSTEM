import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Options = {
  suppliers: { id: number; name: string; stock_group_id: number | null }[];
  groups: { id: number; name: string }[];
};

type Report = {
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

type Period = "all" | "day" | "month" | "year" | "custom";

const dollars = (n: number | string | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n ?? 0));

const isoLocal = (d: Date) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
const today = () => isoLocal(new Date());
const firstDay = (p: string) => (p && /^\d{4}-\d{2}$/.test(p) ? p + "-01" : "");
const lastDay = (p: string) => {
  if (!/^\d{4}-\d{2}$/.test(p)) return "";
  const [year, month] = p.split("-").map(Number);
  return isoLocal(new Date(year, month, 0));
};
const cls = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

function SummaryRow({
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

function SummarySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border">
      <h3 className="border-b bg-muted/50 px-4 py-2 text-xs font-bold uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

export default function SupplierProfitReconciliation() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const [supplierId, setSupplierId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const [day, setDay] = useState(today());
  const [month, setMonth] = useState(today().slice(0, 7));
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const optionsQuery = useQuery<Options>({
    queryKey: companyQueryKey("/api/supplier-profit-reconciliation/options", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/supplier-profit-reconciliation/options", { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Could not load suppliers");
      return r.json();
    },
    enabled: !!selectedCompany?.id,
    staleTime: 60_000,
  });
  const options = optionsQuery.data;

  useEffect(() => {
    if (!options?.suppliers.length) return;
    if (!options.suppliers.some((supplier) => String(supplier.id) === supplierId)) {
      setSupplierId(String(options.suppliers[0].id));
    }
  }, [options, supplierId]);

  const range = useMemo(() => {
    if (period === "all") return { from: "", to: "" };
    if (period === "day") return { from: day, to: day };
    if (period === "month") return { from: firstDay(month), to: lastDay(month) };
    if (period === "year") {
      return /^\d{4}$/.test(year) ? { from: year + "-01-01", to: year + "-12-31" } : { from: "", to: "" };
    }
    return { from, to };
  }, [period, day, month, year, from, to]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ supplierId });
    if (groupId) p.set("groupId", groupId);
    if (range.from) p.set("startDate", range.from);
    if (range.to) p.set("endDate", range.to);
    return p.toString();
  }, [supplierId, groupId, range]);

  const validRange =
    (period !== "year" || /^\d{4}$/.test(year)) &&
    (period !== "month" || !!firstDay(month)) &&
    (period !== "custom" || !range.from || !range.to || range.from <= range.to);

  const reportQuery = useQuery<Report>({
    queryKey: companyQueryKey("/api/supplier-profit-reconciliation/report?" + params, selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/supplier-profit-reconciliation/report?" + params, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Unable to calculate supplier profit");
      return r.json();
    },
    enabled: !!selectedCompany?.id && !!supplierId && validRange,
  });

  const supplierBalanceQuery = useQuery<{ balance: string | number }>({
    queryKey: companyQueryKey("/api/suppliers/" + supplierId + "/balance", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/suppliers/" + supplierId + "/balance", {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Supplier statement unavailable");
      return r.json();
    },
    enabled: !!supplierId && !!selectedCompany?.id,
  });

  // This sheet displays only saved summary amounts; drilldowns stay in Sales Report.
  const report = reportQuery.data;
  const totals = report?.totals;
  const isAllTime = period === "all";
  const bridgeGap = totals?.modeledVsRecordedGap ?? 0;

  const salesReportUrl =
    "/sales-report?" +
    new URLSearchParams({
      startDate: range.from,
      endDate: range.to,
      ...(groupId ? { stockGroupId: groupId } : {}),
    }).toString();

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="supplier-profit-reconciliation">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3">
        <PageHeader title="Supplier Profit Reconciliation" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void optionsQuery.refetch();
            void reportQuery.refetch();
            void supplierBalanceQuery.refetch();
          }}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3 sm:p-5">
        <div className="mx-auto max-w-4xl space-y-4">
          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
              <label className="space-y-1 text-xs font-medium">
                <span>Supplier</span>
                <select
                  aria-label="Supplier"
                  className={cls}
                  value={supplierId}
                  onChange={(event) => {
                    setSupplierId(event.target.value);
                    setGroupId("");
                  }}
                >
                  <option value="">Select supplier</option>
                  {options?.suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">
                <span>Stock group</span>
                <select
                  aria-label="Stock group"
                  className={cls}
                  value={groupId}
                  onChange={(event) => setGroupId(event.target.value)}
                >
                  <option value="">All groups (items received from supplier)</option>
                  {options?.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">
                <span>Date selection</span>
                <select className={cls} value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
                  <option value="all">All time</option>
                  <option value="day">Specific day</option>
                  <option value="month">Specific month</option>
                  <option value="year">Specific year</option>
                  <option value="custom">Custom date range</option>
                </select>
              </label>
              {period === "day" && (
                <label className="space-y-1 text-xs font-medium">
                  <span>Day</span>
                  <Input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
                </label>
              )}
              {period === "month" && (
                <label className="space-y-1 text-xs font-medium">
                  <span>Month</span>
                  <Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
                </label>
              )}
              {period === "year" && (
                <label className="space-y-1 text-xs font-medium">
                  <span>Year</span>
                  <Input
                    type="number"
                    min="2000"
                    max="2100"
                    value={year}
                    onChange={(event) => setYear(event.target.value)}
                  />
                </label>
              )}
              {period === "custom" && (
                <>
                  <label className="space-y-1 text-xs font-medium">
                    <span>From</span>
                    <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    <span>To</span>
                    <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
                  </label>
                </>
              )}
            </CardContent>
          </Card>

          {optionsQuery.isError && <p className="text-sm text-destructive">{(optionsQuery.error as Error).message}</p>}
          {reportQuery.isError && (
            <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              {(reportQuery.error as Error).message}
            </p>
          )}
          {!validRange && <p className="text-sm text-destructive">Choose a valid date range.</p>}
          {reportQuery.isLoading && supplierId && (
            <p className="text-sm text-muted-foreground">Calculating supplier amounts…</p>
          )}
          {!optionsQuery.isLoading && !options?.suppliers.length && (
            <p className="text-sm text-muted-foreground">No container-linked suppliers in this company.</p>
          )}

          {report && totals && validRange && (
            <Card>
              <CardContent className="space-y-4 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{report.supplier.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {isAllTime ? "All time" : (range.from || "Beginning") + " — " + (range.to || "Now")}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => navigate(salesReportUrl)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open Sales Report
                  </Button>
                </div>

                <SummarySection title="CONTAINERS">
                  <SummaryRow
                    label={"Offloading cost (" + totals.offloadedContainers + " offloaded containers)"}
                    value={dollars(totals.offloadingCharges)}
                  />
                  <SummaryRow
                    label={"Offloaded " + totals.offloadedContainers + " containers (without offloading cost)"}
                    value={dollars(totals.offloadedBase)}
                  />
                  <SummaryRow
                    label={"OTW " + totals.otwContainers + " containers (without offloading cost)"}
                    value={dollars(totals.otwBase)}
                  />
                  {isAllTime && (
                    <SummaryRow
                      label="Total cost of all containers"
                      value={dollars(totals.offloadedBase + totals.offloadingCharges + totals.otwBase)}
                      emphasis
                    />
                  )}
                </SummarySection>

                <SummarySection title="STOCK + SALES">
                  <SummaryRow label="Sold bales" value={dollars(totals.salesRevenue)} />
                  <SummaryRow label="Stock in hand (including offloading cost)" value={dollars(totals.currentStock)} />
                  <SummaryRow
                    label="Total stock + sales"
                    value={dollars(totals.salesRevenue + totals.currentStock)}
                    emphasis
                  />
                </SummarySection>

                <SummarySection title="PROFIT & SUPPLIER BALANCE">
                  {isAllTime && (
                    <SummaryRow label="Calculated profit from containers" value={dollars(totals.modeledProfit)} />
                  )}
                  <SummaryRow label="Total profit on the system" value={dollars(totals.storedProfit)} emphasis />
                  {isAllTime && (
                    <SummaryRow label="Difference" value={dollars(bridgeGap)} attention={Math.abs(bridgeGap) > 0.009} />
                  )}
                  <SummaryRow
                    label="Amount owed to supplier"
                    value={
                      supplierBalanceQuery.isLoading
                        ? "…"
                        : supplierBalanceQuery.data
                          ? dollars(supplierBalanceQuery.data.balance)
                          : "Unavailable"
                    }
                    emphasis
                  />
                </SummarySection>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {isAllTime
                    ? "Container profit is an estimate; shared stock items can belong to other suppliers. Supplier balance comes from the ledger."
                    : "Sales and offloaded receipts follow the selected dates. Stock, OTW and supplier balance are current; historical container profit is not calculated."}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
