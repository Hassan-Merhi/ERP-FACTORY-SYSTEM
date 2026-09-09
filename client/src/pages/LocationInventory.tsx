import { useLocation } from "@/contexts/LocationContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useLocation as useRoute } from "wouter";
import { ArrowLeft, Globe, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { LocationGrid } from "./location-inventory/LocationGrid";
import { CombinedStockView } from "./location-inventory/CombinedStockView";
import { LocationDialogs } from "./location-inventory/LocationDialogs";
import { useLocationInventoryQueries } from "./location-inventory/useLocationInventoryQueries";
import { useLocationInventoryMutations } from "./location-inventory/useLocationInventoryMutations";
import { useLocationInventoryExports } from "./location-inventory/useLocationInventoryExports";
import { LocationInventoryDialogs } from "./location-inventory/LocationInventoryDialogs";
import { StockGroupsView } from "./location-inventory/StockGroupsView";
import { useLocationInventoryState } from "./location-inventory/useLocationInventoryState";
import { useCombinedStockRows } from "./location-inventory/useCombinedStockRows";
import { useStockGroupSummaries } from "./location-inventory/useStockGroupSummaries";
import { LocationInventoryHeader } from "./location-inventory/LocationInventoryHeader";
import { LocationInventoryMovementFilter } from "./location-inventory/LocationInventoryMovementFilter";
import { StockGroupItemsView } from "./location-inventory/StockGroupItemsView";
import { AllItemsView } from "./location-inventory/AllItemsView";
import { LocationInventoryBreadcrumb } from "./location-inventory/LocationInventoryBreadcrumb";
import type { InventoryLocation as Location } from "./location-inventory/locationInventoryTypes";

export default function LocationInventory({ posUser }: { posUser?: any } = {}) {
  const { setSelectedLocation: _setSelectedLocation } = useLocation();
  const [_route, navigate] = useRoute();
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  // ─── State ────────────────────────────────────────────────────────────────
  const {
    selectedLocationLocal,
    setSelectedLocationLocal,
    selectedGroup,
    setSelectedGroup,
    selectedRowIndex,
    setSelectedRowIndex,
    viewAllItems,
    setViewAllItems,
    locationSearchTerm,
    setLocationSearchTerm,
    groupSearchTerm,
    setGroupSearchTerm,
    itemSearchTerm,
    setItemSearchTerm,
    asOfDate,
    setAsOfDate,
    fromDate,
    setFromDate,
    showNegativeStock,
    setShowNegativeStock,
    showZeroStock,
    setShowZeroStock,
    negativeSearchTerm,
    setNegativeSearchTerm,
    showAllStock,
    setShowAllStock,
    allStockGroupFilter,
    setAllStockGroupFilter,
    allStockSearchTerm,
    setAllStockSearchTerm,
    allStockLocationFilter,
    setAllStockLocationFilter,
    allStockCategoryFilter,
    setAllStockCategoryFilter,
    itemCategoryFilter,
    setItemCategoryFilter,
    groupCategoryFilter,
    setGroupCategoryFilter,
    allStockSelectedRowIndex,
    stockMovementOpen,
    setStockMovementOpen,
    stockMovementItem,
    setStockMovementItem,
    stockMovementPeriod,
    setStockMovementPeriod,
    drillMonth,
    setDrillMonth,
    allStockTableRef,
    deleteDialogOpen,
    setDeleteDialogOpen,
    isDeleting,
    archiveDialogOpen,
    setArchiveDialogOpen,
    isArchiving,
    renameDialogOpen,
    setRenameDialogOpen,
    renamingLocation,
    renameInput,
    setRenameInput,
    renameDeductionInput,
    setRenameDeductionInput,
    waGroupDialogOpen,
    setWaGroupDialogOpen,
    waGroupLocation,
    waGroupSearch,
    setWaGroupSearch,
    waGroupSelectedId,
    setWaGroupSelectedId,
    createLocationOpen,
    setCreateLocationOpen,
    createLocationName,
    setCreateLocationName,
    openRenameDialog,
    openWaGroupDialog,
    handleDeleteLocation,
    handleArchiveStockGroup,
    goBackToLocations,
  } = useLocationInventoryState({ companyId, toast });

  // ─── Mutations ────────────────────────────────────────────────────────────
  const { renameLocationMutation, createLocationMutation, waGroupMutation, waTestMutation } =
    useLocationInventoryMutations({
      toast,
      selectedLocationLocal,
      setSelectedLocationLocal,
      setRenameDialogOpen,
      setCreateLocationOpen,
      setCreateLocationName,
      setWaGroupDialogOpen,
    });

  // ─── Queries ──────────────────────────────────────────────────────────────
  const {
    canManageWhatsapp,
    waChats,
    waChatsLoading,
    locations,
    locationsLoading,
    inventoryData,
    inventoryLoading,
    openingInventoryData,
    openingInventoryLoading,
    closingInventoryData,
    closingInventoryLoading,
    allInventoryData,
    allInventoryLoading,
    allNegativeStock,
    negativeStockLoading,
    categoriesList,
  } = useLocationInventoryQueries({
    waGroupDialogOpen,
    posUser,
    companyId,
    selectedLocationLocal,
    showZeroStock,
    fromDate,
    asOfDate,
    showAllStock,
    showNegativeStock,
  });

  // ─── Export helpers ───────────────────────────────────────────────────────
  const { handlePrintWithOption, handleExportInventory, handlePrintGroup } = useLocationInventoryExports(
    selectedLocationLocal,
    toast
  );

  // ─── Combined stock rows (all-stock view) ─────────────────────────────────
  const { allInventoryLocations, allInventoryGroups, filteredCombinedRows } = useCombinedStockRows({
    allInventoryData,
    allStockGroupFilter,
    allStockCategoryFilter,
    allStockLocationFilter,
    allStockSearchTerm,
  });

  // ─── Stock group summaries (location view) ────────────────────────────────
  const {
    openingInventoryMap,
    showMovement,
    activeInventoryData,
    activeInventoryLoading,
    inventory,
    stockGroups,
    filteredStockGroups,
    filteredStockItems,
    allItemsFiltered,
    totalQty,
    totalValue,
    totalItems,
  } = useStockGroupSummaries({
    openingInventoryData,
    inventoryData,
    closingInventoryData,
    openingInventoryLoading,
    closingInventoryLoading,
    inventoryLoading,
    fromDate,
    asOfDate,
    showZeroStock,
    showNegativeStock,
    groupSearchTerm,
    groupCategoryFilter,
    itemSearchTerm,
    itemCategoryFilter,
    selectedGroup,
  });

  // The server is authoritative: unauthorized POS inventory responses null both
  // cost fields. One capability value is then shared by every inventory view so
  // group summaries, item rows, totals and cost exports cannot disagree.
  const canViewInventoryCost =
    !posUser || activeInventoryData.some((item) => item.averageRate !== null && item.averageRate !== undefined);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-0 h-full">
      <LocationInventoryHeader
        posUser={posUser}
        showNegativeStock={showNegativeStock}
        setShowNegativeStock={setShowNegativeStock}
      />

      <LocationInventoryMovementFilter
        selectedLocationLocal={selectedLocationLocal}
        viewAllItems={viewAllItems}
        fromDate={fromDate}
        setFromDate={setFromDate}
        asOfDate={asOfDate}
        setAsOfDate={setAsOfDate}
      />

      <div className="flex-1 overflow-auto">
        {showAllStock ? (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Button variant="ghost" size="sm" className="gap-1" onClick={() => setShowAllStock(false)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
            </div>
            <CombinedStockView
              allInventoryLoading={allInventoryLoading}
              filteredCombinedRows={filteredCombinedRows}
              allInventoryData={allInventoryData}
              allInventoryLocations={allInventoryLocations}
              allLocations={locations}
              allInventoryGroups={allInventoryGroups}
              categoriesList={categoriesList}
              allStockSearchTerm={allStockSearchTerm}
              setAllStockSearchTerm={setAllStockSearchTerm}
              allStockGroupFilter={allStockGroupFilter}
              setAllStockGroupFilter={setAllStockGroupFilter}
              allStockLocationFilter={allStockLocationFilter}
              setAllStockLocationFilter={setAllStockLocationFilter}
              allStockCategoryFilter={allStockCategoryFilter}
              setAllStockCategoryFilter={setAllStockCategoryFilter}
              allStockSelectedRowIndex={allStockSelectedRowIndex}
              openMovement={(l, n, sId, sName) => {
                setStockMovementItem({ stockItemId: sId, stockItemName: sName, locationId: l, locationName: n });
                setStockMovementOpen(true);
              }}
              formatAmount={formatAmount}
              posUser={posUser}
              allStockTableRef={allStockTableRef}
            />
          </div>
        ) : (
          <div className="px-6 py-4 space-y-4">
            {/* ── Breadcrumb ──────────────────────────────────────────────── */}
            <LocationInventoryBreadcrumb
              selectedLocationLocal={selectedLocationLocal}
              selectedGroup={selectedGroup}
              viewAllItems={viewAllItems}
              goBackToLocations={goBackToLocations}
              onBackToLocation={() => {
                setSelectedGroup(null);
                setViewAllItems(false);
                setItemSearchTerm("");
              }}
            />

            {/* ── NO LOCATION SELECTED: grid header + cards ───────────────── */}
            {!selectedLocationLocal && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">Location Inventory</h2>
                  {!posUser && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() => setShowAllStock(true)}
                        data-testid="button-view-all-stock"
                      >
                        <Globe className="h-4 w-4" /> View All Stock
                      </Button>
                      <Button
                        size="sm"
                        className="gap-2"
                        onClick={() => setCreateLocationOpen(true)}
                        data-testid="button-create-location"
                      >
                        <Plus className="h-4 w-4" /> Create Location
                      </Button>
                    </div>
                  )}
                </div>
                <LocationGrid
                  locations={locations}
                  locationsLoading={locationsLoading}
                  selectedLocationLocal={selectedLocationLocal}
                  setSelectedLocationLocal={(loc) => {
                    setSelectedLocationLocal(loc as Location | null);
                    setSelectedGroup(null);
                    setViewAllItems(false);
                    setGroupSearchTerm("");
                    setItemSearchTerm("");
                    setGroupCategoryFilter("");
                  }}
                  locationSearchTerm={locationSearchTerm}
                  setLocationSearchTerm={setLocationSearchTerm}
                  posUser={posUser}
                  canManageWhatsapp={canManageWhatsapp}
                  openRenameDialog={openRenameDialog}
                  openWaGroupDialog={openWaGroupDialog}
                />
              </>
            )}

            {/* ── LOCATION SELECTED, no group, no view-all: stock groups ──── */}
            {selectedLocationLocal && !selectedGroup && !viewAllItems && (
              <StockGroupsView
                selectedLocationLocal={selectedLocationLocal}
                posUser={posUser}
                canViewCost={canViewInventoryCost}
                canManageWhatsapp={canManageWhatsapp}
                openRenameDialog={openRenameDialog}
                openWaGroupDialog={openWaGroupDialog}
                activeInventoryLoading={activeInventoryLoading}
                stockGroups={stockGroups}
                totalItems={totalItems}
                totalQty={totalQty}
                totalValue={totalValue}
                formatAmount={formatAmount}
                handleExportInventory={handleExportInventory}
                handlePrintWithOption={handlePrintWithOption}
                handlePrintGroup={handlePrintGroup}
                setViewAllItems={setViewAllItems}
                setItemSearchTerm={setItemSearchTerm}
                showZeroStock={showZeroStock}
                setShowZeroStock={setShowZeroStock}
                setDeleteDialogOpen={setDeleteDialogOpen}
                groupSearchTerm={groupSearchTerm}
                setGroupSearchTerm={setGroupSearchTerm}
                groupCategoryFilter={groupCategoryFilter}
                setGroupCategoryFilter={setGroupCategoryFilter}
                categoriesList={categoriesList}
                filteredStockGroups={filteredStockGroups}
                setSelectedGroup={setSelectedGroup}
                setItemCategoryFilter={setItemCategoryFilter}
              />
            )}

            {/* ── STOCK GROUP SELECTED: items table ───────────────────────── */}
            {selectedLocationLocal && selectedGroup && !viewAllItems && (
              <StockGroupItemsView
                selectedGroup={selectedGroup}
                posUser={posUser}
                canViewCost={canViewInventoryCost}
                formatAmount={formatAmount}
                setArchiveDialogOpen={setArchiveDialogOpen}
                itemSearchTerm={itemSearchTerm}
                setItemSearchTerm={setItemSearchTerm}
                itemCategoryFilter={itemCategoryFilter}
                setItemCategoryFilter={setItemCategoryFilter}
                categoriesList={categoriesList}
                filteredStockItems={filteredStockItems}
                showMovement={showMovement}
                openingInventoryMap={openingInventoryMap}
                selectedRowIndex={selectedRowIndex}
                setSelectedRowIndex={setSelectedRowIndex}
                navigate={navigate}
                inventory={inventory}
              />
            )}

            {/* ── VIEW ALL ITEMS ───────────────────────────────────────────── */}
            {selectedLocationLocal && viewAllItems && !selectedGroup && (
              <AllItemsView
                totalItems={totalItems}
                totalQty={totalQty}
                totalValue={totalValue}
                canViewCost={canViewInventoryCost}
                formatAmount={formatAmount}
                itemSearchTerm={itemSearchTerm}
                setItemSearchTerm={setItemSearchTerm}
                allItemsFiltered={allItemsFiltered}
                showMovement={showMovement}
                openingInventoryMap={openingInventoryMap}
                selectedRowIndex={selectedRowIndex}
                setSelectedRowIndex={setSelectedRowIndex}
                navigate={navigate}
                inventory={inventory}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}
      <LocationInventoryDialogs
        createLocationOpen={createLocationOpen}
        setCreateLocationOpen={setCreateLocationOpen}
        createLocationName={createLocationName}
        setCreateLocationName={setCreateLocationName}
        createLocationMutation={createLocationMutation}
        showNegativeStock={showNegativeStock}
        setShowNegativeStock={setShowNegativeStock}
        selectedLocationLocal={selectedLocationLocal}
        negativeStockLoading={negativeStockLoading}
        allNegativeStock={allNegativeStock}
        negativeSearchTerm={negativeSearchTerm}
        setNegativeSearchTerm={setNegativeSearchTerm}
      />

      <LocationDialogs
        renameDialogOpen={renameDialogOpen}
        setRenameDialogOpen={setRenameDialogOpen}
        renamingLocation={renamingLocation}
        renameInput={renameInput}
        setRenameInput={setRenameInput}
        renameDeductionInput={renameDeductionInput}
        setRenameDeductionInput={setRenameDeductionInput}
        renameLocationMutation={renameLocationMutation}
        deleteDialogOpen={deleteDialogOpen}
        setDeleteDialogOpen={setDeleteDialogOpen}
        isDeleting={isDeleting}
        handleDeleteLocation={handleDeleteLocation}
        selectedLocationLocal={selectedLocationLocal}
        archiveDialogOpen={archiveDialogOpen}
        setArchiveDialogOpen={setArchiveDialogOpen}
        isArchiving={isArchiving}
        handleArchiveStockGroup={handleArchiveStockGroup}
        selectedGroup={selectedGroup}
        waGroupDialogOpen={waGroupDialogOpen}
        setWaGroupDialogOpen={setWaGroupDialogOpen}
        waChats={waChats}
        waChatsLoading={waChatsLoading}
        waGroupSearch={waGroupSearch}
        setWaGroupSearch={setWaGroupSearch}
        waGroupSelectedId={waGroupSelectedId}
        setWaGroupSelectedId={setWaGroupSelectedId}
        waGroupMutation={waGroupMutation}
        waTestMutation={waTestMutation}
        waGroupLocation={waGroupLocation}
        stockMovementOpen={stockMovementOpen}
        setStockMovementOpen={setStockMovementOpen}
        stockMovementItem={stockMovementItem}
        setStockMovementItem={setStockMovementItem}
        stockMovementPeriod={stockMovementPeriod}
        setStockMovementPeriod={setStockMovementPeriod}
        drillMonth={drillMonth}
        setDrillMonth={setDrillMonth}
        formatAmount={formatAmount}
        navigate={navigate}
      />
    </div>
  );
}
