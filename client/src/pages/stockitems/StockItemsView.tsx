import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { PageHeader } from "@/components/PageHeader";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit,
  FileSpreadsheet,
  Layers,
  Package,
  Plus,
  Search,
  Settings,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { PAGE_SIZE } from "./utils";
import { StockItemsDialogs } from "./StockItemsDialogs";
import type { useStockItems } from "./useStockItems";

type StockItemsModel = ReturnType<typeof useStockItems>;

export function StockItemsView({ stockItems }: { stockItems: StockItemsModel }) {
  const {
    hideStockRates,
    searchTerm,
    setSearchTerm,
    debouncedSearch,
    selectedGroupFilter,
    setSelectedGroupFilter,
    selectedGradeFilter,
    setSelectedGradeFilter,
    selectedCategoryFilter,
    setSelectedCategoryFilter,
    resetFilters,
    hasActiveFilters,
    currentPage,
    setCurrentPage,
    selectedIds,
    setDeleteDialogOpen,
    setCreateDialogOpen,
    setImportDialogOpen,
    setAssignCategoryDialogOpen,
    setPendingCategoryId,
    setAdjustDialogOpen,
    setManageGradesOpen,
    setNewGradeName,
    setEditingGradeId,
    setManageCategoriesOpen,
    setNewCategoryName,
    setEditingCategoryId,
    formatAmount,
    displayItems,
    totalItems,
    totalPages,
    refetchAllItems,
    stockGroups,
    stockGrades,
    stockCategories,
    aliasMap,
    isLoading,
    isError,
    error,
    refetch,
    handleSelectAll,
    handleSelectItem,
    allPageSelected,
    getStockGroupName,
    getGradeName,
    getCategoryName,
    handleStockItemClick,
    handleEditClick,
    exportSalesHistory,
    exportToExcel,
  } = stockItems;

  const searchControl = (
    <div className="relative min-w-0 flex-1 sm:min-w-48">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search by name or code..."
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
        className="pl-9"
        data-testid="input-search"
      />
    </div>
  );
  const selectFilters = (
    <>
      <Select
        value={selectedGroupFilter === null ? "all" : String(selectedGroupFilter)}
        onValueChange={(value) => setSelectedGroupFilter(value === "all" ? null : parseInt(value))}
      >
        <SelectTrigger className="w-40" data-testid="select-stock-group">
          <SelectValue placeholder="All Groups" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Groups</SelectItem>
          {stockGroups.map((group) => (
            <SelectItem key={group.id} value={String(group.id)}>
              {group.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {stockGrades.length > 0 && (
        <Select
          value={selectedGradeFilter === null ? "all" : String(selectedGradeFilter)}
          onValueChange={(value) => setSelectedGradeFilter(value === "all" ? null : parseInt(value))}
        >
          <SelectTrigger className="w-36" data-testid="select-grade-filter">
            <SelectValue placeholder="All Grades" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Grades</SelectItem>
            {stockGrades.map((grade) => (
              <SelectItem key={grade.id} value={String(grade.id)}>
                {grade.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {stockCategories.length > 0 && (
        <Select
          value={selectedCategoryFilter === null ? "all" : String(selectedCategoryFilter)}
          onValueChange={(value) =>
            setSelectedCategoryFilter(value === "all" ? null : value === "none" ? "none" : parseInt(value))
          }
        >
          <SelectTrigger className="w-40" data-testid="select-category-filter">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="none">No Category</SelectItem>
            {stockCategories.map((category) => (
              <SelectItem key={category.id} value={String(category.id)}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  );
  const activeSelectFilterCount = [selectedGroupFilter, selectedGradeFilter, selectedCategoryFilter].filter(
    (value) => value !== null
  ).length;

  return (
    <div className="flex flex-col gap-4 sm:p-4 md:p-6">
      <PageHeader title="Stock Items" subtitle="Manage all stock items in your company">
        {selectedIds.length > 0 && (
          <>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                setPendingCategoryId("");
                setAssignCategoryDialogOpen(true);
              }}
              data-testid="button-assign-category"
            >
              <Package className="h-4 w-4" />
              <span className="hidden sm:inline">Assign Category</span>
              <span className="sm:hidden">Category</span>
              <Badge variant="secondary" className="ml-1">
                {selectedIds.length}
              </Badge>
            </Button>
            <Button
              variant="destructive"
              className="gap-2"
              onClick={() => setDeleteDialogOpen(true)}
              data-testid="button-delete-selected"
            >
              <Trash2 className="h-4 w-4" />
              Delete {selectedIds.length}
            </Button>
          </>
        )}
        <Button className="gap-2" onClick={() => setCreateDialogOpen(true)} data-testid="button-add-item">
          <Plus className="h-4 w-4" />
          Add Item
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2" data-testid="button-manage-dropdown">
              <Settings className="h-4 w-4" />
              Manage
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setImportDialogOpen(true)} data-testid="menu-import">
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Import
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void refetchAllItems();
                setAdjustDialogOpen(true);
              }}
              data-testid="menu-adjust-stock"
            >
              <Edit className="h-4 w-4 mr-2" />
              Adjust Stock
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportToExcel} data-testid="menu-export">
              <Download className="h-4 w-4 mr-2" />
              Export Stock Items
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportSalesHistory} data-testid="menu-export-sales-history">
              <Download className="h-4 w-4 mr-2" />
              Export Sales History
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setNewGradeName("");
                setEditingGradeId(null);
                setManageGradesOpen(true);
              }}
              data-testid="menu-manage-grades"
            >
              <Tag className="h-4 w-4 mr-2" />
              Manage Grades
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setNewCategoryName("");
                setEditingCategoryId(null);
                setManageCategoriesOpen(true);
              }}
              data-testid="menu-manage-categories"
            >
              <Layers className="h-4 w-4 mr-2" />
              Manage Categories
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Total</span>
          <span className="font-semibold">{totalItems.toLocaleString()}</span>
        </div>
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Categories</span>
          <span className="font-semibold">{stockCategories.length}</span>
        </div>
      </div>

      <ErpMobileFilters
        label="Stock item filters"
        quick={<div className="flex">{searchControl}</div>}
        activeCount={activeSelectFilterCount}
        onClear={resetFilters}
        canClear={hasActiveFilters}
        data-testid="stock-items-filters"
      >
        {(layout) =>
          layout === "sheet" ? (
            selectFilters
          ) : (
            <div className="flex flex-wrap gap-2">
              {searchControl}
              {selectFilters}
              {hasActiveFilters && (
                <Button variant="outline" type="button" onClick={resetFilters} data-testid="button-reset-filters">
                  <X className="mr-2 h-4 w-4" />
                  Reset filters
                </Button>
              )}
            </div>
          )
        }
      </ErpMobileFilters>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load stock items"
          description={error instanceof Error ? error.message : "Stock items could not be loaded."}
          actionLabel="Try again"
          onAction={() => void refetch()}
          data-testid="stock-items-error"
        />
      ) : (
        <>
          <div className="hidden md:block border rounded-xl overflow-auto max-h-[calc(100vh-300px)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-30 bg-muted/40">
                <tr className="h-11 bg-muted/40 border-b">
                  <th className="w-10 px-3">
                    <Checkbox
                      checked={allPageSelected}
                      onCheckedChange={handleSelectAll}
                      data-testid="checkbox-select-all"
                    />
                  </th>
                  <th className="text-left px-3 font-medium">Name</th>
                  <th className="text-left px-3 font-medium">Group</th>
                  {stockGrades.length > 0 && <th className="text-left px-3 font-medium">Grade</th>}
                  {stockCategories.length > 0 && <th className="text-left px-3 font-medium">Category</th>}
                  <th className="text-left px-3 font-medium">Aliases</th>
                  <th className="text-left px-3 font-medium">Status</th>
                  <th className="w-20 px-3" />
                </tr>
              </thead>
              <tbody>
                {displayItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4 + (stockGrades.length > 0 ? 1 : 0) + (stockCategories.length > 0 ? 1 : 0)}
                      className="text-center py-12 text-muted-foreground"
                    >
                      {debouncedSearch ? "No items match your search" : "No stock items found"}
                    </td>
                  </tr>
                ) : (
                  displayItems.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t hover:bg-muted/30 transition-colors cursor-pointer"
                      onClick={() => handleStockItemClick(item.id, item.name)}
                      data-testid={`row-stock-item-${item.id}`}
                    >
                      <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.includes(item.id)}
                          onCheckedChange={(checked) => handleSelectItem(item.id, checked as boolean)}
                          data-testid={`checkbox-${item.id}`}
                        />
                      </td>
                      <td className="px-3 py-3" data-testid={`name-${item.id}`}>
                        <div className="font-medium leading-tight">{item.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {item.code} · {item.uom}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm text-muted-foreground" data-testid={`group-${item.id}`}>
                        {getStockGroupName(item.stockGroupId) ?? <span className="text-xs">—</span>}
                      </td>
                      {stockGrades.length > 0 && (
                        <td className="px-3 py-3" data-testid={`grade-${item.id}`}>
                          {getGradeName(item.gradeId) ? (
                            <Badge variant="outline" className="text-xs font-normal">
                              {getGradeName(item.gradeId)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      {stockCategories.length > 0 && (
                        <td className="px-3 py-3" data-testid={`category-${item.id}`}>
                          {getCategoryName(item.categoryId) ? (
                            <Badge variant="secondary" className="text-xs">
                              {getCategoryName(item.categoryId)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-3 max-w-[180px]" data-testid={`aliases-${item.id}`}>
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
                      </td>
                      <td className="px-3 py-3" data-testid={`status-${item.id}`}>
                        <Badge variant={item.active ? "default" : "secondary"} className="text-xs">
                          {item.active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(event) => handleEditClick(item.id, event)}
                          data-testid={`button-edit-${item.id}`}
                          className="gap-1.5"
                        >
                          <Edit className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {totalItems > 0 && (
                <tfoot>
                  <tr className="border-t bg-muted/40">
                    <td
                      colSpan={5 + (stockGrades.length > 0 ? 1 : 0) + (stockCategories.length > 0 ? 1 : 0)}
                      className="px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                        <span>
                          Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, totalItems)} of{" "}
                          {totalItems.toLocaleString()} items
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                            disabled={currentPage <= 1}
                            data-testid="button-prev-page"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <span className="px-2 text-sm">
                            Page {currentPage} of {totalPages}
                          </span>
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                            disabled={currentPage >= totalPages}
                            data-testid="button-next-page"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="md:hidden space-y-2">
            <div className="flex items-center gap-2 pb-2 border-b">
              <Checkbox
                checked={allPageSelected}
                onCheckedChange={handleSelectAll}
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
                <div key={item.id} className="border rounded-xl p-3" data-testid={`card-stock-item-${item.id}`}>
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.includes(item.id)}
                        onCheckedChange={(checked) => handleSelectItem(item.id, checked as boolean)}
                        data-testid={`checkbox-mobile-${item.id}`}
                      />
                    </div>
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => handleStockItemClick(item.id, item.name)}
                    >
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
                          <Badge
                            variant="outline"
                            className="text-xs font-normal"
                            data-testid={`grade-mobile-${item.id}`}
                          >
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
        </>
      )}

      <StockItemsDialogs stockItems={stockItems} />
    </div>
  );
}
