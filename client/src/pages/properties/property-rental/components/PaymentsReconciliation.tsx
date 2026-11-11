import { useEffect } from "react";
import {
  useRentalReconciliation,
  type ReconciliationSnapshot,
  type ReconciliationPayment,
} from "@/properties/hooks/useRentalReconciliation";

// Preserve old type imports for both rental pages without modifying their callers.
export type { ReconciliationSnapshot, ReconciliationPayment };

/** Compatibility adapter: reconciliation is a pure read-model hook, not a dashboard. */
export function PaymentsReconciliation({
  payments,
  companyId: scopedCompanyId,
  isLoading,
  isError = false,
  onReconciliationChange,
}: {
  payments: ReconciliationPayment[];
  companyId: number | undefined;
  isLoading: boolean;
  isError?: boolean;
  onReconciliationChange?: (snapshot: ReconciliationSnapshot) => void;
}) {
  const {
    companyId,
    loading,
    verified,
    accountSum,
    aliCashLedgerId,
    cashboxLedgerId,
    rentAndCashBalance,
    depositBalance,
    guaranteeCashOverlap,
    recorded,
    netAdjustment,
    reconciled,
    difference,
  } = useRentalReconciliation({ payments, companyId: scopedCompanyId, isLoading, isError });

  useEffect(() => {
    onReconciliationChange?.({
      companyId,
      loading,
      verified,
      accountSum,
      aliCashLedgerId,
      cashboxLedgerId,
      rentAndCashBalance,
      depositBalance,
      guaranteeCashOverlap,
      recorded,
      netAdjustment,
      reconciled,
      difference,
    });
  }, [
    onReconciliationChange,
    companyId,
    loading,
    verified,
    accountSum,
    aliCashLedgerId,
    cashboxLedgerId,
    rentAndCashBalance,
    depositBalance,
    guaranteeCashOverlap,
    recorded,
    netAdjustment,
    reconciled,
    difference,
  ]);

  return null;
}
