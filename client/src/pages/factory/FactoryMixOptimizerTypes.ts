// Extracted from ./FactoryMixOptimizer.tsx

export interface MaterialRow {
  supplierId: string;
  kgAvailable: number;
  costPerKg: number;
}

export interface OptimizeSuggestion {
  sources: { supplier: string; kgRatio: number }[];
  expectedCostPerBale: number;
  expectedProfit: number;
  historicalWastePercent: number;
}

export interface BaleProduct {
  id: number;
  name: string;
}

export interface Supplier {
  id: number;
  name: string;
}
