import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { getErrorDetails } from "@shared/errorUtils";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Textarea } from "@/components/ui/textarea";
import { ShoppingCart, NotebookPen } from "lucide-react";
import "@/styles/pos-workspace-premium.css";
import { SaleGrid } from "./pos-components/SaleGrid";
import { InventoryPicker } from "./pos-components/InventoryPicker";
import type { AuthMe } from "@shared/apiTypes";
import { InvoiceTemplate, type InvoiceSale } from "./pos-components/InvoiceTemplate";
import { POSDialogs } from "./pos-components/POSDialogs";
import { POSHeader } from "./pos-components/POSHeader";
import { PosCheckoutStrip } from "./pos-components/PosCheckoutStrip";
import { PosMobileLayout } from "./pos-components/PosMobileLayout";
import { PosWorkspaceColumns } from "./pos-components/PosWorkspaceColumns";

import { POS_COLUMNS } from "./utils/posCalculations";
import { ErrorState } from "@/components/ui/page-state";
import { GoldenCoastPosReadinessAlert } from "./pos-components/GoldenCoastPosReadinessAlert";
import { POS_PICKER_LIST_ID } from "./POSUsePOSStatePart1Part1";
import { usePOSState } from "./POSUsePOSState";

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
    posAssignedLocations,
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
    const validRows = rows.filter((r) => r.stockItemId && r.quantity > 0);
    if (validRows.length === 0) {
      toast({ title: "Nothing to export", description: "No items in this transaction.", variant: "destructive" });
      return;
    }
    try {
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Transaction");

      // ── Header row ──────────────────────────────────────────────────────────
      const headerRow = ws.addRow(["#", "Item", "Code", "Qty", "Rate", "Amt", "P/L", "T.P/L"]);
      headerRow.font = { bold: true };
      headerRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FF94A3B8" } },
        };
        cell.alignment = { horizontal: "center" };
      });

      // ── Column widths ────────────────────────────────────────────────────────
      ws.getColumn(1).width = 5; // #
      ws.getColumn(2).width = 30; // Item
      ws.getColumn(3).width = 14; // Code
      ws.getColumn(4).width = 8; // Qty
      ws.getColumn(5).width = 10; // Rate
      ws.getColumn(6).width = 12; // Amt
      ws.getColumn(7).width = 10; // P/L
      ws.getColumn(8).width = 12; // T.P/L

      // ── Data rows ────────────────────────────────────────────────────────────
      validRows.forEach((row, i) => {
        const rateUSD = row.rateUSD ?? row.rate;
        const cfgUSD = row.configuredPrice ?? 0;
        const plBale = rateUSD - cfgUSD;
        const totalPL = plBale * row.quantity;
        const dataRow = ws.addRow([
          i + 1,
          row.itemName,
          row.stockItemCode,
          row.quantity,
          row.rate,
          row.amount,
          plBale,
          totalPL,
        ]);
        // Colour negative P/L rows red
        if (plBale < 0) {
          dataRow.getCell(7).font = { color: { argb: "FFDC2626" } };
          dataRow.getCell(8).font = { color: { argb: "FFDC2626" } };
        }
      });

      // ── Totals row ───────────────────────────────────────────────────────────
      const totalQty = validRows.reduce((s, r) => s + r.quantity, 0);
      const totalAmt = validRows.reduce((s, r) => s + r.amount, 0);
      const totalTPL = validRows.reduce((s, r) => {
        const rateUSD = r.rateUSD ?? r.rate;
        return s + (rateUSD - (r.configuredPrice ?? 0)) * r.quantity;
      }, 0);

      const totRow = ws.addRow(["", "TOTAL", "", totalQty, "", totalAmt, "", totalTPL]);
      totRow.font = { bold: true };
      totRow.eachCell((cell) => {
        cell.border = { top: { style: "thin", color: { argb: "FF94A3B8" } } };
      });

      // ── Download ─────────────────────────────────────────────────────────────
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const dateStr = editVoucher?.voucherDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      const num = editVoucher?.voucherNumber ?? editVoucherId ?? "txn";
      downloadBlob(blob, exportFileName(`transaction ${num}`, "xlsx", { date: dateStr }));
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).optionalMessage, variant: "destructive" });
    }
  }

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

  if (posUser && !posLocationsLoading && posAssignedLocations.length === 0) {
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
    <div data-pos-modern-workspace="true" className="flex flex-col h-full bg-background overflow-hidden relative">
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
        disableSave={goldenCoastPosSaveDisabled || posWritesDisabled}
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
        activeLocation={activeLocation}
        allLocations={allLocations}
        posAssignedLocations={posAssignedLocations}
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
        <div data-pos-sale-panel="true" className="flex-1 flex flex-col overflow-y-auto min-w-0">
          <div data-pos-grid-wrap="true">
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
          </div>
          <div data-pos-notes-wrap="true" className="mt-2 px-1 pb-2">
            <label htmlFor="pos-desktop-notes" className="flex items-center gap-2 text-sm font-medium">
              <NotebookPen className="h-4 w-4" aria-hidden="true" /> {t("pos.modern.notes")}{" "}
              <span className="text-muted-foreground font-normal">{t("pos.modern.optional")}</span>
            </label>
            <Textarea
              id="pos-desktop-notes"
              placeholder={t("pos.modern.notesPlaceholder")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none h-12 min-h-[48px] text-sm"
              data-testid="input-notes"
            />
          </div>
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
        </div>
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
        activeLocation={activeLocation}
        allLocations={allLocations}
        posAssignedLocations={posAssignedLocations}
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
        disableSave={goldenCoastPosSaveDisabled || posWritesDisabled}
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
    </div>
  );
}
