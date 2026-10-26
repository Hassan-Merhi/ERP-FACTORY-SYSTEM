import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  Download,
  RefreshCw,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

type Options = {
  suppliers: { id: number; name: string; stock_group_id: number | null }[];
  groups: { id: number; name: string }[];
};
type MoneyTotals = {
  salesRevenue: number;
  recordedCogs: number;
  storedProfit: number;
  salesReportProfit: number;
  roundingGap: number;
  quantitySold: number;
  saleLines: number;
  offloadedLanded: number;
  offloadingCharges: number;
  offloadedBase: number;
  currentStock: number;
  currentStockQuantity: number;
  otwBase: number;
  otwContainers: number;
  offloadedContainers: number;
  modeledProfit: number;
  modeledVsRecordedGap: number;
};
type Report = {
  readOnly: boolean;
  supplier: { id: number; name: string };
  dateRange: { from: string | null; to: string | null };
  grouping: string;
  sourceBasis: Record<string, string>;
  totals: MoneyTotals;
  warnings: string[];
  periods: {
    period: string;
    revenue: number;
    cogs: number;
    salesReportProfit: number;
    storedProfit: number;
    lines: number;
  }[];
  saleDetails: {
    id: number;
    voucherId: number;
    voucher: string;
    date: string;
    code: string;
    name: string;
    qty: number;
    revenue: number;
    cogs: number;
    storedProfit: number;
  }[];
  detailsTruncated: boolean;
  offloads: {
    offloadId: number;
    containerId: number;
    number: string;
    date: string;
    status: string;
    quantity: number;
    landed: number;
    offloadingCost: number;
    baseCost: number;
    fullOffloadCharges: number;
  }[];
  otw: { id: number; number: string; date: string; status: string; base: number }[];
  items: {
    id: number;
    code: string;
    name: string;
    group: string | null;
    soldQty: number;
    revenue: number;
    cogs: number;
    storedProfit: number;
    receivedQty: number;
    received: number;
    stockQty: number;
    currentStockValue: number;
    supplierCount: number;
    gap: number;
  }[];
  itemsTruncated: boolean;
};
type Period = "all" | "day" | "month" | "year" | "custom";
type DetailTab = "items" | "sales" | "offloads" | "otw";

