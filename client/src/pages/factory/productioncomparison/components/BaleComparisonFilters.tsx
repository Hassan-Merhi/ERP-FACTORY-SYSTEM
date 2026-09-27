import { Button } from "@/components/ui/button";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { Input } from "@/components/ui/input";
import { MultiSelectFilter, type MultiSelectOption } from "./MultiSelectFilter";

interface BaleComparisonFiltersProps {
  categories: MultiSelectOption[];
  grades: MultiSelectOption[];
  workerOptions: MultiSelectOption[];
  filterCategories: string[];
  setFilterCategories: (value: string[]) => void;
  filterGrades: string[];
  setFilterGrades: (value: string[]) => void;
  filterWorkers: string[];
  setFilterWorkers: (value: string[]) => void;
  filterProduct: string;
  setFilterProduct: (value: string) => void;
  shownCount: number;
  totalCount: number;
}

/**
 * Bale comparison filters. Tablet/desktop keep the single wrapping row; phones keep the product
 * search visible and open categories, grades and workers in the filter sheet.
 */
export function BaleComparisonFilters(props: BaleComparisonFiltersProps) {
  const { filterCategories, filterGrades, filterWorkers, filterProduct } = props;
  const sheetCount =
    (filterCategories.length > 0 ? 1 : 0) + (filterGrades.length > 0 ? 1 : 0) + (filterWorkers.length > 0 ? 1 : 0);
  const hasActiveFilter = sheetCount > 0 || filterProduct !== "";
  const clear = () => {
    props.setFilterCategories([]);
    props.setFilterGrades([]);
    props.setFilterProduct("");
    props.setFilterWorkers([]);
  };

  const search = (
    <Input
      placeholder="Search product…"
      className="w-full sm:w-52"
      value={filterProduct}
      onChange={(e) => props.setFilterProduct(e.target.value)}
    />
  );
  const selects = (
    <>
      <MultiSelectFilter
        options={props.categories}
        selected={filterCategories}
        onChange={props.setFilterCategories}
        placeholder="Categories"
        allLabel="All Categories"
        className="w-full sm:w-48"
      />
      <MultiSelectFilter
        options={props.grades}
        selected={filterGrades}
        onChange={props.setFilterGrades}
        placeholder="Grades"
        allLabel="All Grades"
        className="w-full sm:w-36"
      />
      <MultiSelectFilter
        options={props.workerOptions}
        selected={filterWorkers}
        onChange={props.setFilterWorkers}
        placeholder="Workers"
        allLabel="All Workers"
        className="w-full sm:w-44"
      />
    </>
  );
  const count = hasActiveFilter && (
    <span className="text-xs text-muted-foreground">
      {props.shownCount} of {props.totalCount} products
    </span>
  );

  return (
    <div className="space-y-2">
      <ErpMobileFilters
        label="Production comparison filters"
        quick={search}
        activeCount={sheetCount}
        onClear={clear}
        canClear={hasActiveFilter}
        data-testid="production-comparison-filters"
      >
        {(layout) =>
          layout === "sheet" ? (
            selects
          ) : (
            <div className="flex flex-wrap gap-3 items-center">
              {selects}
              {search}
              {hasActiveFilter && (
                <Button variant="ghost" size="sm" onClick={clear}>
                  Clear filters
                </Button>
              )}
              {count}
            </div>
          )
        }
      </ErpMobileFilters>
      {/* The filtered-count summary stays visible on phones, where the row above is a sheet. */}
      <div className="sm:hidden">{count}</div>
    </div>
  );
}
