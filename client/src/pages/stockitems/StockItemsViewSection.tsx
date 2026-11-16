// Extracted from ./StockItemsView.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronLeft, ChevronRight, Edit, Package } from "lucide-react";
import { PAGE_SIZE } from "./utils";
import { useStockItemsViewState } from "./useStockItemsViewState";

export function StockItemsViewSection({
  aliasMap,
  currentPage,
  debouncedSearch,
  displayItems,
  getCategoryName,
  getGradeName,
  getStockGroupName,
  handleEditClick,
  handleSelectItem,
  handleStockItemClick,
  recordChangeReason,
  recordChanges,
  selectedIds,
  setCurrentPage,
  totalItems,
  totalPages,
}: Pick<
  ReturnType<typeof useStockItemsViewState>,
  | "aliasMap"
  | "currentPage"
  | "debouncedSearch"
  | "displayItems"
  | "getCategoryName"
  | "getGradeName"
  | "getStockGroupName"
  | "handleEditClick"
  | "handleSelectItem"
  | "handleStockItemClick"
  | "recordChangeReason"
  | "recordChanges"
  | "selectedIds"
  | "setCurrentPage"
  | "totalItems"
  | "totalPages"
>) {
  return (
    <div className="hidden md:block phone-land:hidden">
      {displayItems.length === 0 ? (
        <div className="stock-items-empty-state py-16 text-center text-muted-foreground">
          {debouncedSearch ? "No items match your search" : "No stock items found"}
        </div>
      ) : (
        <div className="stock-items-grid">
          {displayItems.map((item) => (
            <article key={item.id} className="stock-items-grid-card" data-testid={"grid-stock-item-" + item.id}>
              <div className="flex items-start gap-3">
                <div className="pt-1" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    onCheckedChange={(checked) => handleSelectItem(item.id, checked === true)}
                    aria-label={"Select " + item.name}
                  />
                </div>
                <span className="stock-items-row-icon">
                  <Package className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="stock-items-grid-name text-left font-semibold hover:underline"
                    onClick={() => handleStockItemClick(item.id, item.name)}
                  >
                    {item.name}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.code} · {item.uom}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {getStockGroupName(item.stockGroupId) && (
                  <span className="stock-items-group-pill">{getStockGroupName(item.stockGroupId)}</span>
                )}
                {getGradeName(item.gradeId) && <Badge variant="outline">{getGradeName(item.gradeId)}</Badge>}
                {getCategoryName(item.categoryId) && (
                  <Badge variant="secondary" className="stock-items-category-pill">
                    {getCategoryName(item.categoryId)}
                  </Badge>
                )}
                {(aliasMap.get(item.id) ?? []).map((code) => (
                  <Badge key={code} variant="outline" className="font-mono">
                    {code}
                  </Badge>
                ))}
              </div>
              <div className="stock-items-grid-card-footer">
                <Badge
                  variant="outline"
                  className={
                    item.active
                      ? "stock-items-status stock-items-status-active"
                      : "stock-items-status stock-items-status-inactive"
                  }
                >
                  <span className="stock-items-status-dot" aria-hidden="true" />
                  {item.active ? "Active" : "Inactive"}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="stock-items-edit-button gap-1.5"
                  onClick={(event) => handleEditClick(item.id, event)}
                  disabled={!recordChanges.allowed}
                  title={recordChangeReason}
                  aria-label={recordChanges.reason ?? "Edit stock item"}
                >
                  <Edit className="h-3.5 w-3.5" />
                  Edit
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {totalItems > 0 && (
        <div className="stock-items-grid-pagination mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, totalItems)} of{" "}
            {totalItems.toLocaleString()} items
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <Button
              size="icon"
              variant="outline"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
