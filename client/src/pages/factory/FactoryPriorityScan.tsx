import { CheckCircle2, Layers, ListOrdered, PackageCheck, ScanLine } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PriorityScanColorLetter } from "./PriorityScanColorLetter";
import { useFactoryPriorityScanState } from "./useFactoryPriorityScanState";
import { FactoryPriorityScanSection } from "./FactoryPriorityScanSection";

export default function FactoryPriorityScan() {
  const {
    activeQueue,
    condensedSessionScans,
    currentPriorityBale,
    feedback,
    handleScan,
    historyView,
    inputRef,
    isLoading,
    recordChanges,
    scanInput,
    scanning,
    sessionScans,
    setHistoryView,
    setScanInput,
    tr,
  } = useFactoryPriorityScanState();

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-gradient-to-b from-slate-50 via-slate-50 to-blue-50/40 p-3 text-slate-900 dark:from-[hsl(var(--factory-hue)_69%_9%)] dark:via-[hsl(var(--factory-hue)_66%_11%)] dark:to-[hsl(var(--factory-hue)_57%_12%)] dark:text-slate-100 sm:p-5">
      {/* These counters are derived from the same queue and daily history as the scanner. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-2xl border border-blue-200/80 bg-white/95 px-4 py-3 shadow-sm dark:border-blue-400/25 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_59%_19%)] dark:to-[hsl(var(--factory-hue)_58%_15%)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
            <Layers className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
              {tr("priorityQueue")}
            </p>
            <p className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-300">{activeQueue.length}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-emerald-200/80 bg-white/95 px-4 py-3 shadow-sm dark:border-emerald-400/25 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_52%_13%)] dark:to-[hsl(var(--factory-hue)_56%_14%)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            <PackageCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
              {tr("thisSession")}
            </p>
            <p
              className="text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300"
              data-testid="priority-scan-today-count"
            >
              {sessionScans.length.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-violet-200/80 bg-white/95 px-4 py-3 shadow-sm dark:border-violet-400/25 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_35%_19%)] dark:to-[hsl(var(--factory-hue)_43%_17%)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
            <ListOrdered className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
              {tr("currentPriority")}
            </p>
            <p className="text-2xl font-bold tabular-nums text-violet-700 dark:text-violet-300">
              {activeQueue.length ? "#" + activeQueue[0].priority : "—"}
            </p>
          </div>
        </div>
      </div>

      <FactoryPriorityScanSection
        activeQueue={activeQueue}
        currentPriorityBale={currentPriorityBale}
        feedback={feedback}
        handleScan={handleScan}
        inputRef={inputRef}
        recordChanges={recordChanges}
        scanInput={scanInput}
        scanning={scanning}
        setScanInput={setScanInput}
        tr={tr}
      />

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[hsl(var(--factory-hue)_64%_12%)]/95">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-blue-400/20 dark:bg-gradient-to-r dark:from-[hsl(var(--factory-hue)_60%_18%)] dark:to-[hsl(var(--factory-hue)_56%_14%)] sm:px-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-sky-300">
              <Layers className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-bold tracking-tight">{tr("priorityQueue")}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{tr("firstRowActive")}</p>
            </div>
          </div>
          <Badge className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 font-semibold text-blue-800 shadow-none dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-200">
            {activeQueue.length} {tr("priorityQueue")}
          </Badge>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : activeQueue.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">{tr("noPrioritiesEnabled")}</div>
        ) : (
          <div className="px-2 pb-2 sm:px-3">
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_4.5rem] gap-3 border-b border-slate-200 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400 sm:grid-cols-[5rem_minmax(0,1fr)_6rem_6rem]">
              <span>#</span>
              <span>{tr("customerLoading", { orderId: "" }).replace("#", "").trim()}</span>
              <span className="text-right">{tr("scanned")}</span>
              <span className="hidden text-right sm:block">{tr("active")}</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
              {activeQueue.map((item, index) => (
                <div
                  key={item.id}
                  className={[
                    "grid grid-cols-[3.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-lg px-3 py-2.5 transition-colors sm:grid-cols-[5rem_minmax(0,1fr)_6rem_6rem]",
                    index === 0
                      ? "border border-emerald-300 bg-emerald-50/90 dark:border-emerald-500/65 dark:bg-emerald-500/15"
                      : "hover:bg-blue-50/80 dark:hover:bg-blue-400/10",
                  ].join(" ")}
                  data-testid={"priority-queue-row-" + item.orderId}
                >
                  <span
                    className={[
                      "w-fit rounded-lg px-2 py-1 text-sm font-bold tabular-nums",
                      index === 0
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-200"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300",
                    ].join(" ")}
                  >
                    #{item.priority}
                  </span>
                  <div className="flex min-w-0 items-center gap-3">
                    <PriorityScanColorLetter color={item.color} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">
                        {item.load?.customerName || tr("loadingNumber", { orderId: item.orderId })}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {tr("loadingNumber", { orderId: item.orderId })}
                        {item.load?.proformaName ? " · " + item.load.proformaName : ""}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {item.load?.totalQtyBales ?? 0}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr("scanned")}</div>
                  </div>
                  <div className="hidden justify-end sm:flex">
                    {index === 0 && (
                      <Badge className="gap-1 rounded-full border border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-600/25 dark:text-emerald-200">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {tr("active")}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="min-h-[220px] flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[hsl(var(--factory-hue)_64%_12%)]/95">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-blue-400/20 dark:bg-[hsl(var(--factory-hue)_60%_16%)] sm:px-5">
          <div>
            <h3 className="font-bold">{tr("thisSession")}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {historyView === "condensed" ? "Grouped by product name" : tr("referenceProductOnly")}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-600 dark:bg-[hsl(var(--factory-hue)_74%_10%)]">
            <Button
              type="button"
              size="sm"
              variant={historyView === "condensed" ? "secondary" : "ghost"}
              className="rounded-lg"
              onClick={() => setHistoryView("condensed")}
              data-testid="button-priority-history-condensed"
            >
              Condensed
            </Button>
            <Button
              type="button"
              size="sm"
              variant={historyView === "detailed" ? "secondary" : "ghost"}
              className="rounded-lg"
              onClick={() => setHistoryView("detailed")}
              data-testid="button-priority-history-detailed"
            >
              Detailed
            </Button>
          </div>
        </div>
        {sessionScans.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-slate-500 dark:text-slate-400">
            <ScanLine className="h-10 w-10 opacity-30" />
            <p className="mt-2 text-sm">{tr("scanToBegin")}</p>
          </div>
        ) : (
          <>
            {historyView === "condensed" ? (
              <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {condensedSessionScans.map((group) => (
                  <div
                    key={group.name.toLocaleLowerCase("en-US")}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-blue-400/5"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{group.name}</div>
                      {group.articleCode && (
                        <div className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                          {group.articleCode}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {group.colors.map((color) => (
                        <PriorityScanColorLetter key={color} color={color} size="sm" />
                      ))}
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {group.count} {tr("scanned")}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
                {sessionScans.map((scan) => (
                  <div
                    key={scan.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-blue-400/5"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="min-w-[150px] font-mono font-medium">{scan.referenceNumber}</div>
                    <div className="min-w-0 flex-1 truncate text-sm">{scan.productName || tr("unnamedProduct")}</div>
                    <div className="flex shrink-0 items-center gap-2">
                      <PriorityScanColorLetter color={scan.color} size="sm" />
                      <Badge variant="outline">
                        {tr("priorityNumber", { priority: scan.priority })} ·{" "}
                        {tr("loadingNumber", { orderId: scan.orderId })}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/80 px-4 py-3 text-sm dark:border-slate-700 dark:bg-[hsl(var(--factory-hue)_60%_16%)]">
              <span className="font-medium">Total scanned bales</span>
              <Badge variant="secondary" data-testid="priority-scan-total">
                {sessionScans.length}
              </Badge>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
