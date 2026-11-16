import { List, Eye, Printer, Trash2, FileSpreadsheet, MessageCircle, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  ErpMobileActionsMenu,
  ErpMobileRecordCard,
  ErpMobileRecordList,
  ErpMobileSummaryGrid,
} from "@/components/ui/erp-mobile-records";
import { useStockGroupsViewState, type StockGroupsViewProps } from "./useStockGroupsViewState";
import { StockGroupsViewSection, StockGroupsViewSection2 } from "./StockGroupsViewSection";

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
                label: "Export to Excel",
                icon: FileSpreadsheet,
                onSelect: handleExportInventory,
                separated: true,
                testId: "menu-export-excel",
              },
              canViewCost && {
                label: "Export to PDF (with cost)",
                icon: Printer,
                onSelect: () => handlePrintWithOption(true),
                testId: "menu-export-pdf-cost",
              },
              {
                label: "Export to PDF (without cost)",
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
    <section className="space-y-4" data-testid="stock-groups-desktop">
      {/* Location summary — a restrained gradient works in light and dark themes. */}
      <StockGroupsViewSection2
        activeInventoryLoading={activeInventoryLoading}
        canManageLocation={canManageLocation}
        canManageWhatsapp={canManageWhatsapp}
        canViewCost={canViewCost}
        formatAmount={formatAmount}
        openRenameDialog={openRenameDialog}
        openWaGroupDialog={openWaGroupDialog}
        selectedLocationLocal={selectedLocationLocal}
        stockGroups={stockGroups}
        totalItems={totalItems}
        totalQty={totalQty}
        totalValue={totalValue}
        whatsappTitle={whatsappTitle}
      />

      {/* Action buttons */}
      <StockGroupsViewSection
        canManageLocation={canManageLocation}
        canManageWhatsapp={canManageWhatsapp}
        canViewCost={canViewCost}
        handleExportInventory={handleExportInventory}
        handlePrintWithOption={handlePrintWithOption}
        openRenameDialog={openRenameDialog}
        openWaGroupDialog={openWaGroupDialog}
        selectedLocationLocal={selectedLocationLocal}
        setDeleteDialogOpen={setDeleteDialogOpen}
        setItemSearchTerm={setItemSearchTerm}
        setShowZeroStock={setShowZeroStock}
        setViewAllItems={setViewAllItems}
        showZeroStock={showZeroStock}
      />

      {/* Search + categories */}
      <div className="rounded-2xl border border-violet-200/80 bg-gradient-to-r from-violet-50/80 to-background p-3 shadow-sm dark:border-violet-500/20 dark:from-[#10182f] dark:to-[#0d152b] sm:p-4">
        {groupSearchControls}
      </div>

      {/* Stock groups table */}
      {activeInventoryLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-xl border border-violet-200/60 bg-muted/60 dark:border-violet-500/20"
            />
          ))}
        </div>
      ) : filteredStockGroups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-violet-300/80 bg-violet-50/40 py-16 text-center text-muted-foreground dark:border-violet-500/30 dark:bg-violet-900/10">
          {emptyMessage}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-violet-200/80 bg-card shadow-[0_14px_36px_-24px_rgba(79,70,229,0.55)] dark:border-violet-500/25 dark:bg-[#0a1429]">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-violet-200/80 bg-violet-50/80 text-muted-foreground dark:border-violet-500/20 dark:bg-[#172447]">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-center px-4 py-3 font-medium">Items</th>
                <th className="text-right px-4 py-3 font-medium">Total Qty (BL)</th>
                {canViewCost && (
                  <>
                    <th className="text-right px-4 py-3 font-medium">Avg Rate</th>
                    <th className="text-right px-4 py-3 font-medium">Total Value</th>
                  </>
                )}
                <th className="text-right px-4 py-3 font-medium">Export</th>
              </tr>
            </thead>
            <tbody>
              {filteredStockGroups.map((g) => (
                <tr
                  key={g.groupId}
                  className="group cursor-pointer border-b border-border/70 transition-colors hover:bg-violet-50/70 dark:hover:bg-violet-500/10"
                  onClick={() => openGroup(g)}
                  data-testid={`row-group-${g.groupId}`}
                >
                  <td className="px-4 py-3 font-semibold">
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-xs font-bold text-white shadow-sm"
                        aria-hidden="true"
                      >
                        {g.groupName.trim().slice(0, 2).toUpperCase()}
                      </span>
                      <span>{g.groupName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge
                      variant="secondary"
                      className="rounded-lg border border-violet-200/50 bg-violet-50 px-3 py-1 font-semibold tabular-nums dark:border-violet-500/20 dark:bg-violet-500/15"
                    >
                      {g.itemCount}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {Math.floor(g.totalQuantity).toLocaleString()}
                    <span className="ml-1 text-xs text-muted-foreground font-normal">BL</span>
                  </td>
                  {canViewCost && (
                    <>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                        {formatAmount(g.averageRate)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold">{formatAmount(g.totalValue)}</td>
                    </>
                  )}
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {groupExportMenu(g)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-violet-300/60 bg-violet-100/70 font-semibold dark:border-violet-400/25 dark:bg-violet-500/15">
                <td className="px-4 py-3 font-bold text-violet-800 dark:text-violet-200">Total</td>
                <td className="px-4 py-3 text-center">
                  <Badge variant="secondary">{filteredStockGroups.reduce((s, g) => s + g.itemCount, 0)}</Badge>
                </td>
                <td className="px-4 py-3 text-right font-mono font-bold">
                  {Math.floor(filteredStockGroups.reduce((s, g) => s + g.totalQuantity, 0)).toLocaleString()}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">BL</span>
                </td>
                {canViewCost && (
                  <>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right font-mono font-bold">
                      {formatAmount(filteredStockGroups.reduce((s, g) => s + g.totalValue, 0))}
                    </td>
                  </>
                )}
                <td className="px-4 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {filteredStockGroups.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing {filteredStockGroups.length} of {stockGroups.length} stock{" "}
          {stockGroups.length === 1 ? "group" : "groups"}
        </p>
      )}
    </section>
  );
}
