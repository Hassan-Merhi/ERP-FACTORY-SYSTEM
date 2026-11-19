// Extracted from ./useChatActions.ts
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ChatResponse,
  VoucherDraft,
  StockAdjustmentDraft,
  StockTransferDraft,
  StockItemDraft,
  PriceUpdateDraft,
  FilePatchDraft,
  PushResult,
  VoucherSearchResult,
  AccountQueryResult,
  VerifyContainerDraft,
  DataQueryResult,
} from "./chatWidgetTypes";

export interface ChatActionsState {
  sessionId: string;
  location: string;
  sessionReadFiles: string[];
  setMessage: (msg: string) => void;
  setLastUsedProvider: (p: string | null) => void;
  setSuggestions: (s: string[]) => void;
  setPendingVoucher: (v: VoucherDraft | null) => void;
  setPendingStockAdj: React.Dispatch<React.SetStateAction<StockAdjustmentDraft | null>>;
  setPendingStockTransfer: React.Dispatch<React.SetStateAction<StockTransferDraft | null>>;
  setPendingStockTransferBatch: (v: StockTransferDraft[] | null) => void;
  setVoucherSearchResults: React.Dispatch<React.SetStateAction<VoucherSearchResult[] | null>>;
  setPendingStockItem: React.Dispatch<React.SetStateAction<StockItemDraft | null>>;
  setPendingPriceUpdate: React.Dispatch<React.SetStateAction<PriceUpdateDraft | null>>;
  setAccountQueryResult: React.Dispatch<React.SetStateAction<AccountQueryResult | null>>;
  setVerifyContainerDraft: React.Dispatch<React.SetStateAction<VerifyContainerDraft | null>>;
  setDataQueryResult: React.Dispatch<React.SetStateAction<DataQueryResult | null>>;
  setPendingFilePatches: (v: FilePatchDraft[]) => void;
  setAppliedPatchFiles: (fn: (prev: Set<string>) => Set<string>) => void;
  setPerFilePushResult: (fn: (prev: Record<string, PushResult>) => Record<string, PushResult>) => void;
  setSessionReadFiles: (fn: (prev: string[]) => string[]) => void;
  refetchHistory: () => void;
  pendingFilePatches: FilePatchDraft[];
  appliedPatchFiles: Set<string>;
}

