import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, Info } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

interface BaleCost {
  baleRef: string;
  materialCost: number | null;
  laborCost: number | null;
  overhead: number | null;
  freight: number | null;
  totalCost: number | null;
  salePrice: number | null;
  profit: number | null;
}

interface ContainerProfit {
  containerRef: string;
  revenue: number | null;
  cost: number | null;
  profit: number | null;
  marginPercent: number | null;
}

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toLocaleDateString("en-CA"),
    to: to.toLocaleDateString("en-CA"),
  };
}

function fmt(val: number | null | undefined): string {
  if (val == null) return "-";
  return val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function profitColor(val: number | null | undefined): string {
  if (val == null) return "text-muted-foreground";
  if (val > 0) return "text-green-600 dark:text-green-400";
  if (val < 0) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function marginBadgeVariant(percent: number | null | undefined): "default" | "secondary" | "destructive" | "outline" {
  if (percent == null) return "outline";
  if (percent > 15) return "default";
  if (percent >= 5) return "secondary";
  return "destructive";
}

function marginBadgeClass(percent: number | null | undefined): string {
  if (percent == null) return "";
  if (percent > 15) return "bg-green-600 dark:bg-green-500";
  if (percent >= 5) return "bg-yellow-600 dark:bg-yellow-500";
  return "";
}

function HeaderTooltip({ label, tip }: { label: string; tip: string }) {
  return (
    <div className="flex items-center gap-1">
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{tip}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export default function FactoryProfitability() {
  const defaults = getDefaultDateRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);

  const { data: settings } = useQuery({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];

  const showContainers =
    settings?.profitabilityTabContainersEnabled !== false && !hiddenTabs.includes("hide_tab_profitability_containers");

  const balesQuery = useQuery<BaleCost[]>({
    queryKey: ["/api/factory/profitability/bales", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/profitability/bales?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load bale costs");
      return res.json();
    },
  });

  const containersQuery = useQuery<ContainerProfit[]>({
    queryKey: ["/api/factory/profitability/containers", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/profitability/containers?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load container profitability");
      return res.json();
    },
  });

  const balesSummary = (() => {
    const data = balesQuery.data ?? [];
    const totalBales = data.length;
    const costs = data.filter((b) => b.totalCost != null).map((b) => b.totalCost!);
    const profits = data.filter((b) => b.profit != null).map((b) => b.profit!);
    const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
    const avgProfit = profits.length ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;
    const totalProfit = profits.reduce((a, b) => a + b, 0);
    return { totalBales, avgCost, avgProfit, totalProfit };
  })();

  const containersSummary = (() => {
    const data = containersQuery.data ?? [];
    const revenues = data.filter((c) => c.revenue != null).map((c) => c.revenue!);
    const costs = data.filter((c) => c.cost != null).map((c) => c.cost!);
    const profits = data.filter((c) => c.profit != null).map((c) => c.profit!);
    const margins = data.filter((c) => c.marginPercent != null).map((c) => c.marginPercent!);
    const totalRevenue = revenues.reduce((a, b) => a + b, 0);
    const totalCost = costs.reduce((a, b) => a + b, 0);
    const totalProfit = profits.reduce((a, b) => a + b, 0);
    const avgMargin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
    return { totalRevenue, totalCost, totalProfit, avgMargin };
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Profitability Analysis" subtitle="Bale costs and container profitability" />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-44"
              data-testid="input-date-from"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-44"
              data-testid="input-date-to"
            />
          </div>
        </div>
      </div>

      <Tabs defaultValue="bales" data-testid="tabs-profitability">
        <TabsList>
          <TabsTrigger value="bales" data-testid="tab-bales">
            Bale Costs
          </TabsTrigger>
          {showContainers && (
            <TabsTrigger value="containers" data-testid="tab-containers">
              Container Profitability
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="bales">
          {balesQuery.isLoading ? (
            <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading bale costs...</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Bales</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-total-bales">
                      {balesSummary.totalBales}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Avg Cost/Bale</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-avg-cost">
                      {fmt(balesSummary.avgCost)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Avg Profit/Bale</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div
                      className={`text-2xl font-bold ${profitColor(balesSummary.avgProfit)}`}
                      data-testid="text-avg-profit"
                    >
                      {fmt(balesSummary.avgProfit)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Profit</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div
                      className={`text-2xl font-bold ${profitColor(balesSummary.totalProfit)}`}
                      data-testid="text-total-profit"
                    >
                      {fmt(balesSummary.totalProfit)}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Bale Cost Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  {!Array.isArray(balesQuery.data) || balesQuery.data.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-muted-foreground" data-testid="text-no-data">
                        No bale cost data for selected range
                      </p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <Table>
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow>
                            <TableHead>Bale Ref</TableHead>
                            <TableHead>
                              <HeaderTooltip label="Material Cost" tip="Raw material cost allocated to this bale" />
                            </TableHead>
                            <TableHead>
                              <HeaderTooltip label="Labor Cost" tip="Worker wages attributed to this bale" />
                            </TableHead>
                            <TableHead>
                              <HeaderTooltip label="Overhead" tip="Factory overhead (utilities, rent, etc.) per bale" />
                            </TableHead>
                            <TableHead>
                              <HeaderTooltip label="Freight" tip="Shipping and transportation cost" />
                            </TableHead>
                            <TableHead>
                              <HeaderTooltip label="Total Cost" tip="Material + Labor + Overhead + Freight" />
                            </TableHead>
                            <TableHead>Sale Price</TableHead>
                            <TableHead>
                              <HeaderTooltip label="Profit" tip="Sale Price - Total Cost" />
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {balesQuery.data.map((bale, idx) => (
                            <TableRow key={bale.baleRef ?? idx} data-testid={`row-bale-${idx}`}>
                              <TableCell className="font-medium">{bale.baleRef}</TableCell>
                              <TableCell className="font-mono text-sm">{fmt(bale.materialCost)}</TableCell>
                              <TableCell className="font-mono text-sm">{fmt(bale.laborCost)}</TableCell>
                              <TableCell className="font-mono text-sm">{fmt(bale.overhead)}</TableCell>
                              <TableCell className="font-mono text-sm">{fmt(bale.freight)}</TableCell>
                              <TableCell className="font-mono text-sm font-medium">{fmt(bale.totalCost)}</TableCell>
                              <TableCell className="font-mono text-sm">{fmt(bale.salePrice)}</TableCell>
                              <TableCell
                                className={`font-mono text-sm font-medium ${profitColor(bale.profit)}`}
                                data-testid={`text-bale-profit-${idx}`}
                              >
                                {fmt(bale.profit)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {showContainers && (
          <TabsContent value="containers">
            {containersQuery.isLoading ? (
              <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground">Loading container profitability...</span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold" data-testid="text-total-revenue">
                        {fmt(containersSummary.totalRevenue)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold" data-testid="text-container-total-cost">
                        {fmt(containersSummary.totalCost)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Total Profit</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div
                        className={`text-2xl font-bold ${profitColor(containersSummary.totalProfit)}`}
                        data-testid="text-container-total-profit"
                      >
                        {fmt(containersSummary.totalProfit)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">Avg Margin %</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold" data-testid="text-avg-margin">
                        {containersSummary.avgMargin.toFixed(1)}%
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>Container Profitability</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!Array.isArray(containersQuery.data) || containersQuery.data.length === 0 ? (
                      <div className="text-center py-8">
                        <p className="text-muted-foreground" data-testid="text-no-data">
                          No container profitability data for selected range
                        </p>
                      </div>
                    ) : (
                      <div className="table-responsive">
                        <Table>
                          <TableHeader className="sticky top-0 z-30 bg-background">
                            <TableRow>
                              <TableHead>Container Ref</TableHead>
                              <TableHead>
                                <HeaderTooltip label="Revenue" tip="Total sales revenue from this container" />
                              </TableHead>
                              <TableHead>
                                <HeaderTooltip
                                  label="Cost"
                                  tip="Total cost including purchase, freight, and processing"
                                />
                              </TableHead>
                              <TableHead>
                                <HeaderTooltip label="Profit" tip="Revenue - Cost" />
                              </TableHead>
                              <TableHead>
                                <HeaderTooltip label="Margin %" tip="(Profit / Revenue) x 100" />
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {containersQuery.data.map((container, idx) => (
                              <TableRow key={container.containerRef ?? idx} data-testid={`row-container-${idx}`}>
                                <TableCell className="font-medium">{container.containerRef}</TableCell>
                                <TableCell className="font-mono text-sm">{fmt(container.revenue)}</TableCell>
                                <TableCell className="font-mono text-sm">{fmt(container.cost)}</TableCell>
                                <TableCell
                                  className={`font-mono text-sm font-medium ${profitColor(container.profit)}`}
                                  data-testid={`text-container-profit-${idx}`}
                                >
                                  {fmt(container.profit)}
                                </TableCell>
                                <TableCell data-testid={`text-container-margin-${idx}`}>
                                  <Badge
                                    variant={marginBadgeVariant(container.marginPercent)}
                                    className={marginBadgeClass(container.marginPercent)}
                                  >
                                    {container.marginPercent != null ? `${container.marginPercent.toFixed(1)}%` : "-"}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
