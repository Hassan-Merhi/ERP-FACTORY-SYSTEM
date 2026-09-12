import { useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { upsertPosDraftSummary } from "@/api/posApi";
import type { PosAutoSaveState } from "../pos-components/posTypes";

interface PosAutosaveParams {
  autoSaveStateRef: React.MutableRefObject<PosAutoSaveState>;
  autoSaveInProgressRef: React.MutableRefObject<boolean>;
  lastSavedFingerprintRef: React.MutableRefObject<string>;
  setCurrentDraftId: (id: number | null) => void;
  setLastAutosaved: (date: Date | null) => void;
  refetchDrafts?: () => void;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) ? status : null;
}

export function usePosAutosave({
  autoSaveStateRef,
  autoSaveInProgressRef,
  lastSavedFingerprintRef,
  setCurrentDraftId,
  setLastAutosaved,
}: PosAutosaveParams) {
  useEffect(() => {
    let sessionLost = false;
    // A rejected client write is deterministic for the same draft payload. Keep
    // that fingerprint blocked until the operator changes the draft instead of
    // hammering the same denied POST/PATCH every three seconds.
    let blockedFingerprint: string | null = null;
    let retryNotBefore = 0;
    let transientFailureCount = 0;

    const interval = setInterval(async () => {
      if (sessionLost) return;
      const s = autoSaveStateRef.current;
      if (!s.activeLocation) return;
      if (autoSaveInProgressRef.current || s.saveDraftIsPending) return;
      const validItems = s.rows.filter((r) => r.stockItemId && r.quantity > 0 && r.rate > 0);
      if (validItems.length === 0) return;
      const fingerprint = JSON.stringify({
        items: validItems.map((r) => ({ id: r.stockItemId, qty: r.quantity, rate: r.rate })),
        notes: s.notes,
        isCreditSale: s.isCreditSale,
        paymentAccountType: s.paymentAccountType,
        paymentAccountId: s.paymentAccountId,
        selectedCustomerId: s.selectedCustomerId,
      });
      if (fingerprint === lastSavedFingerprintRef.current || fingerprint === blockedFingerprint) return;
      if (Date.now() < retryNotBefore) return;
      autoSaveInProgressRef.current = true;
      try {
        const draftData = {
          locationId: s.activeLocation.id,
          paymentAccountType: s.isCreditSale ? "credit" : s.paymentAccountType,
          paymentAccountId: s.isCreditSale
            ? s.selectedCustomerId
              ? parseInt(s.selectedCustomerId)
              : null
            : s.paymentAccountId
              ? parseInt(s.paymentAccountId)
              : null,
          isCreditSale: s.isCreditSale,
          notes: s.notes,
          items: validItems.map((row) => ({
            stockItemId: row.stockItemId,
            quantity: row.quantity.toString(),
            rate: row.rate.toString(),
            amount: row.amount.toString(),
          })),
        };
        let data;
        if (s.currentDraftId) {
          const res = await apiRequest("PATCH", `/api/pos/drafts/${s.currentDraftId}`, draftData);
          data = await res.json();
        } else {
          const res = await apiRequest("POST", "/api/pos/drafts", draftData);
          data = await res.json();
        }
        if (data?.id) setCurrentDraftId(data.id);
        upsertPosDraftSummary(s.activeLocation.id, data, draftData.items);
        lastSavedFingerprintRef.current = fingerprint;
        blockedFingerprint = null;
        retryNotBefore = 0;
        transientFailureCount = 0;
        setLastAutosaved(new Date());
      } catch (err: unknown) {
        const status = errorStatus(err);
        if (status === 401) {
          sessionLost = true;
        } else if (status !== null && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
          // Permission/validation/not-found failures will not heal on a timer.
          // Retry only after the operator changes the draft fingerprint.
          blockedFingerprint = fingerprint;
        } else {
          // Network, 5xx and explicitly retryable HTTP failures get bounded
          // exponential backoff instead of a fixed three-second retry loop.
          transientFailureCount += 1;
          retryNotBefore = Date.now() + Math.min(60_000, 5_000 * 2 ** (transientFailureCount - 1));
        }
      } finally {
        autoSaveInProgressRef.current = false;
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [autoSaveInProgressRef, autoSaveStateRef, lastSavedFingerprintRef, setCurrentDraftId, setLastAutosaved]);
}
