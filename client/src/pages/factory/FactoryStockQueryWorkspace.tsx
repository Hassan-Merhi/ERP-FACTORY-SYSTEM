import { useEffect, useMemo, useState } from "react";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowRight,
  Boxes,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  FilterX,
  MapPin,
  Package,
  Search,
  ShoppingCart,
  TrendingUp,
  Warehouse,
} from "lucide-react";

interface Option {
  id: number;
  name: string;
}
interface LocationSummary {
  id: number | null;
  name: string;
  bales: number;
  kg: number;
}
interface Product {
  id: number;
  name: string;
  code: string;
  categoryId: number | null;
  categoryName: string;
  bales: number;
  kg: number;
  soldBales: number;
  soldKg: number;
  salesValue: number;
  locations: LocationSummary[];
}
interface Sale {
  productId: number;
  orderId: number;
  invoiceNumber: string;
  date: string;
  containerNumber: string | null;
  customerId: number;
  customerName: string;
  qty: number;
  kg: number;
  total: number;
  pricePerBale: number;
}
interface Report {
  products: Product[];
  sales: Sale[];
  locations: Option[];
  customers: Option[];
  categories: Option[];
  containers: string[];
}
type DisplayColumn = "category" | "bales" | "kg" | "soldBales" | "salesValue";
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n: number) => numberFormat.format(n || 0);
const money = (n: number) => moneyFormat.format(n || 0);
const csvSafe = (value: string | number) => {
  const text = String(value ?? "");
  return '"' + (/^[\s]*[=+\-@]/.test(text) ? "'" : "") + text.replace(/"/g, '""') + '"';
};
function exportCsv(rows: (string | number)[][]) {
  const csv = rows.map((row) => row.map(csvSafe).join(",")).join("\r\n");
  downloadBlob(
    new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
    exportFileName("factory stock query sales", "csv")
  );
}
const baseSelect =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const cell = "whitespace-nowrap px-3 py-2.5 text-sm";
const label = "block mb-1.5 text-xs font-semibold text-muted-foreground";

export default function FactoryStockQueryWorkspace() {
  const mhd = useFactoryMhdView();
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [location, setLocation] = useState("");
  const [customer, setCustomer] = useState("");
  const [container, setContainer] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("name");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [visible, setVisible] = useState<Record<DisplayColumn, boolean>>({
    category: true,
    bales: true,
    kg: true,
    soldBales: true,
    salesValue: true,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (location) p.set("locationId", location);
    if (customer) p.set("customerId", customer);
    if (container) p.set("container", container);
    // Category is filtered on the client so the full category picker remains available.
    return p.toString();
  }, [from, to, location, customer, container]);

  const { data, isLoading, isFetching, error, refetch } = useQuery<Report>({
    queryKey: ["/api/factory/stock-query-report", selectedCompany?.id, params],
    queryFn: async () => {
      const response = await fetch(`/api/factory/stock-query-report${params ? "?" + params : ""}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Unable to load factory stock and sales");
      return response.json();
    },
  });

  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    const found = (data?.products ?? []).filter(
      (p) =>
        (!q ||
          [p.code, p.name, mhd.nameFor(p.code, p.name), p.categoryName].some((v) => v.toLowerCase().includes(q))) &&
        (!category || String(p.categoryId ?? 0) === category)
    );
    return [...found].sort((a, b) => {
      if (sort === "stock") return b.kg - a.kg || a.name.localeCompare(b.name);
      if (sort === "sales") return b.salesValue - a.salesValue || a.name.localeCompare(b.name);
      if (sort === "sold") return b.soldBales - a.soldBales || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  }, [data?.products, search, category, sort, mhd]);

  const displayedProducts = mhd.sortRows(products, (p) => p.code);

  useEffect(() => {
    if (selectedId != null && products.some((p) => p.id === selectedId)) return;
    setSelectedId(products[0]?.id ?? null);
  }, [products, selectedId]);

  const selected = products.find((p) => p.id === selectedId) ?? null;
  const visibleIds = useMemo(() => new Set(products.map((p) => p.id)), [products]);
  const sales = useMemo(
    () => (data?.sales ?? []).filter((s) => visibleIds.has(s.productId)),
    [data?.sales, visibleIds]
  );
  const itemSales = useMemo(() => sales.filter((s) => s.productId === selectedId), [sales, selectedId]);
  const totalStock = products.reduce((s, p) => s + p.kg, 0);
  const totalBales = products.reduce((s, p) => s + p.bales, 0);
  const totalSold = sales.reduce((s, row) => s + row.qty, 0);
  const totalSoldKg = sales.reduce((s, row) => s + row.kg, 0);
  const totalSalesValue = sales.reduce((s, row) => s + row.total, 0);
  const dateDisplay = (value: string) => {
    if (!value) return "—";
    const date = new Date(value.slice(0, 10) + "T12:00:00");
    return Number.isNaN(date.getTime()) ? value : formatDisplayDate(date);
  };
  const clear = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setLocation("");
    setCustomer("");
    setContainer("");
    setCategory("");
    setSort("name");
  };

  const trend = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const s of itemSales) grouped.set(s.date.slice(0, 10), (grouped.get(s.date.slice(0, 10)) ?? 0) + s.qty);
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-10);
  }, [itemSales]);
  const maxTrend = Math.max(1, ...trend.map(([, value]) => value));

  return (
    <main className="space-y-5 p-3 sm:p-5 lg:p-6" data-testid="factory-stock-query-workspace">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Stock Query – Factory"
          subtitle="Live inventory in hand and finalized sales by product, customer and date"
        />
        <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          Read-only · Factory
        </span>
      </div>

      <section className="rounded-2xl border bg-card p-4 shadow-sm" aria-label="Stock query filters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <label>
            <span className={label}>Date from (sales)</span>
            <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className={label}>Date to (sales)</span>
            <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span className={label}>Category</span>
            <select className={baseSelect} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={label}>Location</span>
            <select className={baseSelect} value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">All locations</option>
              {data?.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={label}>Customer (sales)</span>
            <select className={baseSelect} value={customer} onChange={(e) => setCustomer(e.target.value)}>
              <option value="">All customers</option>
              {data?.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={label}>Container (sales)</span>
            <select className={baseSelect} value={container} onChange={(e) => setContainer(e.target.value)}>
              <option value="">All containers</option>
              {data?.containers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={clear} size="sm">
            <FilterX className="mr-1.5 h-4 w-4" /> Clear filters
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            Refresh
          </Button>
          <ExportButton
            kind="csv"
            variant="outline"
            size="sm"
            onClick={() =>
              exportCsv([
                [
                  "Date",
                  "Customer",
                  "Product",
                  "Invoice",
                  "Container",
                  "Qty (bales)",
                  "Weight (kg)",
                  "Price / bale",
                  "Total",
                ],
                ...sales.map((s) => [
                  s.date,
                  s.customerName,
                  data?.products.find((p) => p.id === s.productId)?.name ?? "",
                  s.invoiceNumber,
                  s.containerNumber ?? "",
                  s.qty,
                  s.kg,
                  s.pricePerBale.toFixed(2),
                  s.total.toFixed(2),
                ]),
              ])
            }
            disabled={!sales.length}
          />
          <span className="ml-auto text-xs text-muted-foreground">
            Inventory is current; date, customer and container filters apply to sales only.
          </span>
        </div>
      </section>

      {error ? (
        <Card>
          <CardContent className="space-y-3 py-8 text-center text-sm text-destructive">
            Could not load Stock Query.{" "}
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading || !data ? (
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                title: "Inventory in hand",
                value: fmt(totalStock) + " kg",
                sub: fmt(totalBales) + " available bales",
                icon: Warehouse,
                tone: "blue",
              },
              {
                title: "Sold quantity",
                value: fmt(totalSold) + " bales",
                sub: fmt(totalSoldKg) + " kg · finalized",
                icon: ShoppingCart,
                tone: "green",
              },
              {
                title: "Sales value",
                value: money(totalSalesValue),
                sub: fmt(sales.length) + " product/order rows",
                icon: TrendingUp,
                tone: "indigo",
              },
              {
                title: "Avg. selling price",
                value: money(totalSoldKg ? totalSalesValue / totalSoldKg : 0) + "/kg",
                sub: money(totalSold ? totalSalesValue / totalSold : 0) + " per bale",
                icon: ChartNoAxesColumnIncreasing,
                tone: "amber",
              },
            ].map(({ title, value, sub, icon: Icon, tone }) => (
              <div key={title} className="rounded-2xl border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-muted-foreground">{title}</p>
                  <span
                    className={`rounded-lg p-2 ${tone === "green" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : tone === "amber" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" : "bg-primary/10 text-primary"}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                </div>
                <p className="mt-1.5 text-2xl font-bold tracking-tight tabular-nums">{value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="flex flex-wrap items-center gap-2 border-b factory-brand-gradient p-3.5 text-white">
                <Package className="h-5 w-5" />
                <h2 className="font-semibold">Inventory in Hand (by item)</h2>
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{products.length} items</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b p-3">
                <div className="relative min-w-[190px] flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search item or code..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    data-testid="input-stock-search"
                  />
                </div>
                <select
                  className={baseSelect + " !w-auto"}
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  aria-label="Sort products"
                >
                  <option value="name">Name A–Z</option>
                  <option value="stock">Most stock</option>
                  <option value="sold">Most sold</option>
                  <option value="sales">Highest sales value</option>
                </select>
                <details className="relative">
                  <summary className="cursor-pointer rounded-lg border px-3 py-2 text-xs font-semibold">
                    Columns
                  </summary>
                  <div className="absolute right-0 top-11 z-20 min-w-44 space-y-2 rounded-xl border bg-popover p-3 shadow-xl">
                    {(["category", "bales", "kg", "soldBales", "salesValue"] as DisplayColumn[]).map((key) => (
                      <label key={key} className="flex items-center gap-2 text-xs capitalize">
                        <input
                          type="checkbox"
                          checked={visible[key]}
                          onChange={(e) => setVisible((v) => ({ ...v, [key]: e.target.checked }))}
                        />
                        {key === "soldBales"
                          ? "Sold bales"
                          : key === "salesValue"
                            ? "Sales value"
                            : key === "kg"
                              ? "Stock kg"
                              : key}
                      </label>
                    ))}
                  </div>
                </details>
              </div>
              <div className="max-h-[440px] overflow-auto" data-horizontal-scroll="true">
                <table className="w-full min-w-[560px] text-left">
                  <thead className="sticky top-0 z-10 bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className={cell}>Item / Product</th>
                      {visible.category && <th className={cell}>Category</th>}
                      {visible.bales && <th className={cell + " text-right"}>Bales</th>}
                      {visible.kg && <th className={cell + " text-right"}>In hand (kg)</th>}
                      {visible.soldBales && <th className={cell + " text-right"}>Sold</th>}
                      {visible.salesValue && <th className={cell + " text-right"}>Sales value</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedProducts.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") setSelectedId(p.id);
                        }}
                        tabIndex={0}
                        aria-selected={selectedId === p.id}
                        data-testid={`row-stock-item-${p.id}`}
                        className={`cursor-pointer border-t transition-colors hover:bg-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selectedId === p.id ? "bg-primary/10" : ""}`}
                      >
                        <td className={cell}>
                          <span className="block font-medium">{mhd.nameFor(p.code, p.name)}</span>
                          <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                        </td>
                        {visible.category && (
                          <td className={cell}>
                            <span className="rounded-md bg-muted px-2 py-1 text-xs">{p.categoryName}</span>
                          </td>
                        )}
                        {visible.bales && <td className={cell + " text-right tabular-nums"}>{fmt(p.bales)}</td>}
                        {visible.kg && <td className={cell + " text-right font-semibold tabular-nums"}>{fmt(p.kg)}</td>}
                        {visible.soldBales && <td className={cell + " text-right tabular-nums"}>{fmt(p.soldBales)}</td>}
                        {visible.salesValue && (
                          <td className={cell + " text-right tabular-nums"}>{money(p.salesValue)}</td>
                        )}
                      </tr>
                    ))}
                    {!products.length && (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">
                          No items match these filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="flex flex-wrap items-center gap-2 border-b factory-brand-gradient p-3.5 text-white">
                <ShoppingCart className="h-5 w-5" />
                <h2 className="font-semibold">Finalized Sales (by item)</h2>
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{sales.length} rows</span>
              </div>
              <p className="border-b px-3 py-2 text-xs text-muted-foreground">
                Customer name, actual scanned-bale selling price, quantity, date and total. Select an item on the left
                to inspect it below.
              </p>
              <div className="max-h-[482px] overflow-auto" data-horizontal-scroll="true">
                <table className="w-full min-w-[700px] text-left">
                  <thead className="sticky top-0 z-10 bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className={cell}>Date</th>
                      <th className={cell}>Customer</th>
                      <th className={cell}>Product</th>
                      <th className={cell + " text-right"}>Qty</th>
                      <th className={cell + " text-right"}>Price/bale</th>
                      <th className={cell + " text-right"}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((s) => (
                      <tr
                        key={`${s.orderId}-${s.productId}`}
                        className="cursor-pointer border-t hover:bg-muted/60"
                        onClick={() => setSelectedId(s.productId)}
                      >
                        <td className={cell}>{dateDisplay(s.date)}</td>
                        <td className={cell + " font-medium"}>{s.customerName}</td>
                        <td className={cell}>{data.products.find((p) => p.id === s.productId)?.name ?? "—"}</td>
                        <td className={cell + " text-right tabular-nums"}>{fmt(s.qty)}</td>
                        <td className={cell + " text-right tabular-nums"}>{money(s.pricePerBale)}</td>
                        <td className={cell + " text-right font-semibold tabular-nums"}>{money(s.total)}</td>
                      </tr>
                    ))}
                    {!sales.length && (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">
                          No finalized sales in these filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot className="sticky bottom-0 border-t bg-muted font-semibold">
                    <tr>
                      <td colSpan={3} className={cell}>
                        Filtered total
                      </td>
                      <td className={cell + " text-right"}>{fmt(totalSold)}</td>
                      <td />
                      <td className={cell + " text-right"}>{money(totalSalesValue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </div>

          {selected && (
            <section
              className="space-y-4 rounded-2xl border bg-card p-4 shadow-sm"
              data-testid="factory-stock-selected-item"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Boxes className="h-5 w-5 text-primary" />
                    <h2 className="text-lg font-bold">{mhd.nameFor(selected.code, selected.name)}</h2>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.code} · {selected.categoryName}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate(`/factory/stock-query/${selected.id}`)}>
                  Full product history <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border bg-primary/10 p-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Warehouse className="h-4 w-4" /> Current inventory
                  </p>
                  <p className="mt-1 text-xl font-bold">{fmt(selected.kg)} kg</p>
                  <p className="text-xs text-muted-foreground">{fmt(selected.bales)} available bales</p>
                </div>
                <div className="rounded-xl border bg-emerald-50/60 p-3 dark:bg-emerald-950/20">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShoppingCart className="h-4 w-4" /> Sold in selected period
                  </p>
                  <p className="mt-1 text-xl font-bold">{fmt(selected.soldBales)} bales</p>
                  <p className="text-xs text-muted-foreground">{fmt(selected.soldKg)} kg</p>
                </div>
                <div className="rounded-xl border bg-primary/10 p-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <TrendingUp className="h-4 w-4" /> Sales total
                  </p>
                  <p className="mt-1 text-xl font-bold">{money(selected.salesValue)}</p>
                  <p className="text-xs text-muted-foreground">
                    {money(selected.soldBales ? selected.salesValue / selected.soldBales : 0)} / bale
                  </p>
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="min-w-0">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <MapPin className="h-4 w-4" /> In-hand by location
                  </h3>
                  <div className="overflow-auto rounded-xl border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted">
                        <tr>
                          <th className={cell + " text-left"}>Location</th>
                          <th className={cell + " text-right"}>Bales</th>
                          <th className={cell + " text-right"}>KG</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.locations.map((l) => (
                          <tr key={l.id ?? "unassigned"} className="border-t">
                            <td className={cell}>{l.name}</td>
                            <td className={cell + " text-right"}>{fmt(l.bales)}</td>
                            <td className={cell + " text-right"}>{fmt(l.kg)}</td>
                          </tr>
                        ))}
                        {!selected.locations.length && (
                          <tr>
                            <td colSpan={3} className="p-5 text-center text-muted-foreground">
                              No available inventory
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="min-w-0">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <ChartNoAxesColumnIncreasing className="h-4 w-4" /> Recent sales quantity by date
                  </h3>
                  <div className="flex h-44 items-end gap-1 overflow-x-auto rounded-xl border px-3 pb-2 pt-4">
                    {!trend.length ? (
                      <p className="m-auto text-sm text-muted-foreground">No finalized sales in selected period</p>
                    ) : (
                      trend.map(([day, qty]) => (
                        <div
                          key={day}
                          className="flex min-w-9 flex-1 flex-col items-center justify-end gap-1"
                          title={`${day}: ${qty} bales`}
                        >
                          <span className="text-[10px] text-muted-foreground">{fmt(qty)}</span>
                          <div
                            className="w-full max-w-14 rounded-t bg-primary"
                            style={{ height: `${Math.max(4, Math.round((qty / maxTrend) * 112))}px` }}
                          />
                          <span className="text-[10px] text-muted-foreground">{day.slice(5)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <CalendarDays className="h-4 w-4" /> Sales details for this item
                </h3>
                <div className="max-h-72 overflow-auto rounded-xl border">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className={cell + " text-left"}>Date</th>
                        <th className={cell + " text-left"}>Customer</th>
                        <th className={cell + " text-left"}>Invoice</th>
                        <th className={cell + " text-right"}>Qty</th>
                        <th className={cell + " text-right"}>Price / bale</th>
                        <th className={cell + " text-right"}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itemSales.map((s) => (
                        <tr className="border-t" key={s.orderId}>
                          <td className={cell}>{dateDisplay(s.date)}</td>
                          <td className={cell}>{s.customerName}</td>
                          <td className={cell + " font-mono"}>{s.invoiceNumber}</td>
                          <td className={cell + " text-right"}>{fmt(s.qty)}</td>
                          <td className={cell + " text-right"}>{money(s.pricePerBale)}</td>
                          <td className={cell + " text-right font-semibold"}>{money(s.total)}</td>
                        </tr>
                      ))}
                      {!itemSales.length && (
                        <tr>
                          <td colSpan={6} className="p-5 text-center text-muted-foreground">
                            No finalized sales
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
