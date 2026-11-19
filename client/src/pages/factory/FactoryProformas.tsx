import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";

import { FactoryProformasHeader } from "./factoryproformas/FactoryProformasHeader";
import { RenameProformaDialog } from "./factory-proformas/dialogs/RenameProformaDialog";
import { TransferProformaDialog } from "./factory-proformas/dialogs/TransferProformaDialog";
import { AddPriceLineDialog } from "./factory-proformas/dialogs/AddPriceLineDialog";
import { EditPriceLineDialog } from "./factory-proformas/dialogs/EditPriceLineDialog";
import { CreatePendingLoadingDialog } from "./factory-proformas/dialogs/CreatePendingLoadingDialog";
import { ImportProformaExcelDialog } from "./factory-proformas/dialogs/ImportProformaExcelDialog";
import { CreateProformaDialog } from "./factory-proformas/dialogs/CreateProformaDialog";
import { AssignProformaDestinationDialog } from "./factory-proformas/dialogs/AssignProformaDestinationDialog";
import { useFactoryProformasState } from "./useFactoryProformasState";
import { FactoryProformasContent } from "./FactoryProformasContent";
export default function FactoryProformas() {
  const {
    model,
    recordChanges,
    customerId,
    proformas,
    proformasLoading,
    customersLoading,
    setExpandedProformaIds,
    customers,
    proformaSearch,
    showInactive,
    expandedProformaIds,
    setShowInactive,
    expandedProformaStateById,
    navigate,
    setPendingDelete,
    pendingDelete,
    openAddLineFor,
    beginInlineQtyEdit,
    beginRename,
    beginAssignDestination,
    beginTransfer,
  } = useFactoryProformasState();

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-violet-500/[0.035] via-background to-background dark:from-violet-600/[0.08]">
      <FactoryProformasHeader
        canCreate={!recordChanges.isCreateOnly}
        customerId={customerId}
        proformas={proformas}
        proformasLoading={proformasLoading}
        hideProformaPrice={model.hideProformaPrice}
        formatAmount={model.formatAmount}
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
      <FactoryProformasContent
        beginAssignDestination={beginAssignDestination}
        beginInlineQtyEdit={beginInlineQtyEdit}
        beginRename={beginRename}
        beginTransfer={beginTransfer}
        customerId={customerId}
        customersLoading={customersLoading}
        expandedProformaIds={expandedProformaIds}
        expandedProformaStateById={expandedProformaStateById}
        model={model}
        navigate={navigate}
        openAddLineFor={openAddLineFor}
        proformas={proformas}
        proformaSearch={proformaSearch}
        proformasLoading={proformasLoading}
        recordChanges={recordChanges}
        setExpandedProformaIds={setExpandedProformaIds}
        setPendingDelete={setPendingDelete}
        setShowInactive={setShowInactive}
        showInactive={showInactive}
      />

      <CreateProformaDialog
        isCreateOpen={model.isCreateOpen}
        setIsCreateOpen={model.setIsCreateOpen}
        newProformaName={model.newProformaName}
        setNewProformaName={model.setNewProformaName}
        newDestination={model.newDestination}
        setNewDestination={model.setNewDestination}
        createProformaMutation={model.createProformaMutation}
        handleCreateProforma={model.handleCreateProforma}
      />

      <AssignProformaDestinationDialog
        destinationProforma={model.destinationProforma}
        setDestinationProforma={model.setDestinationProforma}
        destinationValue={model.destinationValue}
        setDestinationValue={model.setDestinationValue}
        assignDestinationMutation={model.assignDestinationMutation}
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
        excelImportDestination={model.excelImportDestination}
        setExcelImportDestination={model.setExcelImportDestination}
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
