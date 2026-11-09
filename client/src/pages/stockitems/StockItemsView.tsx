import { useState } from "react";
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
import { SearchField } from "@/components/ui/search-field";
import { ErpListTable, ErpRecordAction } from "@/erp-core";
import { TableHeader, TableBody, TableFooter, TableHead, TableCell, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
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
  Grid2X2,
  Layers,
  List,
  Package,
  Plus,
  Settings,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { PAGE_SIZE } from "./utils";
import "./StockItemsModern.css";
import { StockItemsDialogs } from "./StockItemsDialogs";
import type { useStockItems } from "./useStockItems";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

type StockItemsModel = ReturnType<typeof useStockItems>;

export function StockItemsView({ stockItems }: { stockItems: StockItemsModel }) {
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const { selectedCompany } = useCompany();
  // View Only and Create Only roles cannot change existing stock items.
  const recordChanges = useExistingRecordChangeAccess();
  const recordChangeReason = recordChanges.reason ?? undefined;
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
    <SearchField
      placeholder="Search by name or code..."
      value={searchTerm}
      onValueChange={setSearchTerm}
      wrapperClassName="stock-items-search min-w-0 flex-1 sm:min-w-48"
      className="stock-items-search-input"
      data-testid="input-search"
    />
  );
  const selectFilters = (
    <>
      <Select
        value={selectedGroupFilter === null ? "all" : String(selectedGroupFilter)}
        onValueChange={(value) => setSelectedGroupFilter(value === "all" ? null : parseInt(value))}
      >
        <SelectTrigger className="stock-items-select w-40" data-testid="select-stock-group">
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
          <SelectTrigger className="stock-items-select w-36" data-testid="select-grade-filter">
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
          <SelectTrigger className="stock-items-select w-40" data-testid="select-category-filter">
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
    <div className="stock-items-page flex flex-col gap-5 px-2 pb-5 sm:px-4 sm:py-4 md:px-6">
      <div className="stock-items-hero">
        <div className="stock-items-hero-art" aria-hidden="true">
          <Package className="h-24 w-24" strokeWidth={1} />
        </div>
        <PageHeader
          title="Stock Items"
          subtitle="Manage all stock items in your company"
          icon={<Package className="h-5 w-5" aria-hidden="true" />}
        >
          {selectedIds.length > 0 && (
            <>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => {
                  setPendingCategoryId("");
                  setAssignCategoryDialogOpen(true);
                }}
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
                aria-label={recordChanges.reason ?? "Assign category"}
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
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
                aria-label={recordChanges.reason ?? `Delete ${selectedIds.length}`}
                data-testid="button-delete-selected"
              >
                <Trash2 className="h-4 w-4" />
                Delete {selectedIds.length}
              </Button>
            </>
          )}
          <Button
            className="stock-items-add-button gap-2"
            onClick={() => setCreateDialogOpen(true)}
            data-testid="button-add-item"
          >
            <Plus className="h-4 w-4" />
            Add Item
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="stock-items-manage-button gap-2"
                data-testid="button-manage-dropdown"
              >
                <Settings className="h-4 w-4" />
                Manage
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Create Only cannot import; View Only sees it disabled. */}
              {!recordChanges.isCreateOnly && (
                <DropdownMenuItem
                  onClick={() => setImportDialogOpen(true)}
                  disabled={!recordChanges.allowed}
                  title={recordChangeReason}
                  data-testid="menu-import"
                >
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  Import
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  void refetchAllItems();
                  setAdjustDialogOpen(true);
                }}
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
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
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
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
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
                data-testid="menu-manage-categories"
              >
                <Layers className="h-4 w-4 mr-2" />
                Manage Categories
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PageHeader>
      </div>

      <div className="stock-items-metrics" aria-label="Stock items overview">
        <div className="stock-items-metric stock-items-metric-purple">
          <span className="stock-items-metric-icon">
            <Package className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="stock-items-metric-info">
            <span className="stock-items-metric-label">Total Items</span>
            <strong className="stock-items-metric-value" data-testid="stock-total-items">
              {totalItems.toLocaleString()}
            </strong>
          </div>
          <svg className="stock-items-sparkline" viewBox="0 0 160 52" fill="none" aria-hidden="true">
            <path
              d="M2 44 C24 42 27 12 51 21 S81 46 101 28 S133 7 158 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="stock-items-metric stock-items-metric-blue">
          <span className="stock-items-metric-icon">
            <Layers className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="stock-items-metric-info">
            <span className="stock-items-metric-label">Categories</span>
            <strong className="stock-items-metric-value" data-testid="stock-category-count">
              {stockCategories.length}
            </strong>
          </div>
          <svg className="stock-items-sparkline" viewBox="0 0 160 52" fill="none" aria-hidden="true">
            <path
              d="M2 44 C20 37 29 12 53 18 S85 39 110 24 S135 7 158 14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
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
            <div className="stock-items-filter-bar flex flex-wrap gap-2">
              {searchControl}
              {selectFilters}
              {hasActiveFilters && (
                <Button variant="outline" type="button" onClick={resetFilters} data-testid="button-reset-filters">
                  <X className="mr-2 h-4 w-4" />
                  Reset filters
                </Button>
              )}
              <div className="stock-items-layout-switch" role="group" aria-label="Stock items layout">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="List view"
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                  data-testid="button-stock-list-view"
                  className={viewMode === "list" ? "stock-items-layout-active" : ""}
                >
                  <List className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Grid view"
                  aria-pressed={viewMode === "grid"}
                  onClick={() => setViewMode("grid")}
                  data-testid="button-stock-grid-view"
                  className={viewMode === "grid" ? "stock-items-layout-active" : ""}
                >
                  <Grid2X2 className="h-4 w-4" />
                </Button>
              </div>
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
          {viewMode === "list" ? (
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
                {totalItems > 0 && (
                  <TableFooter>
                    <TableRow className="border-t bg-muted/40">
                      <TableCell
                        colSpan={6 + (stockGrades.length > 0 ? 1 : 0) + (stockCategories.length > 0 ? 1 : 0)}
                        className="px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                          <span>
                            Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, totalItems)}{" "}
                            of {totalItems.toLocaleString()} items
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
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                )}
            </ErpListTable>
          ) : (
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
          )}

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
        </>
      )}

      <StockItemsDialogs stockItems={stockItems} />
    </div>
  );
}
