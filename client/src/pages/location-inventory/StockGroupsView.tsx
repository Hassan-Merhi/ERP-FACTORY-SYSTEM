import {
  Warehouse,
  Download,
  List,
  Eye,
  Printer,
  Trash2,
  Layers,
  FileSpreadsheet,
  MessageCircle,
  Pencil,
  Package,
  Search,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InventoryLocation as Location, StockGroupSummary } from "./locationInventoryTypes";
import type { AuthMe } from "@shared/apiTypes";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import {
  ErpMobileActionsMenu,
  ErpMobileRecordCard,
  ErpMobileRecordList,
  ErpMobileSummaryGrid,
} from "@/components/ui/erp-mobile-records";

interface StockGroupsViewProps {
  selectedLocationLocal: Location;
  posUser?: AuthMe;
  canViewCost: boolean;
  canManageWhatsapp: boolean;
  /** False for read-only roles: hides rename, WhatsApp settings and delete. */
  canChangeExistingRecords?: boolean;
  openRenameDialog: (loc: Location, e?: { stopPropagation: () => void }) => void;
  openWaGroupDialog: (loc: Location, e?: { stopPropagation: () => void }) => void;
  activeInventoryLoading: boolean;
  stockGroups: StockGroupSummary[];
  totalItems: number;
  totalQty: number;
  totalValue: number;
  formatAmount: (n: number) => string;
  handleExportInventory: () => void;
  handlePrintWithOption: (withCost: boolean) => void;
  handlePrintGroup: (group: { groupId: number | null; groupName: string }, withCost: boolean) => void;
  setViewAllItems: (v: boolean) => void;
  setItemSearchTerm: (s: string) => void;
  showZeroStock: boolean;
  setShowZeroStock: (v: boolean) => void;
  setDeleteDialogOpen: (v: boolean) => void;
  groupSearchTerm: string;
  setGroupSearchTerm: (s: string) => void;
  groupCategoryFilter: string;
  setGroupCategoryFilter: (s: string) => void;
  categoriesList: { id: number; name: string; active: boolean }[];
  filteredStockGroups: StockGroupSummary[];
  setSelectedGroup: (g: StockGroupSummary | null) => void;
  setItemCategoryFilter: (cats: string[]) => void;
}

export function StockGroupsView({
  selectedLocationLocal,
  posUser,
  canViewCost,
  canManageWhatsapp,
  canChangeExistingRecords = true,
  openRenameDialog,
  openWaGroupDialog,
  activeInventoryLoading,
  stockGroups,
  totalItems,
  totalQty,
  totalValue,
  formatAmount,
  handleExportInventory,
  handlePrintWithOption,
  handlePrintGroup,
  setViewAllItems,
  setItemSearchTerm,
  showZeroStock,
  setShowZeroStock,
  setDeleteDialogOpen,
  groupSearchTerm,
  setGroupSearchTerm,
  groupCategoryFilter,
  setGroupCategoryFilter,
  categoriesList,
  filteredStockGroups,
  setSelectedGroup,
  setItemCategoryFilter,
}: StockGroupsViewProps) {
  const canManageLocation = !posUser && canChangeExistingRecords;
  const whatsappTitle =
    selectedLocationLocal.whatsappGroupChatId && selectedLocationLocal.whatsappStockReportsEnabled
      ? `WhatsApp stock reports enabled${selectedLocationLocal.whatsappGroupName ? `: ${selectedLocationLocal.whatsappGroupName}` : ""}`
      : selectedLocationLocal.whatsappGroupChatId
        ? `WhatsApp group linked but stock reports disabled${selectedLocationLocal.whatsappGroupName ? `: ${selectedLocationLocal.whatsappGroupName}` : ""}`
        : "Link WhatsApp group for stock reports";
  const isPhone = useErpPhoneLayout();

  const openGroup = (g: StockGroupSummary) => {
    setSelectedGroup(g);
    setItemSearchTerm("");
    setItemCategoryFilter([]);
  };

  const groupExportMenu = (g: StockGroupSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" data-testid={`button-export-group-${g.groupId}`}>
          <Printer className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canViewCost && (
          <DropdownMenuItem
            onClick={() => handlePrintGroup({ groupId: g.groupId, groupName: g.groupName }, true)}
            data-testid={`menu-export-group-pdf-cost-${g.groupId}`}
          >
            <Printer className="h-4 w-4 mr-2" /> Export PDF (with cost)
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handlePrintGroup({ groupId: g.groupId, groupName: g.groupName }, false)}
          data-testid={`menu-export-group-pdf-nocost-${g.groupId}`}
        >
          <Printer className="h-4 w-4 mr-2" /> Export PDF (without cost)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const groupSearchControls = (
    <div className="flex items-center gap-2 flex-wrap">
      <div className={isPhone ? "relative w-full" : "relative min-w-[220px] flex-[1_1_320px] max-w-xl"}>
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search stock groups by name..."
          value={groupSearchTerm}
          onChange={(e) => setGroupSearchTerm(e.target.value)}
          className="h-10 rounded-xl border-violet-200/80 bg-background/90 pl-10 shadow-sm focus-visible:ring-violet-500/30 dark:border-violet-500/25 dark:bg-slate-950/40"
          data-testid="input-group-search"
        />
      </div>
      <Select value={groupCategoryFilter || "all"} onValueChange={(v) => setGroupCategoryFilter(v === "all" ? "" : v)}>
        <SelectTrigger
          className={
            isPhone
              ? "h-10 w-full rounded-xl"
              : "h-10 w-52 rounded-xl border-violet-200/80 bg-background/90 shadow-sm dark:border-violet-500/25 dark:bg-slate-950/40"
          }
          data-testid="select-category-filter"
        >
          <SelectValue placeholder="All Categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          <SelectItem value="none">Uncategorized</SelectItem>
          {categoriesList.map((cat) => (
            <SelectItem key={cat.id} value={String(cat.id)}>
              {cat.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const emptyMessage = groupSearchTerm
    ? "No groups match your search."
    : showZeroStock
      ? "No stock items found for this location."
      : 'No items with stock. Toggle "Show zero stock" to see all items.';

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

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-10 gap-2 rounded-xl border-violet-200/80 bg-background/80 px-4 shadow-sm dark:border-violet-500/25"
              data-testid="button-export-dropdown"
            >
              <Download className="h-4 w-4" /> Export <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={handleExportInventory} data-testid="menu-export-excel">
              <FileSpreadsheet className="h-4 w-4 mr-2" /> Export to Excel
            </DropdownMenuItem>
            {canViewCost && (
              <DropdownMenuItem onClick={() => handlePrintWithOption(true)} data-testid="menu-export-pdf-cost">
                <Printer className="h-4 w-4 mr-2" /> Export to PDF (with cost)
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => handlePrintWithOption(false)} data-testid="menu-export-pdf-nocost">
              <Printer className="h-4 w-4 mr-2" /> Export to PDF (without cost)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
