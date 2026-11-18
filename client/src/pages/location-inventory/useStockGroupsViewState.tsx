// Extracted from ./StockGroupsView.tsx to keep that module under the source-size cap.
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InventoryLocation as Location, StockGroupSummary } from "./locationInventoryTypes";
import type { AuthMe } from "@shared/apiTypes";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { SearchField } from "@/components/ui/search-field";

export interface StockGroupsViewProps {
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

export function useStockGroupsViewState({
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
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Export PDF"
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
  );

  const groupSearchControls = (
    <div className="flex items-center gap-2 flex-wrap">
      <SearchField
        placeholder="Search stock groups by name..."
        value={groupSearchTerm}
        onValueChange={setGroupSearchTerm}
        wrapperClassName={isPhone ? "w-full" : "min-w-[220px] flex-[1_1_320px] max-w-xl"}
        className="h-10 rounded-xl border-violet-200/80 bg-background/90 shadow-sm focus-visible:ring-violet-500/30 dark:border-violet-500/25 dark:bg-slate-950/40"
        data-testid="input-group-search"
      />
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
  return {
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
  };
}
