/**
 * Types for the PostOffloadDialog page.
 *
 * Extracted from PostOffloadDialog.tsx during the Phase 4 god-file split.
 */
import type { ContainerWithSupplier } from ".././otwHelpers";
import type { ApiListRow } from "@shared/apiTypes";

export type PostOffloadCharge = {
  id: string;
  description: string;
  amount: string;
  currencyCode: string;
  ledgerAccountId: string;
  supplierId: string;
};

export type HistoryRow = {
  id: number;
  description: string;
  amount: string;
  currencyCode: string;
  fxRateToUsd: string;
  fxRateConfirmed: boolean;
  fxRateDate: string | null;
  ledgerAccountId: number | null;
  supplierId: number | null;
  voucherId: number | null;
  daybookEntryId: number | null;
  supplierLockedRateBefore: string | null;
  supplierLockedRateAfter: string | null;
  supplierRemainingKgAtApply: string | null;
  fullContainerValueDeltaUsd: string | null;
  supplierInventoryValueDeltaUsd: string | null;
  remainingFractionAtApply: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type MutationResult = {
  message: string;
  containerId?: number;
  chargeId?: number;
  action?: string;
  oldContainerCostPerKgUsd: number;
  newContainerCostPerKgUsd: number;
  supplierLockedRateBefore?: string | null;
  supplierLockedRateAfter?: string | null;
  supplierLockedRateOldExact?: string | null;
  supplierLockedRateNewExact?: string | null;
  supplierRemainingKg?: number;
  containerReceivedKg?: number;
  containerRemainingKg?: number;
  remainingFraction?: number | string;
  fullContainerValueDeltaUsd?: string;
  supplierInventoryValueDeltaUsd?: string;
  supplierValueBeforeUsd?: string | null;
  supplierValueAfterUsd?: string | null;
  rawStockRateWasStale?: boolean;
  affectedBatches: {
    batchId: number;
    batchCode: string;
    status: string | null;
    wasCompleted: boolean;
    weightKgFromContainer: number;
    oldCostPerKg: number;
    newCostPerKg: number;
  }[];
  affectedBalesCount: number;
  rawStockRowsUpdated?: number;
};

export interface PostOffloadDialogProps {
  container: ContainerWithSupplier | null;
  ledgerAccounts: ApiListRow[];
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
