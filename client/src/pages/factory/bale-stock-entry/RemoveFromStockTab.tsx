import { Trash2, List, LayoutList, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RemoveBaleAuthDialog, AssignWorkerDialog } from "./RemoveFromStockDialogs";
import { RemoveFromStockTable } from "./RemoveFromStockTable";
import { useRemoveFromStockTabState } from "./useRemoveFromStockTabState";
export type { InStockBale, WorkerOption } from "./RemoveFromStockTabTypes";

export function RemoveFromStockTab() {
  const {
    activeLocations,
    assigningWorker,
    authError,
    balesLoading,
    bulkUpdateNamesMutation,
    clearSelection,
    condensedRows,
    dateFilter,
    filteredBales,
    formatDisplayDate,
    handlePrintWithWorker,
    handleRemoveClick,
    namesFileRef,
    printSingleBale,
    printWorkerBale,
    printWorkerIdSelected,
    reimportFileRef,
    reimportMutation,
    removalReason,
    removeDialogOpen,
    removeMutation,
    selectAll,
    selectedBaleIds,
    selectedLocationId,
    setDateFilter,
    setImportingNames,
    setPrintWorkerBale,
    setPrintWorkerIdSelected,
    setReimporting,
    setRemovalReason,
    setRemoveDialogOpen,
    setSelectedLocationId,
    setSupervisorPassword,
    setSupervisorUsername,
    setViewMode,
    supervisorPassword,
    supervisorUsername,
    toggleBale,
    toggleCondensedRow,
    totalQty,
    totalWeight,
    viewMode,
    workers,
  } = useRemoveFromStockTabState();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap bg-muted/30 p-4 rounded-xl border">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="w-48">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1 ml-1">Location</p>
            <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
              <SelectTrigger className="h-9 rounded-lg" data-testid="select-remove-location">
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {activeLocations?.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id.toString()}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-40">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1 ml-1">
              Date Filter
            </p>
            <Input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="h-9 rounded-lg"
              data-testid="input-remove-date"
            />
          </div>
          <div className="flex items-center gap-1 bg-background border rounded-lg p-1 h-9 self-end">
            <Button
              variant={viewMode === "condensed" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[11px] font-bold px-2 rounded-md"
              onClick={() => setViewMode("condensed")}
            >
              <LayoutList className="h-3 w-3 mr-1" />
              CONDENSED
            </Button>
            <Button
              variant={viewMode === "detailed" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-[11px] font-bold px-2 rounded-md"
              onClick={() => setViewMode("detailed")}
            >
              <List className="h-3 w-3 mr-1" />
              DETAILED
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end">
          <Button variant="outline" size="sm" className="h-9" onClick={selectAll} data-testid="button-select-all">
            Select All
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={clearSelection}
            data-testid="button-clear-selection"
          >
            Clear
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-9 gap-2"
            disabled={selectedBaleIds.size === 0}
            onClick={handleRemoveClick}
            data-testid="button-remove-selected"
          >
            <Trash2 className="h-4 w-4" />
            Remove Selected ({selectedBaleIds.size})
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setImportingNames(true)}
            data-testid="button-import-names"
          >
            <Upload className="h-4 w-4 mr-2" />
            Import Names
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setReimporting(true)}
            data-testid="button-reimport-bales"
          >
            <Upload className="h-4 w-4 mr-2" />
            Re-import
          </Button>
        </div>
      </div>

      <RemoveFromStockTable
        viewMode={viewMode}
        loading={balesLoading}
        filteredBales={filteredBales}
        condensedRows={condensedRows}
        selectedBaleIds={selectedBaleIds}
        onToggleBale={toggleBale}
        onToggleCondensedRow={toggleCondensedRow}
        formatDisplayDate={formatDisplayDate}
        onPrintBale={(bale) => {
          if (bale.finalizedBy) printSingleBale(bale);
          else setPrintWorkerBale(bale);
        }}
      />

      <div className="flex items-center justify-between px-4 py-3 bg-muted/20 rounded-xl border border-dashed">
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Filtered Count</span>
            <span className="text-lg font-black tabular-nums">
              {totalQty} <span className="text-xs font-normal text-muted-foreground">bales</span>
            </span>
          </div>
          <div className="flex flex-col border-l pl-6">
            <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
              Filtered Weight
            </span>
            <span className="text-lg font-black tabular-nums">
              {totalWeight.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">kg</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
            {selectedBaleIds.size} SELECTED
          </span>
        </div>
      </div>

      <RemoveBaleAuthDialog
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        selectedCount={selectedBaleIds.size}
        supervisorUsername={supervisorUsername}
        onSupervisorUsernameChange={setSupervisorUsername}
        supervisorPassword={supervisorPassword}
        onSupervisorPasswordChange={setSupervisorPassword}
        removalReason={removalReason}
        onRemovalReasonChange={setRemovalReason}
        authError={authError}
        isPending={removeMutation.isPending}
        onConfirm={() => removeMutation.mutate()}
      />

      <AssignWorkerDialog
        open={!!printWorkerBale}
        onOpenChange={(open) => !open && setPrintWorkerBale(null)}
        workers={workers}
        workerIdSelected={printWorkerIdSelected}
        onWorkerIdChange={setPrintWorkerIdSelected}
        isPending={assigningWorker}
        onConfirm={handlePrintWithWorker}
      />

      <input
        type="file"
        ref={namesFileRef}
        className="hidden"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) bulkUpdateNamesMutation.mutate(file);
          e.target.value = "";
        }}
      />
      <input
        type="file"
        ref={reimportFileRef}
        className="hidden"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) reimportMutation.mutate(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
