// Extracted from ./useStockTransferFormModel.ts to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { format } from "date-fns";
import { queryClient } from "@/lib/queryClient";
import { utils, writeFile } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import type { StockTransferFormData } from "../stocktransferform/types";
import type { TransferInventoryItem } from "./useTransferFormDerived";
import type { StockTransferLineItem, TransferRevision } from "./transferFormTypes";
import { computeTransferRevisionDiff } from "./transferRevisionDiff";
import { useStockTransferFormModelPart1 } from "./useStockTransferFormModelPart1";
import { useStockTransferFormModelPart2 } from "./useStockTransferFormModelPart2";

export function useStockTransferFormModelPart3({
  isPOS,
  lastKnownTransferIdRef,
  locations,
  modeApiRequest,
  savingTransferRevisionRef,
  setIsTransferSavingRevision,
  setTransferRevisionDialogOpen,
  setTransferRevisionNote,
  setTransferRevisionsExpanded,
  stockItems,
  stockTransferForm,
  stockTransferMutation,
  stockTransferToEdit,
  toast,
  transferRevisionNote,
  transferRevisions,
  voucherIdToEdit,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferFormModelPart1>> &
    Awaited<ReturnType<typeof useStockTransferFormModelPart2>>,
  | "isPOS"
  | "lastKnownTransferIdRef"
  | "locations"
  | "modeApiRequest"
  | "savingTransferRevisionRef"
  | "setIsTransferSavingRevision"
  | "setTransferRevisionDialogOpen"
  | "setTransferRevisionNote"
  | "setTransferRevisionsExpanded"
  | "stockItems"
  | "stockTransferForm"
  | "stockTransferMutation"
  | "stockTransferToEdit"
  | "toast"
  | "transferRevisionNote"
  | "transferRevisions"
  | "voucherIdToEdit"
>) {
  const computeTransferRevisionItems = () =>
    computeTransferRevisionDiff(
      stockTransferToEdit?.items,
      stockItems,
      locations,
      stockTransferForm.getValues("entries")
    );

  const handleTransferSaveAsRevision = () => {
    if (!voucherIdToEdit || !stockTransferToEdit?.id) return;
    setTransferRevisionDialogOpen(true);
  };

  const confirmTransferSaveAsRevision = async () => {
    const transferId = stockTransferToEdit?.id ?? lastKnownTransferIdRef.current;
    if (!voucherIdToEdit || !transferId) {
      toast({
        title: "Revision Not Saved",
        description: "The saved stock transfer could not be identified. Reload the transfer and try again.",
        variant: "destructive",
      });
      return;
    }
    const revisionItems = computeTransferRevisionItems();
    if (revisionItems.length === 0) {
      toast({
        title: "No Changes",
        description: "No differences found compared to the saved order",
        variant: "destructive",
      });
      setTransferRevisionDialogOpen(false);
      return;
    }
    setIsTransferSavingRevision(true);
    savingTransferRevisionRef.current = true;
    try {
      // POS users are only allowed to submit a pending revision for review.
      // Do not submit the transfer itself first: that update endpoint is
      // intentionally restricted to non-POS users and would reject the
      // revision flow before the pending revision can be saved.
      if (!isPOS) {
        let submitted = false;
        await stockTransferForm.handleSubmit(async (data) => {
          submitted = true;
          await onStockTransferSubmit(data);
        })();
        if (!submitted) return;
      }
      const revisionResponse = await modeApiRequest("POST", `/api/stock-transfers/${transferId}/revisions`, {
        note: transferRevisionNote.trim() || null,
        items: revisionItems,
        optional: isPOS,
      });
      if (!revisionResponse.ok) {
        let message = "The transfer was updated, but its revision record could not be saved.";
        try {
          const body = await revisionResponse.json();
          message = body?.message || body?.error || message;
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
        throw new Error(message);
      }
      const transferRevisionPath = `/api/stock-transfers/${transferId}/revisions`;
      const voucherRevisionPath = `/api/stock-transfers/by-voucher/${voucherIdToEdit}/revisions`;
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["/api/stock-transfers", transferId, "revisions"] }),
        queryClient.refetchQueries({ queryKey: [transferRevisionPath] }),
        queryClient.refetchQueries({ queryKey: [voucherRevisionPath] }),
      ]);
      setTransferRevisionNote("");
      setTransferRevisionDialogOpen(false);
      setTransferRevisionsExpanded(true);
      const refreshedRevisions = queryClient.getQueryData<TransferRevision[]>([
        "/api/stock-transfers",
        transferId,
        "revisions",
      ]);
      const nextRevNum = refreshedRevisions?.length ?? transferRevisions.length + 1;
      toast({ title: "Revision Saved", description: `Rev ${nextRevNum} recorded and transfer updated` });
    } catch (error) {
      toast({
        title: "Revision Not Saved",
        description:
          getErrorDetails(error).optionalMessage ||
          "The transfer was updated, but the revision record failed to save. Please try again.",
        variant: "destructive",
      });
    } finally {
      savingTransferRevisionRef.current = false;
      setIsTransferSavingRevision(false);
    }
  };

  const onStockTransferSubmit = async (data: StockTransferFormData) => {
    if (!data.destinationLocationId || data.destinationLocationId <= 0) {
      toast({ title: "Validation Error", description: "Please select a destination location", variant: "destructive" });
      return;
    }
    const validEntries = data.entries.filter(
      (e) => e.stockItemId > 0 && e.sourceLocationId > 0 && parseFloat(e.quantity || "0") > 0
    );
    if (validEntries.length === 0) {
      toast({
        title: "Validation Error",
        description: "Please add at least one valid entry with source location, item, and quantity",
        variant: "destructive",
      });
      return;
    }
    const entriesWithMissingRates = validEntries.filter((e) => !e.rate || e.rate === "" || e.rate === "0");
    if (entriesWithMissingRates.length > 0) {
      const ratePromises = entriesWithMissingRates.map(async (entry) => {
        try {
          const res = await fetch(`/api/locations/${entry.sourceLocationId}/inventory`);
          if (res.ok) {
            const inventory = await res.json();
            const inv = (inventory as TransferInventoryItem[]).find((item) => item.stockItemId === entry.stockItemId);
            return {
              stockItemId: entry.stockItemId,
              sourceLocationId: entry.sourceLocationId,
              rate: inv?.averageRate || "0",
            };
          }
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
        return { stockItemId: entry.stockItemId, sourceLocationId: entry.sourceLocationId, rate: "0" };
      });
      const fetchedRates = await Promise.all(ratePromises);
      for (const entry of validEntries) {
        if (!entry.rate || entry.rate === "" || entry.rate === "0") {
          const fetched = fetchedRates.find(
            (r) => r.stockItemId === entry.stockItemId && r.sourceLocationId === entry.sourceLocationId
          );
          if (fetched) entry.rate = fetched.rate;
        }
      }
    }
    data.entries = data.entries.filter(
      (e) => !(e.stockItemId > 0 && e.sourceLocationId > 0 && parseFloat(e.quantity) === 0)
    );
    const isEditMode = !!voucherIdToEdit;
    let originalItems: StockTransferLineItem[] = [];
    if (isEditMode && voucherIdToEdit) {
      let st = stockTransferToEdit as ({ items?: StockTransferLineItem[] } & Record<string, unknown>) | undefined;
      if (!st) {
        try {
          const res = await fetch(`/api/stock-transfers?voucherId=${voucherIdToEdit}`);
          if (res.ok) {
            const d = await res.json();
            st = Array.isArray(d) ? d[0] : d;
          }
        } catch {
          // Best-effort side request; the user-visible flow does not depend on it completing.
        }
      }
      if (st?.items) originalItems = st.items;
    }
    void originalItems;
    await stockTransferMutation.mutateAsync(data);
  };

  const handleExportStockTransfer = async (detailed: boolean) => {
    const formData = stockTransferForm.getValues();
    const voucherDate = formData.voucherDate
      ? format(formData.voucherDate, "yyyy-MM-dd")
      : format(new Date(), "yyyy-MM-dd");
    const validEntries = formData.entries.filter((e) => e.stockItemId > 0 && parseFloat(e.quantity) > 0);
    if (validEntries.length === 0) {
      toast({
        title: "No data to export",
        description: "Add at least one entry before exporting.",
        variant: "destructive",
      });
      return;
    }
    const destLoc = locations?.find((l) => l.id === formData.destinationLocationId);
    const destLocationName = destLoc?.name || "";
    if (detailed) {
      const exportData = validEntries.map((entry) => ({
        Date: voucherDate,
        "Source Location": entry.sourceLocationName || "",
        "Destination Location": destLocationName,
        "Item Code": entry.stockItemCode || "",
        "Item Name": entry.stockItemName || "",
        Quantity: parseFloat(entry.quantity).toFixed(2),
        Rate: parseFloat(entry.rate || "0").toFixed(2),
        Amount: (parseFloat(entry.quantity) * parseFloat(entry.rate || "0")).toFixed(2),
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      }));
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Stock Transfer Detailed");
      const fileName = exportFileName("stock transfer detailed", "xlsx", { date: voucherDate });
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} items.` });
    } else {
      const totalQty = validEntries.reduce((sum: number, e) => sum + parseFloat(e.quantity), 0);
      const totalAmount = validEntries.reduce(
        (sum: number, e) => sum + parseFloat(e.quantity) * parseFloat(e.rate || "0"),
        0
      );
      const exportData = [
        {
          "Voucher Type": "Stock Transfer",
          Date: voucherDate,
          "Destination Location": destLocationName,
          "Total Items": validEntries.length,
          "Total Quantity": totalQty.toFixed(2),
          "Total Amount": totalAmount.toFixed(2),
          Notes: formData.notes || "",
          Optional: formData.optional ? "Yes" : "No",
        },
      ];
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Stock Transfer Summary");
      const fileName = exportFileName("stock transfer summary", "xlsx", { date: voucherDate });
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
    }
  };
  return {
    computeTransferRevisionItems,
    confirmTransferSaveAsRevision,
    handleExportStockTransfer,
    handleTransferSaveAsRevision,
    onStockTransferSubmit,
  };
}
