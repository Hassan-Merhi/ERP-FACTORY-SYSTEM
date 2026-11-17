// Extracted from ./useBalesHistoryModel.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import {
  type A4DesignColor,
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  type LabelData,
  prefetchBannersForPrint,
} from "@/lib/labelHtml";
import type { BaleRow } from "./useBalesHistoryModelTypes";
import { useBalesHistoryModelPart1 } from "./useBalesHistoryModelPart1";

export function useBalesHistoryModelPart2({
  editingNameValue,
  modeApiRequest,
  nameInputRef,
  recordChanges,
  selectedIds,
  setAuthError,
  setDesignPickerOpen,
  setEditingNameId,
  setEditingNameValue,
  setImportingNames,
  setPendingReprintLabels,
  setReimporting,
  setRemoveDialogOpen,
  setRepackConfirm,
  setReturnToStockBale,
  setSelectedIds,
  toast,
  updateProductName,
  wrapAdminAction,
}: Pick<
  Awaited<ReturnType<typeof useBalesHistoryModelPart1>>,
  | "editingNameValue"
  | "modeApiRequest"
  | "nameInputRef"
  | "recordChanges"
  | "selectedIds"
  | "setAuthError"
  | "setDesignPickerOpen"
  | "setEditingNameId"
  | "setEditingNameValue"
  | "setImportingNames"
  | "setPendingReprintLabels"
  | "setReimporting"
  | "setRemoveDialogOpen"
  | "setRepackConfirm"
  | "setReturnToStockBale"
  | "setSelectedIds"
  | "toast"
  | "updateProductName"
  | "wrapAdminAction"
>) {
  const returnToStockMutation = useMutation({
    mutationFn: async (baleId: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await modeApiRequest("POST", `/api/factory/bales/${baleId}/return-to-stock`, {});
      if (!res.ok) {
        const err = await res.json();
        throw Object.assign(new Error(err.message || "Failed to return bale to stock"), { isLastBale: err.isLastBale });
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      setReturnToStockBale(null);
      const invoiceMsg = data.invoiceNumber
        ? ` Invoice ${data.invoiceNumber} updated to $${parseFloat(data.newGrandTotal || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
        : "";
      toast({ title: "Bale returned to stock", description: `Bale removed from order.${invoiceMsg}` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Remove failed", description: err.message, variant: "destructive" });
    },
  });

  const repackBale = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("POST", `/api/factory/bales/${id}/repack`, {});
    },
    onSuccess: async (response) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      setRepackConfirm(null);
      const data = await response.json();
      toast({ title: "Bale repacked", description: `New reference: ${data.newRefNum}` });

      const label: LabelData = {
        referenceNumber: data.newBale.referenceNumber || data.newRefNum,
        articleCode: data.newBale.articleCode || data.newBale.category || "",
        pieces: data.newBale.quantity || 1,
        approxWeightKg: data.newBale.weightKg || "0",
        productName: data.newBale.productName || data.newBale.category || "",
      };
      openBrowserReprint([label]);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error repacking bale", description: error.message, variant: "destructive" });
      setRepackConfirm(null);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async ({
      ids,
      supervisorUsername,
      supervisorPassword,
      reason,
    }: {
      ids: number[];
      supervisorUsername: string;
      supervisorPassword: string;
      reason: string;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await modeApiRequest("POST", "/api/factory/stock-entry/remove", {
        baleIds: ids,
        supervisorUsername,
        supervisorPassword,
        reason,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to remove bales");
      }
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      toast({ title: "Bales Removed", description: `${result.removed} bale(s) removed from stock` });
      setSelectedIds(new Set());
      setRemoveDialogOpen(false);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      setAuthError(error.message);
    },
  });

  const bulkUpdateNamesMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/bulk-update-names", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Names updated",
        description: `Updated ${data.updated} bale${data.updated !== 1 ? "s" : ""}, skipped ${data.skipped}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => setImportingNames(false),
  });

  const reimportMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/reimport", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Reimport failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Bales reimported",
        description: `Successfully reimported ${data.imported} bale(s) (${parseFloat(data.totalWeight).toFixed(1)} kg).`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Reimport failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => setReimporting(false),
  });

  const startEditName = (baleId: number, currentName: string) => {
    if (!recordChanges.allowed) return;
    setEditingNameId(baleId);
    setEditingNameValue(currentName);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const saveEditName = (baleId: number) => {
    if (editingNameValue.trim()) {
      wrapAdminAction(
        () => updateProductName.mutate({ id: baleId, name: editingNameValue.trim() }),
        "Update Bale Name"
      );
    } else {
      setEditingNameId(null);
    }
  };

  const toggleSelect = (id: number) => {
    if (!recordChanges.allowed) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (filteredItems: BaleRow[]) => {
    if (!recordChanges.allowed) return;
    const filteredIds = filteredItems.map((r) => r.bale.id);
    const allSelected = filteredIds.every((id: number) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredIds));
    }
  };

  const handleReprint = async (baleRow: BaleRow) => {
    if (!recordChanges.allowed) return;
    const label: LabelData = {
      referenceNumber: baleRow.bale.referenceNumber || baleRow.bale.baleCode,
      articleCode: baleRow.product?.articleCode || baleRow.bale.articleCode || baleRow.bale.category || "",
      pieces: baleRow.bale.quantity || 1,
      approxWeightKg: baleRow.bale.weightKg || "0",
      productName: baleRow.bale.productName || baleRow.product?.name || baleRow.bale.category || "",
    };

    try {
      const response = await modeApiRequest("POST", "/api/bale-label-prints/reprint", { baleId: baleRow.bale.id });
      if (!response.ok) throw new Error("Could not prepare reprint");
      const result = (await response.json()) as {
        priorityAllocation?: { color: string; orderId: number; priority: number } | null;
      };
      if (result.priorityAllocation) {
        label.priorityColor = result.priorityAllocation.color;
        label.priorityOrderId = result.priorityAllocation.orderId;
        label.priorityNumber = result.priorityAllocation.priority;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
    } catch (error) {
      toast({
        title: "Reprint preparation failed",
        description: getErrorDetails(error).message,
        variant: "destructive",
      });
      return;
    }

    if (isZebraMode() && !label.priorityColor) {
      try {
        const zpl = buildZplBatch([label], true);
        await printRawZpl(zpl);
        toast({ title: "Label sent to Zebra printer" });
      } catch (err) {
        toast({
          title: "Zebra print failed — falling back to browser",
          description: getErrorDetails(err).message,
          variant: "destructive",
        });
        openBrowserReprint([label]);
      }
    } else {
      openBrowserReprint([label]);
    }
  };

  const openBrowserReprint = (labels: LabelData[], designColor?: A4DesignColor) => {
    prefetchBannersForPrint();
    const fmt = getPaperFormat();
    if (fmt === "A4" && !designColor) {
      setPendingReprintLabels(labels);
      setDesignPickerOpen(true);
      return;
    }
    const paperHtml = fmt === "A5" ? generateA5LabelsHtml(labels) : generateCombinedLabelsHtml(labels, designColor);
    const stickerHtml = generateStickerLabelsHtml(labels);

    const w1 = window.open("", "_blank", "width=800,height=900");
    if (w1) {
      w1.document.write(paperHtml);
      w1.document.close();
      w1.focus();
      setTimeout(() => w1.print(), 500);
    }

    const w2 = window.open("", "_blank", "width=400,height=600");
    if (w2) {
      w2.document.write(stickerHtml);
      w2.document.close();
      w2.focus();
      const imgs = w2.document.images;
      let loaded = 0;
      const total = imgs.length;
      const tryPrint = () => {
        loaded++;
        if (loaded >= total) setTimeout(() => w2.print(), 300);
      };
      if (total === 0) {
        setTimeout(() => w2.print(), 300);
      } else {
        for (let i = 0; i < total; i++) {
          if (imgs[i].complete) tryPrint();
          else imgs[i].onload = imgs[i].onerror = tryPrint;
        }
      }
    }

    if (!w1 && !w2) {
      toast({ title: "Warning", description: "Please allow pop-ups to print labels", variant: "destructive" });
    }
  };
  return {
    bulkUpdateNamesMutation,
    handleReprint,
    openBrowserReprint,
    reimportMutation,
    removeMutation,
    repackBale,
    returnToStockMutation,
    saveEditName,
    startEditName,
    toggleSelect,
    toggleSelectAll,
  };
}
