import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ExternalLink, FileCheck, List, Star } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { PageHeader } from "@/components/PageHeader";

import { AliasConflictAlert, ComparisonCards } from "./containerverification/ComparisonCards";
import { LoadedItemsCard } from "./containerverification/LoadedItemsCard";
import { SummaryCards } from "./containerverification/SummaryCards";
import type { LoadedItemDraft } from "./containerverification/types";
import { useContainerVerificationStatePart1 } from "./useContainerVerificationStatePart1";
import { useContainerVerificationStatePart2 } from "./useContainerVerificationStatePart2";

function useContainerVerificationState() {
  const {
    addItemMutation,
    autoCompare,
    autoCompareTriggered,
    autoPopulateMutation,
    autoSupplierId,
    containerData,
    containerId,
    deleteItemMutation,
    fileInputRef,
    generateComparison,
    handleFileImport,
    isDeveloper,
    loadedItems,
    navigate,
    proformas,
    selectedProformaId,
    selectedSupplierData,
    selectedSupplierId,
    setAutoCompareTriggered,
    setSelectedProformaId,
    setSelectedSupplierId,
    setVerificationResult,
    setViewMode,
    suppliers,
    toast,
    updateItemMutation,
    verificationResult,
    viewMode,
  } = useContainerVerificationStatePart1();
  const {
    container,
    exportSummaryExcel,
    exportToExcel,
    lessLoaded,
    notRequested,
    openSelectedProforma,
    overloaded,
    priceDiffs,
    requestAutoPopulate,
    selectedSupplier,
    selectedSupplierMissingFromList,
  } = useContainerVerificationStatePart2({
    autoCompare,
    autoCompareTriggered,
    autoPopulateMutation,
    autoSupplierId,
    containerData,
    containerId,
    generateComparison,
    proformas,
    selectedProformaId,
    selectedSupplierData,
    selectedSupplierId,
    setAutoCompareTriggered,
    setSelectedProformaId,
    setSelectedSupplierId,
    suppliers,
    toast,
    verificationResult,
  });
  return {
    addItemMutation,
    autoPopulateMutation,
    container,
    containerId,
    deleteItemMutation,
    exportSummaryExcel,
    exportToExcel,
    fileInputRef,
    generateComparison,
    handleFileImport,
    isDeveloper,
    lessLoaded,
    loadedItems,
    navigate,
    notRequested,
    openSelectedProforma,
    overloaded,
    priceDiffs,
    proformas,
    requestAutoPopulate,
    selectedProformaId,
    selectedSupplier,
    selectedSupplierId,
    selectedSupplierMissingFromList,
    setSelectedProformaId,
    setSelectedSupplierId,
    setVerificationResult,
    setViewMode,
    suppliers,
    updateItemMutation,
    verificationResult,
    viewMode,
  };
}

