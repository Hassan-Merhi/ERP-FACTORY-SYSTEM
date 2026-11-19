// Extracted from ./CombinedStockView.tsx
import type { AuthMe } from "@shared/apiTypes";
import type {
  CombinedStockRow,
  InventoryGroupOption,
  InventoryItem,
  InventoryLocation,
  InventoryLocationOption,
} from "./locationInventoryTypes";

type StockCategory = { id: number; name: string; active: boolean };

export interface CombinedStockViewProps {
  allInventoryLoading: boolean;
  filteredCombinedRows: CombinedStockRow[];
  allInventoryData: InventoryItem[];
  allInventoryLocations: InventoryLocationOption[];
  allInventoryGroups: InventoryGroupOption[];
  /** Full location list from /api/locations — used for the dropdown so empty locations are still visible */
  allLocations?: InventoryLocation[];
  categoriesList: StockCategory[];
  allStockSearchTerm: string;
  setAllStockSearchTerm: (s: string) => void;
  allStockGroupFilter: string;
  setAllStockGroupFilter: (s: string) => void;
  allStockLocationFilter: string;
  setAllStockLocationFilter: (s: string) => void;
  allStockCategoryFilter: string[];
  setAllStockCategoryFilter: (cats: string[] | ((prev: string[]) => string[])) => void;
  allStockSelectedRowIndex: number;
  openMovement: (locId: number | null, locName: string | null, stockItemId: number, stockItemName: string) => void;
  formatAmount: (amt: number) => string;
  posUser?: AuthMe;
  allStockTableRef: React.RefObject<HTMLDivElement | null>;
}
