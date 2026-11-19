import { List, Eye, Printer, Trash2, FileSpreadsheet, MessageCircle, Pencil } from "lucide-react";
import {
  ErpMobileActionsMenu,
  ErpMobileRecordCard,
  ErpMobileRecordList,
  ErpMobileSummaryGrid,
} from "@/components/ui/erp-mobile-records";
import { useStockGroupsViewState, type StockGroupsViewProps } from "./useStockGroupsViewState";
import { StockGroupsViewContent } from "./StockGroupsViewContent";

export function StockGroupsView(props: StockGroupsViewProps) {
  const {
    activeInventoryLoading,
    canManageLocation,
    canManageWhatsapp,
    canViewCost,
    emptyMessage,
    filteredStockGroups,
    formatAmount,
    groupExportMenu,
    groupSearchControls,
    handleExportInventory,
    handlePrintWithOption,
    isPhone,
    openGroup,
    openRenameDialog,
    openWaGroupDialog,
    selectedLocationLocal,
    setDeleteDialogOpen,
    setItemSearchTerm,
    setShowZeroStock,
    setViewAllItems,
    showZeroStock,
    stockGroups,
    totalItems,
    totalQty,
    totalValue,
    whatsappTitle,
  } = useStockGroupsViewState(props);

  // Phones: compact title with one Actions menu, a two-column summary and a card per stock group.
  if (isPhone) {
    return (
      <div className="space-y-3" data-testid="stock-groups-phone">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="wrap-break-word text-xl font-bold leading-snug">{selectedLocationLocal.name}</h2>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stock Groups</p>
          </div>
          <ErpMobileActionsMenu
            data-testid="button-stock-groups-actions"
            actions={[
              {
                label: "View All Stock Items",
                icon: List,
                onSelect: () => {
                  setViewAllItems(true);
                  setItemSearchTerm("");
                },
                testId: "button-view-all-items",
              },
              {
                label: showZeroStock ? "Hide zero stock" : "Show zero stock",
                icon: Eye,
                onSelect: () => setShowZeroStock(!showZeroStock),
                testId: "button-show-zero",
              },
              {
                label: "Export Excel",
                icon: FileSpreadsheet,
                onSelect: handleExportInventory,
                separated: true,
                testId: "menu-export-excel",
              },
              canViewCost && {
                label: "Export PDF (with cost)",
                icon: Printer,
                onSelect: () => handlePrintWithOption(true),
                testId: "menu-export-pdf-cost",
              },
              {
                label: "Export PDF (without cost)",
                icon: Printer,
                onSelect: () => handlePrintWithOption(false),
                testId: "menu-export-pdf-nocost",
              },
              canManageLocation && {
                label: "Edit / Rename location",
                icon: Pencil,
                onSelect: () => openRenameDialog(selectedLocationLocal),
                separated: true,
                testId: "button-rename-location",
              },
              canManageLocation &&
                canManageWhatsapp && {
                  label: "WhatsApp Stock Reports",
                  icon: MessageCircle,
                  onSelect: () => openWaGroupDialog(selectedLocationLocal),
                  testId: "button-wa-location",
                },
              canManageLocation && {
                label: "Delete Location",
                icon: Trash2,
                destructive: true,
                onSelect: () => setDeleteDialogOpen(true),
                testId: "menu-delete-location",
              },
            ]}
          />
        </div>

        {!activeInventoryLoading && (
          <ErpMobileSummaryGrid
            data-testid="stock-groups-summary"
            items={[
              { label: "Groups", value: stockGroups.length },
              { label: "Items", value: totalItems },
              { label: "Qty (BL)", value: Math.floor(totalQty).toLocaleString(), wide: !canViewCost },
              ...(canViewCost ? [{ label: "Value", value: formatAmount(totalValue) }] : []),
            ]}
          />
        )}
        {showZeroStock && (
          <p className="text-xs text-muted-foreground" data-testid="text-zero-stock-shown">
            Including zero-stock items.
          </p>
        )}

        {groupSearchControls}

        {activeInventoryLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 rounded-lg border bg-muted animate-pulse" />
            ))}
          </div>
        ) : (
          <ErpMobileRecordList isEmpty={filteredStockGroups.length === 0} empty={emptyMessage}>
            {filteredStockGroups.map((g) => (
              <ErpMobileRecordCard
                key={g.groupId}
                data-testid={`row-group-${g.groupId}`}
                title={g.groupName}
                subtitle={`${g.itemCount} ${g.itemCount === 1 ? "item" : "items"}`}
                value={
                  <>
                    {Math.floor(g.totalQuantity).toLocaleString()}
                    <span className="ms-1 text-[11px] font-normal text-muted-foreground">BL</span>
                  </>
                }
                fields={
                  canViewCost
                    ? [
                        { label: "Avg Rate", value: formatAmount(g.averageRate), numeric: true },
                        { label: "Value", value: formatAmount(g.totalValue), numeric: true },
                      ]
                    : []
                }
                onOpen={() => openGroup(g)}
                openLabel={`Open ${g.groupName}`}
                actions={groupExportMenu(g)}
              />
            ))}
          </ErpMobileRecordList>
        )}

        {filteredStockGroups.length > 0 && (
          <div
            className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2 text-sm font-semibold"
            data-testid="stock-groups-total"
          >
            <span>Total · {filteredStockGroups.reduce((sum, g) => sum + g.itemCount, 0)} items</span>
            <span className="font-mono tabular-nums" dir="ltr">
              {Math.floor(filteredStockGroups.reduce((sum, g) => sum + g.totalQuantity, 0)).toLocaleString()} BL
              {canViewCost && ` · ${formatAmount(filteredStockGroups.reduce((sum, g) => sum + g.totalValue, 0))}`}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <StockGroupsViewContent
      activeInventoryLoading={activeInventoryLoading}
      canManageLocation={canManageLocation}
      canManageWhatsapp={canManageWhatsapp}
      canViewCost={canViewCost}
      emptyMessage={emptyMessage}
      filteredStockGroups={filteredStockGroups}
      formatAmount={formatAmount}
      groupExportMenu={groupExportMenu}
      groupSearchControls={groupSearchControls}
      handleExportInventory={handleExportInventory}
      handlePrintWithOption={handlePrintWithOption}
      openGroup={openGroup}
      openRenameDialog={openRenameDialog}
      openWaGroupDialog={openWaGroupDialog}
      selectedLocationLocal={selectedLocationLocal}
      setDeleteDialogOpen={setDeleteDialogOpen}
      setItemSearchTerm={setItemSearchTerm}
      setShowZeroStock={setShowZeroStock}
      setViewAllItems={setViewAllItems}
      showZeroStock={showZeroStock}
      stockGroups={stockGroups}
      totalItems={totalItems}
      totalQty={totalQty}
      totalValue={totalValue}
      whatsappTitle={whatsappTitle}
    />
  );
}
