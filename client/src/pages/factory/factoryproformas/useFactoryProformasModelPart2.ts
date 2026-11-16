// Extracted from ./useFactoryProformasModel.ts to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { useFactoryProformasModelPart1 } from "./useFactoryProformasModelPart1";

export function useFactoryProformasModelPart2({
  customerId,
  inlineQtyValue,
  invalidateCustomerProformas,
  modeApiRequest,
  setAddLineProformaId,
  setCatalogSearch,
  setCatalogSelectedItem,
  setDestinationProforma,
  setDestinationValue,
  setEditingLine,
  setInlineQtyLineId,
  setIsAddLineOpen,
  setNewLine,
  setRenameValue,
  setRenamingProforma,
  setTransferProforma,
  setTransferTargetCustomerId,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryProformasModelPart1>>,
  | "customerId"
  | "inlineQtyValue"
  | "invalidateCustomerProformas"
  | "modeApiRequest"
  | "setAddLineProformaId"
  | "setCatalogSearch"
  | "setCatalogSelectedItem"
  | "setDestinationProforma"
  | "setDestinationValue"
  | "setEditingLine"
  | "setInlineQtyLineId"
  | "setIsAddLineOpen"
  | "setNewLine"
  | "setRenameValue"
  | "setRenamingProforma"
  | "setTransferProforma"
  | "setTransferTargetCustomerId"
  | "toast"
>) {
  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      return await modeApiRequest("PUT", `/api/factory/customer-proformas/${id}`, { isActive });
    },
    onSuccess: (_, vars) => {
      toast({ title: vars.isActive ? "Proforma activated" : "Proforma deactivated" });
      invalidateCustomerProformas();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      const msg = error.message || "";
      const isStockError = msg.includes("insufficient") || msg.includes("free stock") || msg.includes("needs");
      toast({
        title: isStockError ? "Cannot activate — insufficient stock" : "Error",
        description: isStockError
          ? "One or more articles don't have enough available stock to fulfil this proforma."
          : msg.slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const deleteProformaMutation = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/factory/customer-proformas/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Proforma deleted" });
      invalidateCustomerProformas();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Header-only update: linking an older proforma must never save/reprice its lines.
  const assignDestinationMutation = useMutation({
    mutationFn: async ({ id, destination }: { id: number; destination: string }) => {
      const response = await modeApiRequest("PUT", `/api/factory/customer-proformas/${id}`, { destination });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Failed to assign destination");
      }
      return response.json();
    },
    onSuccess: () => {
      invalidateCustomerProformas();
      toast({
        title: "Destination linked",
        description: "Only the proforma destination was updated. Item prices are unchanged.",
      });
      setDestinationProforma(null);
      setDestinationValue("");
    },
    onError: (error: Error) => {
      toast({ title: "Failed to assign destination", description: error.message, variant: "destructive" });
    },
  });

  const renameProformaMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      return await modeApiRequest("PUT", `/api/factory/customer-proformas/${id}`, { name });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Proforma renamed successfully" });
      invalidateCustomerProformas();
      setRenamingProforma(null);
      setRenameValue("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const transferProformaMutation = useMutation({
    mutationFn: async ({ id, targetCustomerId }: { id: number; targetCustomerId: number }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-proformas/${id}/transfer`, {
        targetCustomerId,
      });
      return (await res.json()) as { targetCustomerName?: string };
    },
    onSuccess: (data: { targetCustomerName?: string }) => {
      toast({ title: "Proforma transferred", description: `Proforma moved to ${data.targetCustomerName}` });
      invalidateCustomerProformas();
      // Both the source and destination customer may have new balances.
      // Refresh the list and any open statement immediately in this tab.
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customers") });
      setTransferProforma(null);
      setTransferTargetCustomerId("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Transfer failed", description: error.message, variant: "destructive" });
    },
  });

  const addLineMutation = useMutation({
    mutationFn: async (data: {
      proformaId: number;
      articleCode: string;
      productName: string;
      quantity: number;
      pricePerBale: string;
    }) => {
      return await modeApiRequest("POST", "/api/factory/customer-proforma-lines", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Line added" });
      invalidateCustomerProformas();
      queryClient.invalidateQueries({ queryKey: [`/api/factory/customer-price-lists/${customerId}`, customerId] });
      setIsAddLineOpen(false);
      setAddLineProformaId(null);
      setNewLine({ articleCode: "", productName: "", quantity: "", pricePerBale: "" });
      setCatalogSelectedItem(null);
      setCatalogSearch("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const editLineMutation = useMutation({
    mutationFn: async (data: {
      id: number;
      pricePerBale: string;
      productName: string;
      quantity: string;
      weightPerBaleKg: string;
    }) => {
      return await modeApiRequest("PUT", `/api/factory/customer-proforma-lines/${data.id}`, {
        pricePerBale: data.pricePerBale,
        productName: data.productName,
        quantity: data.quantity,
        weightPerBaleKg: data.weightPerBaleKg !== "" ? data.weightPerBaleKg : undefined,
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Line updated" });
      invalidateCustomerProformas();
      queryClient.invalidateQueries({ queryKey: [`/api/factory/customer-price-lists/${customerId}`, customerId] });
      setEditingLine(null);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/factory/customer-proforma-lines/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Line deleted" });
      invalidateCustomerProformas();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const inlineQtyMutation = useMutation({
    mutationFn: async ({ id, quantity }: { id: number; quantity: number }) => {
      const res = await modeApiRequest("PUT", `/api/factory/customer-proforma-lines/${id}`, { quantity });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      invalidateCustomerProformas();
      setInlineQtyLineId(null);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setInlineQtyLineId(null);
    },
  });

  const commitInlineQty = (lineId: number) => {
    const qty = parseInt(inlineQtyValue);
    if (!isNaN(qty) && qty >= 1) {
      inlineQtyMutation.mutate({ id: lineId, quantity: qty });
    } else {
      setInlineQtyLineId(null);
    }
  };

  const formatProformaDate = (createdAt: string | null, updatedAt: string | null): { label: string; value: string } => {
    const created = createdAt ? new Date(createdAt) : null;
    const updated = updatedAt ? new Date(updatedAt) : null;
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    if (updated && created && updated.getTime() - created.getTime() > 60_000) {
      return { label: "Edited", value: fmt(updated) };
    }
    if (created) {
      return { label: "Created", value: fmt(created) };
    }
    return { label: "", value: "" };
  };
  return {
    addLineMutation,
    assignDestinationMutation,
    commitInlineQty,
    deleteLineMutation,
    deleteProformaMutation,
    editLineMutation,
    formatProformaDate,
    inlineQtyMutation,
    renameProformaMutation,
    toggleActiveMutation,
    transferProformaMutation,
  };
}
