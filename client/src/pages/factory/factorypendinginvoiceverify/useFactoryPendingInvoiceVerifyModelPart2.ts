// Extracted from ./useFactoryPendingInvoiceVerifyModel.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { useFactoryPendingInvoiceVerifyModelPart1 } from "./useFactoryPendingInvoiceVerifyModelPart1";

export function useFactoryPendingInvoiceVerifyModelPart2({
  addChargeMutation,
  chargeAmount,
  chargeLedgerAccountId,
  chargeName,
  chargeType,
  modeApiRequest,
  navigate,
  orderId,
  setFinalizePreview,
  setPendingFinalizeData,
  setPreviewLoading,
  setRecoverInput,
  setSelectedProformaId,
  setShowFinalizePreview,
  setShowFixBalesDialog,
  setShowPriceWarning,
  setShowProformaDialog,
  setShowRecoverDialog,
  setUnpricedItems,
  toast,
  verification,
}: Pick<
  Awaited<ReturnType<typeof useFactoryPendingInvoiceVerifyModelPart1>>,
  | "addChargeMutation"
  | "chargeAmount"
  | "chargeLedgerAccountId"
  | "chargeName"
  | "chargeType"
  | "modeApiRequest"
  | "navigate"
  | "orderId"
  | "setFinalizePreview"
  | "setPendingFinalizeData"
  | "setPreviewLoading"
  | "setRecoverInput"
  | "setSelectedProformaId"
  | "setShowFinalizePreview"
  | "setShowFixBalesDialog"
  | "setShowPriceWarning"
  | "setShowProformaDialog"
  | "setShowRecoverDialog"
  | "setUnpricedItems"
  | "toast"
  | "verification"
>) {
  const removeChargeMutation = useMutation({
    mutationFn: async (chargeId: number) => {
      await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/charges/${chargeId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      toast({ title: "Charge removed" });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (txDate?: string) => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/finalize`, { txDate });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      toast({ title: "Invoice finalized", description: "Invoice has been created successfully" });
      navigate(`/factory/sales/invoices/${orderId}`);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const forceSyncMutation = useMutation({
    mutationFn: async () => {
      await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/force-sync-bale-status`);
    },
    onSuccess: () => {
      toast({ title: "Bales fixed", description: "Bale statuses have been set to SOLD" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders", orderId, "verification"] });
      setShowFixBalesDialog(false);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const recoverBalesMutation = useMutation({
    mutationFn: async (baleReferences: string[]) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/recover-bales`, {
        baleReferences,
      });
      return res.json();
    },
    onSuccess: (data: { message: string; linked: number; notFound: string[] }) => {
      toast({
        title: `${data.linked} bale(s) recovered`,
        description:
          data.notFound.length > 0
            ? `Not found: ${data.notFound.slice(0, 5).join(", ")}${data.notFound.length > 5 ? ` (+${data.notFound.length - 5} more)` : ""}`
            : data.message,
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setShowRecoverDialog(false);
      setRecoverInput("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Recovery failed", description: error.message, variant: "destructive" });
    },
  });

  const autoRecoverMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/auto-recover-bales`, {});
      return res.json();
    },
    onSuccess: (data: {
      message: string;
      linked: number;
      summary: { articleCode: string; linked: number; needed: number }[];
    }) => {
      toast({
        title: `${data.linked} bale(s) auto-linked`,
        description: data.summary.map((s) => `${s.articleCode}: ${s.linked}/${s.needed}`).join(", "),
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setShowRecoverDialog(false);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Auto-recover failed", description: error.message, variant: "destructive" });
    },
  });

  const applyProformaMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/apply-proforma-prices`, {
        proformaId,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const repriced = data?.repriced ?? 0;
      toast({ title: "Proforma prices applied", description: `${repriced} bale${repriced !== 1 ? "s" : ""} updated` });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setShowProformaDialog(false);
      setSelectedProformaId("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyProductionPricesMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice-production`, {});
      return res.json();
    },
    onSuccess: (data) => {
      const updated = data?.updated ?? data?.repriced ?? 0;
      toast({ title: "Production Prices Applied", description: `${updated} bale(s) updated` });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applySellingPricesMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice`, {});
      return res.json();
    },
    onSuccess: (data) => {
      const updated = data?.updated ?? data?.repriced ?? 0;
      toast({ title: "Selling Prices Applied", description: `${updated} bale(s) updated` });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repairPerKgMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", "/api/factory/repair-perkg-prices", {});
      return res.json();
    },
    onSuccess: (data: {
      ordersScanned: number;
      balesRepaired: number;
      changedOrderIds: number[];
      errors: string[];
    }) => {
      toast({
        title: `Repair complete: ${data.balesRepaired} bale(s) fixed`,
        description:
          data.changedOrderIds.length > 0
            ? `Orders updated: ${data.changedOrderIds.join(", ")}`
            : "No bales needed repair.",
      });
      if (data.errors.length > 0) {
        toast({ title: "Repair errors", description: data.errors.join("; "), variant: "destructive" });
      }
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Repair failed", description: error.message, variant: "destructive" });
    },
  });

  const fetchFinalizePreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/factory/customer-orders/${orderId}/finalize-preview`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch preview");
      const data = await res.json();

      // Check for items with no price set — use totalPrice as the source of truth
      // (pricePerBale can be "0" for per-kg items even when they DO have a price)
      const zeroPrice = (verification?.loadedItems ?? []).filter((item) => {
        const totalPrice = item.totalPrice ?? 0;
        const priceKg = item.pricePerKg ?? 0;
        // Also estimate per-kg total in case bales were loaded before repricing
        const estimatedTotal =
          item.pricingMode === "per_kg" && priceKg > 0 && item.totalWeight > 0 ? priceKg * item.totalWeight : 0;
        return totalPrice === 0 && estimatedTotal === 0;
      });

      if (zeroPrice.length > 0) {
        setUnpricedItems(zeroPrice.map((item) => item.productName));
        setPendingFinalizeData(data);
        setShowPriceWarning(true);
      } else {
        setFinalizePreview(data);
        setShowFinalizePreview(true);
      }
    } catch (error) {
      toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleAddCharge = () => {
    if (!chargeAmount || !orderId) return;
    const name = chargeType === "FREIGHT" ? "Freight" : chargeName.trim();
    if (!name) return;
    addChargeMutation.mutate({
      name,
      amount: parseFloat(chargeAmount),
      chargeType,
      ledgerAccountId: chargeLedgerAccountId ? parseInt(chargeLedgerAccountId) : undefined,
    });
  };
  return {
    applyProductionPricesMutation,
    applyProformaMutation,
    applySellingPricesMutation,
    autoRecoverMutation,
    fetchFinalizePreview,
    finalizeMutation,
    forceSyncMutation,
    handleAddCharge,
    recoverBalesMutation,
    removeChargeMutation,
    repairPerKgMutation,
  };
}
