// Extracted from ./StockItemsView.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronLeft, ChevronRight, Edit } from "lucide-react";
import { PAGE_SIZE } from "./utils";
import { useStockItemsViewState } from "./useStockItemsViewState";

export function StockItemsViewSection2({
  aliasMap,
  allPageSelected,
  currentPage,
  debouncedSearch,
  displayItems,
  formatAmount,
  getCategoryName,
  getGradeName,
  handleEditClick,
  handleSelectAll,
  handleSelectItem,
  handleStockItemClick,
  hideStockRates,
  recordChangeReason,
  recordChanges,
  selectedIds,
  setCurrentPage,
  totalItems,
  totalPages,
}: Pick<
  ReturnType<typeof useStockItemsViewState>,
  | "aliasMap"
  | "allPageSelected"
  | "currentPage"
  | "debouncedSearch"
  | "displayItems"
  | "formatAmount"
  | "getCategoryName"
  | "getGradeName"
  | "handleEditClick"
  | "handleSelectAll"
  | "handleSelectItem"
  | "handleStockItemClick"
  | "hideStockRates"
  | "recordChangeReason"
  | "recordChanges"
  | "selectedIds"
  | "setCurrentPage"
  | "totalItems"
  | "totalPages"
>) {
  return (
    <div className="stock-items-mobile-list md:hidden phone-land:block space-y-2">
      <div className="flex items-center gap-2 pb-2 border-b">
        <Checkbox
          checked={allPageSelected}
          onCheckedChange={(checked) => handleSelectAll(checked === true)}
          data-testid="checkbox-select-all-mobile"
        />
        <span className="text-sm text-muted-foreground">Select All</span>
      </div>
      {displayItems.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          {debouncedSearch ? "No items match your search" : "No stock items found"}
        </div>
      ) : (
        displayItems.map((item) => (
          <div
            key={item.id}
            className="stock-items-mobile-card border rounded-xl p-3"
            data-testid={`card-stock-item-${item.id}`}
          >
            <div className="flex items-start gap-3">
              <div className="pt-0.5" onClick={(event) => event.stopPropagation()}>
                <Checkbox
                  checked={selectedIds.includes(item.id)}
                  onCheckedChange={(checked) => handleSelectItem(item.id, checked as boolean)}
                  data-testid={`checkbox-mobile-${item.id}`}
                />
              </div>
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleStockItemClick(item.id, item.name)}>
                <div className="font-medium truncate" data-testid={`name-mobile-${item.id}`}>
                  {item.name}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {item.code} · {item.uom}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <Badge
                    variant={item.active ? "default" : "secondary"}
                    className="text-xs"
                    data-testid={`status-mobile-${item.id}`}
                  >
                    {item.active ? "Active" : "Inactive"}
                  </Badge>
                  {getGradeName(item.gradeId) && (
                    <Badge variant="outline" className="text-xs font-normal" data-testid={`grade-mobile-${item.id}`}>
                      {getGradeName(item.gradeId)}
                    </Badge>
                  )}
                  {getCategoryName(item.categoryId) && (
                    <Badge variant="secondary" className="text-xs" data-testid={`category-mobile-${item.id}`}>
                      {getCategoryName(item.categoryId)}
                    </Badge>
                  )}
                  {(aliasMap.get(item.id) ?? []).map((code) => (
                    <Badge
                      key={code}
                      variant="outline"
                      className="text-xs font-mono font-normal"
                      data-testid={`alias-mobile-${item.id}`}
                    >
                      {code}
                    </Badge>
                  ))}
                </div>
                {!hideStockRates && (
                  <div className="text-xs text-muted-foreground mt-1">{formatAmount(item.sellingPrice)}</div>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => handleEditClick(item.id, event)}
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
                aria-label={recordChanges.reason ?? "Edit stock item"}
                data-testid={`button-edit-mobile-${item.id}`}
                className="gap-1 shrink-0"
              >
                <Edit className="h-3.5 w-3.5" />
                Edit
              </Button>
            </div>
          </div>
        ))
      )}
      {totalItems > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
          <span>
            {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, totalItems)} of {totalItems}
          </span>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="outline"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage <= 1}
              data-testid="button-prev-page-mobile"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage >= totalPages}
              data-testid="button-next-page-mobile"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
