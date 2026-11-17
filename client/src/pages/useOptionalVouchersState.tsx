// Extracted from ./OptionalVouchers.tsx to keep that module under the source-size cap.
import { ErpRecordAction, useErpDateFormat } from "@/erp-core";
import { erpCompanyDataKey, erpRequestUrl, invalidateErpDataFamilies } from "@/erp-core/erpData";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Check, Eye, Pencil, Trash2 } from "lucide-react";
import type { Voucher } from "./daybook/types";

export function useOptionalVouchersState() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { formatShortDate } = useErpDateFormat();
  const [typeFilter, setTypeFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [search, setSearch] = useState("");
  const [finalizeVoucherId, setFinalizeVoucherId] = useState<number | null>(null);
  const [deleteVoucherId, setDeleteVoucherId] = useState<number | null>(null);
  const [viewVoucher, setViewVoucher] = useState<Voucher | null>(null);

  const queryUrl = erpRequestUrl("/api/vouchers/optional", {
    type: typeFilter !== "all" ? typeFilter : undefined,
    startDate,
    endDate,
    search,
  });

  const {
    data: vouchers = [],
    isLoading,
    isError,
    error,
  } = useQuery<Voucher[]>({
    queryKey: erpCompanyDataKey(queryUrl, selectedCompany?.id),
    enabled: selectedCompany?.id != null,
    queryFn: async () => {
      const res = await apiRequest("GET", queryUrl);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || "Failed to load optional vouchers");
      }
      return res.json();
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (id: number) => {
      // Sales are stock documents: the legacy finalize endpoint flips only
      // the header and never reissues the POS inventory/COGS. Use the atomic
      // optional toggle to restore the original stock and accounting instead.
      const voucher = vouchers.find((row) => row.id === id);
      if (voucher?.voucherType === "Sales") {
        await apiRequest("PATCH", `/api/vouchers/${id}/optional`, { optional: false });
      } else {
        await apiRequest("POST", `/api/vouchers/${id}/finalize`);
      }
    },
    onSuccess: () => {
      void invalidateErpDataFamilies(queryClient, [
        "/api/vouchers/optional",
        "/api/vouchers",
        "/api/daybook",
        "/api/inventory-by-location",
        "/api/location-summary",
        "/api/stock-transfers/list",
      ]);
      toast({ title: "Voucher Finalized", description: "The voucher has been posted successfully." });
      setFinalizeVoucherId(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vouchers/${id}`);
    },
    onSuccess: () => {
      void invalidateErpDataFamilies(queryClient, ["/api/vouchers/optional", "/api/vouchers", "/api/daybook"]);
      toast({ title: "Voucher Deleted", description: "The voucher has been deleted." });
      setDeleteVoucherId(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const clearFilters = () => {
    setTypeFilter("all");
    setStartDate("");
    setEndDate("");
    setSearch("");
  };

  const hasFilters = typeFilter !== "all" || startDate || endDate || search;

  const voucherTypes = [
    "Sales",
    "Payment",
    "Receipt",
    "Journal",
    "Stock Transfer",
    "Purchase",
    "Contra",
    "Credit Note",
    "Debit Note",
  ];

  const getTypeBadgeVariant = (type: string): "default" | "secondary" | "outline" => {
    switch (type) {
      case "Sales":
        return "default";
      case "Payment":
        return "secondary";
      case "Receipt":
        return "outline";
      default:
        return "secondary";
    }
  };

  const orderedVouchers = useMemo(
    () =>
      [...vouchers].sort((a, b) => {
        const dateCompare = a.voucherDate.localeCompare(b.voucherDate);
        return dateCompare !== 0 ? dateCompare : a.id - b.id;
      }),
    [vouchers]
  );

  const grandTotal = orderedVouchers.reduce((sum, v) => sum + parseFloat(v.totalAmount || "0"), 0);

  const handleEdit = (v: Voucher) => {
    const voucherTypeMap: Record<string, string> = {
      Payment: "payment",
      Receipt: "receipt",
      Journal: "journal",
      Consumption: "adjustment",
      Production: "adjustment",
      Mixed: "adjustment",
      StockTransfer: "transfer",
      "Stock Transfer": "transfer",
      "Credit Note": "creditnote",
      "Debit Note": "creditnote",
    };
    const tab = voucherTypeMap[v.voucherType];
    if (tab) {
      navigate(`/vouchers?edit=${v.id}&tab=${tab}`);
    } else {
      navigate(`/vouchers/${v.id}/edit`);
    }
  };
  return {
    clearFilters,
    deleteMutation,
    deleteVoucherId,
    endDate,
    error,
    finalizeMutation,
    finalizeVoucherId,
    formatShortDate,
    getTypeBadgeVariant,
    grandTotal,
    handleEdit,
    hasFilters,
    isError,
    isLoading,
    orderedVouchers,
    search,
    selectedCompany,
    setDeleteVoucherId,
    setEndDate,
    setFinalizeVoucherId,
    setSearch,
    setStartDate,
    setTypeFilter,
    setViewVoucher,
    startDate,
    typeFilter,
    viewVoucher,
    voucherTypes,
    vouchers,
  };
}

export function OptionalVouchersTableBodySection({
  formatShortDate,
  getTypeBadgeVariant,
  handleEdit,
  orderedVouchers,
  setDeleteVoucherId,
  setFinalizeVoucherId,
  setViewVoucher,
}: Pick<
  ReturnType<typeof useOptionalVouchersState>,
  | "formatShortDate"
  | "getTypeBadgeVariant"
  | "handleEdit"
  | "orderedVouchers"
  | "setDeleteVoucherId"
  | "setFinalizeVoucherId"
  | "setViewVoucher"
>) {
  return (
    <TableBody>
      {orderedVouchers.map((v) => (
        <TableRow
          key={v.id}
          className="border-t hover:bg-muted/30 transition-colors"
          data-testid={`row-voucher-${v.id}`}
        >
          <TableCell className="px-4 py-3 text-muted-foreground whitespace-nowrap">
            {v.voucherDate ? formatShortDate(v.voucherDate) : "—"}
          </TableCell>
          <TableCell className="px-4 py-3">
            <Badge variant={getTypeBadgeVariant(v.voucherType)} className="text-xs">
              {v.voucherType}
            </Badge>
          </TableCell>
          <TableCell className="px-4 py-3 text-muted-foreground text-sm">{v.description || "—"}</TableCell>
          <TableCell className="px-4 py-3 text-right tabular-nums font-medium">
            {parseFloat(v.totalAmount || "0").toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            })}
          </TableCell>
          <TableCell className="px-4 py-3">
            <div className="flex items-center justify-end gap-1">
              <ErpRecordAction
                size="icon"
                variant="ghost"
                onClick={() => setViewVoucher(v)}
                data-testid={`button-view-voucher-${v.id}`}
                className="h-8 w-8"
                title="View voucher details"
                aria-label="View voucher details"
              >
                <Eye className="h-3.5 w-3.5" />
              </ErpRecordAction>
              <ErpRecordAction
                size="sm"
                variant="ghost"
                onClick={() => handleEdit(v)}
                data-testid={`button-edit-voucher-${v.id}`}
                className="gap-1.5 h-8"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </ErpRecordAction>
              <ErpRecordAction
                size="sm"
                variant="ghost"
                onClick={() => setFinalizeVoucherId(v.id)}
                data-testid={`button-finalize-voucher-${v.id}`}
                className="gap-1.5 h-8 text-green-700 dark:text-green-400"
              >
                <Check className="h-3.5 w-3.5" />
                Finalize
              </ErpRecordAction>
              <ErpRecordAction
                size="icon"
                variant="ghost"
                onClick={() => setDeleteVoucherId(v.id)}
                data-testid={`button-delete-voucher-${v.id}`}
                className="h-8 w-8 text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </ErpRecordAction>
            </div>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  );
}
