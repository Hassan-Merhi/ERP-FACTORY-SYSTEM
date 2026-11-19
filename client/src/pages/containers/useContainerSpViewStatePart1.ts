// Extracted from ./useContainerSpViewState.ts
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Container, Supplier } from "@shared/schema";
import type { SpContainerWithLines } from "./types";

/**
 * Common display shape the SP list and the ERP (PO Import) containers are
 * normalized to. Also the shape held by the cancel-dialog selection state.
 */
interface SpContainerRowView {
  _key: string;
  id: number;
  _source: "sp" | "erp";
  displayName: string;
  subName: string | null;
  supplierName: string;
  status: string;
  statusLabel: string;
  statusOffloaded: boolean;
  statusCancelled: boolean;
  date: string;
  dateLabel: string;
  totalUsd: number;
}

export interface ContainerSpViewProps {
  spContainersList: SpContainerWithLines[];
  allContainers: Container[];
  suppliers: Supplier[];
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  isSpLoading: boolean;
  setLocation: (path: string) => void;
  formatDisplayDate: (date: string) => string;
}

export function useContainerSpViewStatePart1({
  spContainersList,
  allContainers,
  suppliers,
  searchTerm,
}: Pick<ContainerSpViewProps, "spContainersList" | "allContainers" | "suppliers" | "searchTerm">) {
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const queryClient = useQueryClient();
  const [selectedContainer, setSelectedContainer] = useState<SpContainerRowView | null>(null);
  const [reason, setReason] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OTW" | "OFFLOADED">("ALL");
  const [supplierFilter, setSupplierFilter] = useState("");

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string | null }>({
    queryKey: ["/api/auth/me"],
  });
  const role = currentUser?.currentRole ?? currentUser?.role ?? "";
  const recordChanges = useExistingRecordChangeAccess();
  const canCancel = (role === "Admin" || role === "Developer") && recordChanges.allowed;

  const cancelContainer = useMutation({
    mutationFn: async () => {
      if (!selectedContainer) throw new Error("No container selected");
      const response = await apiRequest("POST", `/api/sp/containers/${selectedContainer.id}/cancel`, { reason });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${selectedContainer?.id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/report/payable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      toast({
        title: "Container cancelled",
        description: data.cancellationVoucherId
          ? `Goods OTW was reversed with voucher #${data.cancellationVoucherId}.`
          : "The open container was cancelled without deleting its history.",
      });
      setSelectedContainer(null);
      setReason("");
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Cancellation failed", description: error.message, variant: "destructive" });
    },
  });

  // Normalize sp_containers rows to a common display shape
  const spNative: SpContainerRowView[] = (Array.isArray(spContainersList) ? spContainersList : []).map((c) => {
    const statusCancelled = c.status === "cancelled";
    const statusOffloaded = c.status === "offloaded";
    return {
      _key: `sp-${c.id}`,
      id: c.id,
      _source: "sp",
      displayName: c.containerNumber || c.invoiceNumber || `#${c.id}`,
      subName: c.containerNumber && c.invoiceNumber ? c.invoiceNumber : null,
      supplierName: c.supplierName ?? "",
      status: c.status,
      statusLabel: statusCancelled ? "Cancelled" : statusOffloaded ? "Offloaded" : "Open / OTW",
      statusOffloaded,
      statusCancelled,
      date: c.invoiceDate,
      dateLabel: "Invoice Date",
      totalUsd: parseFloat(c.invoiceTotalUsd ?? "0"),
    };
  });

  // Normalize regular containers (from PO Import) to same shape
  const erpNormalized: SpContainerRowView[] = allContainers.map((c) => {
    const sup = suppliers.find((s) => s.id === c.supplierId);
    const isOffloaded = c.status === "OFFLOADED";
    return {
      _key: `erp-${c.id}`,
      id: c.id,
      _source: "erp",
      displayName: c.containerNumber,
      subName: null,
      supplierName:
        (
          sup as unknown as (
            | {
                id: number;
                code: string;
                legalName: string;
                phone: string | null;
                openingBalance: string | null;
                active: boolean;
                deletedAt: Date | null;
                createdAt: Date;
                email: string;
                address: string | null;
                taxId: string | null;
                paymentTerms: string | null;
                stockGroupId: number | null;
              }
            | undefined
          ) & { legalName: unknown }
        )?.legalName ??
        (
          sup as unknown as (
            | {
                id: number;
                code: string;
                legalName: string;
                phone: string | null;
                openingBalance: string | null;
                active: boolean;
                deletedAt: Date | null;
                createdAt: Date;
                email: string;
                address: string | null;
                taxId: string | null;
                paymentTerms: string | null;
                stockGroupId: number | null;
              }
            | undefined
          ) & { name: unknown }
        )?.name ??
        "",
      status: c.status,
      statusLabel: isOffloaded ? "Offloaded" : c.status === "OTW" ? "On The Way" : c.status,
      statusOffloaded: isOffloaded,
      statusCancelled: false,
      date: c.importDate,
      dateLabel: "Import Date",
      totalUsd: parseFloat(c.grandTotal ?? "0"),
    };
  });

  // Keep native Supplier Partner and ERP-imported containers in one ERP-style list.
  const allSpItems = [...spNative, ...erpNormalized];
  const visibleContainers = allSpItems.filter((c) => !c.statusCancelled);
  const otwContainers = visibleContainers.filter((c) => !c.statusOffloaded);
  const offloadedContainers = visibleContainers.filter((c) => c.statusOffloaded);
  const totalValue = visibleContainers.reduce((sum, c) => sum + c.totalUsd, 0);
  const supplierNames = Array.from(new Set(allSpItems.map((c) => c.supplierName).filter(Boolean))).sort();
  const filtered = allSpItems.filter(
    (c) =>
      searchAny(searchTerm, c.displayName, c.subName, c.supplierName) &&
      (statusFilter === "ALL" ||
        (statusFilter === "OTW" ? !c.statusOffloaded && !c.statusCancelled : c.statusOffloaded)) &&
      (!supplierFilter || c.supplierName === supplierFilter)
  );

  // Sort the Offloaded tab by displayed container number, not by import date.
  if (statusFilter === "OFFLOADED") {
    filtered.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  }
  return {
    toast,
    formatAmount,
    selectedContainer,
    setSelectedContainer,
    reason,
    setReason,
    statusFilter,
    setStatusFilter,
    setSupplierFilter,
    supplierFilter,
    recordChanges,
    canCancel,
    cancelContainer,
    allSpItems,
    visibleContainers,
    otwContainers,
    offloadedContainers,
    totalValue,
    supplierNames,
    filtered,
  };
}
