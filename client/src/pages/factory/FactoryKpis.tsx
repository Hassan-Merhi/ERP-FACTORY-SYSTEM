import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import type { FactoryMyAccess } from "@shared/apiTypes";

interface DailyProduction {
  date: string;
  balesProduced: number;
  kgPressed: number;
  wasteKg: number;
}

interface WorkerPerformance {
  workerName: string;
  balesCount: number;
  totalKg: number;
}

interface MixEfficiency {
  mixBatchId: number | string;
  totalInputKg: number;
  totalOutputKg: number;
  wasteKg: number;
  wastePercent: number;
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

function getWasteColor(percent: number): string {
  if (percent > 10) return "text-red-600 dark:text-red-400";
  if (percent >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-green-600 dark:text-green-400";
}

export default function FactoryKpis() {
  const { formatDisplayDate } = useDateFormat();
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

  const showWorkers =
    settings?.kpisTabWorkerPerformanceEnabled !== false && !hiddenTabs.includes("hide_tab_kpis_worker_performance");
  const showMixes =
    settings?.kpisTabMixEfficiencyEnabled !== false && !hiddenTabs.includes("hide_tab_kpis_mix_efficiency");

  const dailyQuery = useQuery<DailyProduction[]>({
    queryKey: ["/api/factory/kpis/daily", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/kpis/daily?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load daily production");
      return res.json();
    },
  });

  const workersQuery = useQuery<WorkerPerformance[]>({
    queryKey: ["/api/factory/kpis/workers", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/kpis/workers?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load worker performance");
      return res.json();
    },
  });

  const mixesQuery = useQuery<MixEfficiency[]>({
    queryKey: ["/api/factory/kpis/mixes", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/kpis/mixes?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load mix efficiency");
      return res.json();
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Factory KPIs" subtitle="Production metrics and performance analysis" />
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

      <Tabs defaultValue="daily" data-testid="tabs-kpi">
        <TabsList>
          <TabsTrigger value="daily" data-testid="tab-daily">
            Daily Production
          </TabsTrigger>
          {showWorkers && (
            <TabsTrigger value="workers" data-testid="tab-workers">
              Worker Performance
            </TabsTrigger>
          )}
          {showMixes && (
            <TabsTrigger value="mixes" data-testid="tab-mixes">
              Mix Efficiency
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="daily">
          <Card>
            <CardHeader>
              <CardTitle>Daily Production</CardTitle>
            </CardHeader>
            <CardContent>
              {dailyQuery.isLoading ? (
                <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-muted-foreground">Loading daily production...</span>
                </div>
              ) : !Array.isArray(dailyQuery.data) || dailyQuery.data.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground" data-testid="text-no-data">
                    No daily production data for selected range
                  </p>
                </div>
              ) : (
                <div className="table-responsive">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Bales Produced</TableHead>
                        <TableHead>KG Pressed</TableHead>
                        <TableHead>Waste KG</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dailyQuery.data.map((row, idx) => (
                        <TableRow key={row.date ?? idx} data-testid={`row-daily-${idx}`}>
                          <TableCell className="font-mono text-sm">
                            {row.date ? formatDisplayDate(row.date) : "—"}
                          </TableCell>
                          <TableCell className="font-mono">{row.balesProduced}</TableCell>
                          <TableCell className="font-mono">{row.kgPressed}</TableCell>
                          <TableCell className="font-mono">{row.wasteKg}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {showWorkers && (
          <TabsContent value="workers">
            <Card>
              <CardHeader>
                <CardTitle>Worker Performance</CardTitle>
              </CardHeader>
              <CardContent>
                {workersQuery.isLoading ? (
                  <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-muted-foreground">Loading worker performance...</span>
                  </div>
                ) : !Array.isArray(workersQuery.data) || workersQuery.data.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground" data-testid="text-no-data">
                      No worker performance data for selected range
                    </p>
                  </div>
                ) : (
                  <div className="table-responsive">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Worker Name</TableHead>
                          <TableHead>Bales Count</TableHead>
                          <TableHead>Total KG</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {workersQuery.data.map((worker, idx) => (
                          <TableRow key={worker.workerName ?? idx} data-testid={`row-worker-${idx}`}>
                            <TableCell>
                              <Badge variant="outline">{idx + 1}</Badge>
                            </TableCell>
                            <TableCell className="font-medium">{worker.workerName}</TableCell>
                            <TableCell className="font-mono">{worker.balesCount}</TableCell>
                            <TableCell className="font-mono">{worker.totalKg}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {showMixes && (
          <TabsContent value="mixes">
            <Card>
              <CardHeader>
                <CardTitle>Mix Efficiency</CardTitle>
              </CardHeader>
              <CardContent>
                {mixesQuery.isLoading ? (
                  <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-muted-foreground">Loading mix efficiency...</span>
                  </div>
                ) : !Array.isArray(mixesQuery.data) || mixesQuery.data.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground" data-testid="text-no-data">
                      No mix efficiency data for selected range
                    </p>
                  </div>
                ) : (
                  <div className="table-responsive">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Mix Batch ID</TableHead>
                          <TableHead>Total Input KG</TableHead>
                          <TableHead>Total Output KG</TableHead>
                          <TableHead>Waste KG</TableHead>
                          <TableHead>Waste %</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {mixesQuery.data.map((mix, idx) => (
                          <TableRow key={mix.mixBatchId ?? idx} data-testid={`row-mix-${idx}`}>
                            <TableCell className="font-mono">{mix.mixBatchId}</TableCell>
                            <TableCell className="font-mono">{mix.totalInputKg}</TableCell>
                            <TableCell className="font-mono">{mix.totalOutputKg}</TableCell>
                            <TableCell className="font-mono">{mix.wasteKg}</TableCell>
                            <TableCell
                              className={`font-mono font-medium ${getWasteColor(mix.wastePercent ?? 0)}`}
                              data-testid={`text-waste-percent-${idx}`}
                            >
                              {(mix.wastePercent ?? 0).toFixed(1)}%
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
