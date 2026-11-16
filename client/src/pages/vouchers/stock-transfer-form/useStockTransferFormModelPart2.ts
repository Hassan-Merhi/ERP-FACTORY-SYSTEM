// Extracted from ./useStockTransferFormModel.ts to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { queryClient } from "@/lib/queryClient";
import type { StockTransferFormData } from "../stocktransferform/types";
import { useStockTransferFormModelPart1 } from "./useStockTransferFormModelPart1";

export function useStockTransferFormModelPart2({
  hydratedVoucherIdRef,
  lastKnownTransferIdRef,
  locations,
  modeApiRequest,
  modePrefix,
  pendingTransferRevisions,
  savingTransferRevisionRef,
  selectedCompany,
  setApproveRevisionTarget,
  setImportDestLocation,
  setImportDialogOpen,
  setImportFile,
  setImportNotes,
  setImportPreview,
  setImportValidationResult,
  setLocation,
  setTransferRevisionsExpanded,
  stockTransferForm,
  stockTransferToEdit,
  toast,
  voucherIdToEdit,
  voucherToEdit,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferFormModelPart1>>,
  | "hydratedVoucherIdRef"
  | "lastKnownTransferIdRef"
  | "locations"
  | "modeApiRequest"
  | "modePrefix"
  | "pendingTransferRevisions"
  | "savingTransferRevisionRef"
  | "selectedCompany"
  | "setApproveRevisionTarget"
  | "setImportDestLocation"
  | "setImportDialogOpen"
  | "setImportFile"
  | "setImportNotes"
  | "setImportPreview"
  | "setImportValidationResult"
  | "setLocation"
  | "setTransferRevisionsExpanded"
  | "stockTransferForm"
  | "stockTransferToEdit"
  | "toast"
  | "voucherIdToEdit"
  | "voucherToEdit"
>) {
  const approveRevisionMutation = useMutation({
    mutationFn: async (revisionId: number) => {
      return modeApiRequest("POST", `/api/stock-transfer-revisions/${revisionId}/approve`, {});
    },
    onSuccess: () => {
      const applied = pendingTransferRevisions.length;
      toast({
        title: applied > 1 ? `${applied} revisions approved` : "Revision approved",
        description: "Quantities have been updated.",
      });
      setApproveRevisionTarget(null);
      setTransferRevisionsExpanded(true);
      hydratedVoucherIdRef.current = null;
      queryClient.invalidateQueries({
        queryKey: ["/api/stock-transfers", lastKnownTransferIdRef.current, "revisions"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers", voucherIdToEdit] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    },
  });

  const importParseMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/stock-transfer-import/parse-multi-source", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to parse file");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setImportPreview(data);
      setImportValidationResult(null);
      toast({
        title: "File parsed successfully",
        description: `Found ${data.items.length} item(s). Click Validate to check the data.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Parse error", description: error.message, variant: "destructive" });
    },
  });

  const importValidateMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await modeApiRequest("POST", "/api/stock-transfer-import/validate-multi-source", data);
      return res.json();
    },
    onSuccess: (data) => {
      setImportValidationResult(data);
      const errorCount = data.errors?.length || 0;
      if (errorCount === 0) {
        toast({
          title: "Validation passed",
          description: "All items validated successfully. You can now import the data.",
        });
      } else {
        toast({
          title: "Validation issues found",
          description: `Found ${errorCount} issue(s). Please review before importing.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Validation error", description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await modeApiRequest("POST", "/api/stock-transfer-import/import-multi-source", data);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Import successful", description: `${data.itemsCount} items transferred successfully.` });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
      setImportDialogOpen(false);
      setImportFile(null);
      setImportPreview(null);
      setImportValidationResult(null);
      setImportDestLocation("");
      setImportNotes("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });

  const stockTransferMutation = useMutation({
    mutationFn: async (data: StockTransferFormData) => {
      const isEditMode = !!voucherIdToEdit;
      const validEntries = data.entries.filter(
        (e) => e.stockItemId > 0 && e.sourceLocationId > 0 && parseFloat(e.quantity || "0") > 0
      );
      const totalAmount = validEntries
        .reduce((sum, e) => sum + parseFloat(e.quantity || "0") * parseFloat(e.rate || "0"), 0)
        .toString();

      if (isEditMode) {
        const destLoc = locations.find((l) => l.id === data.destinationLocationId);
        const wasOptional = voucherToEdit?.optional === true;
        const wantOptional = data.optional;
        const isFinalizingTransfer = wasOptional && !wantOptional;

        await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}`, {
          voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
          description: data.notes?.trim() || `Stock transfer to ${destLoc?.name || ""}`,
          totalAmount,
          ...(wantOptional ? { optional: true } : {}),
        });
        if (stockTransferToEdit?.id) {
          await modeApiRequest("PUT", `/api/stock-transfers/${stockTransferToEdit.id}`, {
            destinationLocationId: data.destinationLocationId,
            notes: data.notes || "",
            items: validEntries.map((e) => ({
              stockItemId: e.stockItemId,
              sourceLocationId: e.sourceLocationId,
              quantity: e.quantity,
              rate: e.rate,
            })),
          });
        } else {
          await modeApiRequest("POST", "/api/stock-transfers", {
            voucherId: voucherIdToEdit,
            destinationLocationId: data.destinationLocationId,
            notes: data.notes || "",
            items: validEntries.map((e) => ({
              stockItemId: e.stockItemId,
              sourceLocationId: e.sourceLocationId,
              quantity: e.quantity,
              rate: e.rate,
            })),
          });
        }
        if (isFinalizingTransfer) {
          await modeApiRequest("POST", `/api/vouchers/${voucherIdToEdit}/finalize`, {});
        }
        return { id: voucherIdToEdit };
      }

      const destLoc = locations.find((l) => l.id === data.destinationLocationId);
      const voucherRes = await modeApiRequest("POST", "/api/vouchers", {
        companyId: selectedCompany?.id,
        voucherType: "Stock Transfer",
        voucherNumber: `TRANSFER-${Date.now()}`,
        voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
        description: data.notes?.trim() || `Stock transfer to ${destLoc?.name || ""}`,
        totalAmount,
        optional: data.optional,
      });
      const voucher = await voucherRes.json();
      await modeApiRequest("POST", "/api/stock-transfers", {
        voucherId: voucher.id,
        destinationLocationId: data.destinationLocationId,
        notes: data.notes || "",
        items: validEntries.map((e) => ({
          stockItemId: e.stockItemId,
          sourceLocationId: e.sourceLocationId,
          quantity: e.quantity,
          rate: e.rate,
        })),
      });
      return voucher;
    },
    onSuccess: () => {
      const isEditMode = !!voucherIdToEdit;
      if (!savingTransferRevisionRef.current) {
        toast({ title: "Success", description: `Stock transfer ${isEditMode ? "updated" : "created"} successfully` });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
      if (isEditMode) {
        if (!savingTransferRevisionRef.current) setLocation(`${modePrefix}/daybook`);
      } else {
        stockTransferForm.reset({
          voucherDate: new Date(),
          destinationLocationId: 0,
          entries: [
            {
              sourceLocationId: 0,
              sourceLocationName: "",
              stockItemId: 0,
              stockItemCode: "",
              stockItemName: "",
              quantity: "",
              rate: "",
            },
          ],
          notes: "",
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      const isEditMode = !!voucherIdToEdit;
      toast({
        title: "Error",
        description: error.message || `Failed to ${isEditMode ? "update" : "create"} stock transfer`,
        variant: "destructive",
      });
    },
  });
  return {
    approveRevisionMutation,
    importMutation,
    importParseMutation,
    importValidateMutation,
    stockTransferMutation,
  };
}
