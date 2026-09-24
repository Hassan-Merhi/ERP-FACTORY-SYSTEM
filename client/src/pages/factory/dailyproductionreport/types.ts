/**
 * Types for the DailyProductionReport page.
 *
 * Extracted from DailyProductionReport.tsx during the Phase 4 god-file split.
 */

export type Preset = "today" | "yesterday" | "week" | "month" | "lastmonth" | "year" | "alltime" | "custom";

export interface ReportData {
  from: string | null;
  to: string | null;
  costsHidden?: boolean;
  summary: {
    batchCost: number;
    productionValue: number;
    statusValue: number;
  };
  production: {
    totalBales: number;
    totalWeightKg: number;
    totalValue: number;
    byProduct: {
      articleCode: string;
      productName: string;
      categoryName: string;
      qty: number;
      totalWeightKg: number;
      costPricePerBale: number;
      totalValue: number;
    }[];
    byCategory: {
      categoryName: string;
      qty: number;
      totalWeightKg: number;
      totalValue: number;
    }[];
  };
  wipersGarbage: {
    totalWipersQty: number;
    totalWipersKg: number;
    totalGarbageQty: number;
    totalGarbageKg: number;
    totalWeightKg: number;
    totalValue: number;
    rows: {
      categoryName: string;
      subType: "wiper" | "garbage" | "other";
      qty: number;
      totalWeightKg: number;
      totalValue: number;
    }[];
  };
  rawMaterial: {
    totalBatches: number;
    totalWeightKg: number;
    totalCost: number;
    blendedCostPerKg: number;
    batches: {
      id: number;
      batchCode: string;
      name: string | null;
      totalWeightKg: string;
      costPerKg: string;
      totalCost: string;
      batchDate: string | null;
      createdAt: string;
    }[];
  };
  balanceOnTable: {
    weightKg: number;
    costPerKg: number;
    value: number;
  };
  kgComparison: {
    producedKg: number;
    mixedKg: number;
    diffKg: number;
    diffLabel: string;
  };
}

export interface BaleDetail {
  id: number;
  ref: string;
  weightKg: number;
  totalCost: number;
}

export interface BucketRow {
  productId: number | null;
  productName: string;
  articleCode: string;
  categoryName: string;
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
  baleDetails: BaleDetail[];
}

export interface SectionTotal {
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
}

export interface LedgerData {
  currentStock: BucketRow[];
  wasteStock: BucketRow[];
  sold: BucketRow[];
  wasteDispatched: BucketRow[];
  pendingLoading: BucketRow[];
  totals: {
    currentStock: SectionTotal;
    wasteStock: SectionTotal;
    sold: SectionTotal;
    wasteDispatched: SectionTotal;
    pendingLoading: SectionTotal;
    grand: SectionTotal;
  };
}

export interface LedgerSectionProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  badgeColor: string;
  rows: BucketRow[];
  total: SectionTotal;
  defaultOpen?: boolean;
  showSoldPrice?: boolean;
}
