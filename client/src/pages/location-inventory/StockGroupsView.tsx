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
import type { InventoryLocation as Location } from "./locationInventoryTypes";

interface StockGroupSummary {
  groupId: number | null;
  groupCode: string | null;
  groupName: string;
  totalQuantity: number;
  totalValue: number;
  averageRate: number;
  itemCount: number;
  items: any[];
}

interface StockGroupsViewProps {
  selectedLocationLocal: Location;
  posUser?: any;
  canViewCost: boolean;
  canManageWhatsapp: boolean;
  openRenameDialog: (loc: Location, e?: { stopPropagation: () => void; }) => void;
  openWaGroupDialog: (loc: Location, e?: { stopPropagation: () => void; }) => void;
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
  const whatsappTitle =
    selectedLocationLocal.whatsappGroupChatId && selectedLocationLocal.whatsappStockReportsEnabled
      ? `WhatsApp stock reports enabled${selectedLocationLocal.whatsappGroupName ? `: ${selectedLocationLocal.whatsappGroupName}` : ""}`
      : selectedLocationLocal.whatsappGroupChatId
        ? `WhatsApp group linked but stock reports disabled${selectedLocationLocal.whatsappGroupName ? `: ${selectedLocationLocal.whatsappGroupName}` : ""}`
        : "Link WhatsApp group for stock reports";

  return (
    <>
      {/* Location title + action buttons */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Warehouse className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className="text-2xl font-bold truncate">{selectedLocationLocal.name}</h2>
              {!posUser && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openRenameDialog(selectedLocationLocal)}
                  data-testid="button-rename-location"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {!posUser && canManageWhatsapp && (
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
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Stock Groups</p>
          </div>
        </div>

        {/* Stats pills */}
        {!activeInventoryLoading && (
          <div className="flex items-center gap-2 flex-wrap text-sm shrink-0">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium text-xs">
              <Layers className="h-3 w-3" />
              {stockGroups.length} {stockGroups.length === 1 ? "Group" : "Groups"}
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium text-xs">
              <Package className="h-3 w-3" />
              {totalItems} Items
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium text-xs">
              {Math.floor(totalQty).toLocaleString()} BL total
            </span>
            {canViewCost && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium text-xs">
                {formatAmount(totalValue)} total value
              </span>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-export-dropdown">
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
          className="gap-1.5"
          onClick={() => {
            setViewAllItems(true);
            setItemSearchTerm("");
          }}
          data-testid="button-view-all-items"
        >
          <List className="h-4 w-4" /> View All Stock Items
        </Button>

        <Button
          variant={showZeroStock ? "default" : "outline"}
          size="sm"
          className="gap-1.5"
          onClick={() => setShowZeroStock(!showZeroStock)}
          data-testid="button-show-zero"
        >
          <Eye className="h-4 w-4" /> Show zero stock
        </Button>

        {!posUser && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 ml-auto" data-testid="button-location-menu">
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
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search stock groups by name..."
            value={groupSearchTerm}
            onChange={(e) => setGroupSearchTerm(e.target.value)}
            className="pl-9"
            data-testid="input-group-search"
          />
        </div>
        <Select
          value={groupCategoryFilter || "all"}
          onValueChange={(v) => setGroupCategoryFilter(v === "all" ? "" : v)}
        >
          <SelectTrigger className="w-48" data-testid="select-category-filter">
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

      {/* Stock groups table */}
      {activeInventoryLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg border bg-muted animate-pulse" />
          ))}
        </div>
      ) : filteredStockGroups.length === 0 ? (
        <div className="py-16 text-center border-2 border-dashed rounded-lg text-muted-foreground">
          {groupSearchTerm
            ? "No groups match your search."
            : showZeroStock
              ? "No stock items found for this location."
              : 'No items with stock. Toggle "Show zero stock" to see all items.'}
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/50 border-b">
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
                  className="border-b hover-elevate cursor-pointer"
                  onClick={() => {
                    setSelectedGroup(g);
                    setItemSearchTerm("");
                    setItemCategoryFilter([]);
                  }}
                  data-testid={`row-group-${g.groupId}`}
                >
                  <td className="px-4 py-3 font-medium">{g.groupName}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant="secondary">{g.itemCount}</Badge>
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          data-testid={`button-export-group-${g.groupId}`}
                        >
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
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 border-t-2 font-semibold">
                <td className="px-4 py-3 font-bold">Total</td>
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
    </>
  );
}
