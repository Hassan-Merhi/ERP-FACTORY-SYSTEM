import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Plus, Users } from "lucide-react";
import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";

import { useFactoryProformasModel } from "./factoryproformas/useFactoryProformasModel";
import { FactoryProformasHeader } from "./factoryproformas/FactoryProformasHeader";
import { ProformaCard } from "./factoryproformas/ProformaCard";
import { RenameProformaDialog } from "./factory-proformas/dialogs/RenameProformaDialog";
import { TransferProformaDialog } from "./factory-proformas/dialogs/TransferProformaDialog";
import { AddPriceLineDialog } from "./factory-proformas/dialogs/AddPriceLineDialog";
import { EditPriceLineDialog } from "./factory-proformas/dialogs/EditPriceLineDialog";
import { CreatePendingLoadingDialog } from "./factory-proformas/dialogs/CreatePendingLoadingDialog";
import { ImportProformaExcelDialog } from "./factory-proformas/dialogs/ImportProformaExcelDialog";
import { CreateProformaDialog } from "./factory-proformas/dialogs/CreateProformaDialog";
import type { Proforma } from "./factoryproformas/types";
export default function FactoryProformas() {
  const model = useFactoryProformasModel();
  const {
    navigate,
    expandedProformaIds,
    setExpandedProformaIds,
    newProformaName: _newProformaName,
    pendingDelete,
    setPendingDelete,
    renamingProforma: _renamingProforma,
    transferProforma: _transferProforma,
    editingLine: _editingLine,
    createLoadingProforma: _createLoadingProforma,
    excelImportName: _excelImportName,
    customerId,
    customers,
    customersLoading,
    proformas,
    proformasLoading,
    expandedProformaStateById,
    showInactive,
    setShowInactive,
    proformaSearch,
  } = model;

  const openAddLineFor = (proformaId: number) => {
    model.setAddLineProformaId(proformaId);
    model.setAddLineMode("catalog");
    model.setCatalogSelectedItem(null);
    model.setCatalogSearch("");
    model.setNewLine({ articleCode: "", productName: "", quantity: "", pricePerBale: "" });
    model.setIsAddLineOpen(true);
  };

  const beginInlineQtyEdit = (lineId: number, currentQuantity: number) => {
    model.setInlineQtyLineId(lineId);
    model.setInlineQtyValue(String(currentQuantity));
  };

  const beginRename = (proforma: Proforma) => {
    model.setRenamingProforma(proforma);
    model.setRenameValue(proforma.name);
  };

  const beginTransfer = (proforma: Proforma) => {
    model.setTransferProforma(proforma);
    model.setTransferTargetCustomerId("");
  };

  return (
    <div className="flex flex-col h-full">
      <FactoryProformasHeader
        customerId={customerId}
        setExcelImportName={model.setExcelImportName}
        setExcelImportLines={model.setExcelImportLines}
        setExcelImportErrors={model.setExcelImportErrors}
        setIsExcelImportOpen={model.setIsExcelImportOpen}
        setIsCreateOpen={model.setIsCreateOpen}
        customersLoading={customersLoading}
        selectedCustomerId={model.selectedCustomerId}
        setSelectedCustomerId={model.setSelectedCustomerId}
        setExpandedProformaIds={setExpandedProformaIds}
        setProformaSearch={model.setProformaSearch}
        customers={customers}
        proformaSearch={proformaSearch}
      />

      {/* ── Content area ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-6 py-5">
        {/* Loading skeletons */}
        {customerId && proformasLoading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        )}

        {/* Empty: no customer selected */}
        {!customerId && !customersLoading && (
          <div
            className="flex flex-col items-center justify-center py-20 text-center"
            data-testid="text-select-customer"
          >
            <div className="rounded-full bg-muted p-4 mb-4">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="font-medium text-muted-foreground">No customer selected</p>
            <p className="text-sm text-muted-foreground mt-1">Pick a customer above to view their proformas</p>
          </div>
        )}

        {/* Empty: customer selected but no proformas */}
        {customerId && !proformasLoading && proformas.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="text-no-proformas">
            <div className="rounded-full bg-muted p-4 mb-4">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="font-medium text-muted-foreground">No proformas yet</p>
            <p className="text-sm text-muted-foreground mt-1">Create a proforma to define this customer's pricing</p>
            <Button size="sm" className="mt-4" onClick={() => model.setIsCreateOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New Proforma
            </Button>
          </div>
        )}

        {/* Proforma list */}
        {customerId && !proformasLoading && proformas.length > 0 && (
          <div className="space-y-3">
            {/* Inactive toggle + search status */}
            {(() => {
              const inactiveCount = proformas.filter((p) => !p.isActive).length;
              const searchTerm = proformaSearch.trim().toLowerCase();
              const visibleProformas = proformas
                .filter((p) => p.isActive || showInactive)
                .filter((p) => !searchTerm || p.name.toLowerCase().includes(searchTerm));
              const allExpanded =
                visibleProformas.length > 0 && visibleProformas.every((p) => expandedProformaIds.has(p.id));
              return (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  {searchTerm ? (
                    <p className="text-sm text-muted-foreground">
                      {visibleProformas.length === 0
                        ? `No proformas match "${proformaSearch}"`
                        : `${visibleProformas.length} proforma${visibleProformas.length !== 1 ? "s" : ""} matching "${proformaSearch}"`}
                    </p>
                  ) : (
                    <div />
                  )}
                  <div className="flex items-center gap-2 ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (allExpanded) {
                          setExpandedProformaIds(new Set());
                        } else {
                          setExpandedProformaIds(new Set(visibleProformas.map((p) => p.id)));
                        }
                      }}
                      data-testid="button-expand-collapse-all"
                      className="text-muted-foreground"
                    >
                      {allExpanded ? "Collapse all" : "Expand all"}
                    </Button>
                    {inactiveCount > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowInactive((v) => !v)}
                        data-testid="button-toggle-inactive-proformas"
                        className="text-muted-foreground"
                      >
                        {showInactive ? `Hide inactive (${inactiveCount})` : `Show inactive (${inactiveCount})`}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })()}

            {proformas
              .filter((p) => p.isActive || showInactive)
              .filter(
                (p) => !proformaSearch.trim() || p.name.toLowerCase().includes(proformaSearch.trim().toLowerCase())
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((proforma) => {
                const isExpanded = expandedProformaIds.has(proforma.id);
                const detailState = expandedProformaStateById.get(proforma.id);
                const detailProforma = detailState?.data;
                const detailLoading = isExpanded && !detailProforma && (detailState?.isLoading ?? true);
                const detailError = isExpanded && !detailProforma && (detailState?.isError ?? false);

                return (
                  <ProformaCard
                    key={proforma.id}
                    proforma={proforma}
                    isExpanded={isExpanded}
                    onToggleExpand={() =>
                      setExpandedProformaIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(proforma.id)) next.delete(proforma.id);
                        else next.add(proforma.id);
                        return next;
                      })
                    }
                    detailProforma={detailProforma}
                    detailLoading={detailLoading}
                    detailError={detailError}
                    onDetailRefetch={() => detailState?.refetch()}
                    customerId={customerId}
                    hideProformaPrice={model.hideProformaPrice}
                    canEdit={model.canEdit}
                    formatAmount={model.formatAmount}
                    formatProformaDate={model.formatProformaDate}
                    navigate={navigate}
                    toggleActiveMutation={model.toggleActiveMutation}
                    deleteProformaMutation={model.deleteProformaMutation}
                    renameProforma={beginRename}
                    transferProforma={beginTransfer}
                    setPendingDelete={setPendingDelete}
                    onAddLine={() => openAddLineFor(proforma.id)}
                    saveAgreedPricesMutation={model.saveAgreedPricesMutation}
                    applyProductionPricesMutation={model.applyProductionPricesMutation}
                    applyCatalogPricesMutation={model.applyCatalogPricesMutation}
                    inlineQtyLineId={model.inlineQtyLineId}
                    inlineQtyValue={model.inlineQtyValue}
                    onInlineQtyValueChange={model.setInlineQtyValue}
                    onInlineQtyEdit={beginInlineQtyEdit}
                    onInlineQtyCancel={() => model.setInlineQtyLineId(null)}
                    commitInlineQty={model.commitInlineQty}
                    onEditLine={(line) => {
                      model.setEditingLine(line);
                      model.setEditLineValues({
                        productName: line.productName,
                        quantity: String(line.quantity),
                        pricePerBale: line.pricePerBale,
                        weightPerBaleKg: line.weightPerBaleKg ?? "",
                      });
                    }}
                    deleteLineMutation={model.deleteLineMutation}
                  />
                );
              })}
          </div>
        )}
      </div>

      <CreateProformaDialog
        isCreateOpen={model.isCreateOpen}
        setIsCreateOpen={model.setIsCreateOpen}
        newProformaName={model.newProformaName}
        setNewProformaName={model.setNewProformaName}
        createProformaMutation={model.createProformaMutation}
        handleCreateProforma={model.handleCreateProforma}
      />

      <RenameProformaDialog
        renameProformaMutation={model.renameProformaMutation}
        renameValue={model.renameValue}
        renamingProforma={model.renamingProforma}
        setRenameValue={model.setRenameValue}
        setRenamingProforma={model.setRenamingProforma}
      />

      {/* ── Transfer Proforma Dialog ────────────────────────────────────── */}
      <TransferProformaDialog
        customers={customers}
        setTransferProforma={model.setTransferProforma}
        setTransferTargetCustomerId={model.setTransferTargetCustomerId}
        transferProforma={model.transferProforma}
        transferProformaMutation={model.transferProformaMutation}
        transferTargetCustomerId={model.transferTargetCustomerId}
      />

      <AddPriceLineDialog
        addLineMode={model.addLineMode}
        addLineMutation={model.addLineMutation}
        allStockItems={model.allStockItems}
        catalogSearch={model.catalogSearch}
        catalogSelectedItem={model.catalogSelectedItem}
        handleAddLine={model.handleAddLine}
        isAddLineOpen={model.isAddLineOpen}
        newLine={model.newLine}
        priceListMap={model.priceListMap}
        setAddLineMode={model.setAddLineMode}
        setCatalogSearch={model.setCatalogSearch}
        setCatalogSelectedItem={model.setCatalogSelectedItem}
        setIsAddLineOpen={model.setIsAddLineOpen}
        setNewLine={model.setNewLine}
      />

      <EditPriceLineDialog
        editLineMutation={model.editLineMutation}
        editLineValues={model.editLineValues}
        editingLine={model.editingLine}
        handleEditLine={model.handleEditLine}
        setEditLineValues={model.setEditLineValues}
        setEditingLine={model.setEditingLine}
      />
      <CreatePendingLoadingDialog
        createLoadingLocationId={model.createLoadingLocationId}
        createLoadingMutation={model.createLoadingMutation}
        createLoadingProforma={model.createLoadingProforma}
        locations={model.locations}
        setCreateLoadingLocationId={model.setCreateLoadingLocationId}
        setCreateLoadingProforma={model.setCreateLoadingProforma}
      />

      {/* ── Excel Import Dialog ──────────────────────────────────────────── */}
      <ImportProformaExcelDialog
        bulkImportMutation={model.bulkImportMutation}
        customerId={customerId}
        customers={customers}
        downloadProformaTemplate={model.downloadProformaTemplate}
        excelFileInputRef={model.excelFileInputRef}
        excelImportErrors={model.excelImportErrors}
        excelImportLines={model.excelImportLines}
        excelImportLoading={model.excelImportLoading}
        excelImportName={model.excelImportName}
        handleExcelFile={model.handleExcelFile}
        isExcelImportOpen={model.isExcelImportOpen}
        setExcelImportErrors={model.setExcelImportErrors}
        setExcelImportLines={model.setExcelImportLines}
        setExcelImportName={model.setExcelImportName}
        setIsExcelImportOpen={model.setIsExcelImportOpen}
      />

      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
