import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/PageHeader";
import { Trash2, Weight, DollarSign, CheckSquare, ScanLine, X } from "lucide-react";
import { fmt, fmtKg } from "./wastedispatch/utils";
import { WasteDispatchDialogs } from "./wastedispatch/components/WasteDispatchDialogs";
import { useWasteDispatchState } from "./useWasteDispatchState";
import { WasteDispatchCardSection, WasteDispatchCardSection2 } from "./WasteDispatchCardSection";

export default function WasteDispatch() {
  const {
    bales,
    confirming,
    deleteDispatchId,
    deleteDispatchMutation,
    dispatchDate,
    expandedGroups,
    expandedHistoryIds,
    grandTotals,
    handleHistoryPrint,
    handleScan,
    history,
    isLoading,
    notes,
    printData,
    productGroups,
    scanInput,
    scanInputRef,
    scanReference,
    search,
    selected,
    setConfirming,
    setDeleteDispatchId,
    setDispatchDate,
    setNotes,
    setPrintData,
    setScanInput,
    setSearch,
    setSelected,
    setShowAllHistory,
    showAllHistory,
    submitMutation,
    toggleAll,
    toggleBale,
    toggleExpandGroup,
    toggleGroup,
    toggleHistoryItem,
    totalCost,
    totalWeight,
  } = useWasteDispatchState();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page Header */}
      <div className="flex items-center justify-between gap-3 px-6 py-3 border-b flex-wrap">
        <div>
          <PageHeader
            title="Waste Dispatch"
            subtitle="Manage waste bales — dispatch or create new entries"
            icon={<Trash2 className="h-5 w-5" />}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Dispatch Details + Scan — top bar */}
        <div className="flex flex-wrap gap-3">
          {/* Date + Notes */}
          <Card className="flex-1 min-w-60">
            <CardContent className="p-3">
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Dispatch Date
                  </label>
                  <Input
                    type="date"
                    value={dispatchDate}
                    onChange={(e) => setDispatchDate(e.target.value)}
                    className="w-40"
                    data-testid="input-dispatch-date"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1 min-w-40">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Notes (optional)
                  </label>
                  <Textarea
                    placeholder="Reason for disposal..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={1}
                    className="resize-none"
                    data-testid="input-notes"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Scan input */}
          <Card className="min-w-56">
            <CardContent className="p-3 h-full flex flex-col justify-center">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                <ScanLine className="w-3 h-3" /> Scan / Enter Ref
              </label>
              <div className="relative">
                <ScanLine className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={scanInputRef}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={handleScan}
                  placeholder="REF123456 + Enter"
                  className="pl-9 font-mono text-sm"
                  data-testid="input-scan-ref"
                  autoComplete="off"
                />
                <MobileBarcodeScanner onScan={scanReference} className="mt-2" />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Press Enter to select a bale</p>
            </CardContent>
          </Card>
        </div>

        {/* Bale Groups Table */}
        <WasteDispatchCardSection
          bales={bales}
          expandedGroups={expandedGroups}
          grandTotals={grandTotals}
          isLoading={isLoading}
          productGroups={productGroups}
          search={search}
          selected={selected}
          setSearch={setSearch}
          toggleAll={toggleAll}
          toggleBale={toggleBale}
          toggleExpandGroup={toggleExpandGroup}
          toggleGroup={toggleGroup}
        />

        {/* Selection Summary + Dispatch Button */}
        {selected.size > 0 && (
          <Card className="border-destructive/30 bg-destructive/3">
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-5 flex-wrap">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 text-destructive" />
                    <span className="text-sm font-semibold text-destructive" data-testid="text-selected-count">
                      {selected.size} bale{selected.size !== 1 ? "s" : ""} selected
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Weight className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm" data-testid="text-total-weight">
                      {fmtKg(totalWeight)} kg
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <DollarSign className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium" data-testid="text-total-cost">
                      {fmt(totalCost)} write-off
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelected(new Set())} className="gap-1.5">
                    <X className="w-3.5 h-3.5" /> Clear
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setConfirming(true)}
                    data-testid="button-dispatch-waste"
                    className="gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Dispatch {selected.size} Bale{selected.size !== 1 ? "s" : ""}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Dispatch History */}
        <WasteDispatchCardSection2
          expandedHistoryIds={expandedHistoryIds}
          handleHistoryPrint={handleHistoryPrint}
          history={history}
          setDeleteDispatchId={setDeleteDispatchId}
          setShowAllHistory={setShowAllHistory}
          showAllHistory={showAllHistory}
          toggleHistoryItem={toggleHistoryItem}
        />
      </div>

      <WasteDispatchDialogs
        confirming={confirming}
        setConfirming={setConfirming}
        selectedCount={selected.size}
        totalWeight={totalWeight}
        totalCost={totalCost}
        dispatchDate={dispatchDate}
        notes={notes}
        submitPending={submitMutation.isPending}
        onSubmit={() => submitMutation.mutate()}
        deleteDispatchId={deleteDispatchId}
        setDeleteDispatchId={setDeleteDispatchId}
        deletePending={deleteDispatchMutation.isPending}
        onDelete={(id) => deleteDispatchMutation.mutate(id)}
        printData={printData}
        setPrintData={setPrintData}
      />
    </div>
  );
}
