// Extracted from ./useFactoryContainerLoadingScanModelPart3.ts
import { useCallback } from "react";
import { OPEN_ORDER_STATUSES } from "./types";
import { downloadBaleImportTemplate } from "./loadedBales";
import { useFactoryContainerLoadingScanModelPart1 } from "./useFactoryContainerLoadingScanModelPart1";
import { useFactoryContainerLoadingScanModelPart2 } from "./useFactoryContainerLoadingScanModelPart2";

export function useFactoryContainerLoadingScanModelPart4({
  canCreateLoading,
  chosenProforma,
  createOrderMutation,
  customerId,
  loadingNote,
  orderDate,
  selectedLocationId,
  setPendingOrders,
  setShowPendingWarning,
}: Pick<
  Pick<
    Awaited<ReturnType<typeof useFactoryContainerLoadingScanModelPart1>> &
      Awaited<ReturnType<typeof useFactoryContainerLoadingScanModelPart2>>,
    | "addBaleMutation"
    | "bulkImportMutation"
    | "canCreateLoading"
    | "chosenProforma"
    | "createOrderMutation"
    | "customerId"
    | "ignoreProformaRef"
    | "importMode"
    | "importPreview"
    | "importRefNumbers"
    | "loadingNote"
    | "orderDate"
    | "orderDetail"
    | "orderId"
    | "pendingBypassBaleRef"
    | "pendingBypassOverloadRef"
    | "proformaCapacity"
    | "proformas"
    | "recordChanges"
    | "scanCode"
    | "scanFlash"
    | "scanSubmissionInFlightRef"
    | "selectedLocationId"
    | "setExpandedGroups"
    | "setImportMode"
    | "setImportPreview"
    | "setImportRefNumbers"
    | "setPendingBypassBaleRef"
    | "setPendingBypassOverloadRef"
    | "setPendingOrders"
    | "setShowImportDialog"
    | "setShowPendingWarning"
    | "toast"
  >,
  | "canCreateLoading"
  | "chosenProforma"
  | "createOrderMutation"
  | "customerId"
  | "loadingNote"
  | "orderDate"
  | "selectedLocationId"
  | "setPendingOrders"
  | "setShowPendingWarning"
>) {
  const handleStartLoading = useCallback(async () => {
    if (!customerId || !selectedLocationId || !canCreateLoading) return;
    const proforma = chosenProforma();

    // A reusable proforma is a per-loading reference. Aggregate quantities from
    // older/sibling loadings must never prevent creation of a fresh loading.
    if (proforma) {
      try {
        const res = await fetch(`/api/factory/customer-orders?customerId=${customerId}&proformaId=${proforma.id}`, {
          credentials: "include",
        });
        if (res.ok) {
          const allOrders = await res.json();
          const pending = allOrders.filter((o: { status: string }) => OPEN_ORDER_STATUSES.includes(o.status));
          if (pending.length > 0) {
            setPendingOrders(pending);
            setShowPendingWarning(true);
            return;
          }
        }
      } catch {
        // If check fails, proceed with creation anyway
      }
    }

    createOrderMutation.mutate({
      customerId,
      proformaIdUsed: proforma?.id || null,
      locationId: parseInt(selectedLocationId),
      orderDate,
      containerNotes: loadingNote.trim() || undefined,
    });
  }, [
    customerId,
    selectedLocationId,
    chosenProforma,
    orderDate,
    loadingNote,
    createOrderMutation,
    canCreateLoading,
    setPendingOrders,
    setShowPendingWarning,
  ]);

  /** Create a separate loading from the pending-orders warning. */
  const startNewLoadingAnyway = () => {
    setShowPendingWarning(false);
    if (!canCreateLoading) return;
    const proforma = chosenProforma();
    createOrderMutation.mutate({
      customerId: customerId!,
      proformaIdUsed: proforma?.id || null,
      locationId: parseInt(selectedLocationId),
      orderDate,
      containerNotes: loadingNote.trim() || undefined,
    });
  };

  const downloadTemplate = useCallback((mode: "ref" | "articleCode") => downloadBaleImportTemplate(mode), []);
  return { handleStartLoading, startNewLoadingAnyway, downloadTemplate };
}
