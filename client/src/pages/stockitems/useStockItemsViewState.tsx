// Extracted from ./StockItemsView.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { SearchField } from "@/components/ui/search-field";
import { useCompany } from "@/contexts/CompanyContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useStockItems } from "./useStockItems";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

export type StockItemsModel = ReturnType<typeof useStockItems>;

export function useStockItemsViewState({ stockItems }: { stockItems: StockItemsModel }) {
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
    exportingStockItems,
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
  return {
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
  };
}
