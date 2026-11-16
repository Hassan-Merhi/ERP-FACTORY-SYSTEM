import { getPaperFormat } from "@/components/LabelPrintSettings";
import { generateCombinedLabelsHtml, generateA5LabelsHtml, prefetchBannersForPrint } from "@/lib/labelHtml";
import {
  ConfirmStockEntryDialog,
  QuickCreateProductDialog,
  DesignPickerDialog,
  AdminAuthDialog,
} from "./StockEntryDialogs";
import { StockEntrySidebar } from "./StockEntrySidebar";
import { openBrowserPrint } from "./StockEntryPrinting";
import type { StockEntryTabProps } from "./useStockEntryTabStatePart1";
import { useStockEntryTabState } from "./useStockEntryTabState";
import { StockEntryTabSection } from "./StockEntryTabSection";

export function StockEntryTab(props: StockEntryTabProps) {
  const {
    activeCategories,
    activeLocations,
    adminAuthOpen,
    allCustomers,
    assignProductionPosition,
    assignWorker,
    baleProducts,
    cart,
    cartDraft,
    cartDraftAge,
    confirmDialogOpen,
    designColors,
    designPickerOpen,
    discardCartDraft,
    entryDate,
    filteredProducts,
    filteredWorkers,
    handleConfirmClick,
    handleScan,
    handleScanKeyDown,
    hasCartDraft,
    logoPickerOpen,
    onOpenHistory,
    pendingCreateName,
    pendingPrintLabels,
    preOpenedWindowsRef,
    productionPositionByProduct,
    productionPositions,
    quickCreateCategoryId,
    quickCreateGrade,
    quickCreateMutation,
    quickCreateName,
    quickCreateOpen,
    quickCreateWeight,
    removeItem,
    scanError,
    scanInput,
    scanRef,
    selectProduct,
    selectedCustomerId,
    selectedLocationId,
    selectedLogoId,
    setAdminAuthOpen,
    setCart,
    setConfirmDialogOpen,
    setDesignPickerOpen,
    setEntryDate,
    setLogoOverride,
    setLogoPickerOpen,
    setPendingAdminAuth,
    setPendingCreateName,
    setPendingPrintLabels,
    setProductionPositionByProduct,
    setQty,
    setQuickCreateCategoryId,
    setQuickCreateGrade,
    setQuickCreateName,
    setQuickCreateOpen,
    setQuickCreateWeight,
    setScanInput,
    setSelectedCustomerId,
    setSelectedLocationId,
    setSelectedLogoId,
    setShowDropdown,
    setWorkerCategoryFilter,
    setWorkerCategoryFilterManual,
    showDropdown,
    showHistory,
    stockEntryMutation,
    totalKg,
    totalQty,
    updateQty,
    updateWeight,
    workerCategoryFilter,
    workerCategoryGroups,
    workers,
  } = useStockEntryTabState(props);

  return (
    <div className="stock-entry-workspace grid grid-cols-1 items-start gap-5 xl:grid-cols-12 xl:gap-6">
      <StockEntryTabSection
        allCustomers={allCustomers}
        assignProductionPosition={assignProductionPosition}
        assignWorker={assignWorker}
        baleProducts={baleProducts}
        cart={cart}
        cartDraft={cartDraft}
        cartDraftAge={cartDraftAge}
        discardCartDraft={discardCartDraft}
        filteredProducts={filteredProducts}
        filteredWorkers={filteredWorkers}
        handleScan={handleScan}
        handleScanKeyDown={handleScanKeyDown}
        hasCartDraft={hasCartDraft}
        logoPickerOpen={logoPickerOpen}
        onOpenHistory={onOpenHistory}
        productionPositionByProduct={productionPositionByProduct}
        productionPositions={productionPositions}
        removeItem={removeItem}
        scanError={scanError}
        scanInput={scanInput}
        scanRef={scanRef}
        selectProduct={selectProduct}
        setAdminAuthOpen={setAdminAuthOpen}
        setCart={setCart}
        setEntryDate={setEntryDate}
        setLogoOverride={setLogoOverride}
        setLogoPickerOpen={setLogoPickerOpen}
        setPendingCreateName={setPendingCreateName}
        setProductionPositionByProduct={setProductionPositionByProduct}
        setQty={setQty}
        setScanInput={setScanInput}
        setSelectedCustomerId={setSelectedCustomerId}
        setSelectedLocationId={setSelectedLocationId}
        setSelectedLogoId={setSelectedLogoId}
        setShowDropdown={setShowDropdown}
        showDropdown={showDropdown}
        showHistory={showHistory}
        updateQty={updateQty}
        updateWeight={updateWeight}
        workerCategoryFilter={workerCategoryFilter}
        workers={workers}
      />

      <div className="stock-entry-options min-w-0 space-y-6 xl:col-span-4">
        <StockEntrySidebar
          selectedLocationId={selectedLocationId}
          onLocationChange={setSelectedLocationId}
          activeLocations={activeLocations || []}
          entryDate={entryDate}
          onEntryDateChange={setEntryDate}
          workerCategoryFilter={workerCategoryFilter}
          onWorkerCategoryFilterChange={(val) => {
            setWorkerCategoryFilter(val);
            setWorkerCategoryFilterManual(true);
          }}
          workerCategoryGroups={workerCategoryGroups}
          selectedCustomerId={selectedCustomerId}
          onCustomerIdChange={setSelectedCustomerId}
          allCustomers={allCustomers}
          totalQty={totalQty}
          totalKg={totalKg}
          isPending={stockEntryMutation.isPending}
          onConfirm={handleConfirmClick}
        />
      </div>

      <ConfirmStockEntryDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        cart={cart}
        entryDate={entryDate}
        totalQty={totalQty}
        totalKg={totalKg}
        selectedLogoId={selectedLogoId}
        isPending={stockEntryMutation.isPending}
        onConfirm={() => {
          preOpenedWindowsRef.current = {
            a4: window.open("", "_blank"),
            sticker: window.open("", "_blank"),
          };
          stockEntryMutation.mutate();
        }}
      />

      <QuickCreateProductDialog
        open={quickCreateOpen}
        onOpenChange={setQuickCreateOpen}
        grade={quickCreateGrade}
        onGradeChange={setQuickCreateGrade}
        name={quickCreateName}
        onNameChange={setQuickCreateName}
        categoryId={quickCreateCategoryId}
        onCategoryChange={setQuickCreateCategoryId}
        weight={quickCreateWeight}
        onWeightChange={setQuickCreateWeight}
        activeCategories={activeCategories}
        isPending={quickCreateMutation.isPending}
        onSubmit={() => quickCreateMutation.mutate()}
      />

      <AdminAuthDialog
        open={adminAuthOpen}
        onOpenChange={(open) => {
          setAdminAuthOpen(open);
          if (!open) setPendingCreateName("");
        }}
        action="create a new bale product"
        onAuthorized={(credentials) => {
          setPendingAdminAuth(credentials);
          setAdminAuthOpen(false);
          setQuickCreateName(pendingCreateName);
          setQuickCreateOpen(true);
        }}
      />

      <DesignPickerDialog
        open={designPickerOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDesignPickerOpen(false);
            setPendingPrintLabels(null);
          }
        }}
        designColors={designColors}
        onSelect={(color) => {
          setDesignPickerOpen(false);
          if (pendingPrintLabels) {
            const labels = pendingPrintLabels;
            setPendingPrintLabels(null);
            openBrowserPrint(labels, color, preOpenedWindowsRef);
          }
        }}
        onNoDesign={() => {
          setDesignPickerOpen(false);
          if (pendingPrintLabels) {
            const labels = pendingPrintLabels;
            setPendingPrintLabels(null);
            prefetchBannersForPrint();
            const paperFormat = getPaperFormat();
            const labelHtml = paperFormat === "A5" ? generateA5LabelsHtml(labels) : generateCombinedLabelsHtml(labels);
            // Reuse the Stock Entry print tab rather than opening a third tab.
            // "No Design" only prints the full-size label; no sticker/blank tab.
            const preOpened = preOpenedWindowsRef.current;
            preOpenedWindowsRef.current = null;
            const win = preOpened?.a4 && !preOpened.a4.closed ? preOpened.a4 : window.open("", "_blank");
            if (preOpened?.sticker && !preOpened.sticker.closed) {
              preOpened.sticker.close();
            }
            if (win) {
              win.document.open();
              win.document.write(labelHtml);
              win.document.close();
              win.focus();
              setTimeout(() => win.print(), 500);
            }
          }
        }}
      />
    </div>
  );
}