const dollars = (n: number | string | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n ?? 0));
const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n);
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
function exportCsv(name: string, columns: string[], values: (string | number)[][]) {
  const escape = (value: string | number) => {
    const s = String(value ?? "");
    const safe = /^[=+@-]/.test(s.trimStart()) ? "'" + s : s;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const content = [columns, ...values].map((row) => row.map(escape).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function Kpi({ label, value, note, attention }: { label: string; value: string; note?: string; attention?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
        <p
          className={`mt-1 font-mono text-xl font-semibold tabular-nums ${attention ? "text-amber-600 dark:text-amber-400" : ""}`}
        >
          {value}
        </p>
        {note && <p className="text-xs text-muted-foreground mt-1">{note}</p>}
      </CardContent>
    </Card>
  );
}
function DataSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <CardTitle className="text-base">
            {title} <span className="ml-1 text-xs font-normal text-muted-foreground">({count})</span>
          </CardTitle>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </CardHeader>
      {open && <CardContent className="px-4 pb-4 pt-0">{children}</CardContent>}
    </Card>
  );
}
function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="w-full overflow-x-auto rounded-md border">
      <table className="w-full text-sm whitespace-nowrap">{children}</table>
    </div>
  );
}
const th = "p-2.5 text-left font-medium text-muted-foreground bg-muted/50";
const td = "px-2.5 py-2 border-t";
const moneyTd = td + " text-right font-mono tabular-nums";

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
  const [grouping, setGrouping] = useState<"daily" | "monthly" | "yearly">("monthly");
  const [tab, setTab] = useState<DetailTab>("items");
  const [showSources, setShowSources] = useState(false);

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
    if (!options.suppliers.some((s) => String(s.id) === supplierId)) setSupplierId(String(options.suppliers[0].id));
  }, [options, supplierId]);

  const range = useMemo(() => {
    if (period === "all") return { from: "", to: "" };
    if (period === "day") return { from: day, to: day };
    if (period === "month") return { from: firstDay(month), to: lastDay(month) };
    if (period === "year")
      return /^\d{4}$/.test(year) ? { from: year + "-01-01", to: year + "-12-31" } : { from: "", to: "" };
    return { from, to };
  }, [period, day, month, year, from, to]);
  const params = useMemo(() => {
    const p = new URLSearchParams({ supplierId, grouping });
    if (groupId) p.set("groupId", groupId);
    if (range.from) p.set("startDate", range.from);
    if (range.to) p.set("endDate", range.to);
    return p.toString();
  }, [supplierId, groupId, grouping, range]);
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
    enabled:
      !!selectedCompany?.id &&
      !!supplierId &&
      (period !== "year" || /^\d{4}$/.test(year)) &&
      (period !== "month" || !!firstDay(month)) &&
      (period !== "custom" || !range.from || !range.to || range.from <= range.to),
  });
  const supplierBalanceQuery = useQuery<{ balance: string | number; balanceBasis?: string }>({
    queryKey: companyQueryKey("/api/suppliers/" + supplierId + "/balance", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/suppliers/" + supplierId + "/balance", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw Error("Supplier statement unavailable");
      return r.json();
    },
    enabled: !!supplierId && !!selectedCompany?.id,
  });
  const report = reportQuery.data;
  const t = report?.totals;
  const isAllTime = period === "all";
  const hasMismatch = !!t && Math.abs(t.roundingGap) > 0.009;

  function download() {
    if (!report) return;
    const prefix = `Supplier-Profit-${report.supplier.name.replace(/[^a-z0-9_-]+/gi, "-")}-${range.from || "all"}`;
    if (tab === "sales")
      exportCsv(
        prefix + "-sales.csv",
        ["Date", "Voucher", "Code", "Item", "Qty", "Revenue", "COGS", "Stored Profit"],
        report.saleDetails.map((x) => [x.date, x.voucher, x.code, x.name, x.qty, x.revenue, x.cogs, x.storedProfit])
      );
    else if (tab === "offloads")
      exportCsv(
        prefix + "-offloads.csv",
        ["Date", "Container", "Qty", "Base Cost", "Offloading Charges Allocated", "Landed Cost"],
        report.offloads.map((x) => [x.date, x.number, x.quantity, x.baseCost, x.offloadingCost, x.landed])
      );
    else if (tab === "otw")
      exportCsv(
        prefix + "-otw.csv",
        ["Date", "Container", "Status", "Base Amount"],
        report.otw.map((x) => [x.date, x.number, x.status, x.base])
      );
    else
      exportCsv(
        prefix + "-items.csv",
        [
          "Code",
          "Item",
          "Group",
          "Received Qty",
          "Landed Receipts",
          "Sold Qty",
          "Revenue",
          "Recorded COGS",
          "Stored Profit",
          "Current Stock Qty",
          "Current Stock Value",
          "Bridge Gap",
          "Supplier Count",
        ],
        report.items.map((x) => [
          x.code,
          x.name,
          x.group ?? "",
          x.receivedQty,
          x.received,
          x.soldQty,
          x.revenue,
          x.cogs,
          x.storedProfit,
          x.stockQty,
          x.currentStockValue,
          x.gap,
          x.supplierCount,
        ])
      );
  }

  return (
    <div className="flex flex-col min-w-0 h-full" data-testid="supplier-profit-reconciliation">
      <div className="border-b bg-background px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <PageHeader title="Supplier Profit Reconciliation" />
          <p className="text-xs text-muted-foreground mt-1">
            Compare recorded Sales Report profit with source container costs. Read-only.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Badge variant="secondary">
            <ShieldCheck className="h-3 w-3 mr-1" />
            No accounting changes
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void optionsQuery.refetch();
              void reportQuery.refetch();
              void supplierBalanceQuery.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-5">
        <Card>
          <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <label className="text-xs font-medium space-y-1">
              <span>Supplier</span>
              <select
                aria-label="Supplier"
                className={cls}
                value={supplierId}
                onChange={(e) => {
                  setSupplierId(e.target.value);
                  setGroupId("");
                }}
              >
                {!supplierId && <option value="">Select supplier</option>}
                {options?.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium space-y-1">
              <span>Stock group</span>
              <select
                aria-label="Stock group"
                className={cls}
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                <option value="">All groups (items received from supplier)</option>
                {options?.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium space-y-1">
              <span>Date selection</span>
              <select className={cls} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                <option value="all">All time</option>
                <option value="day">Specific day</option>
                <option value="month">Specific month</option>
                <option value="year">Specific year</option>
                <option value="custom">Custom date range</option>
              </select>
            </label>
            <label className="text-xs font-medium space-y-1">
              <span>Sales grouping (like Sales Report)</span>
              <select className={cls} value={grouping} onChange={(e) => setGrouping(e.target.value as typeof grouping)}>
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            {period === "day" && (
              <label className="text-xs font-medium space-y-1">
                <span>Day</span>
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </label>
            )}
            {period === "month" && (
              <label className="text-xs font-medium space-y-1">
                <span>Month</span>
                <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              </label>
            )}
            {period === "year" && (
              <label className="text-xs font-medium space-y-1">
                <span>Year</span>
                <Input type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(e.target.value)} />
              </label>
            )}
            {period === "custom" && (
              <>
                <label className="text-xs font-medium space-y-1">
                  <span>From</span>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="text-xs font-medium space-y-1">
                  <span>To</span>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
              </>
            )}
          </CardContent>
        </Card>

        {optionsQuery.isError && <p className="text-destructive">{(optionsQuery.error as Error).message}</p>}
        {reportQuery.isError && (
          <div className="border border-destructive/40 rounded-md p-3 text-sm text-destructive">
            {(reportQuery.error as Error).message}
          </div>
        )}
        {reportQuery.isLoading && supplierId && (
          <p className="text-muted-foreground">Calculating recorded sales and tracing container costs…</p>
        )}
        {!optionsQuery.isLoading && !options?.suppliers.length && (
          <p className="text-muted-foreground">No container-linked suppliers in this company.</p>
        )}

        {t && report && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-lg flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                {report.supplier.name}
              </h2>
              <span className="text-xs text-muted-foreground">
                Period: {range.from || "Beginning"} – {range.to || "Now"} · Stored sale values
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <Kpi
                label="Sales (posted, selected period)"
                value={dollars(t.salesRevenue)}
                note={`${t.saleLines} sales lines · ${qty(t.quantitySold)} units`}
              />
              <Kpi label="Cost of goods sold" value={dollars(t.recordedCogs)} note="Recorded sale-time cost" />
              <Kpi
                label="Sales Report cost profit"
                value={dollars(t.salesReportProfit)}
                note="Revenue − recorded COGS"
              />
              <Kpi label="Saved system profit" value={dollars(t.storedProfit)} note="Sum of saved sale-line profit" />
            </div>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h3 className="font-semibold">Sales Report verification</h3>
                  <Badge variant={hasMismatch ? "destructive" : "secondary"}>
                    {hasMismatch ? "Difference" : "Matches to the cent"}
                  </Badge>
                </div>
                <div className="flex flex-wrap justify-between text-sm gap-3 border-b pb-2">
                  <span>Sales Report cost profit vs saved sale-line profit</span>
                  <strong className="font-mono">{dollars(t.roundingGap)}</strong>
                </div>
                <div className="text-xs text-muted-foreground">
                  This is the direct comparison on the same saved sales lines, date basis, and current item group
                  membership as Sales Report. It is different from the container-cost bridge below.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigate(
                      `/sales-report?${new URLSearchParams({
                        startDate: range.from,
                        endDate: range.to,
                        ...(groupId ? { stockGroupId: groupId } : {}),
                      })}`
                    )
                  }
                >
                  <ExternalLink className="h-4 w-4 mr-1" />
                  Open Sales Report
                </Button>
              </CardContent>
            </Card>

            <h3 className="font-semibold">Container and inventory reconciliation</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <Kpi
                label="Offloaded, excluding allocated charges"
                value={dollars(t.offloadedBase)}
                note={`${t.offloadedContainers} supplier containers in receipt date range`}
              />
              <Kpi
                label="Allocated offloading charges"
                value={dollars(t.offloadingCharges)}
                note="From saved offload charges, allocated by bale share"
              />
              <Kpi
                label="Offloaded landed cost"
                value={dollars(t.offloadedLanded)}
                note="Base + charges; saved receipt value"
              />
              <Kpi
                label="Current stock including landed cost"
                value={dollars(t.currentStock)}
                note={`${qty(t.currentStockQuantity)} units · today, not period end`}
              />
              <Kpi
                label="Current OTW purchase base"
                value={dollars(t.otwBase)}
                note={`${t.otwContainers} containers · not COGS or earned profit`}
              />
              <Kpi
                label="Supplier ledger balance"
                value={supplierBalanceQuery.data ? dollars(supplierBalanceQuery.data.balance) : "Unavailable"}
                note={supplierBalanceQuery.data?.balanceBasis || "Independent supplier ledger; not an OTW subtotal"}
              />
              <Kpi
                label="Illustrative container-cost bridge"
                value={isAllTime ? dollars(t.modeledProfit) : "Not comparable"}
                note={
                  isAllTime
                    ? "Sales − landed receipts + current stock (exceptions apply)"
                    : "Selected sales period cannot use today's stock"
                }
                attention={isAllTime && Math.abs(t.modeledVsRecordedGap) > 0.009}
              />
              <Kpi
                label="Bridge minus saved profit"
                value={isAllTime ? dollars(t.modeledVsRecordedGap) : "—"}
                note={
                  isAllTime
                    ? "Investigate item-level receipts, adjustments and stock movements"
                    : "Historical inventory snapshot unavailable"
                }
                attention={isAllTime && Math.abs(t.modeledVsRecordedGap) > 0.009}
              />
            </div>
            <div className="rounded-lg border p-3 text-sm space-y-2 bg-muted/20">
              {report.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
              <button
                type="button"
                className="underline text-primary text-xs"
                onClick={() => setShowSources((v) => !v)}
              >
                {showSources ? "Hide" : "Show"} exact source definitions
              </button>
              {showSources && (
                <dl className="grid grid-cols-1 gap-2 text-xs pt-2">
                  {Object.entries(report.sourceBasis).map(([key, val]) => (
                    <div key={key}>
                      <dt className="font-semibold capitalize">{key}</dt>
                      <dd className="text-muted-foreground">{val}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <DataSection
              title={`Sales by ${grouping === "daily" ? "day" : grouping === "monthly" ? "month" : "year"}`}
              count={report.periods.length}
            >
              <TableWrap>
                <thead>
                  <tr>
                    <th className={th}>Period</th>
                    {["Sale lines", "Sales", "Recorded COGS", "Sales Report Profit", "Saved Profit", "Difference"].map(
                      (x) => (
                        <th key={x} className={th + " text-right"}>
                          {x}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {report.periods.map((p) => (
                    <tr key={p.period}>
                      <td className={td + " font-medium"}>{p.period}</td>
                      <td className={moneyTd}>{qty(p.lines)}</td>
                      <td className={moneyTd}>{dollars(p.revenue)}</td>
                      <td className={moneyTd}>{dollars(p.cogs)}</td>
                      <td className={moneyTd}>{dollars(p.salesReportProfit)}</td>
                      <td className={moneyTd}>{dollars(p.storedProfit)}</td>
                      <td className={moneyTd}>{dollars(p.salesReportProfit - p.storedProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </DataSection>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex gap-2 flex-wrap">
                {(
                  [
                    { id: "items", label: "Item reconciliation" },
                    { id: "sales", label: "Sale vouchers" },
                    { id: "offloads", label: "Offloaded containers" },
                    { id: "otw", label: "OTW containers" },
                  ] as const
                ).map((x) => (
                  <Button
                    key={x.id}
                    variant={tab === x.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setTab(x.id)}
                  >
                    {x.label}
                  </Button>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={download}>
                <Download className="h-4 w-4 mr-1" />
                Export{" "}
                {tab === "items"
                  ? "item details"
                  : tab === "sales"
                    ? "sales"
                    : tab === "offloads"
                      ? "offloads"
                      : "OTW"}{" "}
                (CSV)
              </Button>
            </div>

            {tab === "items" && (
              <DataSection title="Items: trace receipts, sales, COGS and inventory" count={report.items.length}>
                <p className="text-xs text-muted-foreground mb-2">
                  Gap = receipts from this supplier − recorded COGS of eligible sales − current stock for the same SKU.
                  Not a posting instruction: opening inventory, other suppliers, returns and transfers must be
                  investigated.
                </p>
                {report.itemsTruncated && (
                  <p className="text-amber-600 text-xs mb-2">
                    Only first 1,000 item rows shown. Do not treat this as a complete reconciliation.
                  </p>
                )}
                <TableWrap>
                  <thead>
                    <tr>
                      {[
                        "Code",
                        "Item / Group",
                        "Suppliers",
                        "Received Qty",
                        "Landed Receipts",
                        "Sold Qty",
                        "Revenue",
                        "COGS",
                        "Saved Profit",
                        "Stock Qty Today",
                        "Stock Value Today",
                        "Gap",
                      ].map((x) => (
                        <th key={x} className={th}>
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.map((i) => (
                      <tr key={i.id}>
                        <td className={td + " font-mono"}>{i.code}</td>
                        <td className={td}>
                          {i.name}
                          <span className="block text-xs text-muted-foreground">{i.group || "No group"}</span>
                        </td>
                        <td className={td}>
                          {i.supplierCount > 1 ? (
                            <Badge variant="destructive">{i.supplierCount} (mixed)</Badge>
                          ) : (
                            i.supplierCount
                          )}
                        </td>
                        {[
                          i.receivedQty,
                          i.received,
                          i.soldQty,
                          i.revenue,
                          i.cogs,
                          i.storedProfit,
                          i.stockQty,
                          i.currentStockValue,
                          i.gap,
                        ].map((v, n) => (
                          <td key={n} className={moneyTd + (n === 8 && Math.abs(v) > 0.009 ? " text-amber-600" : "")}>
                            {n === 0 || n === 2 || n === 6 ? qty(v) : dollars(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </DataSection>
            )}

            {tab === "sales" && (
              <DataSection title="Recorded sales lines" count={t.saleLines}>
                {report.detailsTruncated && (
                  <p className="text-xs text-amber-600 mb-2">
                    Showing latest 300 lines, while summary includes all eligible sales. Export is also limited to these
                    300 rows.
                  </p>
                )}
                <TableWrap>
                  <thead>
                    <tr>
                      {["Date", "Voucher", "Code", "Product", "Qty", "Sales", "COGS", "Profit"].map((x) => (
                        <th key={x} className={th}>
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.saleDetails.map((s) => (
                      <tr key={s.id}>
                        <td className={td}>{s.date}</td>
                        <td className={td}>
                          <button
                            type="button"
                            onClick={() => navigate("/voucher-detail/" + s.voucherId)}
                            className="text-primary hover:underline"
                          >
                            {s.voucher || s.voucherId}
                          </button>
                        </td>
                        <td className={td}>{s.code}</td>
                        <td className={td}>{s.name}</td>
                        <td className={moneyTd}>{qty(s.qty)}</td>
                        <td className={moneyTd}>{dollars(s.revenue)}</td>
                        <td className={moneyTd}>{dollars(s.cogs)}</td>
                        <td className={moneyTd}>{dollars(s.storedProfit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </DataSection>
            )}

            {tab === "offloads" && (
              <DataSection title="Offloaded supplier containers" count={report.offloads.length}>
                <TableWrap>
                  <thead>
                    <tr>
                      {[
                        "Date",
                        "Container",
                        "Units",
                        "Base excl. charges",
                        "Allocated charges",
                        "Landed receipt",
                        "Full container charges",
                      ].map((x) => (
                        <th key={x} className={th}>
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.offloads.map((o) => (
                      <tr key={o.offloadId || o.containerId}>
                        <td className={td}>{o.date}</td>
                        <td className={td}>{o.number}</td>
                        <td className={moneyTd}>{qty(o.quantity)}</td>
                        <td className={moneyTd}>{dollars(o.baseCost)}</td>
                        <td className={moneyTd}>{dollars(o.offloadingCost)}</td>
                        <td className={moneyTd}>{dollars(o.landed)}</td>
                        <td className={moneyTd}>{dollars(o.fullOffloadCharges)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </DataSection>
            )}

            {tab === "otw" && (
              <DataSection title="Current OTW containers (excluded from realized profit)" count={report.otw.length}>
                <TableWrap>
                  <thead>
                    <tr>
                      {["Import Date", "Container", "Status", "Stored base purchase amount"].map((x) => (
                        <th key={x} className={th}>
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.otw.map((o) => (
                      <tr key={o.id}>
                        <td className={td}>{o.date}</td>
                        <td className={td}>{o.number}</td>
                        <td className={td}>{o.status}</td>
                        <td className={moneyTd}>{dollars(o.base)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </DataSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}
