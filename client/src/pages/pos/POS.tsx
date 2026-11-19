import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ShoppingCart } from "lucide-react";
import { SaleGrid } from "./pos-components/SaleGrid";
import { InventoryPicker } from "./pos-components/InventoryPicker";
import type { AuthMe } from "@shared/apiTypes";
import { InvoiceTemplate, type InvoiceSale } from "./pos-components/InvoiceTemplate";
import { POSDialogs } from "./pos-components/POSDialogs";
import { POSHeader } from "./pos-components/POSHeader";
import { PosCheckoutStrip } from "./pos-components/PosCheckoutStrip";
import { PosMobileLayout } from "./pos-components/PosMobileLayout";
import { PosWorkspaceColumns } from "./pos-components/PosWorkspaceColumns";
import { PosSaleGridWrap, PosSaleNotes, PosSalePanel, PosSaleScreen } from "./pos-components/PosSaleLayout";

import { POS_COLUMNS } from "./utils/posCalculations";
import { ErrorState } from "@/components/ui/page-state";
import { GoldenCoastPosReadinessAlert } from "./pos-components/GoldenCoastPosReadinessAlert";
import { POS_PICKER_LIST_ID } from "./POSUsePOSStatePart1Part1";
import { usePOSState } from "./POSUsePOSState";
import { exportPosTransaction } from "./posTransactionExport";

