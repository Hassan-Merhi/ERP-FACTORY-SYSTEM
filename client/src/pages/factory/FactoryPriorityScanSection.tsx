// Extracted from ./FactoryPriorityScan.tsx to keep that module under the source-size cap.
import { AlertCircle, CheckCircle2, Info, ScanLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Input } from "@/components/ui/input";
import { getPriorityScanLetter, getPriorityScanLetterInk } from "@shared/priorityScanColors";
import { useFactoryPriorityScanState } from "./useFactoryPriorityScanState";

export function FactoryPriorityScanSection({
  activeQueue,
  currentPriorityBale,
  feedback,
  handleScan,
  inputRef,
  recordChanges,
  scanInput,
  scanning,
  setScanInput,
  tr,
}: Pick<
  ReturnType<typeof useFactoryPriorityScanState>,
  | "activeQueue"
  | "currentPriorityBale"
  | "feedback"
  | "handleScan"
  | "inputRef"
  | "recordChanges"
  | "scanInput"
  | "scanning"
  | "setScanInput"
  | "tr"
>) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(290px,0.9fr)]">
      <section className="relative overflow-hidden rounded-2xl border border-blue-200/80 bg-gradient-to-br from-white via-blue-50/70 to-sky-100/60 p-4 shadow-md shadow-blue-950/5 dark:border-blue-400/35 dark:bg-gradient-to-br dark:from-[hsl(var(--factory-hue)_65%_19%)] dark:via-[hsl(var(--factory-hue)_70%_16%)] dark:to-[hsl(var(--factory-hue)_69%_13%)] dark:shadow-blue-950/25 sm:p-5">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-blue-400/10 blur-3xl dark:bg-blue-400/15" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/20 dark:text-blue-300">
              <ScanLine className="h-6 w-6" />
            </span>
            <div>
              <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{tr("priorityScan")}</h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-blue-100/75">{tr("scanDescription")}</p>
            </div>
          </div>
          <Badge className="rounded-full border border-blue-300 bg-blue-100 px-3 py-1 text-blue-800 shadow-none dark:border-blue-500/30 dark:bg-blue-500/20 dark:text-blue-200">
            {tr(activeQueue.length === 1 ? "activePriority" : "activePriorities", { count: activeQueue.length })}
          </Badge>
        </div>

        <div className="relative mt-5 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <ScanLine className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-600/70 dark:text-sky-300" />
            <Input
              ref={inputRef}
              value={scanInput}
              onChange={(event) => setScanInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleScan();
                }
              }}
              placeholder={tr("scanPlaceholder")}
              autoComplete="off"
              className="h-12 rounded-xl border-blue-300 bg-white pl-11 font-mono text-base text-slate-900 shadow-inner shadow-blue-100/60 focus-visible:ring-blue-500 dark:border-blue-400/55 dark:bg-[hsl(var(--factory-hue)_75%_11%)] dark:text-white dark:shadow-blue-900/30 dark:placeholder:text-slate-400"
              disabled={scanning || !recordChanges.allowed}
              title={recordChanges.reason ?? undefined}
              data-testid="input-priority-scan"
            />
          </div>
          <MobileBarcodeScanner
            onScan={(code) => void handleScan(code)}
            feedback={feedback}
            disabled={scanning || !recordChanges.allowed}
            className="h-12 w-12 shrink-0 rounded-xl border-blue-300 dark:border-blue-400/55"
          />
          <Button
            type="button"
            className="h-12 shrink-0 rounded-xl bg-blue-600 px-4 font-semibold text-white shadow-md shadow-blue-600/20 hover:bg-blue-500 dark:bg-blue-600 dark:hover:bg-blue-500 sm:px-6"
            onClick={() => void handleScan()}
            disabled={scanning || !scanInput.trim() || !recordChanges.allowed}
            title={recordChanges.reason ?? undefined}
            data-testid="button-priority-scan"
          >
            <ScanLine className="mr-2 h-4 w-4" />
            {scanning ? tr("checking") : tr("scan")}
          </Button>
        </div>

        <div className="relative mt-4 flex gap-2 rounded-xl border border-blue-200/70 bg-blue-100/50 p-3 text-xs leading-relaxed text-slate-600 dark:border-blue-400/20 dark:bg-blue-950/35 dark:text-blue-100/75">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-sky-300" />
          <div className="space-y-1">
            <p>{tr("routeHint")}</p>
            <p>{tr("manualExceptionHint")}</p>
          </div>
        </div>

        {feedback && (
          <div
            role="status"
            className={[
              "relative mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 shadow-sm",
              feedback.type === "success"
                ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/45 dark:bg-emerald-950/45 dark:text-emerald-100"
                : feedback.type === "warn"
                  ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/45 dark:bg-amber-950/45 dark:text-amber-100"
                  : "border-red-300 bg-red-50 text-red-900 dark:border-red-400/45 dark:bg-red-950/45 dark:text-red-100",
            ].join(" ")}
            data-testid="priority-scan-feedback"
          >
            {feedback.type === "success" ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="font-mono font-bold">{feedback.referenceNumber}</div>
              <div className="text-sm">{feedback.message}</div>
            </div>
          </div>
        )}
      </section>

      {/* Preserve the authoritative full HEX-color flash and its M–W letter. */}
      <section
        className={[
          "relative flex min-h-[230px] flex-col overflow-hidden rounded-2xl border shadow-md transition-colors duration-150",
          currentPriorityBale
            ? "border-slate-400/40 shadow-slate-950/15 dark:border-white/20 dark:shadow-black/25"
            : "border-slate-200 bg-white dark:border-slate-700 dark:bg-gradient-to-br dark:from-[hsl(var(--factory-hue)_54%_18%)] dark:to-[hsl(var(--factory-hue)_64%_12%)]",
        ].join(" ")}
        style={
          currentPriorityBale
            ? {
                backgroundColor: currentPriorityBale.color,
                color: getPriorityScanLetterInk(currentPriorityBale.color),
              }
            : undefined
        }
        aria-label={
          currentPriorityBale ? tr("priorityColor", { color: currentPriorityBale.color }) : tr("currentPriority")
        }
        data-testid="current-priority-color"
      >
        {currentPriorityBale ? (
          <div
            className="flex h-full min-h-[230px] flex-col items-center justify-center gap-2 p-5 text-center"
            aria-live="polite"
          >
            <div className="flex items-center gap-1.5 rounded-full border border-current/30 bg-white/15 px-3 py-1 text-xs font-bold">
              <CheckCircle2 className="h-4 w-4" />
              {tr("scanned")}
            </div>
            {getPriorityScanLetter(currentPriorityBale.color) && (
              <span
                className="font-black text-[clamp(4.5rem,9vw,7rem)] leading-none"
                style={{ color: getPriorityScanLetterInk(currentPriorityBale.color) }}
                data-testid="current-priority-letter"
                aria-label={"Letter " + getPriorityScanLetter(currentPriorityBale.color)}
              >
                {getPriorityScanLetter(currentPriorityBale.color)}
              </span>
            )}
            <div className="max-w-full truncate font-mono text-lg font-bold">{currentPriorityBale.referenceNumber}</div>
            <p className="text-xs font-semibold">
              {tr("priorityNumber", { priority: currentPriorityBale.priority })} ·{" "}
              {tr("loadingNumber", { orderId: currentPriorityBale.orderId })}
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-[230px] flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-200 bg-blue-50 text-blue-500 dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300">
              <ScanLine className="h-8 w-8" />
            </span>
            <h3 className="font-bold text-slate-800 dark:text-slate-100">{tr("currentPriority")}</h3>
            <p className="max-w-xs text-sm text-slate-500 dark:text-slate-400">{tr("scanToBegin")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
