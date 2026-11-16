import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { PageHeader } from "@/components/PageHeader";
import {
  ChevronDown,
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
import "./StockItemsModern.css";
import { StockItemsDialogs } from "./StockItemsDialogs";
import { useStockItemsViewState, type StockItemsModel } from "./useStockItemsViewState";
import { StockItemsViewErpListTableSection } from "./StockItemsViewErpListTableSection";
import { StockItemsViewSection } from "./StockItemsViewSection";
import { StockItemsViewSection2 } from "./StockItemsViewSection2";

export function StockItemsView(props: { stockItems: StockItemsModel }) {
  const {
    activeSelectFilterCount,
    aliasMap,
    allPageSelected,
    currentPage,
    debouncedSearch,
    displayItems,
    error,
    exportSalesHistory,
    exportToExcel,
    exportingStockItems,
    formatAmount,
    getCategoryName,
    getGradeName,
    getStockGroupName,
    handleEditClick,
    handleSelectAll,
    handleSelectItem,
    handleStockItemClick,
    hasActiveFilters,
    hideStockRates,
    isError,
    isLoading,
    recordChangeReason,
    recordChanges,
    refetch,
    refetchAllItems,
    resetFilters,
    searchControl,
    selectFilters,
    selectedCompany,
    selectedIds,
    setAdjustDialogOpen,
    setAssignCategoryDialogOpen,
    setCreateDialogOpen,
    setCurrentPage,
    setDeleteDialogOpen,
    setEditingCategoryId,
    setEditingGradeId,
    setImportDialogOpen,
    setManageCategoriesOpen,
    setManageGradesOpen,
    setNewCategoryName,
    setNewGradeName,
    setPendingCategoryId,
    setViewMode,
    stockCategories,
    stockGrades,
    stockItems,
    totalItems,
    totalPages,
    viewMode,
  } = useStockItemsViewState(props);

  return (
    <div className="stock-items-page flex flex-col gap-5 px-2 pb-5 sm:px-4 sm:py-4 md:px-6">
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
            <Button variant="outline" className="stock-items-manage-button gap-2" data-testid="button-manage-dropdown">
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
            <DropdownMenuItem onClick={exportToExcel} disabled={exportingStockItems} data-testid="menu-export">
              <Download className="h-4 w-4 mr-2" />
              {exportingStockItems ? "Exporting all matching items..." : "Export Stock Items"}
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
            <StockItemsViewErpListTableSection
              aliasMap={aliasMap}
              allPageSelected={allPageSelected}
              currentPage={currentPage}
              debouncedSearch={debouncedSearch}
              displayItems={displayItems}
              getCategoryName={getCategoryName}
              getGradeName={getGradeName}
              getStockGroupName={getStockGroupName}
              handleEditClick={handleEditClick}
              handleSelectAll={handleSelectAll}
              handleSelectItem={handleSelectItem}
              handleStockItemClick={handleStockItemClick}
              recordChangeReason={recordChangeReason}
              recordChanges={recordChanges}
              selectedCompany={selectedCompany}
              selectedIds={selectedIds}
              setCurrentPage={setCurrentPage}
              stockCategories={stockCategories}
              stockGrades={stockGrades}
              totalItems={totalItems}
              totalPages={totalPages}
            />
          ) : (
            <StockItemsViewSection
              aliasMap={aliasMap}
              currentPage={currentPage}
              debouncedSearch={debouncedSearch}
              displayItems={displayItems}
              getCategoryName={getCategoryName}
              getGradeName={getGradeName}
              getStockGroupName={getStockGroupName}
              handleEditClick={handleEditClick}
              handleSelectItem={handleSelectItem}
              handleStockItemClick={handleStockItemClick}
              recordChangeReason={recordChangeReason}
              recordChanges={recordChanges}
              selectedIds={selectedIds}
              setCurrentPage={setCurrentPage}
              totalItems={totalItems}
              totalPages={totalPages}
            />
          )}

          <StockItemsViewSection2
            aliasMap={aliasMap}
            allPageSelected={allPageSelected}
            currentPage={currentPage}
            debouncedSearch={debouncedSearch}
            displayItems={displayItems}
            formatAmount={formatAmount}
            getCategoryName={getCategoryName}
            getGradeName={getGradeName}
            handleEditClick={handleEditClick}
            handleSelectAll={handleSelectAll}
            handleSelectItem={handleSelectItem}
            handleStockItemClick={handleStockItemClick}
            hideStockRates={hideStockRates}
            recordChangeReason={recordChangeReason}
            recordChanges={recordChanges}
            selectedIds={selectedIds}
            setCurrentPage={setCurrentPage}
            totalItems={totalItems}
            totalPages={totalPages}
          />
        </>
      )}

      <StockItemsDialogs stockItems={stockItems} />
    </div>
  );
}
