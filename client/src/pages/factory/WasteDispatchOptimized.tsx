import { CheckSquare, DollarSign, ScanLine, Trash2, Weight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
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
    submitMutation,
    deleteDispatchId,
    setDeleteDispatchId,
    deleteDispatchMutation,
    printData,
    setPrintData,
  } = model;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b px-6 py-3">
        <PageHeader
          title="Waste Dispatch"
          subtitle="Select and dispatch Garbage or Wiper bales from factory stock"
          icon={<Trash2 className="h-5 w-5" />}
        />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-3">
          <Card className="min-w-60 flex-1">
            <CardContent className="p-3">
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Dispatch Date
                  </label>
                  <Input
                    type="date"
                    value={dispatchDate}
                    onChange={(event) => setDispatchDate(event.target.value)}
                    className="w-40"
                    data-testid="input-dispatch-date"
                  />
                </div>
                <div className="flex min-w-40 flex-1 flex-col gap-1">
                  <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Notes (optional)
                  </label>
                  <Textarea
                    placeholder="Reason for disposal..."
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={1}
                    className="resize-none"
                    data-testid="input-notes"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="min-w-56">
            <CardContent className="flex h-full flex-col justify-center p-3">
              <label className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ScanLine className="h-3 w-3" /> Scan / Enter Ref
              </label>
              <div className="relative">
                <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={scanInput}
                  onChange={(event) => setScanInput(event.target.value)}
                  onKeyDown={handleScan}
                  placeholder="REF123456 + Enter"
                  className="pl-9 font-mono text-sm"
                  data-testid="input-scan-ref"
                  autoComplete="off"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <WasteBaleGroupTable model={model} />

        {selected.size > 0 && (
          <Card className="border-destructive/30 bg-destructive/3">
            <CardContent className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-5">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="h-4 w-4 text-destructive" />
                    <span className="text-sm font-semibold text-destructive" data-testid="text-selected-count">
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
