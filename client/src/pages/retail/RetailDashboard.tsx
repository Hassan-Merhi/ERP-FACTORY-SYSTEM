import { type ReactNode, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  DollarSign,
  PackageCheck,
  PackageX,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCompany } from "@/contexts/CompanyContext";

interface Location {
  id: number;
  name: string;
  active?: boolean;
}

interface DashboardRow {
  product_id?: number;
  location_id?: number;
  variant_id?: number;
  product_name?: string;
  product_code?: string;
  code?: string;
  name?: string;
  brand?: string;
  brand_name?: string;
  size?: string;
  barcode?: string;
  location_name?: string;
  quantity?: number;
  revenue?: number;
  cogs?: number;
  profit?: number;
  threshold?: number;
  last_sale_at?: string | null;
}

interface RetailDashboardData {
  period: { from: string; to: string; locationId: number | null };
  summary: {
    inventory_quantity: number;
    inventory_value: number;
    product_count: number;
    variant_count: number;
    low_stock_count: number;
    out_of_stock_count: number;
    revenue: number;
    cogs: number;
    gross_profit: number;
    units_sold: number;
    sale_lines: number;
  };
  bestSellingProducts: DashboardRow[];
  bestSellingBrands: DashboardRow[];
  bestSellingSizes: DashboardRow[];
  salesByLocation: DashboardRow[];
  lowStock: DashboardRow[];
  outOfStock: DashboardRow[];
  slowMoving: DashboardRow[];
  profitByProduct: DashboardRow[];
  profitByBrand: DashboardRow[];
}

interface RetailAudit {
  ready: boolean;
  errors: number;
  warnings: number;
  issues: Array<{
    code: string;
    severity: "error" | "warning";
    count: number;
    message: string;
  }>;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}

const money = (value: number | undefined) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0));

const quantity = (value: number | undefined) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value ?? 0));

function isoDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function SummaryCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
            {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="rounded-lg border bg-muted/30 p-2 text-muted-foreground">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function RankingTable({
  title,
  rows,
  label,
  showProfit = false,
}: {
  title: string;
  rows: DashboardRow[];
  label: (row: DashboardRow) => string;
  showProfit?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-y bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Name</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              {showProfit ? <th className="px-4 py-2 text-right">Profit</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={`${label(row)}-${index}`} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-medium">{label(row)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{quantity(row.quantity)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{money(row.revenue)}</td>
                  {showProfit ? <td className="px-4 py-2.5 text-right tabular-nums">{money(row.profit)}</td> : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={showProfit ? 4 : 3} className="px-4 py-8 text-center text-muted-foreground">
                  No activity in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function StockTable({ title, rows, mode }: { title: string; rows: DashboardRow[]; mode: "low" | "out" | "slow" }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="border-y bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Product</th>
              <th className="px-3 py-2">Size</th>
              {mode === "low" ? <th className="px-3 py-2">Location</th> : null}
              <th className="px-3 py-2 text-right">Qty</th>
              {mode === "low" ? <th className="px-4 py-2 text-right">Low at</th> : null}
              {mode === "slow" ? <th className="px-4 py-2">Last sale</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={`${row.variant_id ?? index}-${row.location_id ?? "all"}`} className="border-b last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{row.name ?? row.product_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{row.code ?? row.product_code ?? row.barcode}</div>
                  </td>
                  <td className="px-3 py-2.5">{row.size ?? "—"}</td>
                  {mode === "low" ? <td className="px-3 py-2.5">{row.location_name ?? "—"}</td> : null}
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums">{quantity(row.quantity)}</td>
                  {mode === "low" ? (
                    <td className="px-4 py-2.5 text-right tabular-nums">{quantity(row.threshold)}</td>
                  ) : null}
                  {mode === "slow" ? (
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.last_sale_at ? new Date(row.last_sale_at).toLocaleDateString() : "Never"}
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={mode === "low" || mode === "slow" ? 5 : 3}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Nothing to review.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export default function RetailDashboard() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const now = useMemo(() => new Date(), []);
  const thirtyDaysAgo = useMemo(() => new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), [now]);
  const [from, setFrom] = useState(isoDateInput(thirtyDaysAgo));
  const [to, setTo] = useState(isoDateInput(now));
  const [locationId, setLocationId] = useState("");
  const companyKey = selectedCompany?.id ?? 0;
  const retailEnabled = selectedCompany?.companyType === "retail";

  const reportUrl = useMemo(() => {
    const params = new URLSearchParams({
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(`${to}T23:59:59.999`).toISOString(),
      slowMovingDays: "60",
      limit: "10",
    });
    if (locationId) params.set("locationId", locationId);
    return `/api/retail/reporting/dashboard?${params.toString()}`;
  }, [from, to, locationId]);

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["retail-locations", companyKey],
    queryFn: () => getJson("/api/locations"),
    enabled: retailEnabled,
  });
  const { data, isLoading, isFetching, refetch, error } = useQuery<RetailDashboardData>({
    queryKey: ["retail-dashboard", companyKey, reportUrl],
    queryFn: () => getJson(reportUrl),
    enabled: retailEnabled,
    staleTime: 30_000,
  });
  const { data: audit } = useQuery<RetailAudit>({
    queryKey: ["retail-audit", companyKey],
    queryFn: () => getJson("/api/retail/reporting/audit"),
    enabled: retailEnabled,
    staleTime: 60_000,
  });

  if (!retailEnabled) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6">
            Retail reporting is only available for Retail / Variant Inventory companies.
          </CardContent>
        </Card>
      </div>
    );
  }

  const summary = data?.summary;

  return (
    <div className="mx-auto max-w-[1700px] space-y-5 p-4 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-6 w-6" />
            <h1 className="text-2xl font-bold">Retail Dashboard</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Sales, margin, inventory health, and variant-level reconciliation from the retail movement ledger.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate("/retail/inventory")}>
            <Boxes className="mr-2 h-4 w-4" />
            Inventory
          </Button>
          <Button variant="outline" disabled={isFetching} onClick={() => refetch()}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
            />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
            />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground sm:col-span-2">
            Location
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
            >
              <option value="">All locations</option>
              {locations
                .filter((location) => location.active !== false)
                .map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
            </select>
          </label>
        </CardContent>
      </Card>

      {audit ? (
        <div
          className={`flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
            audit.ready ? "bg-muted/20" : "border-destructive/40 bg-destructive/5"
          }`}
        >
          <div className="flex items-start gap-3">
            {audit.ready ? (
              <ShieldCheck className="mt-0.5 h-5 w-5" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
            )}
            <div>
              <p className="font-medium">
                {audit.ready ? "Retail reconciliation is clean" : "Retail reconciliation needs attention"}
              </p>
              <p className="text-sm text-muted-foreground">
                {audit.errors} blocking error{audit.errors === 1 ? "" : "s"} · {audit.warnings} warning
                {audit.warnings === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          {!audit.ready ? (
            <div className="text-sm text-muted-foreground">
              {audit.issues
                .slice(0, 2)
                .map((issue) => issue.message)
                .join(" · ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Could not load retail reporting."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Revenue"
          value={money(summary?.revenue)}
          subtitle="Net of returns and cancellations"
          icon={<DollarSign className="h-5 w-5" />}
        />
        <SummaryCard
          title="COGS"
          value={money(summary?.cogs)}
          subtitle="Sale-time cost snapshots"
          icon={<ShoppingCart className="h-5 w-5" />}
        />
        <SummaryCard
          title="Gross profit"
          value={money(summary?.gross_profit)}
          subtitle="Revenue minus COGS"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <SummaryCard
          title="Inventory value"
          value={money(summary?.inventory_value)}
          subtitle={`${quantity(summary?.inventory_quantity)} units on hand`}
          icon={<PackageCheck className="h-5 w-5" />}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Products"
          value={quantity(summary?.product_count)}
          subtitle={`${quantity(summary?.variant_count)} variants`}
          icon={<Boxes className="h-5 w-5" />}
        />
        <SummaryCard
          title="Units sold"
          value={quantity(summary?.units_sold)}
          subtitle="Net units in selected period"
          icon={<ShoppingCart className="h-5 w-5" />}
        />
        <SummaryCard
          title="Low stock"
          value={quantity(summary?.low_stock_count)}
          subtitle="Variant/location rows at threshold"
          icon={<AlertTriangle className="h-5 w-5" />}
        />
        <SummaryCard
          title="Out of stock"
          value={quantity(summary?.out_of_stock_count)}
          subtitle="Active variants with no stock"
          icon={<PackageX className="h-5 w-5" />}
        />
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading retail reporting…</div>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <RankingTable
              title="Best-selling products"
              rows={data.bestSellingProducts}
              label={(row) => row.product_name ?? row.name ?? "—"}
              showProfit
            />
            <RankingTable
              title="Best-selling brands"
              rows={data.bestSellingBrands}
              label={(row) => row.name ?? row.brand_name ?? row.brand ?? "—"}
              showProfit
            />
            <RankingTable
              title="Best-selling sizes"
              rows={data.bestSellingSizes}
              label={(row) => row.name ?? row.size ?? "—"}
            />
            <RankingTable
              title="Sales by location"
              rows={data.salesByLocation}
              label={(row) => row.name ?? row.location_name ?? "—"}
              showProfit
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <StockTable title="Low-stock items" rows={data.lowStock} mode="low" />
            <StockTable title="Out-of-stock products" rows={data.outOfStock} mode="out" />
            <StockTable title="Slow-moving inventory" rows={data.slowMoving} mode="slow" />
          </div>
        </>
      ) : null}
    </div>
  );
}
