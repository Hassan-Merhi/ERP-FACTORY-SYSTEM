// Extracted from ./FactoryPriorityScan.tsx to keep that module under the source-size cap.
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PRIORITY_SCAN_HISTORY_URL } from "./priorityScanHistory";
import {
  PENDING_LOADS_URL,
  PRIORITY_SCAN_CONFIGS_URL,
  type PriorityScanAdvanceResult,
  type PriorityScanAllocation,
  type PriorityScanRequestError,
} from "./FactoryPriorityScanTypes";
import { useFactoryPriorityScanStatePart1 } from "./useFactoryPriorityScanStatePart1";

export function useFactoryPriorityScanState() {
  const {
    recordChanges,
    tr,
    inputRef,
    scanSubmissionInFlightRef,
    scanInput,
    setScanInput,
    scanning,
    setScanning,
    feedback,
    historyView,
    setHistoryView,
    configsLoading,
    loadsLoading,
    sessionScans,
    condensedSessionScans,
    activeQueue,
    currentPriorityBale,
    showFeedback,
    flashConfirmedRoute,
    focusScanner,
    resolvePriorityRoute,
  } = useFactoryPriorityScanStatePart1();

  const allocatePriorityScan = async (referenceNumber: string): Promise<PriorityScanAllocation> => {
    const maxAttempts = Math.max(3, activeQueue.length + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const route = await resolvePriorityRoute(referenceNumber);
      try {
        const allocationResponse = await apiRequest(
          "POST",
          `/api/factory/customer-orders/${route.target.orderId}/bales`,
          {
            scanCode: route.referenceNumber,
            locationId: route.locationId,
            priorityScan: true,
          }
        );
        const allocation = (await allocationResponse.json()) as {
          priorityScanAdvance?: PriorityScanAdvanceResult | null;
        };
        return {
          ...route,
          advance: allocation.priorityScanAdvance ?? null,
        };
      } catch (error) {
        const requestError = error as PriorityScanRequestError;
        const routeMayHaveChanged =
          requestError.code === "PRIORITY_SCAN_ROUTE_CHANGED" ||
          (requestError.status === 400 && (requestError.overloaded === true || requestError.notInProforma === true));
        if (!routeMayHaveChanged || attempt === maxAttempts - 1) throw error;
      }
    }

    throw new Error(tr("noDestination"));
  };

  const handleScan = async (code = scanInput) => {
    const referenceNumber = code.trim().toUpperCase();
    if (!referenceNumber || scanning || scanSubmissionInFlightRef.current || !recordChanges.allowed) return;

    setScanInput("");

    if (activeQueue.length === 0) {
      showFeedback({
        type: "error",
        referenceNumber,
        message: tr("noActivePriority"),
      });
      focusScanner();
      return;
    }

    scanSubmissionInFlightRef.current = true;
    setScanning(true);
    try {
      const routed = await allocatePriorityScan(referenceNumber);
      flashConfirmedRoute(routed);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [PENDING_LOADS_URL] }),
        queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_CONFIGS_URL] }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-orders", routed.target.orderId],
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/customer-proformas/capacity", routed.target.proformaId],
        }),
        queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-stock-count"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/factory/daily-bale-scans"] }),
        queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_HISTORY_URL] }),
      ]);

      const completedThisLoading = routed.advance?.completedOrderIds.includes(routed.target.orderId) === true;
      const message = completedThisLoading
        ? routed.advance?.activeOrderId
          ? tr("loadingSatisfiedAdvance", {
              orderId: routed.target.orderId,
              nextOrderId: routed.advance.activeOrderId,
            })
          : tr("loadingSatisfiedComplete", { orderId: routed.target.orderId })
        : tr("addedToPriority", {
            priority: routed.target.priority,
            orderId: routed.target.orderId,
          });

      showFeedback({
        type: "success",
        referenceNumber: routed.referenceNumber,
        message,
      });
    } catch (error) {
      const requestError = error as PriorityScanRequestError;

      if (requestError.code === "PRIORITY_SCAN_NOT_REQUIRED") {
        let dailyScanRecorded = true;
        try {
          await apiRequest("POST", "/api/factory/daily-bale-scans", { referenceNumber });
        } catch (dailyError) {
          if ((dailyError as PriorityScanRequestError).status !== 409) {
            dailyScanRecorded = false;
          }
        }

        await queryClient.invalidateQueries({ queryKey: ["/api/factory/daily-bale-scans"] });

        showFeedback({
          type: dailyScanRecorded ? "warn" : "error",
          referenceNumber,
          message: dailyScanRecorded
            ? `${requestError.message} It was still marked as scanned in Daily Scan.`
            : requestError.message,
        });
      } else {
        showFeedback({
          type: /already (?:been )?(?:scanned|loaded|added|in)|reserved for another loading/i.test(
            requestError.message || ""
          )
            ? "duplicate"
            : "error",
          referenceNumber,
          message: error instanceof Error ? error.message : tr("couldNotRoute"),
        });
      }
    } finally {
      scanSubmissionInFlightRef.current = false;
      setScanning(false);
      focusScanner();
    }
  };

  const isLoading = configsLoading || loadsLoading;
  return {
    activeQueue,
    condensedSessionScans,
    currentPriorityBale,
    feedback,
    handleScan,
    historyView,
    inputRef,
    isLoading,
    recordChanges,
    scanInput,
    scanning,
    sessionScans,
    setHistoryView,
    setScanInput,
    tr,
  };
}
