// Extracted from ./CreateMixBatchDialog.tsx to keep that module under the source-size cap.
import type { FactoryMixBatch } from "@shared/schema";

export interface SupplierRawStock {
  supplierName: string;
  supplierId: number | null;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  freeKg?: string;
  costPerKg: string;
  costPerKgUsd?: string;
  valueRemaining: string;
  valueRemainingUsd?: string;
  lastOffloaded: string;
}

/**
 * The supplier's rate is the server-authoritative locked raw-material cost/kg
 * (factorySuppliers.currentRawMaterialCostPerKgUsd), returned as costPerKgUsd by
 * GET /api/factory/raw-stock. It never shifts with usage/remaining kg — deriving
 * it from valueRemainingUsd ÷ freeKg would recompute a number that can drift once
 * charges are edited or stock is partially used. This dialog only ever previews
 * that locked rate; it must never send a client-computed cost back to the server.
 */
export function getSupplierRate(stock: SupplierRawStock): number {
  return parseFloat(stock.costPerKgUsd || "") || parseFloat(stock.costPerKg || "0");
}

export type SourceType = "supplier" | "batch";

export type DialogMode = "new" | "topup";

export interface SourceSelection {
  type: SourceType;
  sourceId: number;
  label: string;
  weightKg: number;
  costPerKg: number;
  totalCost: number;
  availableKg: number;
}

export interface CreateMixBatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (batch: FactoryMixBatch) => void;
}
