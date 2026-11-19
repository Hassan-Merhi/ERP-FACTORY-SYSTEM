import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { apiRequest, queryClient } from "@/lib/queryClient";

import { utils, writeFile } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import { containerExportItemRows } from "./containerExportItemRows";
import { exportContainerWithoutCost } from "./containerDetailExports";
import { useContainerDetailDataModel, type PaymentFormValues } from "./useContainerDetailDataModel";

/** Row returned by the container price-import preview endpoint. */
export interface ContainerPriceImportPreviewRow {
  barcode: string;
  itemName: string | null;
  lineItemIds?: number[];
  status: "invalid" | "invalid_price" | "not_found" | "not_in_container" | "no_change" | "will_update";
  currentRate: number | null;
  newRate: number | null;
}

const saleFormSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  commission: z
    .string()
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Commission must be non-negative"),
  commissionAccountId: z.string().optional(),
  saleDate: z.string().min(1, "Sale date is required"),
});

export function useContainerDetailModel({ id: idProp, forceErp }: { id?: string; forceErp?: boolean }) {
  const d = useContainerDetailDataModel({ idProp, forceErp });

  const paymentForm = useForm<PaymentFormValues>({
    defaultValues: { paymentDate: new Date().toLocaleDateString("en-CA"), amount: "", method: "", reference: "" },
  });

  const addPaymentMutation = useMutation({
    mutationFn: async ({ freightId, data }: { freightId: number; data: PaymentFormValues }) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/freight/${freightId}/payments`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", d.containerId, "freight"] });
      d.setShowPaymentDialog(null);
      paymentForm.reset({ paymentDate: new Date().toLocaleDateString("en-CA"), amount: "", method: "", reference: "" });
      d.toast({ title: "Payment recorded" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      d.toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const handleExportContainer = async () => {
    if (!navigator.onLine) {
      d.toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    try {
      const response = await fetch(`/api/containers/${d.containerId}/export`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Export failed");

      const rows = containerExportItemRows(data);

      const worksheet = utils.json_to_sheet(rows);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Container Items");
      await writeFile(workbook, exportFileName(`container ${data.container.containerNumber}`, "xlsx"));

      d.toast({ title: "Export successful", description: "Container data downloaded as Excel" });
    } catch (error) {
      d.toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handleExportContainerNoCost = async () => {
    return await exportContainerWithoutCost({ toast: d.toast, containerId: d.containerId });
  };

  // Determine the back URL based on container status
  const backUrl =
    d.selectedCompany?.companyType === "properties"
      ? "/properties/containers"
      : d.containerData?.container?.status === "SOLD"
        ? "/sold-containers"
        : "/containers";

  const form = useForm<z.infer<typeof saleFormSchema>>({
    resolver: zodResolver(saleFormSchema),
    defaultValues: {
      customerId: "",
      commission: "0.00",
      commissionAccountId: "",
      saleDate: new Date().toLocaleDateString("en-CA"),
    },
  });

  // Delete PO mutation
  const deletePOMutation = useMutation({
    mutationFn: async (poId: number) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      await apiRequest("DELETE", `/api/purchase-orders/${poId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${d.containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", d.selectedCompany?.id] });
      d.toast({
        title: "Purchase Order Deleted",
        description: "The purchase order and associated data have been removed",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      d.toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete purchase order",
        variant: "destructive",
      });
    },
  });

  // Delete Container mutation
  const deleteContainerMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      await apiRequest("DELETE", `/api/containers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", d.selectedCompany?.id] });
      d.toast({
        title: "Container Deleted",
        description: "The container and all associated data have been removed",
      });
      d.setLocation(d.selectedCompany?.companyType === "properties" ? "/properties/containers" : "/containers");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      d.toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete container",
        variant: "destructive",
      });
    },
  });

  // Sync purchase voucher amounts (fixes $0 balance when items were imported after PO creation)
  const syncVoucherMutation = useMutation({
    mutationFn: async () => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/containers/${d.containerId}/sync-voucher`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${d.containerId}`] });
      d.toast({
        title: "Voucher Synced",
        description: data.message || "Purchase voucher amounts updated successfully",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      d.toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync voucher amounts",
        variant: "destructive",
      });
    },
  });

  // Reverse Offload mutation
  const reverseOffloadMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      await apiRequest("POST", `/api/containers/${id}/reverse-offload`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${d.containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", d.selectedCompany?.id] });
      d.toast({
        title: "Offload Reversed",
        description: "Container status restored to IN_TRANSIT",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      d.toast({
        title: "Reverse Failed",
        description: error.message || "Failed to reverse offload",
        variant: "destructive",
      });
    },
  });

  // Sell Container mutation
  const sellContainerMutation = useMutation({
    mutationFn: async (data: z.infer<typeof saleFormSchema>) => {
      const containerCost = parseFloat(d.containerData?.container.grandTotal || "0");
      const commission = parseFloat(data.commission);
      const totalAmount = containerCost + commission;

      await apiRequest("POST", "/api/container-sales", {
        containerId: parseInt(d.containerId!),
        customerId: parseInt(data.customerId),
        saleDate: data.saleDate,
        containerCost: containerCost.toString(),
        commission: data.commission,
        commissionAccountId: data.commissionAccountId ? parseInt(data.commissionAccountId) : undefined,
        totalAmount: totalAmount.toString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/container-sales", d.selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${d.containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", d.selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/sold", d.selectedCompany?.id] });
      d.toast({
        title: "Container Sold",
        description: "Container sale has been recorded successfully",
      });
      d.setShowSellDialog(false);
      form.reset();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      d.toast({
        title: "Sale Failed",
        description: error.message || "Failed to record container sale",
        variant: "destructive",
      });
    },
  });

  const handleDeletePO = async (poId: number, _poNumber: string) => {
    d.setPendingDelete(() => () => deletePOMutation.mutate(poId));
  };

  const handleDeleteContainer = async () => {
    d.setPendingDelete(() => () => deleteContainerMutation.mutate(parseInt(d.containerId!)));
  };

  const handleSellSubmit = async (data: z.infer<typeof saleFormSchema>) => {
    sellContainerMutation.mutate(data);
  };

  const saleCustomer = d.customers.find((c) => c.id === d.containerSale?.customerId);

  return {
    formatDisplayDate: d.formatDisplayDate,
    containerId: d.containerId,
    showOffloadDialog: d.showOffloadDialog,
    setShowOffloadDialog: d.setShowOffloadDialog,
    showSellDialog: d.showSellDialog,
    setShowSellDialog: d.setShowSellDialog,
    pendingDelete: d.pendingDelete,
    setPendingDelete: d.setPendingDelete,
    setLocation: d.setLocation,
    formatAmount: d.formatAmount,
    isSupplierPartner: d.isSupplierPartner,
    isDeveloper: d.isDeveloper,
    containerData: d.containerData,
    isLoading: d.isLoading,
    containerError: d.containerError,
    retryContainer: d.retryContainer,
    spContainerData: d.spContainerData,
    spDetailLoading: d.spDetailLoading,
    showSpOffloadDialog: d.showSpOffloadDialog,
    setShowSpOffloadDialog: d.setShowSpOffloadDialog,
    suppliers: d.suppliers,
    customers: d.customers,
    incomeAccounts: d.incomeAccounts,
    containerSale: d.containerSale,
    docsData: d.docsData,
    showUploadDialog: d.showUploadDialog,
    setShowUploadDialog: d.setShowUploadDialog,
    showFreightDialog: d.showFreightDialog,
    setShowFreightDialog: d.setShowFreightDialog,
    showPaymentDialog: d.showPaymentDialog,
    setShowPaymentDialog: d.setShowPaymentDialog,
    uploadDocTypeId: d.uploadDocTypeId,
    setUploadDocTypeId: d.setUploadDocTypeId,
    uploadFile: d.uploadFile,
    setUploadFile: d.setUploadFile,
    fileInputRef: d.fileInputRef,
    showPriceImportDialog: d.showPriceImportDialog,
    setShowPriceImportDialog: d.setShowPriceImportDialog,
    priceImportPreview: d.priceImportPreview,
    setPriceImportPreview: d.setPriceImportPreview,
    priceImportParsing: d.priceImportParsing,
    priceImportError: d.priceImportError,
    setPriceImportError: d.setPriceImportError,
    priceImportFileRef: d.priceImportFileRef,
    pricePreviewMutation: d.pricePreviewMutation,
    priceApplyMutation: d.priceApplyMutation,
    handlePriceImportFile: d.handlePriceImportFile,
    uploadDocMutation: d.uploadDocMutation,
    freightForm: d.freightForm,
    addFreightMutation: d.addFreightMutation,
    paymentForm,
    addPaymentMutation,
    handleExportContainer,
    handleExportContainerNoCost,
    backUrl,
    form,
    deletePOMutation,
    deleteContainerMutation,
    syncVoucherMutation,
    reverseOffloadMutation,
    sellContainerMutation,
    handleDeletePO,
    handleDeleteContainer,
    handleSellSubmit,
    handlePrint: d.handlePrint,
    saleCustomer,
    canChangeExistingRecords: d.recordChanges.allowed,
    canCreate: d.recordChanges.canCreate,
  } as const;
}