export function useChatActionsPart1(state: ChatActionsState) {
  const queryClient = useQueryClient();
  const {
    sessionId,
    location,
    sessionReadFiles,
    setMessage,
    setLastUsedProvider,
    setSuggestions,
    setPendingVoucher,
    setPendingStockAdj,
    setPendingStockTransfer,
    setPendingStockTransferBatch,
    setVoucherSearchResults,
    setPendingStockItem,
    setPendingPriceUpdate,
    setAccountQueryResult,
    setVerifyContainerDraft,
    setDataQueryResult,
    setPendingFilePatches,
    setAppliedPatchFiles,
    setPerFilePushResult,
    setSessionReadFiles,
    refetchHistory,
    pendingFilePatches,
    appliedPatchFiles,
  } = state;

  const sendMutation = useMutation({
    mutationFn: async (msg: string) => {
      const response = await apiRequest(
        "POST",
        "/api/chatbot/message",
        {
          message: msg,
          sessionId,
          pageContext: { currentRoute: location },
          sessionReadFiles: sessionReadFiles.length > 0 ? sessionReadFiles : undefined,
        },
        false,
        120000
      );
      return response.json() as Promise<ChatResponse>;
    },
    onSuccess: (data) => {
      refetchHistory();
      setMessage("");
      if (data.provider) setLastUsedProvider(data.provider);
      if (data.suggestions && data.suggestions.length > 0) setSuggestions(data.suggestions);
      if (data.voucherDraft) {
        setPendingVoucher(data.voucherDraft);
        setPendingStockAdj(null);
        setPendingStockTransfer(null);
        setPendingStockTransferBatch(null);
      } else if (data.stockAdjustmentDraft) {
        setPendingStockAdj(data.stockAdjustmentDraft);
        setPendingVoucher(null);
        setPendingStockTransfer(null);
        setPendingStockTransferBatch(null);
      } else if (data.stockTransferDraft) {
        setPendingStockTransfer(data.stockTransferDraft);
        setPendingStockTransferBatch(null);
        setPendingVoucher(null);
        setPendingStockAdj(null);
      } else if (data.stockTransferDrafts && data.stockTransferDrafts.length > 0) {
        setPendingStockTransferBatch(data.stockTransferDrafts);
        setPendingStockTransfer(null);
        setPendingVoucher(null);
        setPendingStockAdj(null);
      } else {
        setPendingStockTransfer(null);
        setPendingStockTransferBatch(null);
      }
      setVoucherSearchResults(
        data.voucherSearchResults && data.voucherSearchResults.length > 0 ? data.voucherSearchResults : null
      );
      setPendingStockItem(data.stockItemDraft ?? null);
      setPendingPriceUpdate(data.priceUpdateDraft ?? null);
      setAccountQueryResult(data.accountQueryResult ?? null);
      setVerifyContainerDraft(data.verifyContainerDraft ?? null);
      setDataQueryResult(data.dataQueryResult ?? null);
      if (data.filePatchDrafts && data.filePatchDrafts.length > 0) {
        setPendingFilePatches(data.filePatchDrafts);
        setAppliedPatchFiles(() => new Set());
        setPerFilePushResult(() => ({}));
      } else {
        setPendingFilePatches([]);
      }
      if (data.readFiles && data.readFiles.length > 0) {
        setSessionReadFiles((prev) => {
          const next = [...prev];
          for (const f of data.readFiles!) {
            if (!next.includes(f)) next.push(f);
          }
          return next;
        });
      }
    },
  });

  const handleConfirmVoucher = async (edited: VoucherDraft) => {
    try {
      const voucherNumber = `AI-${Date.now()}`;
      const body = {
        voucher: {
          voucherNumber,
          voucherType: edited.type,
          voucherDate: edited.date,
          description: edited.description,
          optional: edited.optional ?? false,
        },
        entries: edited.entries.map((e) => ({
          ledgerAccountId: e.accountId,
          debitAmount: String(e.debit || 0),
          creditAmount: String(e.credit || 0),
          narration: edited.description,
        })),
      };
      const res = await apiRequest("POST", "/api/vouchers/with-entries", body);
      const resData = await res.json();
      setPendingVoucher(null);
      apiRequest("POST", "/api/chatbot/log-action", {
        sessionId,
        prompt: edited.description,
        draftJson: edited,
        actionType: "voucher",
        createdRecordId: resData?.id || null,
        status: "confirmed",
      }).catch(() => {});
      sendMutation.mutate(
        `Voucher created: ${edited.type} of $${Math.max(...edited.entries.map((e) => e.debit || e.credit))} on ${edited.date}`
      );
    } catch (err) {
      sendMutation.mutate(`Voucher creation failed: ${getErrorDetails(err).message}`);
    }
  };

  const handleConfirmStockTransfer = async (resolved: StockTransferDraft) => {
    // Defense in depth: even though the confirm button is gated in the UI,
    // never let an incomplete draft (unresolved location candidates, missing/
    // equal source & destination, or no items) reach the confirm API — this
    // is exactly the shape that previously produced a raw "Source and
    // destination locations are required" 400 the assistant couldn't explain.
    const items = resolved.items.filter((i) => (Number(i.quantity) || 0) > 0);
    if (
      resolved.locationCandidates?.length ||
      !(Number(resolved.sourceLocationId) > 0) ||
      !(Number(resolved.destinationLocationId) > 0) ||
      resolved.sourceLocationId === resolved.destinationLocationId ||
      items.length === 0
    ) {
      sendMutation.mutate(
        "This draft is incomplete (missing a resolved source/destination location or item quantities), so I didn't submit it. Please provide the exact source location, destination location, and item(s)/quantities."
      );
      return;
    }
    try {
      // AI-suggested analysis drafts default to optional=true (no inventory movement
      // until approved through the normal stock transfer workflow). Manual/direct
      // drafts (optional undefined) keep prior behavior of creating a real transfer.
      const optional = resolved.optional === true;
      const resp = await fetch("/api/chatbot/confirm-stock-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: resolved.date,
          sourceLocationId: resolved.sourceLocationId,
          destinationLocationId: resolved.destinationLocationId,
          notes: resolved.notes || "",
          items: resolved.items.map((i) => ({ stockItemId: i.stockItemId, quantity: i.quantity })),
          optional,
          analysisSummary: resolved.analysisSummary || undefined,
          analysisDateRange: resolved.analysisDateRange || undefined,
          sessionId,
          prompt: `Transfer stock from ${resolved.sourceLocationName} to ${resolved.destinationLocationName}`,
        }),
        credentials: "include",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || "Transfer failed");
      setPendingStockTransfer(null);
      const voucherRef = data.voucher?.voucherNumber ? ` (voucher ${data.voucher.voucherNumber})` : "";
      sendMutation.mutate(
        optional
          ? `Optional stock transfer draft created from "${resolved.sourceLocationName}" to "${resolved.destinationLocationName}"${voucherRef}. ${resolved.items.length} item(s). Inventory has NOT moved — open Stock Transfers to review and approve/post it.`
          : `Stock transfer created from "${resolved.sourceLocationName}" to "${resolved.destinationLocationName}" on ${resolved.date}. ${resolved.items.length} item(s) transferred.`
      );
    } catch (err) {
      sendMutation.mutate(`Stock transfer failed: ${getErrorDetails(err).message}`);
    }
  };
  return {
    queryClient,
    setPendingStockAdj,
    setPendingStockItem,
    setPendingPriceUpdate,
    setPerFilePushResult,
    setAppliedPatchFiles,
    pendingFilePatches,
    appliedPatchFiles,
    sendMutation,
    handleConfirmVoucher,
    handleConfirmStockTransfer,
  };
}
