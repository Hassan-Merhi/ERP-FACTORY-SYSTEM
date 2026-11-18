// Extracted from ./StockOTW.tsx to keep that module under the source-size cap.
import { SearchField } from "@/components/ui/search-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, X } from "lucide-react";
import { useStockOTWContentState } from "./useStockOTWContentState";

export function StockOTWContentSection({
  categoryOptions,
  clearFilters,
  gradeOptions,
  hasActiveFilters,
  searchTerm,
  selectedCategory,
  selectedGrade,
  selectedSupplier,
  setSearchTerm,
  setSelectedCategory,
  setSelectedGrade,
  setSelectedSupplier,
  supplierOptions,
}: Pick<
  ReturnType<typeof useStockOTWContentState>,
  | "categoryOptions"
  | "clearFilters"
  | "gradeOptions"
  | "hasActiveFilters"
  | "searchTerm"
  | "selectedCategory"
  | "selectedGrade"
  | "selectedSupplier"
  | "setSearchTerm"
  | "setSelectedCategory"
  | "setSelectedGrade"
  | "setSelectedSupplier"
  | "supplierOptions"
>) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <SearchField
        placeholder="Search by name, container, supplier, grade or category..."
        value={searchTerm}
        onValueChange={setSearchTerm}
        wrapperClassName="flex-1 min-w-[200px]"
        data-testid="input-search"
      />
      {gradeOptions.length > 0 && (
        <Select value={selectedGrade} onValueChange={setSelectedGrade}>
          <SelectTrigger className="w-[140px]" data-testid="select-grade-filter">
            <SelectValue placeholder="All Grades" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Grades</SelectItem>
            {gradeOptions.map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {categoryOptions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-[170px] justify-between gap-2" data-testid="select-category-filter">
              <span className="truncate">
                {selectedCategory.length === 0
                  ? "All Categories"
                  : selectedCategory.length === 1
                    ? selectedCategory[0]
                    : `${selectedCategory.length} Categories`}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[220px]">
            {categoryOptions.map((category) => {
              const checked = selectedCategory.includes(category);
              return (
                <DropdownMenuItem
                  key={category}
                  className="cursor-pointer gap-2"
                  onSelect={(event) => {
                    event.preventDefault();
                    setSelectedCategory((current) =>
                      checked ? current.filter((value) => value !== category) : [...current, category]
                    );
                  }}
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="truncate">{category}</span>
                </DropdownMenuItem>
              );
            })}
            {selectedCategory.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer justify-center text-xs text-muted-foreground"
                  onSelect={(event) => {
                    event.preventDefault();
                    setSelectedCategory([]);
                  }}
                >
                  Clear categories
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {supplierOptions.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-[180px] justify-between gap-2" data-testid="select-supplier-filter">
              <span className="truncate">
                {selectedSupplier.length === 0
                  ? "All Suppliers"
                  : selectedSupplier.length === 1
                    ? selectedSupplier[0]
                    : `${selectedSupplier.length} Suppliers`}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px]">
            {supplierOptions.map((supplier) => {
              const checked = selectedSupplier.includes(supplier);
              return (
                <DropdownMenuItem
                  key={supplier}
                  className="cursor-pointer gap-2"
                  onSelect={(event) => {
                    event.preventDefault();
                    setSelectedSupplier((current) =>
                      checked ? current.filter((value) => value !== supplier) : [...current, supplier]
                    );
                  }}
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="truncate">{supplier}</span>
                </DropdownMenuItem>
              );
            })}
            {selectedSupplier.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="cursor-pointer justify-center text-xs text-muted-foreground"
                  onSelect={(event) => {
                    event.preventDefault();
                    setSelectedSupplier([]);
                  }}
                >
                  Clear suppliers
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-filters">
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
