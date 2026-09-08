import { Layers, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InventoryTable } from "./InventoryTable";
import type { InventoryItem, StockGroupSummary } from "./locationInventoryTypes";

interface StockGroupItemsViewProps {
  selectedGroup: StockGroupSummary;
  posUser?: any;
  canViewCost: boolean;
  formatAmount: (v: number) => string;
  setArchiveDialogOpen: (v: boolean) => void;
  itemSearchTerm: string;
  setItemSearchTerm: (v: string) => void;
  itemCategoryFilter: string[];
  setItemCategoryFilter: (v: string[]) => void;
  categoriesList: { id: number; name: string; active: boolean; }[];
  filteredStockItems: InventoryItem[];
  showMovement: boolean;
  openingInventoryMap: Map<number, number>;
  selectedRowIndex: number;
  setSelectedRowIndex: (v: number) => void;
  navigate: (path: string) => void;
  inventory: InventoryItem[];
}

export function StockGroupItemsView({
  selectedGroup,
  posUser,
  canViewCost,
  formatAmount,
  setArchiveDialogOpen,
  itemSearchTerm,
  setItemSearchTerm,
  itemCategoryFilter,
  setItemCategoryFilter,
  categoriesList,
  filteredStockItems,
  showMovement,
  openingInventoryMap,
  selectedRowIndex,
  setSelectedRowIndex,
  navigate,
  inventory,
}: StockGroupItemsViewProps) {
  return (
    <>
      {/* Stats bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Layers className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-bold">{selectedGroup.groupName}</h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span>
              <span className="font-semibold text-foreground">{selectedGroup.itemCount}</span> Items
            </span>
            <span>
              <span className="font-semibold text-foreground font-mono">
                {Math.floor(selectedGroup.totalQuantity).toLocaleString()}
              </span>{" "}
              BL total
            </span>
            {canViewCost && (
              <span>
                <span className="font-semibold text-foreground">
                  {formatAmount(selectedGroup.totalValue)}
                </span>{" "}
                total value
              </span>
            )}
          </div>
        </div>
        {!posUser && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={() => setArchiveDialogOpen(true)}
            data-testid="button-archive-group"
          >
            <Trash2 className="h-4 w-4" /> Archive Group
          </Button>
        )}
      </div>

      {/* Search + category */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search items by name..."
            value={itemSearchTerm}
            onChange={(e) => setItemSearchTerm(e.target.value)}
            className="pl-9"
            data-testid="input-item-search"
          />
        </div>
        <Select
          value={itemCategoryFilter[0] || "all"}
          onValueChange={(v) => setItemCategoryFilter(v === "all" ? [] : [v])}
        >
          <SelectTrigger className="w-48">
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

      <InventoryTable
        filteredStockItems={filteredStockItems}
        showMovement={showMovement}
        openingInventoryMap={openingInventoryMap}
        selectedRowIndex={selectedRowIndex}
        setSelectedRowIndex={setSelectedRowIndex}
        navigate={navigate}
        formatAmount={formatAmount}
        canViewCost={canViewCost}
        itemSearchTerm={itemSearchTerm}
        inventory={inventory}
        selectedGroup={selectedGroup}
      />
    </>
  );
}
