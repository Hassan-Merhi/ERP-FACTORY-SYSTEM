// Extracted from ./useFactoryContainerLoadingScanModel.ts to keep that module under the source-size cap.
import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { translateCameraScanMessage } from "@/i18n/mobileCameraScanTranslations";
import { queryClient } from "@/lib/queryClient";
import { applyCurrentOrderBalesToCapacity, type ProformaCapacitySnapshot } from "@/lib/proformaCapacity";
import type { AddLoadingBaleInput, AddLoadingBaleResponse, CreateLoadingOrderResponse, OrderDetail } from "./types";
import {
  playScanBeep,
  playScanErrorSweep,
  SCAN_NOT_IN_PROFORMA_TONE,
  SCAN_OVERLOAD_TONE,
  SCAN_SUCCESS_TONE,
} from "./scanFeedback";
import { useLoadingOrderMutations } from "./useLoadingOrderMutations";
import { useFactoryContainerLoadingScanModelPart1 } from "./useFactoryContainerLoadingScanModelPart1";

export function useFactoryContainerLoadingScanModelPart2({
  capacityProformaId,
  ignoreProformaRef,
  language,
  modeApiRequest,
  navigate,
  orderId,
  proformas,
  recordChanges,
  refreshSharedLoadingQueues,
  scanSubmissionInFlightRef,
  scannerRef,
  scheduleFlashReset,
  selectedLocationId,
  selectedProformaId,
  setBaleToDelete,
  setCameraScanFeedback,
  setExpandedGroups,
  setImportPreview,
  setImportRefNumbers,
  setIsResuming,
  setLastScannedRef,
  setLoadingNote,
  setOrderId,
  setPendingBypassBaleRef,
  setPendingBypassOverloadRef,
  setScanCode,
  setScanFlash,
  setShowEmptyContainerConfirm,
  setShowFinalizeDialog,
  setShowImportDialog,
  setShowLastScannedPopup,
  setShowScanErrorPopup,
  setShowScanSuccessPopup,
  toast,
  tr,
}: Pick<
  Awaited<ReturnType<typeof useFactoryContainerLoadingScanModelPart1>>,
  | "capacityProformaId"
  | "ignoreProformaRef"
  | "language"
  | "modeApiRequest"
  | "navigate"
  | "orderId"
  | "proformas"
  | "recordChanges"
  | "refreshSharedLoadingQueues"
  | "scanSubmissionInFlightRef"
  | "scannerRef"
  | "scheduleFlashReset"
  | "selectedLocationId"
  | "selectedProformaId"
  | "setBaleToDelete"
  | "setCameraScanFeedback"
  | "setExpandedGroups"
  | "setImportPreview"
  | "setImportRefNumbers"
  | "setIsResuming"
  | "setLastScannedRef"
  | "setLoadingNote"
  | "setOrderId"
  | "setPendingBypassBaleRef"
  | "setPendingBypassOverloadRef"
  | "setScanCode"
  | "setScanFlash"
  | "setShowEmptyContainerConfirm"
  | "setShowFinalizeDialog"
  | "setShowImportDialog"
  | "setShowLastScannedPopup"
  | "setShowScanErrorPopup"
  | "setShowScanSuccessPopup"
  | "toast"
  | "tr"
>) {
  const createOrderMutation = useMutation({
    mutationFn: async (data: {
      customerId: number;
      proformaIdUsed: number | null;
      locationId: number;
      orderDate: string;
      containerNotes?: string;
    }) => {
      const res = await modeApiRequest("POST", "/api/factory/customer-orders-loading", data);
      return await res.json();
    },
    onSuccess: (data: CreateLoadingOrderResponse) => {
      setOrderId(data.id);
      setIsResuming(false);
      // Canonicalize the newly-created loading in the URL. This prevents a
      // refresh or same-route navigation from snapping back to an older order.
      navigate(`/factory/sales/loading/new?orderId=${data.id}`);
      toast({
        title: "Loading order created",
        description: `Loading #${data.id} is separate and ready for scanning`,
      });
      setTimeout(() => scannerRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const addBaleMutation = useMutation({
    mutationFn: async (data: {
      scanCode: string;
      locationId: number;
      allowBypassProforma?: boolean;
      allowBypassOverload?: boolean;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales`, data);
      return await res.json();
    },
    onSuccess: (data: AddLoadingBaleResponse, variables: AddLoadingBaleInput) => {
      setPendingBypassBaleRef(null);
      setPendingBypassOverloadRef(null);
      setScanFlash("success");
      setShowScanSuccessPopup(true);
      setCameraScanFeedback({
        type: "success",
        referenceNumber: variables.scanCode,
        message: translateCameraScanMessage("loadingSuccess", language),
      });
      playScanBeep(SCAN_SUCCESS_TONE.frequency, SCAN_SUCCESS_TONE.durationMs);
      scheduleFlashReset(() => {
        setScanFlash(null);
        setShowScanSuccessPopup(false);
      }, 500);
      if (orderId) {
        const scanned = variables.scanCode;
        const newestForRef = [...(data?.bales || [])].sort((a, b) => b.id - a.id)[0];
        const lastScanned = {
          baleReference: newestForRef?.baleReference || scanned,
          baleName: newestForRef?.baleName || "",
          articleCode: newestForRef?.articleCode || "",
        };
        setLastScannedRef(lastScanned);
      }
      const newest = [...(data?.bales || [])].sort((a, b) => b.id - a.id)[0];
      if (newest?.articleCode) {
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          next.add(newest.articleCode);
          return next;
        });
      }
      queryClient.setQueryData<OrderDetail>(["/api/factory/customer-orders", orderId], data);
      refreshSharedLoadingQueues();
      void queryClient.invalidateQueries({
        queryKey: ["/api/factory/bale-stock-count"],
        refetchType: "active",
      });
      if (capacityProformaId) {
        queryClient.setQueryData<ProformaCapacitySnapshot>(
          ["/api/factory/customer-proformas/capacity", capacityProformaId, orderId],
          (current) => applyCurrentOrderBalesToCapacity(current, data.bales) ?? current
        );
      }
      setScanCode("");
    },
    onError: (error: Error, variables: AddLoadingBaleInput) => {
      const handledGlobally = (error as { _handledGlobally?: boolean })?._handledGlobally === true;
      // Overload and not-in-proforma are soft rejections: arm a bypass so the
      // same code scanned a second time goes through.
      if ((error as unknown as Error & { overloaded: unknown }).overloaded) {
        setPendingBypassOverloadRef(variables.scanCode);
        setPendingBypassBaleRef(null);
        setCameraScanFeedback({
          type: "warn",
          referenceNumber: variables.scanCode,
          message: translateCameraScanMessage("overload", language),
        });
        setScanFlash("error");
        playScanBeep(SCAN_OVERLOAD_TONE.frequency, SCAN_OVERLOAD_TONE.durationMs);
        scheduleFlashReset(() => setScanFlash(null), 600);
        setScanCode("");
        return;
      }
      if ((error as unknown as Error & { notInProforma: unknown }).notInProforma) {
        setPendingBypassBaleRef(variables.scanCode);
        setPendingBypassOverloadRef(null);
        setCameraScanFeedback({
          type: "warn",
          referenceNumber: variables.scanCode,
          message: translateCameraScanMessage("notRequested", language),
        });
        setScanFlash("error");
        playScanBeep(SCAN_NOT_IN_PROFORMA_TONE.frequency, SCAN_NOT_IN_PROFORMA_TONE.durationMs);
        scheduleFlashReset(() => setScanFlash(null), 600);
        setScanCode("");
        return;
      }
      setScanFlash("error");
      setShowScanErrorPopup(true);
      setCameraScanFeedback({
        type: /already (?:been )?(?:scanned|loaded|added|in)|reserved for another loading/i.test(error.message)
          ? "duplicate"
          : "error",
        referenceNumber: variables.scanCode,
        message: error.message || translateCameraScanMessage("unableToAdd", language),
      });
      playScanErrorSweep();
      scheduleFlashReset(() => {
        setScanFlash(null);
        setShowScanErrorPopup(false);
      }, 1500);
      if (!handledGlobally) {
        toast({
          title: "Scan Error",
          description: error.message,
          variant: "destructive",
        });
      }
      setScanCode("");
    },
    onSettled: () => {
      scanSubmissionInFlightRef.current = false;
    },
  });

  // Restore focus to the scan input whenever the mutation finishes (success or error).
  // Using a useEffect keyed on isPending is more reliable than setTimeout because
  // it fires after React re-enables the input (disabled={isPending}), so focus
  // is never called on a disabled element.
  const wasPending = useRef(false);
  useEffect(() => {
    const justFinished = wasPending.current && !addBaleMutation.isPending;
    wasPending.current = addBaleMutation.isPending;
    if (justFinished && scannerRef.current) {
      scannerRef.current.focus();
    }
  }, [addBaleMutation.isPending, scannerRef]);

  const {
    removeBaleMutation,
    emptyContainerMutation,
    bulkImportMutation,
    finalizeMutation,
    saveNoteMutation,
    canChangeExistingRecords,
  } = useLoadingOrderMutations({
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
  });

  const chosenProforma = useCallback(
    () =>
      selectedProformaId && selectedProformaId !== "none"
        ? proformas.find((p) => p.id === parseInt(selectedProformaId)) || null
        : null,
    [selectedProformaId, proformas]
  );
  return {
    addBaleMutation,
    bulkImportMutation,
    canChangeExistingRecords,
    chosenProforma,
    createOrderMutation,
    emptyContainerMutation,
    finalizeMutation,
    removeBaleMutation,
    saveNoteMutation,
  };
}
