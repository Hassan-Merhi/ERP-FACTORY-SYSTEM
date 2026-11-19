import { getErrorDetails } from "@shared/errorUtils";
import { apiRequest } from "@/lib/queryClient";
import { StockAdjustmentDraft, StockItemDraft, PriceUpdateDraft, FilePatchDraft } from "./chatWidgetTypes";
import { useChatActionsPart1, type ChatActionsState } from "./useChatActionsPart1";

export function useChatActions(state: ChatActionsState) {
  const {
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
  } = useChatActionsPart1(state);

  const handleConfirmStockAdj = async (resolved: StockAdjustmentDraft) => {
    try {
      const hasP = resolved.items.some((i) => i.type === "PRODUCE");
      const hasC = resolved.items.some((i) => i.type === "CONSUME");
      const adjType = hasP && hasC ? "Mixed" : hasP ? "Production" : "Consumption";
      const voucherNumber = `AI-${Date.now()}`;
      // One request: the server creates the voucher with its adjustment.
      await apiRequest("POST", "/api/stock-adjustments", {
        voucher: {
          voucherNumber,
          voucherDate: resolved.date,
          description: resolved.notes || `${adjType} voucher`,
          optional: resolved.optional ?? false,
        },
        locationId: resolved.locationId,
        adjustmentType: adjType,
        notes: resolved.notes || "",
        items: resolved.items.map((i) => ({
          stockItemId: i.stockItemId,
          quantity: i.type === "CONSUME" ? -Math.abs(i.quantity) : Math.abs(i.quantity),
          rate: i.rate,
        })),
      });
      setPendingStockAdj(null);
      sendMutation.mutate(
        `Stock adjustment created: ${adjType} voucher on ${resolved.date} at ${resolved.locationName}`
      );
    } catch (err) {
      sendMutation.mutate(`Stock adjustment failed: ${getErrorDetails(err).message}`);
    }
  };

  const handleConfirmStockItem = async (resolved: StockItemDraft) => {
    if (!resolved.stockGroupId) return;
    try {
      await apiRequest("POST", "/api/stock-items", {
        name: resolved.name,
        code: resolved.code,
        uom: resolved.uom,
        stockGroupId: resolved.stockGroupId,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      setPendingStockItem(null);
      sendMutation.mutate(
        `Stock item "${resolved.name}" (${resolved.code}) created successfully in group "${resolved.stockGroupName}".`
      );
    } catch (err) {
      sendMutation.mutate(`Failed to create stock item: ${getErrorDetails(err).message}`);
    }
  };

  const handleConfirmPriceUpdate = async (resolved: PriceUpdateDraft) => {
    if (!resolved.locationId) return;
    try {
      await apiRequest("POST", `/api/stock-items/${resolved.stockItemId}/location-prices`, {
        locationId: resolved.locationId,
        sellingPrice: String(resolved.newPrice),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list-by-masters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/price-list"] });
      setPendingPriceUpdate(null);
      const cascadeNote =
        resolved.followerCount > 0
          ? ` (cascaded to ${resolved.followerCount} follower location${resolved.followerCount !== 1 ? "s" : ""})`
          : "";
      sendMutation.mutate(
        `Price updated: "${resolved.stockItemName}" set to ${resolved.newPrice} for "${resolved.locationName}"${cascadeNote}.`
      );
    } catch (err) {
      sendMutation.mutate(`Failed to update price: ${getErrorDetails(err).message}`);
    }
  };

  const handleApplyPatch = async (patch: FilePatchDraft) => {
    setPerFilePushResult((prev) => ({ ...prev }));
    try {
      const res = await apiRequest("POST", "/api/chatbot/apply-patch", {
        filePath: patch.filePath,
        originalContent: patch.originalContent,
        newContent: patch.newContent,
        description: patch.description,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Apply failed" }));
        sendMutation.mutate(`Failed to apply patch to ${patch.filePath}: ${err.message}`);
        return;
      }
      setAppliedPatchFiles((prev) => new Set([...prev, patch.filePath]));
    } catch (err) {
      sendMutation.mutate(`Failed to apply patch: ${getErrorDetails(err).message}`);
    }
  };

  const handleApplyAllPatches = async () => {
    for (const patch of pendingFilePatches) {
      if (appliedPatchFiles.has(patch.filePath)) continue;
      await handleApplyPatch(patch);
    }
  };

  const handleGitPush = async (filePath: string, commitMsg: string) => {
    setPerFilePushResult((prev) => ({ ...prev, [filePath]: { success: false } }));
    try {
      const res = await apiRequest("POST", "/api/chatbot/git-push", {
        files: [filePath],
        message: commitMsg,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPerFilePushResult((prev) => ({
          ...prev,
          [filePath]: { success: false, error: data.error ?? data.message ?? "Unknown error" },
        }));
        return;
      }
      setPerFilePushResult((prev) => ({
        ...prev,
        [filePath]: { success: true, commitHash: data.commitHash, branch: data.branch },
      }));
    } catch (err) {
      setPerFilePushResult((prev) => ({
        ...prev,
        [filePath]: { success: false, error: getErrorDetails(err).message },
      }));
    }
  };

  return {
    sendMutation,
    handleConfirmVoucher,
    handleConfirmStockTransfer,
    handleConfirmStockAdj,
    handleConfirmStockItem,
    handleConfirmPriceUpdate,
    handleApplyPatch,
    handleApplyAllPatches,
    handleGitPush,
  };
}
