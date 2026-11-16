// Extracted from ./useFactoryInvoiceDetailModel.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { invalidateCustomerBalances, keyStartsWith, queryClient } from "@/lib/queryClient";
import { useFactoryInvoiceDetailModelPart1 } from "./useFactoryInvoiceDetailModelPart1";

export function useFactoryInvoiceDetailModelPart2({
  assertCanChange,
  modeApiRequest,
  navigate,
  order,
  orderId,
  setEditingArticleCode,
  setSelectedProformaId,
  setShowProformaDialog,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryInvoiceDetailModelPart1>>,
  | "assertCanChange"
  | "modeApiRequest"
  | "navigate"
  | "order"
  | "orderId"
  | "setEditingArticleCode"
  | "setSelectedProformaId"
  | "setShowProformaDialog"
  | "toast"
>) {
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "DRAFT":
        return (
          <Badge variant="secondary" data-testid="badge-status-draft">
            Draft
          </Badge>
        );
      case "LOADING":
        return (
          <Badge
            variant="outline"
            className="bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
            data-testid="badge-status-loading"
          >
            Loading
          </Badge>
        );
      case "PENDING_VERIFICATION":
      case "VERIFIED":
        return (
          <Badge
            variant="outline"
            className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
            data-testid="badge-status-verified"
          >
            Verified
          </Badge>
        );
      case "FINALIZED":
        return (
          <Badge variant="default" data-testid="badge-status-finalized">
            Finalized
          </Badge>
        );
      case "CANCELLED":
        return (
          <Badge variant="destructive" data-testid="badge-status-cancelled">
            Cancelled
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" data-testid="badge-status-unknown">
            {status}
          </Badge>
        );
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      assertCanChange();
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${id}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Invoice deleted successfully." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances(order?.customerId ?? undefined);
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repriceMutation = useMutation({
    mutationFn: async () => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to reprice");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.repriced === 0) {
        toast({
          title: "Prices already current",
          description: "All bale prices already match the current catalogue — no changes needed.",
        });
      } else {
        toast({
          title: "Prices updated",
          description: `Updated ${data.repriced} bale(s) to current catalogue prices.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const repriceArticleMutation = useMutation({
    mutationFn: async ({ articleCode, pricePerBale }: { articleCode: string; pricePerBale: number }) => {
      assertCanChange();
      const res = await modeApiRequest("PATCH", `/api/factory/customer-orders/${orderId}/bales/reprice-article`, {
        articleCode,
        pricePerBale,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update price");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Price updated",
        description: "All bales for this article have been repriced and totals recalculated.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setEditingArticleCode(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setEditingArticleCode(null);
    },
  });

  const unfinalizeMutation = useMutation({
    mutationFn: async () => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/unfinalize`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to revert invoice");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Invoice reverted successfully", description: "The original workflow stage has been restored." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      invalidateCustomerBalances(order?.customerId ?? undefined);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Cannot revert", description: error.message, variant: "destructive" });
    },
  });

  const repriceProductionMutation = useMutation({
    mutationFn: async () => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/reprice-production`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to apply production prices");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.repriced === 0) {
        toast({
          title: "Already at production prices",
          description: "All bale prices already match the current production prices — no changes needed.",
        });
      } else {
        toast({
          title: "Production prices applied",
          description: `Updated ${data.repriced} bale(s) to production prices.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyProformaMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/apply-proforma-prices`, {
        proformaId,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to apply proforma prices");
      }
      return res.json();
    },
    onSuccess: (data) => {
      const repriced = data?.repriced ?? 0;
      if (repriced === 0) {
        toast({
          title: "No changes",
          description: "All bale prices already match the selected proforma — no updates needed.",
        });
      } else {
        toast({ title: "Proforma prices applied", description: `Updated ${repriced} bale(s).` });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setShowProformaDialog(false);
      setSelectedProformaId("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
  return {
    applyProformaMutation,
    deleteMutation,
    getStatusBadge,
    repriceArticleMutation,
    repriceMutation,
    repriceProductionMutation,
    unfinalizeMutation,
  };
}
