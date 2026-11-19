import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { useFactoryKpisState } from "./useFactoryKpisState";

function getWasteColor(percent: number): string {
  if (percent > 10) return "text-red-600 dark:text-red-400";
  if (percent >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-green-600 dark:text-green-400";
}

export default function FactoryKpis() {
  const {
    formatDisplayDate,
    from,
    setFrom,
    to,
    setTo,
    setRequestedTab,
    showDaily,
    showWorkers,
    showMixes,
    activeTab,
    dailyQuery,
    workersQuery,
    mixesQuery,
    exportSheet,
  } = useFactoryKpisState();

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
          {exportSheet && (
            <RowsExportMenu
              title={`Factory KPIs ${exportSheet.name}`}
              sheetName={exportSheet.name}
              rows={exportSheet.rows}
              columns={exportSheet.columns}
              period={{ from, to }}
              resource="factory.analytics"
              className="self-end"
            />
          )}
        </div>
      </div>

      {activeTab ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setRequestedTab(value as "daily" | "workers" | "mixes")}
          data-testid="tabs-kpi"
        >
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory KPI sections">
              {showDaily && (
                <TabsTrigger value="daily" data-testid="tab-daily">
                  Daily Production
                </TabsTrigger>
              )}
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
          </div>

          {showDaily && (
            <TabsContent value="daily">
              <Card>
                <CardHeader>
                  <CardTitle>Daily Production</CardTitle>
                </CardHeader>
                <CardContent>
                  {dailyQuery.isLoading ? (
                    <LoadingState title="Loading daily production..." data-testid="loading-spinner" />
                  ) : dailyQuery.isError && !dailyQuery.data ? (
                    <ErrorState onAction={() => void dailyQuery.refetch()} actionLabel="Try again" />
                  ) : !Array.isArray(dailyQuery.data) || dailyQuery.data.length === 0 ? (
                    <EmptyState title="No daily production data for selected range" data-testid="text-no-data" />
                  ) : (
                    <div className="table-responsive">
                      <Table mobileLayout="cards" data-testid="kpi-daily-table">
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
          )}

          {showWorkers && (
            <TabsContent value="workers">
              <Card>
                <CardHeader>
                  <CardTitle>Worker Performance</CardTitle>
                </CardHeader>
                <CardContent>
                  {workersQuery.isLoading ? (
                    <LoadingState title="Loading worker performance..." data-testid="loading-spinner" />
                  ) : workersQuery.isError && !workersQuery.data ? (
                    <ErrorState onAction={() => void workersQuery.refetch()} actionLabel="Try again" />
                  ) : !Array.isArray(workersQuery.data) || workersQuery.data.length === 0 ? (
                    <EmptyState title="No worker performance data for selected range" data-testid="text-no-data" />
                  ) : (
                    <div className="table-responsive">
                      <Table mobileLayout="cards" data-testid="kpi-workers-table">
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
                              {/* Rank stays a labelled field on phone cards (a bare "#" column would be hidden as an ordinal). */}
                              <TableCell data-label="Rank" data-mobile-cell="field">
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
                    <LoadingState title="Loading mix efficiency..." data-testid="loading-spinner" />
                  ) : mixesQuery.isError && !mixesQuery.data ? (
                    <ErrorState onAction={() => void mixesQuery.refetch()} actionLabel="Try again" />
                  ) : !Array.isArray(mixesQuery.data) || mixesQuery.data.length === 0 ? (
                    <EmptyState title="No mix efficiency data for selected range" data-testid="text-no-data" />
                  ) : (
                    <div className="table-responsive">
                      <Table mobileLayout="cards" data-testid="kpi-mix-batches-table">
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
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No KPI tabs are available for this user.
        </div>
      )}
    </div>
  );
}
