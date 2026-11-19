// Extracted from ./FactoryPendingInvoices.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { StatusBadge } from "@/components/StatusBadge";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl } from "@/lib/exportFile";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

interface CustomerOrder {
  id: number;
  companyId: number;
  customerId: number;
  orderDate: string;
  status: string;
  invoiceNumber?: string;
  subtotalBales: string;
  freightAmount: string;
  otherChargesTotal: string;
  grandTotal: string;
  totalQtyBales: number;
  totalWeightKg: string;
  customerName: string;
  containerNumber?: string | null;
  proformaName?: string | null;
  containerNotes?: string | null;
}

export function useFactoryPendingInvoicesState() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [statusFilter, setStatusFilter] = useState<string>("PENDING_VERIFIED");
  const { toast } = useToast();
  const downloadExport = async (url: string, fileName: string) => {
    try {
      await downloadFromUrl(url, { fileName });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const isAdmin =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true && myAccess.fullAccess === true;

  const {
    data: pendingOrders = [],
    isLoading: pendingLoading,
    isError: pendingError,
    refetch: refetchPending,
  } = useQuery<CustomerOrder[]>({
    queryKey: companyQueryKey(
      "/api/factory/customer-orders?status=PENDING_VERIFICATION&profile=summary&pageSize=250",
      selectedCompany?.id
    ),
    enabled: Boolean(selectedCompany?.id),
  });

  const {
    data: verifiedOrders = [],
    isLoading: verifiedLoading,
    isError: verifiedError,
    refetch: refetchVerified,
  } = useQuery<CustomerOrder[]>({
    queryKey: companyQueryKey(
      "/api/factory/customer-orders?status=VERIFIED&profile=summary&pageSize=250",
      selectedCompany?.id
    ),
    enabled: Boolean(selectedCompany?.id),
  });

  const {
    data: finalizedOrders = [],
    isLoading: finalizedLoading,
    isError: finalizedError,
    refetch: refetchFinalized,
  } = useQuery<CustomerOrder[]>({
    queryKey: companyQueryKey(
      "/api/factory/customer-orders?status=FINALIZED&profile=summary&pageSize=250",
      selectedCompany?.id
    ),
    enabled: Boolean(selectedCompany?.id),
  });

  const deleteMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Invoice deleted successfully." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const allOrders = [...pendingOrders, ...verifiedOrders, ...finalizedOrders];
  const isLoading = pendingLoading || verifiedLoading || finalizedLoading;
  const hasLoadError = pendingError || verifiedError || finalizedError;

  const filteredOrders =
    statusFilter === "ALL"
      ? allOrders
      : statusFilter === "PENDING_VERIFIED"
        ? allOrders.filter((o) => o.status === "PENDING_VERIFICATION" || o.status === "VERIFIED")
        : allOrders.filter((o) => o.status === statusFilter);

  const getStatusBadge = (status: string) => (
    <StatusBadge
      status={status === "PENDING_VERIFICATION" ? "pending" : status}
      label={status === "PENDING_VERIFICATION" ? "Pending" : undefined}
      showIcon={false}
    />
  );

  const filters: { key: string; label: string; count: number }[] = [
    { key: "PENDING_VERIFIED", label: "Pending + Verified", count: pendingOrders.length + verifiedOrders.length },
    { key: "FINALIZED", label: "Finalized", count: finalizedOrders.length },
    { key: "ALL", label: "All", count: allOrders.length },
  ];
  return {
    navigate,
    formatDisplayDate,
    statusFilter,
    setStatusFilter,
    downloadExport,
    isAdmin,
    refetchPending,
    refetchVerified,
    refetchFinalized,
    deleteMutation,
    allOrders,
    isLoading,
    hasLoadError,
    filteredOrders,
    getStatusBadge,
    filters,
  };
}
