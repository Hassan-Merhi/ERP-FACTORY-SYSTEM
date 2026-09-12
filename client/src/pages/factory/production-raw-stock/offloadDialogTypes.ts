/**
 * Types for the production raw-stock OffloadDialog.
 *
 * Extracted from OffloadDialog.tsx during the god-file split so the dialog
 * stays under the repository size limit. Type-only module: no runtime code.
 */

export interface OffloadContainer {
  id: number;
  containerNumber?: string | null;
  supplierName?: string | null;
  status?: string | null;
  totalKg?: string | null;
  declaredKg?: string | null;
  actualReceivedKg?: string | null;
  fixedCostPerKgUsd?: string | null;
  currencyCode?: string | null;
  fxRateToUsd?: string | null;
  ratePerKg?: string | null;
  freight?: string | null;
  freightCurrencyCode?: string | null;
  freightAccountId?: number | null;
  freightSupplierId?: number | null;
  freightOwnAccountId?: number | null;
  freightPaidBy?: string | null;
  otherCharges?: string | null;
  otherChargesCurrencyCode?: string | null;
  otherChargesAccountId?: number | null;
  otherChargesSupplierId?: number | null;
  commissionAmount?: string | null;
  commissionCurrencyCode?: string | null;
  commissionSupplierId?: number | null;
  commissionFxRateToUsd?: string | null;
  commissionFxRateConfirmed?: boolean | null;
}

export interface OffloadSupplierOption {
  id: number;
  name: string;
}

export interface OffloadLedgerAccount {
  id: number;
  name: string;
  code?: string;
  accountType?: string;
  subType?: string;
}

export interface AdditionalCharge {
  id: string;
  description: string;
  amount: string;
  currencyCode: string;
  fxRate: string;
  fxRateLoading: boolean;
  ledgerAccountId: string;
}

export interface MixBatchAllocation {
  mixBatchId?: string;
  weightKg?: string;
}

export interface OffloadPayload {
  [key: string]: unknown;
}

export interface OffloadMutationLike {
  isPending: boolean;
  mutate: (payload: OffloadPayload) => void;
}

export interface OffloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableContainers: OffloadContainer[];
  factorySuppliers: OffloadSupplierOption[];
  ledgerAccounts: OffloadLedgerAccount[];
  offloadMutation: OffloadMutationLike;
  wrapAdminAction: (action: () => void, title: string) => void;
  mixBatches: unknown[];
}