export default function POS(props: { posUser?: AuthMe; editVoucherId?: string }) {
  const {
    activeCurrency,
    activeLocation,
    activeRow,
    allLocations,
    authUser,
    bankAccounts,
    canSellNegativeStock,
    canSendWhatsApp,
    cashLedgerAccounts,
    clearActiveRowTimerRef,
    companySettings,
    customerAccounts,
    customerComboOpen,
    deleteDraftMutation,
    drafts,
    editVoucher,
    editVoucherId,
    ensureItemSellable,
    exchangeRate,
    fmtAmount,
    focusCell,
    goldenCoastPosBlocked,
    goldenCoastPosSaveDisabled,
    goldenCoastReadiness,
    handleDetailedExport,
    handleExportInventory,
    handleKeyDown,
    handleLoadDraft,
    handleNewSale,
    handlePrint,
    handleSaveSale,
    handleSendInvoiceWhatsApp,
    handleSendWhatsAppReport,
    handleStockPrint,
    handleSummaryExport,
    hasValidItems,
    highlightedIndex,
    inputRefs,
    inventory,
    inventoryError,
    inventoryLoading,
    inventoryPickerSearchRef,
    invoiceWaStatus,
    isCreditSale,
    isSpCompany,
    itemListRef,
    lastAutosaved,
    matchingItemCount,
    mobileCustomerComboOpen,
    mobileSearchInputRef,
    navigate,
    notes,
    paymentAccountId,
    paymentAccountType,
    // Always bind a concrete array before rendering the POS location picker.
    // This also covers initial query hydration for cashier sessions.
    posAssignedLocations: assignedPosLocations = [],
    posLocationsLoading,
    posSelectedLocation,
    posUser,
    posWritesDisabled,
    printRef,
    refetchInventory,
    resolveItemRate,
    rows,
    saleDate,
    saveDraftMutation,
    saveMutation,
    savedSale,
    searchTerm,
    selectItem,
    selectedCell,
    selectedCompany,
    selectedCustomerId,
    selectedItemIndex,
    sendingInvoiceWhatsApp,
    sendingWhatsApp,
    setActiveRow,
    setCustomerComboOpen,
    setHighlightedIndex,
    setIsCreditSale,
    setMobileCustomerComboOpen,
    setNotes,
    setPaymentAccountId,
    setPaymentAccountType,
    setPosSelectedLocation,
    setRows,
    setSaleDate,
    setSearchTerm,
    setSelectedCell,
    setSelectedCustomerId,
    setSelectedLocation,
    setShowDraftDialog,
    setShowPrintDialog,
    setShowStockPrompt,
    setZeroStockAlert,
    showDraftDialog,
    showPrintDialog,
    showStockPrompt,
    stockInventory,
    stockInventoryLoading,
    stockPrintRef,
    stockWaStatus,
    t,
    toast,
    updateRow,
    zeroStockAlert,
    zeroStockItem,
  } = usePOSState(props);

  // ── Admin/dev: export the current edit-mode transaction to Excel ───────────
  async function handleExportTransaction() {
    return await exportPosTransaction({ rows, toast, editVoucher, editVoucherId });
  }

  // Never enable Update until the original receipt and its location are loaded.
  const editNotReady = Boolean(editVoucherId && (!editVoucher || activeLocation?.id !== editVoucher.locationId));
  // ── Early returns ─────────────────────────────────────────────────────────
  if (posUser && posLocationsLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 gap-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <p className="text-muted-foreground text-sm">Loading location...</p>
      </div>
    );
  }

  if (inventoryError) {
    return (
      <div className="p-4 md:p-6">
        <ErrorState
          title="Inventory unavailable"
          description="POS inventory could not be loaded for this location. Your sale draft is preserved; retry to continue."
          actionLabel="Retry inventory"
          onAction={refetchInventory}
        />
      </div>
    );
  }

  if (posUser && !posLocationsLoading && assignedPosLocations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 gap-2">
        <p className="font-semibold">No location assigned</p>
        <p className="text-muted-foreground text-sm">Contact your administrator to be assigned to a location.</p>
      </div>
    );
  }

  if (!activeLocation && !posUser && !editVoucherId) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-8">
        <PageHeader title="Point of Sale" subtitle="Choose the location to sell from." showBackButton={false} />
        <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
          {allLocations.map((loc) => (
            <Card
              key={loc.id}
              role="button"
              tabIndex={0}
              className="cursor-pointer p-5 hover-elevate focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:p-6"
              onClick={() => setSelectedLocation(loc)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedLocation(loc);
                }
              }}
              data-testid={`card-pos-location-${loc.id}`}
            >
              <h3 className="text-lg font-bold">{loc.name}</h3>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <PosSaleScreen variant="erp">
      <POSHeader
        posUser={posUser}
        editVoucherId={editVoucherId}
        activeLocation={activeLocation}
        showPosImport={!posUser || Boolean(companySettings?.posExcelImportEnabled)}
        onExportInventory={handleExportInventory}
        onImportClick={() => navigate("/pos-import")}
        onShowStockReport={() => setShowStockPrompt(true)}
        navigate={navigate}
        saveMutation={saveMutation}
        hasValidItems={hasValidItems}
        disableSave={goldenCoastPosSaveDisabled || posWritesDisabled || editNotReady}
        handleSaveSale={handleSaveSale}
        lastAutosaved={lastAutosaved}
        drafts={drafts}
        onOpenDraftDialog={() => setShowDraftDialog(true)}
        onUpdateDraft={posWritesDisabled ? undefined : () => saveDraftMutation.mutate(undefined)}
        onSummaryExport={handleSummaryExport}
        onDetailedExport={handleDetailedExport}
        onExportTransaction={
          editVoucherId && (authUser?.role === "Admin" || authUser?.role === "Developer")
            ? handleExportTransaction
            : undefined
        }
      />

      <PosCheckoutStrip
        posUser={posUser}
        editVoucherId={editVoucherId}
        activeLocation={activeLocation}
        allLocations={allLocations}
        posAssignedLocations={assignedPosLocations}
        posSelectedLocation={posSelectedLocation}
        setPosSelectedLocation={setPosSelectedLocation}
        setSelectedLocation={setSelectedLocation}
        saleDate={saleDate}
        setSaleDate={setSaleDate}
        paymentAccountType={paymentAccountType}
        setPaymentAccountType={setPaymentAccountType}
        paymentAccountId={paymentAccountId}
        setPaymentAccountId={setPaymentAccountId}
        isCreditSale={isCreditSale}
        setIsCreditSale={setIsCreditSale}
        customerComboOpen={customerComboOpen}
        setCustomerComboOpen={setCustomerComboOpen}
        selectedCustomerId={selectedCustomerId}
        setSelectedCustomerId={setSelectedCustomerId}
        customerAccounts={customerAccounts}
        bankAccounts={bankAccounts}
        cashLedgerAccounts={cashLedgerAccounts}
        isSpCompany={isSpCompany}
      />

      {goldenCoastPosBlocked && <GoldenCoastPosReadinessAlert blockers={goldenCoastReadiness?.blockers} />}

      {/* ── Desktop layout ── */}
      <PosWorkspaceColumns layout="erp">
        <PosSalePanel className="flex-1 overflow-y-auto">
          <PosSaleGridWrap>
            {inventoryLoading ? (
              <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground" aria-busy="true">
                Loading inventory…
              </div>
            ) : (
              <SaleGrid
                rows={rows}
                columns={POS_COLUMNS}
                selectedCell={selectedCell}
                highlightedIndex={selectedItemIndex}
                matchingItemCount={matchingItemCount}
                pickerListId={POS_PICKER_LIST_ID}
                setSelectedCell={setSelectedCell}
                updateRow={updateRow}
                handleDeleteRow={(i) => setRows(rows.filter((_, idx) => idx !== i))}
                handleKeyDown={handleKeyDown}
                setActiveRow={setActiveRow}
                setSearchTerm={setSearchTerm}
                setHighlightedIndex={setHighlightedIndex}
                getStockWarning={() => null}
                formatDisplayAmount={fmtAmount}
                activeCurrency={activeCurrency}
                exchangeRate={exchangeRate}
                inputRefs={inputRefs}
                clearActiveRowTimerRef={clearActiveRowTimerRef}
                focusCell={focusCell}
                toast={toast}
                isEditMode={!!editVoucherId}
              />
            )}
          </PosSaleGridWrap>
          <PosSaleNotes
            id="pos-desktop-notes"
            label={t("pos.modern.notes")}
            optionalLabel={t("pos.modern.optional")}
            placeholder={t("pos.modern.notesPlaceholder")}
            value={notes}
            onChange={setNotes}
            testId="input-notes"
          />
          {!rows.some((row) => row.stockItemId || row.itemName?.trim()) && (
            <div
              data-pos-empty-state="true"
              className="hidden lg:flex flex-1 flex-col items-center justify-center px-6 py-10 text-center"
            >
              <span data-pos-empty-icon="true">
                <ShoppingCart className="h-8 w-8" aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-base font-semibold">{t("pos.modern.addItems")}</h2>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("pos.modern.addItemsHint")}</p>
            </div>
          )}
        </PosSalePanel>
        <InventoryPicker
          inventory={inventory}
          // Preserve the row the cashier was typing into. The item-name input
          // blurs when the sidebar is clicked, so activeRow can clear before
          // the click completes; selectedCell is the stable row fallback.
          selectItem={(item) => selectItem(item, activeRow ?? selectedCell.row)}
          onSearchTermChange={setSearchTerm}
          searchInputRef={inventoryPickerSearchRef}
          listId={POS_PICKER_LIST_ID}
          itemListRef={itemListRef}
          highlightedIndex={highlightedIndex}
          setHighlightedIndex={setHighlightedIndex}
          canSellNegativeStock={canSellNegativeStock}
          syncTerm={searchTerm}
        />
      </PosWorkspaceColumns>

      {/* ── Mobile layout ── */}
      <PosMobileLayout
        posUser={posUser}
        editVoucherId={editVoucherId}
        activeLocation={activeLocation}
        allLocations={allLocations}
        posAssignedLocations={assignedPosLocations}
        posSelectedLocation={posSelectedLocation}
        setPosSelectedLocation={setPosSelectedLocation}
        setSelectedLocation={setSelectedLocation}
        saleDate={saleDate}
        setSaleDate={setSaleDate}
        paymentAccountType={paymentAccountType}
        setPaymentAccountType={setPaymentAccountType}
        paymentAccountId={paymentAccountId}
        setPaymentAccountId={setPaymentAccountId}
        bankAccounts={bankAccounts}
        cashLedgerAccounts={cashLedgerAccounts}
        isCreditSale={isCreditSale}
        setIsCreditSale={setIsCreditSale}
        mobileCustomerComboOpen={mobileCustomerComboOpen}
        setMobileCustomerComboOpen={setMobileCustomerComboOpen}
        selectedCustomerId={selectedCustomerId}
        setSelectedCustomerId={setSelectedCustomerId}
        customerAccounts={customerAccounts}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        mobileSearchInputRef={mobileSearchInputRef}
        inventory={inventory}
        selectItem={selectItem}
        ensureItemSellable={ensureItemSellable}
        resolveItemRate={resolveItemRate}
        rows={rows}
        setRows={setRows}
        updateRow={updateRow}
        notes={notes}
        setNotes={setNotes}
        saveMutation={saveMutation}
        hasValidItems={hasValidItems}
        disableSave={goldenCoastPosSaveDisabled || posWritesDisabled || editNotReady}
        handleSaveSale={handleSaveSale}
        formatDisplayAmount={fmtAmount}
        isSpCompany={isSpCompany}
      />

      <POSDialogs
        zeroStockAlert={zeroStockAlert}
        setZeroStockAlert={setZeroStockAlert}
        zeroStockItem={zeroStockItem}
        showDraftDialog={showDraftDialog}
        setShowDraftDialog={setShowDraftDialog}
        drafts={drafts}
        handleLoadDraft={handleLoadDraft}
        deleteDraftMutation={deleteDraftMutation}
        allowDraftMutations={!posWritesDisabled}
        showPrintDialog={showPrintDialog}
        setShowPrintDialog={setShowPrintDialog}
        editVoucherId={editVoucherId}
        handleNewSale={handleNewSale}
        navigate={navigate}
        activeLocation={activeLocation}
        invoiceWaStatus={invoiceWaStatus}
        handleSendInvoiceWhatsApp={handleSendInvoiceWhatsApp}
        sendingInvoiceWhatsApp={sendingInvoiceWhatsApp}
        stockWaStatus={stockWaStatus}
        handleSendStockWhatsApp={handleSendWhatsAppReport}
        sendingWhatsApp={sendingWhatsApp}
        canSendWhatsApp={canSendWhatsApp}
        handlePrint={handlePrint}
        isCreditSale={isCreditSale}
        showStockPrompt={showStockPrompt}
        setShowStockPrompt={setShowStockPrompt}
        stockInventoryLoading={stockInventoryLoading}
        handleStockPrint={handleStockPrint}
        handleSendWhatsAppReport={handleSendWhatsAppReport}
        stockInventory={stockInventory.map((item) => ({
          stockItemName: item.stockItemName,
          stockItemCode: item.stockItemCode,
          stock: parseFloat(item.quantity),
        }))}
        stockPrintRef={stockPrintRef}
      />

      <InvoiceTemplate
        printRef={printRef}
        savedSale={savedSale as InvoiceSale}
        printUserName={posUser?.fullName || authUser?.fullName || "User"}
        selectedCompany={selectedCompany}
        exchangeRate={exchangeRate}
        fmtPrint={(v) => String(v)}
        fmtPrintCurrency={(v) => String(v)}
      />
    </PosSaleScreen>
  );
}
