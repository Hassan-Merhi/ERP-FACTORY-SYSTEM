import { useQuery } from "@tanstack/react-query";
import { BarChart3, Package, Scale, Boxes, TrendingUp, Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/formatNumber";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { FactoryMixBatch } from "@shared/schema";

interface RawStockRow {
  id: number;
  containerNumber: string;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
}

function getToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getWeekStart(): Date {
  const today = getToday();
  const day = today.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - diff);
  return monday;
}

function getMonthStart(): Date {
  const today = getToday();
  return new Date(today.getFullYear(), today.getMonth(), 1);
}

interface ProductionBaleRow {
  bale: { createdAt: string; weightKg: string | null };
}

function filterBalesByDate(bales: ProductionBaleRow[], startDate: Date) {
  return bales.filter((row) => {
    const created = new Date(row.bale.createdAt);
    return created >= startDate;
  });
}

export default function ProductionSummary() {
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);
  const { data: balesData, isLoading: balesLoading } = useQuery<ProductionBaleRow[]>({
    queryKey: ["/api/factory/bales"],
  });

  const { data: mixBatches, isLoading: batchesLoading } = useQuery<FactoryMixBatch[]>({
    queryKey: ["/api/factory/mix-batches"],
  });

  const { data: rawStock, isLoading: rawStockLoading } = useQuery<RawStockRow[]>({
    queryKey: ["/api/factory/raw-stock"],
  });

  const isLoading = balesLoading || batchesLoading || rawStockLoading;

  if (isLoading) {
    return (
      <div className="space-y-6" data-testid="loading-skeleton">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const allBales = balesData || [];
  const allBatches = mixBatches || [];
  const allRawStock = rawStock || [];

  const totalBalesCount = allBales.length;
  const totalWeightProduced = allBales.reduce((sum, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);
  const activeBatches = allBatches.filter((b) => b.status === "ACTIVE");
  const activeBatchCount = activeBatches.length;
  const rawStockAvailable = allRawStock.reduce((sum, r) => sum + parseFloat(r.remainingKg || "0"), 0);

  const today = getToday();
  const weekStart = getWeekStart();
  const monthStart = getMonthStart();

  const todayBales = filterBalesByDate(allBales, today);
  const todayCount = todayBales.length;
  const todayWeight = todayBales.reduce((sum, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);

  const weekBales = filterBalesByDate(allBales, weekStart);
  const weekCount = weekBales.length;
  const weekWeight = weekBales.reduce((sum, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);

  const monthBales = filterBalesByDate(allBales, monthStart);
  const monthCount = monthBales.length;
  const monthWeight = monthBales.reduce((sum, row) => sum + parseFloat(row.bale.weightKg || "0"), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <BarChart3 className="h-6 w-6 text-muted-foreground" />
        <PageHeader title="Production Summary" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Bales Produced</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono" data-testid="text-total-bales">
              {formatNumber(totalBalesCount)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Weight Produced</CardTitle>
            <Scale className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono" data-testid="text-total-weight">
              {formatNumber(totalWeightProduced)} kg
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Batches</CardTitle>
            <Boxes className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono" data-testid="text-active-batches">
              {activeBatchCount}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Raw Stock Available</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono" data-testid="text-raw-stock-available">
              {formatNumber(rawStockAvailable)} kg
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Today's Production</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {todayCount > 0 ? (
            <div className="flex items-center gap-6 flex-wrap" data-testid="section-today-production">
              <div>
                <p className="text-sm text-muted-foreground">Bales</p>
                <p className="text-xl font-bold font-mono" data-testid="text-today-bales">
                  {formatNumber(todayCount)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Weight</p>
                <p className="text-xl font-bold font-mono" data-testid="text-today-weight">
                  {formatNumber(todayWeight)} kg
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="text-no-production-today">
              No production today
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This Week</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6 flex-wrap" data-testid="section-week-production">
              <div>
                <p className="text-sm text-muted-foreground">Bales</p>
                <p className="text-xl font-bold font-mono" data-testid="text-week-bales">
                  {formatNumber(weekCount)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Weight</p>
                <p className="text-xl font-bold font-mono" data-testid="text-week-weight">
                  {formatNumber(weekWeight)} kg
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6 flex-wrap" data-testid="section-month-production">
              <div>
                <p className="text-sm text-muted-foreground">Bales</p>
                <p className="text-xl font-bold font-mono" data-testid="text-month-bales">
                  {formatNumber(monthCount)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Weight</p>
                <p className="text-xl font-bold font-mono" data-testid="text-month-weight">
                  {formatNumber(monthWeight)} kg
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <Boxes className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Batch Utilization</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {activeBatches.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead className="text-right">Total (kg)</TableHead>
                    <TableHead className="text-right">Used (kg)</TableHead>
                    <TableHead className="text-right">Remaining (kg)</TableHead>
                    <TableHead className="min-w-[150px]">Utilization</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeBatches.map((batch) => {
                    const total = parseFloat(batch.totalWeightKg || "0");
                    const used = parseFloat(batch.usedKg || "0");
                    const remaining = total - used;
                    const utilization = total > 0 ? Math.min((used / total) * 100, 100) : 0;
                    return (
                      <TableRow key={batch.id} data-testid={`row-batch-util-${batch.id}`}>
                        <TableCell className="font-medium" data-testid={`text-batch-name-${batch.id}`}>
                          {batch.name || batch.batchCode}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(total)}</TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(used)}</TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(remaining)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Progress value={utilization} className="h-2 flex-1" />
                            <Badge variant="secondary" data-testid={`badge-util-${batch.id}`}>
                              {utilization.toFixed(0)}%
                            </Badge>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-no-active-batches">
              No active batches
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <Package className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Raw Stock Status</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {allRawStock.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead className="text-right">Received (kg)</TableHead>
                    <TableHead className="text-right">Used (kg)</TableHead>
                    <TableHead className="text-right">Remaining (kg)</TableHead>
                    <TableHead className="text-right">Cost/kg</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allRawStock.map((row) => {
                    const remaining = parseFloat(row.remainingKg || "0");
                    return (
                      <TableRow key={row.id} data-testid={`row-raw-stock-${row.id}`}>
                        <TableCell className="font-medium" data-testid={`text-container-${row.id}`}>
                          {row.containerNumber}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatNumber(parseFloat(row.receivedKg || "0"))}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatNumber(parseFloat(row.usedKg || "0"))}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          <Badge variant={remaining <= 0 ? "secondary" : "default"}>{formatNumber(remaining)}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          ${parseFloat(row.costPerKg || "0").toFixed(4)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-no-raw-stock">
              No raw stock entries
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
