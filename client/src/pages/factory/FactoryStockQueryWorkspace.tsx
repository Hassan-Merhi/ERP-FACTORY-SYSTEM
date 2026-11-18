import { ExportButton } from "@/components/export/ReportExportMenu";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Boxes, FilterX, MapPin, ShoppingCart, TrendingUp, Warehouse } from "lucide-react";
import {
  cell,
  exportCsv,
  fmt,
  label,
  money,
  useFactoryStockQueryWorkspaceState,
} from "./useFactoryStockQueryWorkspaceState";
import {
  FactoryStockQueryWorkspaceSection,
  FactoryStockQueryWorkspaceSection2,
  FactoryStockQueryWorkspaceSection3,
  FactoryStockQueryWorkspaceSection4,
} from "./FactoryStockQueryWorkspaceSection";
import { SelectContent, SelectTrigger, SelectValue, Select, SelectItem } from "@/components/ui/select";

export default function FactoryStockQueryWorkspace() {
  const {
    category,
    clear,
    container,
    customer,
    data,
    dateDisplay,
    displayedProducts,
    error,
    from,
    isFetching,
    isLoading,
    itemSales,
    location,
    maxTrend,
    mhd,
    navigate,
    products,
    refetch,
    sales,
    search,
    selected,
    selectedId,
    setCategory,
    setContainer,
    setCustomer,
    setFrom,
    setLocation,
    setSearch,
    setSelectedId,
    setSort,
    setTo,
    setVisible,
    sort,
    to,
    totalBales,
    totalSalesValue,
    totalSold,
    totalSoldKg,
    totalStock,
    trend,
    visible,
  } = useFactoryStockQueryWorkspaceState();

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
            <Select value={category || "__all__"} onValueChange={(v) => setCategory(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-10 w-full min-w-0 rounded-lg shadow-sm" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All categories</SelectItem>
                {data?.categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            <span className={label}>Location</span>
            <Select value={location || "__all__"} onValueChange={(v) => setLocation(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-10 w-full min-w-0 rounded-lg shadow-sm" aria-label="Location">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All locations</SelectItem>
                {data?.locations.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            <span className={label}>Customer (sales)</span>
            <Select value={customer || "__all__"} onValueChange={(v) => setCustomer(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-10 w-full min-w-0 rounded-lg shadow-sm" aria-label="Customer (sales)">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All customers</SelectItem>
                {data?.customers.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            <span className={label}>Container (sales)</span>
            <Select value={container || "__all__"} onValueChange={(v) => setContainer(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-10 w-full min-w-0 rounded-lg shadow-sm" aria-label="Container (sales)">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All containers</SelectItem>
                {data?.containers.map((c) => (
                  <SelectItem key={c} value={String(c)}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          <FactoryStockQueryWorkspaceSection4
            sales={sales}
            totalBales={totalBales}
            totalSalesValue={totalSalesValue}
            totalSold={totalSold}
            totalSoldKg={totalSoldKg}
            totalStock={totalStock}
          />

          <div className="grid gap-4 xl:grid-cols-2">
            <FactoryStockQueryWorkspaceSection
              displayedProducts={displayedProducts}
              mhd={mhd}
              products={products}
              search={search}
              selectedId={selectedId}
              setSearch={setSearch}
              setSelectedId={setSelectedId}
              setSort={setSort}
              setVisible={setVisible}
              sort={sort}
              visible={visible}
            />

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
                <FactoryStockQueryWorkspaceSection2 maxTrend={maxTrend} trend={trend} />
              </div>
              <FactoryStockQueryWorkspaceSection3 dateDisplay={dateDisplay} itemSales={itemSales} />
            </section>
          )}
        </>
      )}
    </main>
  );
}
