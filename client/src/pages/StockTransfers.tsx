import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowRight, ExternalLink, Pencil, X, ArrowLeftRight, DollarSign, Clock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ErpListFilters, ErpListTable } from "@/erp-core";
import { PeriodFilter } from "@/components/ui/period-filter";
import {
  StockTransfersDialogSection,
  useStockTransfersState,
  type StockTransfersProps,
} from "./useStockTransfersState";

export default function StockTransfers(props: StockTransfersProps) {
  const {
    editNotes,
    editingTransfer,
    filtered,
    formatAmount,
    formatVoucherDate,
    hasActiveFilters,
    hideVoucherNotes,
    isLoading,
    openVoucher,
    pendingCount,
    period,
    recordChanges,
    resetFilters,
    saveNotes,
    search,
    selectedCompany,
    setEditNotes,
    setEditingTransfer,
    setFilter,
    startEdit,
    totalValue,
    transfers,
    updateNotesMutation,
  } = useStockTransfersState(props);

  return (
    <div className="p-4 md:p-6 space-y-5 w-full">
      <PageHeader
        title="Stock Transfers"
        subtitle="All stock movement vouchers between locations"
        icon={<ArrowLeftRight className="h-5 w-5" />}
      />

      {/* Stats pill bar */}
      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <ArrowLeftRight className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Transfers</p>
            {isLoading ? (
              <Skeleton className="h-5 w-10 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none">{transfers.length}</p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <DollarSign className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Total Value</p>
            {isLoading ? (
              <Skeleton className="h-5 w-20 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none font-mono">{formatAmount(totalValue)}</p>
            )}
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex items-center gap-3">
          <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-xs text-muted-foreground leading-none mb-0.5">Pending</p>
            {isLoading ? (
              <Skeleton className="h-5 w-10 mt-0.5" />
            ) : (
              <p className="text-lg font-semibold leading-none">{pendingCount}</p>
            )}
          </div>
        </div>
      </div>

      <ErpListFilters
        search={search}
        onSearchChange={(value) => setFilter("search", value)}
        searchPlaceholder="Search by voucher, location, notes…"
        searchTestId="input-search"
        filters={<PeriodFilter value={period} onChange={(next) => setFilter("period", next)} />}
        actions={
          hasActiveFilters ? (
            <Button variant="outline" size="sm" type="button" onClick={resetFilters} data-testid="button-reset-filters">
              <X className="mr-2 h-4 w-4" />
              Reset filters
            </Button>
          ) : undefined
        }
      />

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ArrowLeftRight className="h-12 w-12 mx-auto mb-4 opacity-40" />
          <p className="text-base font-medium">No transfers found</p>
          <p className="text-sm mt-1">
            {search ? "Try adjusting your search or date range" : "No stock transfers in the selected period"}
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block phone-land:hidden border rounded-xl overflow-hidden">
            <div className="table-responsive">
              <ErpListTable
                pageKey="stock-transfers"
                companyId={selectedCompany?.id}
                scrollLabel="Stock transfer history"
              >
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    {!hideVoucherNotes && <TableHead className="text-xs whitespace-nowrap">Voucher</TableHead>}
                    <TableHead className="text-xs whitespace-nowrap">Date</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Route</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Items</TableHead>
                    <TableHead className="text-xs whitespace-nowrap text-right">Total</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Status</TableHead>
                    {!hideVoucherNotes && <TableHead className="text-xs whitespace-nowrap">Notes</TableHead>}
                    <TableHead className="text-xs whitespace-nowrap text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow
                      key={t.transferId}
                      className="hover-elevate cursor-pointer"
                      onClick={() => openVoucher(t.voucherId)}
                      data-testid={`row-transfer-${t.transferId}`}
                    >
                      {!hideVoucherNotes && (
                        <TableCell className="font-mono text-sm font-medium whitespace-nowrap">
                          {t.voucherNumber}
                        </TableCell>
                      )}
                      <TableCell className="whitespace-nowrap text-sm">{formatVoucherDate(t.voucherDate)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        <span className="flex items-center gap-1.5">
                          <span>{t.sourceLocationName}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span>{t.destinationLocationName}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-sm max-w-52">
                        <TooltipProvider>
                          {(t.stockItemNames ?? []).length === 0 ? (
                            <span className="text-muted-foreground/50 italic">—</span>
                          ) : (t.stockItemNames ?? []).length <= 2 ? (
                            <span>{(t.stockItemNames ?? []).join(", ")}</span>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default underline decoration-dotted underline-offset-2">
                                  {(t.stockItemNames ?? [])[0]}{" "}
                                  <span className="text-muted-foreground text-xs">
                                    +{(t.stockItemNames ?? []).length - 1} more
                                  </span>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs">
                                <ul className="text-xs space-y-0.5">
                                  {(t.stockItemNames ?? []).map((n, i) => (
                                    <li key={i}>{n}</li>
                                  ))}
                                </ul>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums whitespace-nowrap">
                        {formatAmount(t.totalAmount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={t.inventoryApplied ? "default" : "secondary"}
                          className="text-xs whitespace-nowrap"
                        >
                          {t.inventoryApplied ? "Applied" : "Pending"}
                        </Badge>
                      </TableCell>
                      {!hideVoucherNotes && (
                        <TableCell className="max-w-44 text-sm text-muted-foreground truncate">
                          {t.notes || <span className="italic text-muted-foreground/40">—</span>}
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          {recordChanges.allowed && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Edit notes"
                              onClick={() => startEdit(t)}
                              data-testid={`button-edit-${t.transferId}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Open voucher"
                            onClick={() => openVoucher(t.voucherId)}
                            data-testid={`button-open-${t.transferId}`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </ErpListTable>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden phone-land:block space-y-2">
            {filtered.map((t) => (
              <div
                key={t.transferId}
                className="border rounded-xl p-3 cursor-pointer"
                onClick={() => openVoucher(t.voucherId)}
                data-testid={`card-transfer-${t.transferId}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {!hideVoucherNotes && (
                      <div className="font-mono text-xs font-medium text-muted-foreground mb-0.5">
                        {t.voucherNumber}
                      </div>
                    )}
                    <div className="flex items-center gap-1 text-sm font-medium flex-wrap">
                      <span>{t.sourceLocationName}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span>{t.destinationLocationName}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{formatVoucherDate(t.voucherDate)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm font-medium">{formatAmount(t.totalAmount)}</div>
                    <div className="flex items-center justify-end gap-1 mt-1">
                      {t.itemCount > 0 && (
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`text-item-count-mobile-${t.transferId}`}
                        >
                          {t.itemCount} {t.itemCount === 1 ? "item" : "items"}
                        </span>
                      )}
                      <Badge variant={t.inventoryApplied ? "default" : "secondary"} className="text-xs">
                        {t.inventoryApplied ? "Applied" : "Pending"}
                      </Badge>
                    </div>
                  </div>
                </div>
                {((t.stockItemNames ?? []).length > 0 || (!hideVoucherNotes && t.notes)) && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground truncate">
                      {(t.stockItemNames ?? []).join(", ")}
                      {!hideVoucherNotes && t.notes && <span className="ml-1 italic">{t.notes}</span>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {recordChanges.allowed && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Edit notes"
                          onClick={() => startEdit(t)}
                          data-testid={`button-edit-mobile-${t.transferId}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Open voucher"
                        onClick={() => openVoucher(t.voucherId)}
                        data-testid={`button-open-mobile-${t.transferId}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
                {(t.stockItemNames ?? []).length === 0 && (hideVoucherNotes || !t.notes) && (
                  <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      {recordChanges.allowed && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Edit notes"
                          onClick={() => startEdit(t)}
                          data-testid={`button-edit-mobile-${t.transferId}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Open voucher"
                        onClick={() => openVoucher(t.voucherId)}
                        data-testid={`button-open-mobile-${t.transferId}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Edit Notes Dialog */}
      <StockTransfersDialogSection
        editNotes={editNotes}
        editingTransfer={editingTransfer}
        formatAmount={formatAmount}
        formatVoucherDate={formatVoucherDate}
        saveNotes={saveNotes}
        setEditNotes={setEditNotes}
        setEditingTransfer={setEditingTransfer}
        updateNotesMutation={updateNotesMutation}
      />
    </div>
  );
}
