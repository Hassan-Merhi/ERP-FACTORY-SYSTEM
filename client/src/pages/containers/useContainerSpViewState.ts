// Extracted from ./ContainerSpView.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { utils, writeFile } from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";
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

export function useContainerSpViewState({
  spContainersList,
  allContainers,
  suppliers,
  searchTerm,
  setSearchTerm,
  isSpLoading,
  setLocation,
  formatDisplayDate,
}: ContainerSpViewProps) {
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

  const exportContainers = async (full: boolean) => {
    try {
      const summary = filtered.map((c) => ({
        "Container Number": c.subName || c.displayName,
        "Invoice / PO": c._source === "sp" ? c.displayName : "",
        Supplier: c.supplierName,
        Status: c.statusLabel,
        "Import / Invoice Date": formatDisplayDate(c.date),
        "Total (USD)": c.totalUsd,
        Source: c._source === "sp" ? "Supplier Partner" : "ERP",
      }));
      const book = utils.book_new();
      utils.book_append_sheet(book, utils.json_to_sheet(summary), "Containers");
      if (full) {
        const detailRows: Record<string, string | number>[] = [];
        for (const c of filtered) {
          if (c._source === "sp") {
            const native = spContainersList.find((item) => item.id === c.id);
            if (!native) continue;
            const factor = 1 - parseFloat(native.discountPct ?? "0") / 100;
            for (const line of native.lines ?? []) {
              const quantity = parseFloat(line.qty ?? "0");
              const rate = parseFloat(line.unitRateUsd ?? "0") * factor;
              detailRows.push({
                Container: native.containerNumber || "",
                Invoice: native.invoiceNumber || "",
                Supplier: native.supplierName || "",
                "Item Name": line.description || line.articleCode,
                Quantity: quantity,
                "Rate (USD)": rate,
                "Total (USD)": quantity * rate,
              });
            }
            for (const charge of spContainerInvoiceChargeLines(native)) {
              detailRows.push({
                Container: native.containerNumber || "",
                Invoice: native.invoiceNumber || "",
                Supplier: native.supplierName || "",
                "Item Name": charge.description,
                Quantity: 1,
                "Rate (USD)": charge.amountUsd,
                "Total (USD)": charge.amountUsd,
              });
            }
            detailRows.push({
              Container: native.containerNumber || "",
              Invoice: native.invoiceNumber || "",
              Supplier: native.supplierName || "",
              "Item Name": "Recorded Invoice Total",
              Quantity: Number(native.totalQty || 0),
              "Rate (USD)": 0,
              "Total (USD)": Number(native.invoiceTotalUsd || 0),
            });
          } else {
            const response = await fetch("/api/containers/" + c.id, { credentials: "include" });
            if (!response.ok) throw new Error("Cannot export ERP container " + c.displayName);
            const detail = (await response.json()) as {
              pos?: { items?: { itemName?: string; quantity?: string; rate?: string; lineTotal?: string }[] }[];
            };
            for (const po of detail.pos ?? []) {
              for (const item of po.items ?? []) {
                detailRows.push({
                  Container: c.displayName,
                  Invoice: "",
                  Supplier: c.supplierName,
                  "Item Name": item.itemName || "",
                  Quantity: Number(item.quantity || 0),
                  "Rate (USD)": Number(item.rate || 0),
                  "Total (USD)": Number(item.lineTotal || 0),
                });
              }
            }
          }
        }
        utils.book_append_sheet(
          book,
          utils.json_to_sheet(detailRows.length ? detailRows : [{ Message: "No line items" }]),
          "Line Items"
        );
      }
      await writeFile(book, exportFileName(full ? "containers full export" : "containers", "xlsx"));
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };
  return {
    allSpItems,
    canCancel,
    cancelContainer,
    exportContainers,
    filtered,
    formatAmount,
    formatDisplayDate,
    isSpLoading,
    offloadedContainers,
    otwContainers,
    reason,
    recordChanges,
    searchTerm,
    selectedContainer,
    setLocation,
    setReason,
    setSearchTerm,
    setSelectedContainer,
    setStatusFilter,
    setSupplierFilter,
    statusFilter,
    supplierFilter,
    supplierNames,
    totalValue,
    visibleContainers,
  };
}
