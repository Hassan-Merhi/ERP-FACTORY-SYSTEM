import { Boxes, CalendarDays, CheckSquare, DollarSign, MessageSquareText, ScanLine, Trash2, Weight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { PageHeader } from "@/components/PageHeader";
import { FactorySalesDispatchSwitcher } from "./FactorySalesDispatchSwitcher";
import { Textarea } from "@/components/ui/textarea";
import { fmt, fmtKg } from "./wastedispatch/utils";
import { useWasteDispatchModel } from "./wastedispatch/useWasteDispatchModel";
import { WasteBaleGroupTable } from "./wastedispatch/components/WasteBaleGroupTable";
import { DispatchHistoryPanel } from "./wastedispatch/components/DispatchHistoryPanel";
import { ConfirmDisposalDialog, DeleteDispatchDialog, PrintDispatchDialog } from "./wastedispatch/OptimizedDialogs";

export default function WasteDispatchOptimized() {
  const model = useWasteDispatchModel();
  const {
    scanInput,
    setScanInput,
    dispatchDate,
    setDispatchDate,
    notes,
    setNotes,
    selected,
    selectedTotals,
    confirming,
    setConfirming,
    clearSelectedBales,
    handleScan,
    scanReference,
    submitMutation,
    deleteDispatchId,
    setDeleteDispatchId,
    deleteDispatchMutation,
    printData,
    setPrintData,
  } = model;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="waste-dispatch-page">
      <div className="flex-1 space-y-5 overflow-y-auto p-3 sm:p-5 lg:p-6">
        <FactorySalesDispatchSwitcher />
        {/* Presentation only: all dispatch state, permissions, scanning, and accounting remain in the existing model. */}
        <section className="relative isolate overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-r from-white via-slate-50 to-orange-50/70 shadow-sm dark:border-slate-700/70 dark:from-card dark:via-blue-950/25 dark:to-card">
          <div className="pointer-events-none absolute -right-8 -top-12 hidden h-52 w-80 -rotate-12 items-center justify-center rounded-[3rem] border border-orange-400/20 bg-gradient-to-br from-orange-400/15 via-sky-400/5 to-transparent text-orange-500/15 dark:text-orange-300/10 md:flex" aria-hidden="true">
            <Boxes className="h-40 w-40 stroke-[0.7]" />
          </div>
          <div className="relative z-10 flex min-w-0 items-center gap-4 px-4 py-5 sm:px-6 sm:py-6">
            <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-orange-400/25 bg-orange-500/10 text-orange-600 shadow-sm dark:bg-orange-500/15 dark:text-orange-400 sm:flex" aria-hidden="true">
              <Trash2 className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1 [&_[data-testid=page-header]]:mb-0 [&_[data-testid=page-header]]:border-0 [&_[data-testid=page-header]]:pb-0 [&_[data-testid=text-page-title]]:text-xl sm:[&_[data-testid=text-page-title]]:text-2xl">
              <PageHeader
                title="Waste Dispatch"
                subtitle="Select and dispatch Garbage or Wiper bales from factory stock"
                icon={<Trash2 className="h-5 w-5 sm:hidden" />}
              />
            </div>
          </div>
        </section>

        <section className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/80 sm:p-5 lg:grid-cols-[minmax(160px,0.75fr)_minmax(230px,1.6fr)_minmax(210px,1fr)] lg:gap-0" aria-label="Waste dispatch details">
          <div className="flex flex-col gap-2 lg:pr-5">
            <label htmlFor="waste-dispatch-date" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
              <CalendarDays className="h-4 w-4 text-orange-500" /> Dispatch Date
            </label>
            <Input
              id="waste-dispatch-date"
              type="date"
              value={dispatchDate}
              onChange={(event) => setDispatchDate(event.target.value)}
              className="h-10 w-full rounded-lg border-slate-300 bg-slate-50/70 font-semibold tabular-nums focus-visible:ring-orange-500 dark:border-slate-600 dark:bg-slate-950/50"
              data-testid="input-dispatch-date"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:border-x lg:border-slate-200 lg:px-5 dark:lg:border-slate-700">
            <label htmlFor="waste-dispatch-notes" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
              <MessageSquareText className="h-4 w-4 text-orange-500" /> Notes (optional)
            </label>
            <Textarea
              id="waste-dispatch-notes"
              placeholder="Reason for disposal..."
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              className="min-h-16 resize-y rounded-lg border-slate-300 bg-slate-50/70 focus-visible:ring-orange-500 dark:border-slate-600 dark:bg-slate-950/50"
              data-testid="input-notes"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:pl-5">
            <label htmlFor="waste-dispatch-scan" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
              <ScanLine className="h-4 w-4 text-orange-500" /> Scan / Enter Ref
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
                <Input
                  id="waste-dispatch-scan"
                  value={scanInput}
                  onChange={(event) => setScanInput(event.target.value)}
                  onKeyDown={handleScan}
                  placeholder="REF123456 + Enter"
                  className="h-10 rounded-lg border-slate-300 bg-slate-50/70 pl-9 font-mono text-sm focus-visible:ring-orange-500 dark:border-slate-600 dark:bg-slate-950/50"
                  data-testid="input-scan-ref"
                  autoComplete="off"
                />
              </div>
              <div className="shrink-0 rounded-lg border border-orange-500/60 bg-orange-500/5 p-0.5 dark:bg-orange-500/10">
                <MobileBarcodeScanner onScan={(code) => void scanReference(code)} />
              </div>
            </div>
          </div>
        </section>

        <WasteBaleGroupTable model={model} />

        {selected.size > 0 && (
          <Card className="overflow-hidden rounded-2xl border border-orange-300 bg-orange-50/70 shadow-sm dark:border-orange-500/35 dark:bg-orange-500/10">
            <CardContent className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-5">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                    <span className="text-sm font-semibold text-orange-800 dark:text-orange-300" data-testid="text-selected-count">
                      {selected.size} bale{selected.size !== 1 ? "s" : ""} selected
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Weight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm" data-testid="text-total-weight">
                      {fmtKg(selectedTotals.weight)} kg
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium" data-testid="text-total-cost">
                      {fmt(selectedTotals.cost)} write-off
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={clearSelectedBales}>
                    <X className="mr-1.5 h-3.5 w-3.5" /> Clear
                  </Button>
                  <Button variant="destructive" onClick={() => setConfirming(true)} data-testid="button-dispatch-waste">
                    <Trash2 className="mr-2 h-4 w-4" /> Dispatch {selected.size} Bale{selected.size !== 1 ? "s" : ""}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <DispatchHistoryPanel model={model} />
      </div>

      <ConfirmDisposalDialog
        open={confirming}
        onOpenChange={setConfirming}
        baleCount={selected.size}
        weight={selectedTotals.weight}
        cost={selectedTotals.cost}
        dispatchDate={dispatchDate}
        notes={notes}
        isPending={submitMutation.isPending}
        onConfirm={() => submitMutation.mutate()}
      />

      <DeleteDispatchDialog
        dispatchId={deleteDispatchId}
        onClose={() => setDeleteDispatchId(null)}
        isPending={deleteDispatchMutation.isPending}
        onConfirm={(id) => deleteDispatchMutation.mutate(id)}
      />

      <PrintDispatchDialog printData={printData} onClose={() => setPrintData(null)} />
    </div>
  );
}
