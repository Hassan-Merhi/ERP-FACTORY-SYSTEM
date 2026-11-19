// Extracted from ./SalesReportItemsView.tsx
import type { ItemGroup } from "../types";

type ItemColumnId =
  | "qty"
  | "costPrice"
  | "hassanPrice"
  | "pricePerBale"
  | "costProfitBale"
  | "hassanProfitBale"
  | "costProfitTotal"
  | "hassanProfitTotal";

type LocationColor = { dot: string; text: string; badge: string };

export interface SalesReportItemsViewProps {
  itemGroups: ItemGroup[];
  expandedItems: Set<string>;
  toggleItem: (key: string) => void;
  expandedLocations: Set<string>;
  toggleLocation: (key: string) => void;
  locationColorMap: Map<string, LocationColor>;
  multipleLocations: boolean;
  col: (id: ItemColumnId) => boolean;
  plFilter: "all" | "gain" | "loss";
  totalQty: number;
  totalSales: number;
  totalCost: number;
  totalConfiguredCost: number;
  costProfit: number;
  configuredProfit: number;
  formatAmount: (amount: number | string | null | undefined) => string;
}
