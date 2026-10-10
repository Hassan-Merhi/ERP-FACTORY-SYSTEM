import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getJson, money, type Brand, type Location, type RetailCatalogFacets } from "./retailInventoryTypes";

interface StockRow {
  variantId: number;
  brand: string;
  style: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
  quantity: number;
  lowStockThreshold: number;
  stockValue: number;
  locations: string;
  lastSaleAt: string | null;
}

interface SalesRow {
  variantId: number;
  brand: string;
  style: string;
  color: string;
  size: string;
  barcode: string;
  sku: string | null;
  soldQuantity: number;
  returnedQuantity: number;
  netQuantity: number;
  netRevenue: number;
  netCost: number;
  profit: number;
}

type ReportKind = "stock" | "sales";

const STATUS_OPTIONS = [
  { value: "all", label: "All stock" },
  { value: "in", label: "In stock" },
  { value: "low", label: "Low stock" },
  { value: "out", label: "Out of stock" },
  { value: "slow", label: "Slow-moving" },
];

/** Exact-variant stock and sales reports by brand, style, color, size, barcode, SKU and location. */
export function RetailVariantReports({ companyKey }: { companyKey: number }) {
  const [kind, setKind] = useState<ReportKind>("stock");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [brandId, setBrandId] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ["retail-brands", companyKey],
    queryFn: () => getJson("/api/retail/brands"),
  });
  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["retail-locations", companyKey],
    queryFn: () => getJson("/api/locations"),
  });
  const { data: facets } = useQuery<RetailCatalogFacets>({
    queryKey: ["retail-catalog-facets", companyKey],
    queryFn: () => getJson("/api/retail/catalog-facets"),
    staleTime: 60_000,
  });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (debounced) params.set("search", debounced);
    if (brandId) params.set("brandId", brandId);
    if (color) params.set("color", color);
    if (size) params.set("size", size);
    if (locationId) params.set("locationId", locationId);
    if (kind === "stock") params.set("status", status);
    if (kind === "sales") {
      params.set("from", new Date(`${from}T00:00:00`).toISOString());
      params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    }
    return params.toString();
  }, [debounced, brandId, color, size, locationId, status, kind, from, to]);

  const endpoint = kind === "stock" ? "/api/retail/reporting/stock" : "/api/retail/reporting/variant-sales";
  const { data: rows = [], isLoading } = useQuery<Array<StockRow | SalesRow>>({
    queryKey: ["retail-variant-report", companyKey, kind, query],
    queryFn: () => getJson(`${endpoint}?${query}`),
  });

  const selectClass = "h-10 rounded-md border bg-background px-2 text-sm";
  const stockRows = kind === "stock" ? (rows as StockRow[]) : [];
  const salesRows = kind === "sales" ? (rows as SalesRow[]) : [];

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Variant reports</CardTitle>
          <div className="flex gap-1 rounded-md bg-muted p-1">
            {(["stock", "sales"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={cn(
                  "rounded-sm px-3 py-1 text-sm",
                  kind === value ? "bg-background shadow-sm" : "text-muted-foreground"
                )}
              >
                {value === "stock" ? "Stock by variant" : "Sales by variant"}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
          <Input
            className="col-span-2"
            placeholder="Style, brand, barcode or SKU…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select className={selectClass} value={brandId} onChange={(event) => setBrandId(event.target.value)}>
            <option value="">All brands</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
          <select className={selectClass} value={color} onChange={(event) => setColor(event.target.value)}>
            <option value="">All colors</option>
            {(facets?.colors ?? []).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select className={selectClass} value={size} onChange={(event) => setSize(event.target.value)}>
            <option value="">All sizes</option>
            {(facets?.sizes ?? []).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select className={selectClass} value={locationId} onChange={(event) => setLocationId(event.target.value)}>
            <option value="">All locations</option>
            {locations
              .filter((location) => location.id > 0 && location.active !== false)
              .map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
          </select>
          {kind === "stock" ? (
            <select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <>
              <Input type="date" aria-label="From" value={from} onChange={(event) => setFrom(event.target.value)} />
              <Input type="date" aria-label="To" value={to} onChange={(event) => setTo(event.target.value)} />
            </>
          )}
          <Button variant="outline" asChild>
            <a href={`${endpoint}?${query}&format=csv`} download>
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        ) : !rows.length ? (
          <p className="text-sm text-muted-foreground">No rows for these filters.</p>
        ) : kind === "stock" ? (
          <table className="w-full min-w-[900px] text-sm [&_td]:px-2 [&_th]:px-2" data-testid="stock-report">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Brand</th>
                <th>Style</th>
                <th>Color</th>
                <th>Size</th>
                <th>Barcode</th>
                <th>SKU</th>
                <th className="text-right">Quantity</th>
                <th>Locations</th>
                <th className="text-right">Stock value</th>
                <th>Last sale</th>
              </tr>
            </thead>
            <tbody>
              {stockRows.map((row) => (
                <tr key={row.variantId} className="border-b last:border-0">
                  <td className="py-1.5">{row.brand}</td>
                  <td>{row.style}</td>
                  <td>{row.color}</td>
                  <td>{row.size}</td>
                  <td className="font-mono text-xs">{row.barcode}</td>
                  <td className="text-xs">{row.sku ?? "—"}</td>
                  <td
                    className={cn(
                      "text-right font-semibold",
                      row.quantity <= 0 && "text-destructive",
                      row.quantity > 0 && row.quantity <= row.lowStockThreshold && "text-amber-600"
                    )}
                  >
                    {row.quantity}
                  </td>
                  <td className="text-xs text-muted-foreground">{row.locations || "—"}</td>
                  <td className="text-right">{money(row.stockValue)}</td>
                  <td className="text-xs">{row.lastSaleAt ? new Date(row.lastSaleAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full min-w-[900px] text-sm [&_td]:px-2 [&_th]:px-2" data-testid="sales-report">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Brand</th>
                <th>Style</th>
                <th>Color</th>
                <th>Size</th>
                <th>Barcode</th>
                <th className="text-right">Sold</th>
                <th className="text-right">Returned</th>
                <th className="text-right">Net</th>
                <th className="text-right">Net revenue</th>
                <th className="text-right">Profit</th>
              </tr>
            </thead>
            <tbody>
              {salesRows.map((row) => (
                <tr key={row.variantId} className="border-b last:border-0">
                  <td className="py-1.5">{row.brand}</td>
                  <td>{row.style}</td>
                  <td>{row.color}</td>
                  <td>{row.size}</td>
                  <td className="font-mono text-xs">{row.barcode}</td>
                  <td className="text-right">{row.soldQuantity}</td>
                  <td className="text-right">{row.returnedQuantity}</td>
                  <td className="text-right font-semibold">{row.netQuantity}</td>
                  <td className="text-right">{money(row.netRevenue)}</td>
                  <td className="text-right">{money(row.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
