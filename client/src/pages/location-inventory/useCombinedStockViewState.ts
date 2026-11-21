// Extracted from ./CombinedStockView.tsx
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import type { CombinedStockViewProps } from "./CombinedStockViewTypes";

export function useCombinedStockViewState({
  allInventoryLocations,
  allLocations,
  categoriesList,
  allStockLocationFilter,
}: Pick<
  CombinedStockViewProps,
  "allInventoryLocations" | "allLocations" | "categoriesList" | "allStockLocationFilter"
>) {
  const mobileCards = useMobileCardTable();
  // Table columns: locations that actually have stock (derived from inventory data)
  const uniqueLocationNames = Array.from(new Map(allInventoryLocations.map((l) => [l.name, l])).values());

  // Dropdown options: full location list so empty locations are still selectable.
  // Falls back to inventory-derived list if allLocations wasn't passed.
  const dropdownLocations =
    allLocations && allLocations.length > 0
      ? [...allLocations].sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      : uniqueLocationNames;
  // Deduplicate categories by id (guard against any API-level duplicates)
  const uniqueCategories = Array.from(new Map(categoriesList.map((c) => [c.id, c])).values());

  // Columns are always deduplicated by name so same-name locations never produce duplicate headers
  const visibleLocations = allStockLocationFilter
    ? uniqueLocationNames.filter((l) => l.name === allStockLocationFilter)
    : uniqueLocationNames;
  return { mobileCards, uniqueLocationNames, dropdownLocations, uniqueCategories, visibleLocations };
}