export default function ContainerVerification() {
  const {
    addItemMutation,
    autoPopulateMutation,
    container,
    containerId,
    deleteItemMutation,
    exportSummaryExcel,
    exportToExcel,
    fileInputRef,
    generateComparison,
    handleFileImport,
    isDeveloper,
    lessLoaded,
    loadedItems,
    navigate,
    notRequested,
    openSelectedProforma,
    overloaded,
    priceDiffs,
    proformas,
    requestAutoPopulate,
    selectedProformaId,
    selectedSupplier,
    selectedSupplierId,
    selectedSupplierMissingFromList,
    setSelectedProformaId,
    setSelectedSupplierId,
    setVerificationResult,
    setViewMode,
    suppliers,
    updateItemMutation,
    verificationResult,
    viewMode,
  } = useContainerVerificationState();

  return (
    <div className="flex flex-col h-full overflow-y-auto sm:p-4 lg:p-6">
      <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleFileImport} />

      <PageHeader
        title="Container Verification"
        meta={<span>{container?.containerNumber || `Container #${containerId}`} - Proforma vs Loaded Items</span>}
        onBack={() => navigate(`/containers/${containerId}`)}
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <LoadedItemsCard
          items={loadedItems}
          autoPopulatePending={autoPopulateMutation.isPending}
          onAutoPopulate={requestAutoPopulate}
          onImportClick={() => fileInputRef.current?.click()}
          onAdd={(draft: LoadedItemDraft) => addItemMutation.mutateAsync(draft)}
          onUpdate={(id: number, draft: LoadedItemDraft) => updateItemMutation.mutateAsync({ id, data: draft })}
          onDelete={(id: number) => deleteItemMutation.mutate(id)}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Generate Comparison</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium mb-1 block">Supplier</label>
              <Select
                value={selectedSupplierId}
                onValueChange={(v) => {
                  setSelectedSupplierId(v);
                  setSelectedProformaId("");
                  setVerificationResult(null);
                }}
              >
                <SelectTrigger data-testid="select-supplier">
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {selectedSupplierMissingFromList && (
                    <SelectItem value={selectedSupplierId}>
                      {selectedSupplier?.legalName ||
                        selectedSupplier?.name ||
                        selectedSupplier?.code ||
                        `Supplier #${selectedSupplierId}`}
                    </SelectItem>
                  )}
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.legalName || s.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Proforma</label>
              <div className="flex items-center gap-2">
                <Select value={selectedProformaId} onValueChange={setSelectedProformaId} disabled={!selectedSupplierId}>
                  <SelectTrigger className="flex-1" data-testid="select-proforma">
                    <SelectValue placeholder={selectedSupplierId ? "Select proforma" : "Select a supplier first"} />
                  </SelectTrigger>
                  <SelectContent>
                    {proformas.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        <span className="flex items-center gap-1.5">
                          {p.isStarred && <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />}
                          {p.reference}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={openSelectedProforma}
                  disabled={!selectedSupplierId || !selectedProformaId}
                  className="shrink-0"
                  data-testid="button-view-proforma"
                >
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  View Proforma
                </Button>
              </div>
              {proformas.length > 0 && !proformas.some((p) => p.isStarred) && (
                <p className="text-xs text-muted-foreground mt-1">
                  Tip: star a proforma on the supplier page to auto-select it here
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => generateComparison()}
                disabled={!selectedSupplierId || !selectedProformaId || autoPopulateMutation.isPending}
                className="flex-1"
                data-testid="button-generate-comparison"
              >
                <FileCheck className="mr-2 h-4 w-4" />
                Generate Comparison
              </Button>
              {verificationResult && (
                <>
                  <ExportButton onClick={() => void exportToExcel()} data-testid="button-export-excel" />
                  <ExportButton
                    label="Export Excel (Summary)"
                    onClick={() => void exportSummaryExcel()}
                    data-testid="button-export-summary-excel"
                  />
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {verificationResult && (
        <>
          {isDeveloper && <AliasConflictAlert conflicts={verificationResult.aliasConflicts ?? []} />}
          <div className="flex items-center gap-2 mb-4">
            <Button
              variant={viewMode === "summary" ? "default" : "outline"}
              size="sm"
              onClick={() => setViewMode(viewMode === "summary" ? "detailed" : "summary")}
              className="toggle-elevate"
              data-testid="button-toggle-summary"
            >
              <List className="mr-1.5 h-3.5 w-3.5" />
              {viewMode === "summary" ? "Hide Summary" : "Show Summary"}
            </Button>
          </div>

          <ComparisonCards
            overloaded={overloaded}
            lessLoaded={lessLoaded}
            notRequested={notRequested}
            priceDiffs={priceDiffs}
          />

          {viewMode === "summary" && (
            <SummaryCards
              overloaded={overloaded}
              lessLoaded={lessLoaded}
              notRequested={notRequested}
              priceDiffs={priceDiffs}
            />
          )}
        </>
      )}
    </div>
  );
}
