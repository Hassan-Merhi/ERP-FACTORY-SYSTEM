// Extracted from ./FactoryMonthlyProductionDrilldown.tsx to keep that module under the source-size cap.
import { Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import {
  validMonths,
  monthText,
  format,
  kg,
  DrilldownBack,
  useFactoryMonthlyProductionWorkersState,
  type Worker,
} from "./FactoryMonthlyProductionWorkersParts";
export {
  root,
  validMonths,
  monthText,
  format,
  kg,
  requestJson,
  periodQuery,
  DrilldownBack,
  type Product,
  type Bale,
  type DailyProductionGroup,
} from "./FactoryMonthlyProductionWorkersParts";

export function FactoryMonthlyProductionWorkers() {
  const { backToMatrix, data, dt, enabled, error, filtered, isLoading, months, openBales, refetch, search, setSearch } =
    useFactoryMonthlyProductionWorkersState();

  return (
    <main className="space-y-4 p-3 sm:p-5" data-testid="monthly-production-workers">
      <DrilldownBack onClick={backToMatrix} label="Back to monthly matrix" />
      <PageHeader title="Monthly production by worker" subtitle={monthText(validMonths(months) ? months : "")}>
        <RowsExportMenu
          title={`Monthly Production by Worker ${data?.product.articleCode ?? ""}`}
          sheetName="Workers"
          rows={filtered}
          columns={[
            { header: "Worker", value: (worker) => worker.workerName },
            ...(data?.months ?? []).map((month) => ({
              header: monthText(month),
              value: (worker: Worker) => worker.monthlyBales[month] ?? 0,
              type: "number" as const,
            })),
            { header: "Weight (kg)", value: (worker) => Number(worker.weightKg), type: "number" },
            { header: "Total bales", value: (worker) => worker.quantity, type: "number" },
          ]}
          footer={
            data
              ? [
                  "Total (all workers)",
                  ...data.months.map((month) =>
                    data.workers.reduce((sum, worker) => sum + (worker.monthlyBales[month] ?? 0), 0)
                  ),
                  Number(data.totalWeightKg),
                  data.totalBales,
                ]
              : undefined
          }
          filters={
            data ? [{ label: "Product", value: `${data.product.name} (${data.product.articleCode})` }] : undefined
          }
          resource="factory.production"
        />
      </PageHeader>
      {!enabled ? (
        <p className="rounded-lg border p-6 text-destructive">Invalid item or month selection.</p>
      ) : isLoading ? (
        <p className="rounded-lg border p-8 text-muted-foreground">Loading worker production…</p>
      ) : error ? (
        <div className="rounded-lg border p-8 text-destructive">
          {error instanceof Error ? error.message : "Unable to load workers."}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{data.product.name}</h2>
                <p className="text-sm text-muted-foreground">{data.product.articleCode}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="rounded-lg border bg-card px-4 py-2">
                  <span className="block text-xs text-muted-foreground">Total produced bales</span>
                  <strong className="text-xl tabular-nums">{format(data.totalBales)}</strong>
                </div>
                <div className="rounded-lg border bg-card px-4 py-2">
                  <span className="block text-xs text-muted-foreground">Total weight (kg)</span>
                  <strong className="text-xl tabular-nums">{kg(data.totalWeightKg)}</strong>
                </div>
                <div className="rounded-lg border bg-card px-4 py-2">
                  <span className="block text-xs text-muted-foreground">Workers / unassigned</span>
                  <strong className="text-xl tabular-nums">{format(data.workers.length)}</strong>
                </div>
              </div>
            </div>
            <SearchField
              value={search}
              onValueChange={setSearch}
              placeholder="Search workers"
              aria-label="Search workers"
              wrapperClassName="max-w-sm"
            />
            <p className="text-xs text-muted-foreground">
              Highest month per worker <strong className="text-emerald-600 dark:text-emerald-300">green</strong>
              {" · "}lowest <strong className="text-red-600 dark:text-red-300">red</strong>. Click a monthly count to
              see only that month's bales.
            </p>
            <section
              className="space-y-3 md:hidden phone-land:block"
              aria-label={dt("productionByMonth")}
              data-testid="monthly-production-workers-mobile"
            >
              {filtered.map((worker) => {
                const values = data.months.map((month) => worker.monthlyBales[month] ?? 0);
                const min = Math.min(...values);
                const max = Math.max(...values);
                const hasRange = values.length > 1 && max !== min;
                return (
                  <article key={worker.workerId} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-semibold">{worker.workerName}</h3>
                        {worker.workerId === 0 ? (
                          <span className="text-xs text-muted-foreground">{dt("noWorkerRecorded")}</span>
                        ) : null}
                        <p className="mt-1 text-xs text-muted-foreground">{kg(worker.weightKg)} kg</p>
                      </div>
                      <button
                        type="button"
                        className="min-h-11 shrink-0 rounded-lg bg-primary/10 px-3 font-semibold text-primary tabular-nums"
                        onClick={() => openBales(worker)}
                        aria-label={`${dt("workerBales")}: ${worker.workerName} · ${worker.quantity}`}
                        data-testid={`worker-mobile-bales-${worker.workerId}`}
                      >
                        {format(worker.quantity)} <span className="text-xs font-normal">{dt("bales")}</span>
                      </button>
                    </div>
                    <details className="mt-3 rounded-lg border bg-muted/20">
                      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
                        {dt("productionByMonth")} · {data.months.length}
                      </summary>
                      <div className="grid grid-cols-2 gap-2 border-t p-2">
                        {data.months.map((month, index) => {
                          const value = values[index];
                          const accent =
                            hasRange && value === max
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : hasRange && value === min
                                ? "bg-red-500/10 text-red-700 dark:text-red-300"
                                : "bg-background";
                          return (
                            <button
                              key={month}
                              type="button"
                              disabled={value === 0}
                              className={`min-h-11 rounded-lg border p-2 text-left disabled:opacity-60 ${accent}`}
                              onClick={() => openBales(worker, month)}
                              aria-label={`${dt("workerBales")}: ${worker.workerName} · ${monthText(month)} · ${value}`}
                              data-testid={`worker-mobile-month-${worker.workerId}-${month}`}
                            >
                              <span className="block text-xs">{monthText(month)}</span>
                              <strong className="text-lg tabular-nums">{format(value)}</strong>
                            </button>
                          );
                        })}
                      </div>
                    </details>
                  </article>
                );
              })}
              {!filtered.length && (
                <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
                  {dt("noMatchingWorkers")}
                </p>
              )}
            </section>
            <div
              className="hidden overflow-auto rounded-xl border bg-card md:block phone-land:hidden"
              style={{ maxHeight: "calc(100dvh - 315px)" }}
            >
              <table className="min-w-max w-full border-separate border-spacing-0 text-sm tabular-nums">
                <thead className="sticky top-0 z-20 bg-muted text-foreground">
                  <tr>
                    <th className="sticky left-0 z-30 min-w-64 border-b border-r bg-muted p-3 text-left">Worker</th>
                    {data.months.map((month) => (
                      <th key={month} className="min-w-24 whitespace-nowrap border-b border-r px-3 py-2 text-right">
                        {monthText(month)}
                      </th>
                    ))}
                    <th className="min-w-28 whitespace-nowrap border-b border-r p-3 text-right">Weight (kg)</th>
                    <th className="sticky right-0 z-30 min-w-24 border-b bg-muted p-3 text-right">Total bales</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((worker) => {
                    const values = data.months.map((month) => worker.monthlyBales[month] ?? 0);
                    const min = Math.min(...values);
                    const max = Math.max(...values);
                    const hasRange = values.length > 1 && min !== max;
                    return (
                      <tr key={worker.workerId} className="group hover:bg-accent/30">
                        <td className="sticky left-0 z-10 border-b border-r bg-card p-3 font-medium group-hover:bg-accent/30">
                          <span className="inline-flex items-center gap-2">
                            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                            {worker.workerName}
                          </span>
                          {worker.workerId === 0 && (
                            <span className="ml-2 text-xs text-muted-foreground">(no worker recorded)</span>
                          )}
                        </td>
                        {values.map((value, index) => {
                          const month = data.months[index];
                          const accent =
                            hasRange && value === max
                              ? "bg-emerald-100 text-emerald-800 font-bold dark:bg-emerald-950/50 dark:text-emerald-300"
                              : hasRange && value === min
                                ? "bg-red-100 text-red-800 font-bold dark:bg-red-950/50 dark:text-red-300"
                                : "";
                          return (
                            <td
                              key={month}
                              className={"border-b border-r px-3 py-2 text-right " + accent}
                              title={monthText(month) + ": " + format(value) + " bales"}
                            >
                              {value > 0 ? (
                                <button
                                  type="button"
                                  className="font-semibold underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                                  onClick={() => openBales(worker, month)}
                                  aria-label={
                                    "View " +
                                    format(value) +
                                    " bales for " +
                                    worker.workerName +
                                    " in " +
                                    monthText(month)
                                  }
                                  data-testid={"worker-production-month-" + worker.workerId + "-" + month}
                                >
                                  {format(value)}
                                </button>
                              ) : (
                                format(value)
                              )}
                            </td>
                          );
                        })}
                        <td className="border-b border-r p-3 text-right">{kg(worker.weightKg)}</td>
                        <td className="sticky right-0 z-10 border-b bg-card p-3 text-right group-hover:bg-accent/30">
                          <button
                            type="button"
                            className="font-bold text-primary underline-offset-4 hover:underline focus-visible:underline"
                            onClick={() => openBales(worker)}
                            aria-label={"View " + worker.quantity + " bales for " + worker.workerName}
                            data-testid={"worker-production-bales-" + worker.workerId}
                          >
                            {format(worker.quantity)}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 z-20 bg-muted font-semibold">
                  <tr>
                    <td className="sticky left-0 z-10 border-t border-r bg-muted p-3">Total (all workers)</td>
                    {data.months.map((month) => (
                      <td key={month} className="border-t border-r px-3 py-2 text-right">
                        {format(data.workers.reduce((sum, worker) => sum + (worker.monthlyBales[month] ?? 0), 0))}
                      </td>
                    ))}
                    <td className="border-t border-r p-3 text-right">{kg(data.totalWeightKg)}</td>
                    <td className="sticky right-0 z-10 border-t bg-muted p-3 text-right">{format(data.totalBales)}</td>
                  </tr>
                </tfoot>
              </table>
              {filtered.length === 0 && (
                <p className="p-6 text-center text-muted-foreground">No workers match your search.</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Click a worker's bale count to view the individual reference numbers. Unassigned bales are included so
              totals match the matrix.
            </p>
          </>
        )
      )}
    </main>
  );
}
