import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import {
  preparePaymentReceiptData,
  prepareJournalData,
  prepareSalesData,
  preparePurchaseData,
  prepareAdjustmentData,
  prepareTransferData,
} from "./VoucherSubmitHelpers";
import {
  VoucherFormData,
  JournalFormData,
  SalesFormData,
  PurchaseFormData,
  AdjustmentFormData,
  TransferFormData,
} from "./VoucherEditSchemas";

interface UseVoucherEditMutationsOptions {
  id: string | undefined;
  modeApiRequest: (method: string, url: string, body?: any) => Promise<any>;
  voucherType: string | undefined;
  exchangeRate: number;
  handleBack: () => void;
  modePrefix: string;
  goldenCoastParentCompanyId?: number | null;
}

export function useVoucherEditMutations({
  id,
  modeApiRequest,
  voucherType,
  exchangeRate,
  handleBack,
  modePrefix,
  goldenCoastParentCompanyId,
}: UseVoucherEditMutationsOptions) {
  const { toast } = useToast();
  const [_location, navigate] = useLocation();

  const updateMutation = useMutation({
    mutationFn: async (data: { voucherUpdates: unknown; entries: unknown[] }) => {
      return await modeApiRequest("PUT", `/api/vouchers/${id}/with-entries`, {
        voucher: data.voucherUpdates,
        entries: data.entries,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/accounts/") });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customers/") });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      toast({ title: "Success", description: "Voucher updated successfully" });
      handleBack();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to update voucher", variant: "destructive" });
    },
  });

  const toggleOptionalMutation = useMutation({
    mutationFn: async (optional: boolean) => {
      return await modeApiRequest("PATCH", `/api/vouchers/${id}/optional`, { optional });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      toast({ title: "Success", description: "Optional status updated successfully" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update optional status",
        variant: "destructive",
      });
    },
  });

  const updateSalesMutation = useMutation({
    mutationFn: async (data: SalesFormData) => {
      const salesData = prepareSalesData(data);
      return await modeApiRequest("PUT", `/api/vouchers/${id}/sales`, {
        ...salesData,
        targetCompanyId: goldenCoastParentCompanyId ?? undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/sp/report/profit") });

      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      toast({ title: "Success", description: "Sales voucher updated successfully" });
      navigate(`${modePrefix}/daybook`);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message || "Failed to update sales voucher", variant: "destructive" });
    },
  });

  const updatePurchaseMutation = useMutation({
    mutationFn: async (data: PurchaseFormData) => {
      const purchaseData = preparePurchaseData(data);
      return await modeApiRequest("PATCH", `/api/vouchers/${id}/purchase`, purchaseData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });

      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      toast({ title: "Success", description: "Purchase voucher updated successfully" });
      navigate(`${modePrefix}/daybook`);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update purchase voucher",
        variant: "destructive",
      });
    },
  });

  const updateAdjustmentMutation = useMutation({
    mutationFn: async (data: AdjustmentFormData) => {
      const adjustmentData = prepareAdjustmentData(data);
      return await modeApiRequest("PATCH", `/api/vouchers/${id}/adjustment`, adjustmentData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });

      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      toast({ title: "Success", description: "Adjustment voucher updated successfully" });
      navigate(`${modePrefix}/daybook`);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update adjustment voucher",
        variant: "destructive",
      });
    },
  });

  const updateTransferMutation = useMutation({
    mutationFn: async (data: TransferFormData) => {
      const transferData = prepareTransferData(data);
      return await modeApiRequest("PATCH", `/api/vouchers/${id}/transfer`, transferData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });

      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      toast({ title: "Success", description: "Stock transfer voucher updated successfully" });
      navigate(`${modePrefix}/daybook`);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update stock transfer voucher",
        variant: "destructive",
      });
    },
  });

  const onSubmitPaymentReceipt = async (data: VoucherFormData) => {
    const { voucherUpdates, entries } = preparePaymentReceiptData(data, voucherType!, exchangeRate);
    updateMutation.mutate({ voucherUpdates, entries });
  };

  const onSubmitJournal = async (data: JournalFormData) => {
    const { voucherUpdates, entries } = prepareJournalData(data, exchangeRate);
    updateMutation.mutate({ voucherUpdates, entries });
  };

  return {
    updateMutation,
    toggleOptionalMutation,
    updateSalesMutation,
    updatePurchaseMutation,
    updateAdjustmentMutation,
    updateTransferMutation,
    onSubmitPaymentReceipt,
    onSubmitJournal,
  };
}
