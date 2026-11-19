// Extracted from ./StockGroupsView.tsx
import { Badge } from "@/components/ui/badge";
import { useStockGroupsViewState } from "./useStockGroupsViewState";
import { StockGroupsViewSection, StockGroupsViewSection2 } from "./StockGroupsViewSection2";

export function StockGroupsViewContent({
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
}: Pick<
  ReturnType<typeof useStockGroupsViewState>,
  | "activeInventoryLoading"
  | "canManageLocation"
  | "canManageWhatsapp"
  | "canViewCost"
  | "emptyMessage"
  | "filteredStockGroups"
  | "formatAmount"
  | "groupExportMenu"
  | "groupSearchControls"
  | "handleExportInventory"
  | "handlePrintWithOption"
  | "openGroup"
  | "openRenameDialog"
  | "openWaGroupDialog"
  | "selectedLocationLocal"
  | "setDeleteDialogOpen"
  | "setItemSearchTerm"
  | "setShowZeroStock"
  | "setViewAllItems"
  | "showZeroStock"
  | "stockGroups"
  | "totalItems"
  | "totalQty"
  | "totalValue"
  | "whatsappTitle"
>) {
  return (
    <section className="space-y-4" data-testid="stock-groups-desktop">
      {/* Location summary — a restrained gradient works in light and dark themes. */}
      <StockGroupsViewSection
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
      <StockGroupsViewSection2
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
