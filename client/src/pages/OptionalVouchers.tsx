import { ErpListFilters, ErpListTable, ErpConfirmDialog, ErpRecordAction, useErpDateFormat } from "@/erp-core";
import { erpCompanyDataKey, erpRequestUrl, invalidateErpDataFamilies } from "@/erp-core/erpData";
import { TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { FileText, Pencil, Check, Trash2, X, Eye } from "lucide-react";
import { OptionalVoucherDetailsDialog } from "./optional-vouchers/OptionalVoucherDetailsDialog";
import type { Voucher } from "./daybook/types";

export default function OptionalVouchers() {
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
      toast({ title: "Error", description: error.message, variant: "destructive" });
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

  return (
    <div className="flex flex-col gap-4 sm:p-4 md:p-6">
      {/* ── Header ── */}
      <PageHeader
        title="Optional Vouchers"
        subtitle="Draft vouchers pending edit or finalization"
        icon={<FileText className="h-5 w-5" />}
        meta={
          !isLoading &&
          !isError &&
          vouchers.length > 0 && (
            <Badge variant="secondary" className="text-xs sm:text-sm px-2 py-0.5" data-testid="text-voucher-count">
              {vouchers.length} draft{vouchers.length !== 1 ? "s" : ""}
            </Badge>
          )
        }
      />

      {/* Shared ERP search, desktop filters and phone filter sheet. */}
      <ErpListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search voucher #, notes..."
        searchTestId="input-search-vouchers"
        mobileFilters
        filterLabel="Optional voucher filters"
        activeFilterCount={[typeFilter !== "all", !!startDate, !!endDate].filter(Boolean).length}
        onResetFilters={clearFilters}
        data-testid="optional-voucher"
        filters={
          <>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40" data-testid="select-voucher-type">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {voucherTypes.map((type) => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="w-40"
              data-testid="input-start-date"
            />
            <Input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="w-40"
              data-testid="input-end-date"
            />
          </>
        }
        actions={
          hasFilters ? (
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-filters" className="gap-1.5">
              <X className="h-4 w-4" />
              Clear
            </Button>
          ) : undefined
        }
      />

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
          <ErpListTable
            pageKey="optional-vouchers"
            companyId={selectedCompany?.id}
            scrollLabel="Optional vouchers"
            wrapperClassName="hidden md:block phone-land:hidden rounded-xl"
          >
              <TableHeader className="sticky top-0 z-30 bg-muted">
                <TableRow className="h-11 bg-muted/40 border-b">
                  <TableHead className="text-left px-4 font-medium">Date</TableHead>
                  <TableHead className="text-left px-4 font-medium">Type</TableHead>
                  <TableHead className="text-left px-4 font-medium">Description</TableHead>
                  <TableHead className="text-right px-4 font-medium">Total</TableHead>
                  <TableHead className="text-right px-4 font-medium">Actions</TableHead>
                </TableRow>
              </TableHeader>
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
              <TableFooter>
                <TableRow className="border-t bg-muted/40">
                  <TableCell colSpan={3} className="px-4 py-2 text-sm font-medium">
                    Total ({vouchers.length} voucher{vouchers.length !== 1 ? "s" : ""})
                  </TableCell>
                  <TableCell
                    className="px-4 py-2 text-right tabular-nums font-semibold"
                    data-testid="text-optional-grand-total-footer"
                  >
                    {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
          </ErpListTable>

          {/* Mobile cards */}
          <div className="md:hidden phone-land:block space-y-2">
            {orderedVouchers.map((v) => (
              <div key={v.id} className="border rounded-xl p-4 space-y-2" data-testid={`card-voucher-${v.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">
                      {v.voucherDate ? formatShortDate(v.voucherDate) : "—"}
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
                  <ErpRecordAction
                    size="icon"
                    variant="ghost"
                    onClick={() => setViewVoucher(v)}
                    data-testid={`button-view-mobile-${v.id}`}
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
                    data-testid={`button-edit-mobile-${v.id}`}
                    className="gap-1.5 flex-1 h-8"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </ErpRecordAction>
                  <ErpRecordAction
                    size="sm"
                    variant="ghost"
                    onClick={() => setFinalizeVoucherId(v.id)}
                    data-testid={`button-finalize-mobile-${v.id}`}
                    className="gap-1.5 flex-1 h-8 text-green-700 dark:text-green-400"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Finalize
                  </ErpRecordAction>
                  <ErpRecordAction
                    size="icon"
                    variant="ghost"
                    onClick={() => setDeleteVoucherId(v.id)}
                    data-testid={`button-delete-mobile-${v.id}`}
                    className="h-8 w-8 text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </ErpRecordAction>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <OptionalVoucherDetailsDialog
        voucher={viewVoucher}
        open={viewVoucher !== null}
        onOpenChange={(open) => {
          if (!open) setViewVoucher(null);
        }}
        onEdit={(voucher) => {
          setViewVoucher(null);
          handleEdit(voucher);
        }}
      />

      <ErpConfirmDialog
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

      <ErpConfirmDialog
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
