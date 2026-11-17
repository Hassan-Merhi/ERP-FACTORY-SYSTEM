// Extracted from ./StockItemsView.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ErpListTable, ErpRecordAction } from "@/erp-core";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Edit, Package } from "lucide-react";
import { PAGE_SIZE } from "./utils";
import { useStockItemsViewState } from "./useStockItemsViewState";
import { PaginationBar } from "@/components/PaginationBar";

export function StockItemsViewErpListTableSection({
  aliasMap,
  allPageSelected,
  currentPage,
  debouncedSearch,
  displayItems,
  getCategoryName,
  getGradeName,
  getStockGroupName,
  handleEditClick,
  handleSelectAll,
  handleSelectItem,
  handleStockItemClick,
  recordChangeReason,
  recordChanges,
  selectedCompany,
  selectedIds,
  setCurrentPage,
  stockCategories,
  stockGrades,
  totalItems,
  totalPages,
}: Pick<
  ReturnType<typeof useStockItemsViewState>,
  | "aliasMap"
  | "allPageSelected"
  | "currentPage"
  | "debouncedSearch"
  | "displayItems"
  | "getCategoryName"
  | "getGradeName"
  | "getStockGroupName"
  | "handleEditClick"
  | "handleSelectAll"
  | "handleSelectItem"
  | "handleStockItemClick"
  | "recordChangeReason"
  | "recordChanges"
  | "selectedCompany"
  | "selectedIds"
  | "setCurrentPage"
  | "stockCategories"
  | "stockGrades"
  | "totalItems"
  | "totalPages"
>) {
  return (
    <>
      <ErpListTable
        pageKey="stock-items"
        companyId={selectedCompany?.id}
        scrollLabel="Stock items"
        wrapperClassName="stock-items-table-shell hidden md:block phone-land:hidden rounded-xl"
        minimumWidth="800px"
      >
        <TableHeader className="sticky top-0 z-30 bg-muted">
          <TableRow className="h-11 bg-muted/40 border-b">
            <TableHead className="w-10 px-3">
              <Checkbox
                checked={allPageSelected}
                onCheckedChange={(checked) => handleSelectAll(checked === true)}
                data-testid="checkbox-select-all"
              />
            </TableHead>
            <TableHead className="text-left px-3 font-medium">Name</TableHead>
            <TableHead className="text-left px-3 font-medium">Group</TableHead>
            {stockGrades.length > 0 && <TableHead className="text-left px-3 font-medium">Grade</TableHead>}
            {stockCategories.length > 0 && <TableHead className="text-left px-3 font-medium">Category</TableHead>}
            <TableHead className="text-left px-3 font-medium">Aliases</TableHead>
            <TableHead className="text-left px-3 font-medium">Status</TableHead>
            <TableHead className="w-20 px-3 text-right font-medium">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayItems.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6 + (stockGrades.length > 0 ? 1 : 0) + (stockCategories.length > 0 ? 1 : 0)}
                className="text-center py-12 text-muted-foreground"
              >
                {debouncedSearch ? "No items match your search" : "No stock items found"}
              </TableCell>
            </TableRow>
          ) : (
            displayItems.map((item) => (
              <TableRow
                key={item.id}
                className="stock-items-table-row border-t hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => handleStockItemClick(item.id, item.name)}
                data-testid={`row-stock-item-${item.id}`}
              >
                <TableCell className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    onCheckedChange={(checked) => handleSelectItem(item.id, checked as boolean)}
                    data-testid={`checkbox-${item.id}`}
                  />
                </TableCell>
                <TableCell className="px-3 py-3" data-testid={`name-${item.id}`}>
                  <div className="stock-items-name-cell">
                    <span className="stock-items-row-icon">
                      <Package className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="font-semibold leading-tight">{item.name}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {item.code} · {item.uom}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="px-3 py-3 text-sm text-muted-foreground" data-testid={`group-${item.id}`}>
                  {getStockGroupName(item.stockGroupId) ? (
                    <span className="stock-items-group-pill">{getStockGroupName(item.stockGroupId)}</span>
                  ) : (
                    <span className="text-xs">—</span>
                  )}
                </TableCell>
                {stockGrades.length > 0 && (
                  <TableCell className="px-3 py-3" data-testid={`grade-${item.id}`}>
                    {getGradeName(item.gradeId) ? (
                      <Badge variant="outline" className="text-xs font-normal">
                        {getGradeName(item.gradeId)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                {stockCategories.length > 0 && (
                  <TableCell className="px-3 py-3" data-testid={`category-${item.id}`}>
                    {getCategoryName(item.categoryId) ? (
                      <Badge variant="secondary" className="stock-items-category-pill text-xs">
                        {getCategoryName(item.categoryId)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="px-3 py-3 max-w-[180px]" data-testid={`aliases-${item.id}`}>
                  {(aliasMap.get(item.id) ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {(aliasMap.get(item.id) ?? []).map((code) => (
                        <Badge key={code} variant="outline" className="text-xs font-mono font-normal">
                          {code}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-3" data-testid={`status-${item.id}`}>
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
                </TableCell>
                <TableCell className="px-3 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                  <ErpRecordAction
                    size="sm"
                    variant="ghost"
                    onClick={(event) => handleEditClick(item.id, event)}
                    permitted={recordChanges.allowed}
                    deniedReason={recordChangeReason}
                    aria-label={recordChanges.reason ?? "Edit stock item"}
                    data-testid={`button-edit-${item.id}`}
                    className="stock-items-edit-button gap-1.5"
                  >
                    <Edit className="h-3.5 w-3.5" />
                    Edit
                  </ErpRecordAction>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </ErpListTable>
      <div className="hidden md:block phone-land:hidden">
        <PaginationBar
          page={currentPage}
          totalPages={totalPages}
          total={totalItems}
          pageSize={PAGE_SIZE}
          onPageChange={setCurrentPage}
          noun="items"
          data-testid="stock-items-pagination-list"
        />
      </div>
    </>
  );
}
