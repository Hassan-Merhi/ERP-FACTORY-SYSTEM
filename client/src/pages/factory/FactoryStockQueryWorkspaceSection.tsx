// Extracted from ./FactoryStockQueryWorkspace.tsx to keep that module under the source-size cap.
import { CalendarDays, ChartNoAxesColumnIncreasing, Package, ShoppingCart, TrendingUp, Warehouse } from "lucide-react";
import {
  cell,
  fmt,
  money,
  useFactoryStockQueryWorkspaceState,
  type DisplayColumn,
  type Product,
} from "./useFactoryStockQueryWorkspaceState";
import { RowsExportMenu, type RowsExportColumn } from "@/components/export/RowsExportMenu";
import { SearchField } from "@/components/ui/search-field";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";
export { FactoryStockQueryWorkspaceSection2 } from "./FactoryStockQueryWorkspaceSection2";

export function FactoryStockQueryWorkspaceSection({
  displayedProducts,
  from,
  mhd,
  products,
  search,
  selectedId,
  setSearch,
  setSelectedId,
  setSort,
  setVisible,
  sort,
  to,
  visible,
}: Pick<
  ReturnType<typeof useFactoryStockQueryWorkspaceState>,
  | "displayedProducts"
  | "from"
  | "mhd"
  | "products"
  | "search"
  | "selectedId"
  | "setSearch"
  | "setSelectedId"
  | "setSort"
  | "setVisible"
  | "sort"
  | "to"
  | "visible"
>) {
  // The Inventory in Hand table as shown, honouring the Columns picker.
  const inventoryExportColumns: RowsExportColumn<Product>[] = [
    { header: "Item / Product", value: (p) => mhd.nameFor(p.code, p.name) },
    { header: "Code", value: (p) => p.code },
    ...(visible.category ? [{ header: "Category", value: (p: Product) => p.categoryName }] : []),
    ...(visible.bales ? [{ header: "Bales", value: (p: Product) => p.bales, type: "number" as const }] : []),
    ...(visible.kg ? [{ header: "In hand (kg)", value: (p: Product) => p.kg, type: "number" as const }] : []),
    ...(visible.soldBales ? [{ header: "Sold", value: (p: Product) => p.soldBales, type: "number" as const }] : []),
    ...(visible.salesValue
      ? [{ header: "Sales value", value: (p: Product) => p.salesValue, type: "number" as const }]
      : []),
  ];
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b factory-brand-gradient p-3.5 text-white">
        <Package className="h-5 w-5" />
        <h2 className="font-semibold">Inventory in Hand (by item)</h2>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{products.length} items</span>
        <RowsExportMenu
          title="Factory Stock Query Inventory in Hand"
          sheetName="Inventory in Hand"
          rows={displayedProducts}
          columns={inventoryExportColumns}
          period={{ from: from || null, to: to || null }}
          resource="factory.bales"
          variant="secondary"
          className="ml-auto h-8"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <SearchField
          wrapperClassName="min-w-[190px] flex-1"
          placeholder="Search item or code..."
          value={search}
          onValueChange={setSearch}
          data-testid="input-stock-search"
        />
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="h-10 w-auto rounded-lg shadow-sm" aria-label="Sort products">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Name A–Z</SelectItem>
            <SelectItem value="stock">Most stock</SelectItem>
            <SelectItem value="sold">Most sold</SelectItem>
            <SelectItem value="sales">Highest sales value</SelectItem>
          </SelectContent>
        </Select>
        <details className="relative">
          <summary className="cursor-pointer rounded-lg border px-3 py-2 text-xs font-semibold">Columns</summary>
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
                {visible.salesValue && <td className={cell + " text-right tabular-nums"}>{money(p.salesValue)}</td>}
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
  );
}

export function FactoryStockQueryWorkspaceSection3({
  dateDisplay,
  itemSales,
}: Pick<ReturnType<typeof useFactoryStockQueryWorkspaceState>, "dateDisplay" | "itemSales">) {
  return (
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
  );
}

export function FactoryStockQueryWorkspaceSection4({
  sales,
  totalBales,
  totalSalesValue,
  totalSold,
  totalSoldKg,
  totalStock,
}: Pick<
  ReturnType<typeof useFactoryStockQueryWorkspaceState>,
  "sales" | "totalBales" | "totalSalesValue" | "totalSold" | "totalSoldKg" | "totalStock"
>) {
  return (
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
  );
}
