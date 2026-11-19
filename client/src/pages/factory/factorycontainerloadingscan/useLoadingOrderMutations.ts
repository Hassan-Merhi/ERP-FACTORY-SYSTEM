/**
 * Order-maintenance mutations for the factory container loading scan model:
 * bale removal, emptying the container, Excel bulk import, finalize, and the
 * loading note. Extracted verbatim from useFactoryContainerLoadingScanModel;
 * the hooks run in the same order at the same call site.
 */
import { useMutation } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import type { LoadingOrderMutationsInput } from "./useLoadingOrderMutationsTypes";
export type { LoadingOrderMutationsInput } from "./useLoadingOrderMutationsTypes";

export function useLoadingOrderMutations({
  orderId,
  selectedLocationId,
  capacityProformaId,
  modeApiRequest,
  toast,
  tr,
  navigate,
  refreshSharedLoadingQueues,
  scannerRef,
  ignoreProformaRef,
  setBaleToDelete,
  setShowEmptyContainerConfirm,
  setLastScannedRef,
  setShowLastScannedPopup,
  setPendingBypassBaleRef,
  setPendingBypassOverloadRef,
  setExpandedGroups,
  setScanCode,
  setShowImportDialog,
  setImportPreview,
  setImportRefNumbers,
  setOrderId,
  setIsResuming,
  setLoadingNote,
  setShowFinalizeDialog,
}: LoadingOrderMutationsInput) {
  // Every mutation here changes an existing loading; read-only roles never run them.
  const recordChanges = useExistingRecordChangeAccess();
  const assertCanChange = () => {
    if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
  };
  const removeBaleMutation = useMutation({
    mutationFn: async (baleId: number) => {
      assertCanChange();
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/bales/${baleId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/customer-orders", orderId], exact: true, refetchType: "active" },
        { cancelRefetch: false }
      );
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/customer-orders", orderId, "bale-removals"],
      });
      refreshSharedLoadingQueues();
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/bale-stock-count"],
        refetchType: "active",
      });
      if (capacityProformaId) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],
          refetchType: "active",
        });
      }
      setBaleToDelete(null);
      toast({ title: "Bale removed" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Remove failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const emptyContainerMutation = useMutation({
    mutationFn: async () => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales/empty`, {});
      return (await res.json()) as { removed: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/customer-orders", orderId], exact: true, refetchType: "active" },
        { cancelRefetch: false }
      );
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/customer-orders", orderId, "bale-removals"],
      });
      refreshSharedLoadingQueues();
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/bale-stock-count"],
        refetchType: "active",
      });
      if (capacityProformaId) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],
          refetchType: "active",
        });
      }

      setShowEmptyContainerConfirm(false);
      setLastScannedRef(null);
      setShowLastScannedPopup(false);
      setPendingBypassBaleRef(null);
      setPendingBypassOverloadRef(null);
      setExpandedGroups(new Set());
      setScanCode("");

      toast({
        title: tr("containerEmptied"),
        description: data.removed === 1 ? tr("oneBaleReturned") : tr("manyBalesReturned", { count: data.removed }),
      });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: tr("couldNotEmptyContainer"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async (
      payload:
        | { mode: "articleCode"; items: Array<{ articleCode: string; qty: number }> }
        | { mode: "refNumber"; refNumbers: string[] }
    ) => {
      assertCanChange();
      const body =
        payload.mode === "refNumber"
          ? {
              locationId: parseInt(selectedLocationId),
              refNumbers: payload.refNumbers,
              allowBypassProforma: ignoreProformaRef.current || undefined,
            }
          : {
              locationId: parseInt(selectedLocationId),
              items: payload.items,
              allowBypassProforma: ignoreProformaRef.current || undefined,
            };
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales/bulk-import`, body);
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(
        { queryKey: ["/api/factory/customer-orders", orderId], exact: true, refetchType: "active" },
        { cancelRefetch: false }
      );
      refreshSharedLoadingQueues();
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/bale-stock-count"],
        refetchType: "active",
      });
      if (capacityProformaId) {
        void queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", capacityProformaId],
          refetchType: "active",
        });
      }
      setShowImportDialog(false);
      setImportPreview([]);
      setImportRefNumbers([]);
      const notFoundMsgs = (data.notFound || []).map(
        (n: { articleCode: string; requestedQty: number; foundQty: number }) =>
          `${n.articleCode}: requested ${n.requestedQty}, found ${n.foundQty}`
      );
      const notFoundRefMsgs =
        (data.notFoundRefs || []).length > 0 ? `Not found: ${(data.notFoundRefs as string[]).join(", ")}` : undefined;
      toast({
        title: `Import complete — ${data.added} bale${data.added === 1 ? "" : "s"} added`,
        description: notFoundMsgs.length > 0 ? `Short: ${notFoundMsgs.join(", ")}` : notFoundRefMsgs,
      });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (variables: {
      txDate?: string;
      overrideLoadingDate?: boolean;
      createCarryoverProforma?: boolean;
      createNextLoading?: boolean;
    }) => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize-loading`, variables);
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(
        { predicate: keyStartsWith("/api/factory/customer-orders"), refetchType: "active" },
        { cancelRefetch: false }
      );
      const nextLoading = data?.nextLoading as { id: number; remainingBales: number } | undefined;
      if (nextLoading?.id) {
        // The next order is empty. Do not carry the previous container's
        // note, last-scanned reference, scanner input, or bypass state into it.
        setOrderId(nextLoading.id);
        setIsResuming(true);
        setLoadingNote("");
        setScanCode("");
        setLastScannedRef(null);
        setPendingBypassBaleRef(null);
        setPendingBypassOverloadRef(null);
        setShowFinalizeDialog(false);
        toast({
          title: "Loading finalized — new loading opened",
          description: `Loading #${nextLoading.id} is ready with only ${nextLoading.remainingBales} remaining bales.`,
        });
        navigate(`/factory/sales/loading/new?orderId=${nextLoading.id}`);
        return;
      }
      const carriedOverProforma = data?.carriedOverProforma;
      toast({
        title: "Loading finalized",
        description: carriedOverProforma
          ? `Loading sent for verification. Proforma "${carriedOverProforma.name}" was created for the remaining quantity.`
          : "Loading has been sent for office verification",
      });
      setShowFinalizeDialog(false);
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: Error) => {
      if (
        orderId &&
        ((error as Error & { code?: string }).code === "DISPATCH_CONSOLIDATION_REQUIRED" ||
          error.message.includes("DISPATCH_CONSOLIDATION_REQUIRED"))
      ) {
        setShowFinalizeDialog(false);
        toast({
          title: "Continue in Dispatch Comparison",
          description:
            "Close and post all trips, reconcile the loading, then finalize one invoice with combined dispatch charges.",
        });
        navigate(`/factory/sales/loading/dispatch/${orderId}/compare`);
        return;
      }
      if ((error as Error & { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Finalize failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const saveNoteMutation = useMutation({
    mutationFn: async (note: string) => {
      assertCanChange();
      await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/loading-note`, { note });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(
        { predicate: keyStartsWith("/api/factory/customer-orders"), refetchType: "active" },
        { cancelRefetch: false }
      );
      toast({ title: "Note saved" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Failed to save note", description: error.message, variant: "destructive" });
    },
  });

  return {
    removeBaleMutation,
    emptyContainerMutation,
    bulkImportMutation,
    finalizeMutation,
    saveNoteMutation,
    canChangeExistingRecords: recordChanges.allowed,
  };
}
