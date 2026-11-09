import { useEffect, useRef } from "react";
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
  companyId,
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
  const snapshot = useRentalReconciliation({ payments, companyId, isLoading, isError });
  // Notify only when a reported field changes, always with this render's snapshot.
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;

  useEffect(() => {
    onReconciliationChange?.(latestSnapshot.current);
  }, [
    onReconciliationChange,
    snapshot.companyId,
    snapshot.loading,
    snapshot.verified,
    snapshot.accountSum,
    snapshot.aliCashLedgerId,
    snapshot.cashboxLedgerId,
    snapshot.rentAndCashBalance,
    snapshot.depositBalance,
    snapshot.guaranteeCashOverlap,
    snapshot.recorded,
    snapshot.netAdjustment,
    snapshot.reconciled,
    snapshot.difference,
  ]);

  return null;
}
