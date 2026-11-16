// Extracted from ./StockGroupsView.tsx to keep that module under the source-size cap.
import { ChevronDown, Eye, Layers, List, MessageCircle, Package, Pencil, Trash2, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStockGroupsViewState } from "./useStockGroupsViewState";

export function StockGroupsViewSection({
  activeInventoryLoading,
  canManageLocation,
  canManageWhatsapp,
  canViewCost,
  formatAmount,
  openRenameDialog,
  openWaGroupDialog,
  selectedLocationLocal,
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
  | "formatAmount"
  | "openRenameDialog"
  | "openWaGroupDialog"
  | "selectedLocationLocal"
  | "stockGroups"
  | "totalItems"
  | "totalQty"
  | "totalValue"
  | "whatsappTitle"
>) {
  return (
    <div className="relative flex flex-col gap-5 overflow-hidden rounded-2xl border border-violet-200/80 bg-gradient-to-r from-violet-50 via-background to-indigo-50/80 p-4 shadow-sm dark:border-violet-500/25 dark:from-[#171035] dark:via-[#111a36] dark:to-[#0c142c] sm:p-5 xl:flex-row xl:items-center xl:justify-between">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/20">
          <Warehouse className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h2 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{selectedLocationLocal.name}</h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Stock Groups
            </span>
            {canManageLocation && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openRenameDialog(selectedLocationLocal)}
                data-testid="button-rename-location"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {canManageLocation && canManageWhatsapp && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openWaGroupDialog(selectedLocationLocal)}
                data-testid="button-wa-location"
                title={whatsappTitle}
                aria-label={`Configure WhatsApp stock reports for ${selectedLocationLocal.name}`}
              >
                <MessageCircle
                  className={`h-4 w-4 ${
                    selectedLocationLocal.whatsappGroupChatId && selectedLocationLocal.whatsappStockReportsEnabled
                      ? "text-green-500"
                      : selectedLocationLocal.whatsappGroupChatId
                        ? "text-amber-500"
                        : ""
                  }`}
                />
              </Button>
            )}
          </div>
          <p className="mt-1 text-xs font-medium tracking-wide text-muted-foreground">
            Location: {selectedLocationLocal.name}
          </p>
        </div>
      </div>

      {/* Stats pills */}
      {!activeInventoryLoading && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="stock-groups-summary">
          <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-violet-200/80 bg-background/80 px-3 font-semibold shadow-sm dark:border-white/10 dark:bg-white/5">
            <Layers className="h-4 w-4 text-violet-600 dark:text-violet-300" />
            {stockGroups.length} {stockGroups.length === 1 ? "Group" : "Groups"}
          </span>
          <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-violet-200/80 bg-background/80 px-3 font-semibold shadow-sm dark:border-white/10 dark:bg-white/5">
            <Package className="h-3 w-3" />
            {totalItems} Items
          </span>
          <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-violet-200/80 bg-background/80 px-3 font-semibold shadow-sm dark:border-white/10 dark:bg-white/5">
            {Math.floor(totalQty).toLocaleString()} BL total
          </span>
          {canViewCost && (
            <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-violet-200/80 bg-background/80 px-3 font-semibold shadow-sm dark:border-white/10 dark:bg-white/5">
              {formatAmount(totalValue)} total value
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function StockGroupsViewSection2({
  canManageLocation,
  canManageWhatsapp,
  canViewCost,
  handleExportInventory,
  handlePrintWithOption,
  openRenameDialog,
  openWaGroupDialog,
  selectedLocationLocal,
  setDeleteDialogOpen,
  setItemSearchTerm,
  setShowZeroStock,
  setViewAllItems,
  showZeroStock,
}: Pick<
  ReturnType<typeof useStockGroupsViewState>,
  | "canManageLocation"
  | "canManageWhatsapp"
  | "canViewCost"
  | "handleExportInventory"
  | "handlePrintWithOption"
  | "openRenameDialog"
  | "openWaGroupDialog"
  | "selectedLocationLocal"
  | "setDeleteDialogOpen"
  | "setItemSearchTerm"
  | "setShowZeroStock"
  | "setViewAllItems"
  | "showZeroStock"
>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ReportExportMenu
        size="sm"
        align="start"
        className="h-10 gap-2 rounded-xl border-violet-200/80 bg-background/80 px-4 shadow-sm dark:border-violet-500/25"
        data-testid="button-export-dropdown"
        options={[
          {
            id: "excel",
            label: "Export Excel",
            kind: "excel",
            onSelect: handleExportInventory,
            testId: "menu-export-excel",
          },
          ...(canViewCost
            ? [
                {
                  id: "pdf-cost",
                  label: "Export PDF (with cost)",
                  kind: "pdf" as const,
                  onSelect: () => handlePrintWithOption(true),
                  testId: "menu-export-pdf-cost",
                },
              ]
            : []),
          {
            id: "pdf-nocost",
            label: "Export PDF (without cost)",
            kind: "pdf",
            onSelect: () => handlePrintWithOption(false),
            testId: "menu-export-pdf-nocost",
          },
        ]}
      />

      <Button
        variant="outline"
        size="sm"
        className="h-10 gap-2 rounded-xl border-violet-200/80 bg-background/80 px-4 shadow-sm dark:border-violet-500/25"
        onClick={() => {
          setViewAllItems(true);
          setItemSearchTerm("");
        }}
        data-testid="button-view-all-items"
      >
        <List className="h-4 w-4" /> View All Stock Items
      </Button>

      <Button
        variant="outline"
        size="sm"
        className={`h-10 gap-2 rounded-xl px-4 shadow-sm ${showZeroStock ? "border-violet-400/60 bg-violet-500/10 text-violet-700 dark:text-violet-200" : "border-violet-200/80 bg-background/80 dark:border-violet-500/25"}`}
        aria-pressed={showZeroStock}
        onClick={() => setShowZeroStock(!showZeroStock)}
        data-testid="button-show-zero"
      >
        <Eye className="h-4 w-4" /> Show Zero Stock{" "}
        <span
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showZeroStock ? "bg-violet-600" : "bg-slate-300 dark:bg-slate-600"}`}
          aria-hidden="true"
        >
          <span
            className={`h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${showZeroStock ? "translate-x-4" : "translate-x-1"}`}
          />
        </span>
      </Button>

      {canManageLocation && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-10 gap-2 rounded-xl border-violet-200/80 bg-background/80 px-4 shadow-sm dark:border-violet-500/25"
              data-testid="button-location-menu"
            >
              Location <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openRenameDialog(selectedLocationLocal)}>
              <Pencil className="h-4 w-4 mr-2" /> Edit / Rename
            </DropdownMenuItem>
            {canManageWhatsapp && (
              <DropdownMenuItem onClick={() => openWaGroupDialog(selectedLocationLocal)}>
                <MessageCircle className="h-4 w-4 mr-2" /> WhatsApp Stock Reports
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setDeleteDialogOpen(true)}
              data-testid="menu-delete-location"
            >
              <Trash2 className="h-4 w-4 mr-2" /> Delete Location
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
