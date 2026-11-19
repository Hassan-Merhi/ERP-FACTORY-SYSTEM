import { useMemo, useState } from "react";
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
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "@/contexts/CompanyContext";
import { RetailNav } from "./RetailNav";
import { RetailVariantReports } from "./RetailVariantReports";
import { RetailFinancialPanel } from "./RetailFinancialPanel";
import {
  RankingTable,
  SummaryCard,
  getJson,
  isoDateInput,
  money,
  quantity,
  type RetailAudit,
  type RetailDashboardData,
} from "./RetailDashboardRankingTable";
import { brandLabel, locationLabel, productLabel, rankingSheet, sizeLabel, stockSheet } from "./retailDashboardExport";
import { StockTable, type Location } from "./RetailDashboardStockTable";

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
      <RetailNav />
      <PageHeader
        title="Retail Dashboard"
        icon={<BarChart3 className="h-6 w-6" />}
        subtitle="Sales, margin, inventory health, and variant-level reconciliation from the retail movement ledger."
      >
        <Button variant="outline" onClick={() => navigate("/retail/inventory")}>
          <Boxes className="mr-2 h-4 w-4" />
          Inventory
        </Button>
        <Button variant="outline" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        {data && (
          <RowsExportMenu
            title="Retail Dashboard"
            period={{ from, to }}
            size="default"
            sheetName="Best-selling products"
            rows={data.bestSellingProducts}
            columns={rankingSheet("Best-selling products", data.bestSellingProducts, productLabel, true).columns}
            extraSheets={[
              rankingSheet("Best-selling brands", data.bestSellingBrands, brandLabel, true),
              rankingSheet("Best-selling sizes", data.bestSellingSizes, sizeLabel),
              rankingSheet("Sales by location", data.salesByLocation, locationLabel, true),
              stockSheet("Low-stock items", data.lowStock, "low"),
              stockSheet("Out-of-stock products", data.outOfStock, "out"),
              stockSheet("Slow-moving inventory", data.slowMoving, "slow"),
            ]}
            resource="retail.pos"
            data-testid="button-export-retail-dashboard"
          />
        )}
      </PageHeader>

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
            <Select value={locationId || "__all__"} onValueChange={(v) => setLocationId(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-10 w-full text-sm text-foreground" aria-label="Location">
                <SelectValue placeholder="All locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All locations</SelectItem>
                {locations
                  .filter((location) => location.active !== false)
                  .map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
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
              label={productLabel}
              showProfit
            />
            <RankingTable title="Best-selling brands" rows={data.bestSellingBrands} label={brandLabel} showProfit />
            <RankingTable title="Best-selling sizes" rows={data.bestSellingSizes} label={sizeLabel} />
            <RankingTable title="Sales by location" rows={data.salesByLocation} label={locationLabel} showProfit />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <StockTable title="Low-stock items" rows={data.lowStock} mode="low" />
            <StockTable title="Out-of-stock products" rows={data.outOfStock} mode="out" />
            <StockTable title="Slow-moving inventory" rows={data.slowMoving} mode="slow" />
          </div>
        </>
      ) : null}

      <RetailVariantReports companyKey={companyKey} />
      <RetailFinancialPanel companyKey={companyKey} />
    </div>
  );
}
