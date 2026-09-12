import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { FileText, Search, Pencil, Check, Trash2, X } from "lucide-react";
import { format } from "date-fns";

interface OptionalVoucher {
  id: number;
  voucherType: string;
  voucherDate?: string;
  description?: string | null;
  totalAmount?: string;
}

export default function OptionalVouchers() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [typeFilter, setTypeFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [search, setSearch] = useState("");
  const [finalizeVoucherId, setFinalizeVoucherId] = useState<number | null>(null);
  const [deleteVoucherId, setDeleteVoucherId] = useState<number | null>(null);

  const queryParams = new URLSearchParams();
  if (typeFilter && typeFilter !== "all") queryParams.set("type", typeFilter);
  if (startDate) queryParams.set("startDate", startDate);
  if (endDate) queryParams.set("endDate", endDate);
  if (search) queryParams.set("search", search);
  const queryString = queryParams.toString();
  const queryUrl = `/api/vouchers/optional${queryString ? `?${queryString}` : ""}`;

  const {
    data: vouchers = [],
    isLoading,
    isError,
    error,
  } = useQuery<OptionalVoucher[]>({
    queryKey: ["/api/vouchers/optional", typeFilter, startDate, endDate, search],
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
      await apiRequest("POST", `/api/vouchers/${id}/finalize`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers/optional"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
      toast({ title: "Voucher Finalized", description: "The voucher has been posted successfully." });
      setFinalizeVoucherId(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vouchers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers/optional"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      toast({ title: "Voucher Deleted", description: "The voucher has been deleted." });
      setDeleteVoucherId(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
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

  const grandTotal = vouchers.reduce((sum, v) => sum + parseFloat(v.totalAmount || "0"), 0);

  const handleEdit = (v: OptionalVoucher) => {
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

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          title="Optional Vouchers"
          subtitle="Draft vouchers pending edit or finalization"
          icon={<FileText className="h-5 w-5" />}
        />
        {!isLoading && !isError && vouchers.length > 0 && (
          <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="text-voucher-count">
            {vouchers.length} draft{vouchers.length !== 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      {/* ── Filter row ── */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40" data-testid="select-voucher-type">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {voucherTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1 min-w-44">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search voucher #, notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-vouchers"
          />
        </div>

        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="w-40"
          data-testid="input-start-date"
        />

        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="w-40"
          data-testid="input-end-date"
        />

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="button-clear-filters"
            className="gap-1.5"
          >
            <X className="h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {/* ── Stats pill bar ── */}
      {!isLoading && !isError && vouchers.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Drafts</span>
            <span className="font-semibold">{vouchers.length}</span>
          </div>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <span className="text-muted-foreground">Grand Total</span>
            <span className="font-semibold" data-testid="text-optional-grand-total">
              {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      )}

      {/* ── States ── */}
      {isLoading ? (
        <div className="border rounded-xl overflow-hidden">
          <div className="h-11 bg-muted/40 border-b" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-20 ml-auto" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div
          className="flex flex-col items-center justify-center py-20 gap-3 text-destructive"
          data-testid="text-optional-vouchers-error"
        >
          <FileText className="h-10 w-10 opacity-30" />
          <p className="text-sm font-medium">Failed to load optional vouchers</p>
          <p className="text-xs text-muted-foreground">{error?.message}</p>
        </div>
      ) : vouchers.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground"
          data-testid="text-no-optional-vouchers"
        >
          <FileText className="h-10 w-10 opacity-25" />
          <p className="text-sm font-medium">No optional vouchers found</p>
          <p className="text-xs">{hasFilters ? "Try adjusting your filters" : "All vouchers have been finalized"}</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block border rounded-xl overflow-auto max-h-[calc(100vh-280px)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-30 bg-muted/40">
                <tr className="h-11 bg-muted/40 border-b">
                  <th className="text-left px-4 font-medium">Date</th>
                  <th className="text-left px-4 font-medium">Type</th>
                  <th className="text-left px-4 font-medium">Description</th>
                  <th className="text-right px-4 font-medium">Total</th>
                  <th className="text-right px-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr
                    key={v.id}
                    className="border-t hover:bg-muted/30 transition-colors"
                    data-testid={`row-voucher-${v.id}`}
                  >
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {v.voucherDate ? format(new Date(v.voucherDate + "T00:00:00"), "dd MMM yyyy") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={getTypeBadgeVariant(v.voucherType)} className="text-xs">
                        {v.voucherType}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-sm">{v.description || "—"}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      {parseFloat(v.totalAmount || "0").toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEdit(v)}
                          data-testid={`button-edit-voucher-${v.id}`}
                          className="gap-1.5 h-8"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setFinalizeVoucherId(v.id)}
                          data-testid={`button-finalize-voucher-${v.id}`}
                          className="gap-1.5 h-8 text-green-700 dark:text-green-400"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Finalize
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteVoucherId(v.id)}
                          data-testid={`button-delete-voucher-${v.id}`}
                          className="h-8 w-8 text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/40">
                  <td colSpan={3} className="px-4 py-2 text-sm font-medium">
                    Total ({vouchers.length} voucher{vouchers.length !== 1 ? "s" : ""})
                  </td>
                  <td
                    className="px-4 py-2 text-right tabular-nums font-semibold"
                    data-testid="text-optional-grand-total-footer"
                  >
                    {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {vouchers.map((v) => (
              <div key={v.id} className="border rounded-xl p-4 space-y-2" data-testid={`card-voucher-${v.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">
                      {v.voucherDate ? format(new Date(v.voucherDate + "T00:00:00"), "dd MMM yyyy") : "—"}
                    </div>
                    {v.description && <div className="text-xs text-muted-foreground mt-0.5">{v.description}</div>}
                  </div>
                  <Badge variant={getTypeBadgeVariant(v.voucherType)} className="text-xs shrink-0">
                    {v.voucherType}
                  </Badge>
                </div>
                <div className="flex items-center justify-end text-sm">
                  <span className="font-semibold tabular-nums">
                    {parseFloat(v.totalAmount || "0").toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-1 pt-1 border-t">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleEdit(v)}
                    data-testid={`button-edit-mobile-${v.id}`}
                    className="gap-1.5 flex-1 h-8"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFinalizeVoucherId(v.id)}
                    data-testid={`button-finalize-mobile-${v.id}`}
                    className="gap-1.5 flex-1 h-8 text-green-700 dark:text-green-400"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Finalize
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setDeleteVoucherId(v.id)}
                    data-testid={`button-delete-mobile-${v.id}`}
                    className="h-8 w-8 text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <ConfirmDialog
        open={finalizeVoucherId !== null}
        onOpenChange={(open) => !open && setFinalizeVoucherId(null)}
        title="Finalize Voucher"
        description="Are you sure you want to finalize this voucher? Once posted, it will be included in all financial calculations and reports. This cannot be undone easily."
        confirmText={finalizeMutation.isPending ? "Finalizing..." : "Finalize"}
        loading={finalizeMutation.isPending}
        onConfirm={() => {
          if (finalizeVoucherId) finalizeMutation.mutate(finalizeVoucherId);
        }}
      />

      <ConfirmDialog
        open={deleteVoucherId !== null}
        onOpenChange={(open) => !open && setDeleteVoucherId(null)}
        title="Delete Voucher"
        description="Are you sure you want to delete this optional voucher? This action will remove it from the system."
        tone="destructive"
        confirmText={deleteMutation.isPending ? "Deleting..." : "Delete"}
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteVoucherId) deleteMutation.mutate(deleteVoucherId);
        }}
      />
    </div>
  );
}
