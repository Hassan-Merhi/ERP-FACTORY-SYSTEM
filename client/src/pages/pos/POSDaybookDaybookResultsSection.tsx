// Extracted from ./POSDaybook.tsx to keep that module under the source-size cap.
import { format, isValid } from "date-fns";
import { Eye, EyeOff, MessageCircle, Printer, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DaybookResults, DaybookShowHiddenButton, DaybookTableState } from "@/components/daybook/DaybookFrame";
import { PaginationBar } from "@/components/PaginationBar";
import { ErpListTable } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePOSDaybookState } from "./usePOSDaybookState";
import { formatPosVoucherAmount } from "./posdaybook/zmwDisplay";

export function POSDaybookDaybookResultsSection({
  currentUser,
  error,
  formatCashAmount,
  hiddenRowIds,
  isError,
  isLoading,
  isLoadingUser,
  isPOS,
  navigate,
  pagination,
  printVoucherId,
  recordChanges,
  refetch,
  searchedVouchers,
  setFilter,
  setHiddenRowIds,
  setPrintVoucherId,
  setSelectedVoucher,
  showHidden,
  showState,
  visibleVouchers,
  whatsappMutation,
}: Pick<
  ReturnType<typeof usePOSDaybookState>,
  | "currentUser"
  | "error"
  | "formatCashAmount"
  | "hiddenRowIds"
  | "isError"
  | "isLoading"
  | "isLoadingUser"
  | "isPOS"
  | "navigate"
  | "pagination"
  | "printVoucherId"
  | "recordChanges"
  | "refetch"
  | "searchedVouchers"
  | "setFilter"
  | "setHiddenRowIds"
  | "setPrintVoucherId"
  | "setSelectedVoucher"
  | "showHidden"
  | "showState"
  | "visibleVouchers"
  | "whatsappMutation"
>) {
  return (
    <DaybookResults
      count={searchedVouchers.length}
      tools={
        <DaybookShowHiddenButton
          showHidden={showHidden}
          onToggle={() => setFilter("showHidden", (value) => !value)}
          hiddenCount={hiddenRowIds.size}
        />
      }
      footer={
        !showState && (
          <PaginationBar
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={searchedVouchers.length}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setPage}
            noun="transactions"
          />
        )
      }
    >
      {showState ? (
        <DaybookTableState
          isLoading={isLoadingUser || isLoading}
          errorMessage={isError ? (error instanceof Error ? error.message : "Failed to load POS transactions") : null}
          onRetry={() => void refetch()}
          isEmpty={searchedVouchers.length === 0}
          emptyTitle={visibleVouchers.length === 0 ? "No transactions found" : "No matching transactions"}
          emptyDescription={
            visibleVouchers.length === 0
              ? "There are no visible POS sales or transfers for the selected date."
              : "Try a different search term or transaction type."
          }
          emptyAction={
            isPOS ? (
              <Button className="mt-3 rounded-xl shadow-sm" onClick={() => navigate("/pos")}>
                <ShoppingCart className="mr-2 h-4 w-4" />
                New Sale
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ErpListTable pageKey="pos-daybook" scrollLabel="POS daybook">
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Time</TableHead>
              <TableHead className="whitespace-nowrap">Receipt #</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="hidden sm:table-cell">Location</TableHead>
              <TableHead className="whitespace-nowrap text-right">Amount</TableHead>
              <TableHead className="hidden md:table-cell">Notes</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.paginate(searchedVouchers).map((voucher) => {
              const canResend = !isPOS || (voucher.userId != null && String(voucher.userId) === String(currentUser?.id));
              const isSending = whatsappMutation.isPending && whatsappMutation.variables?.id === voucher.id;
              const isPrinting = printVoucherId === voucher.id;
              const isHidden = hiddenRowIds.has(voucher.id);
              return (
                <TableRow key={voucher.id} className={isHidden && showHidden ? "opacity-50" : ""}>
                  <TableCell className="whitespace-nowrap text-xs font-medium tabular-nums">
                    {voucher.createdAt && isValid(new Date(voucher.createdAt))
                      ? format(new Date(voucher.createdAt), "MMM dd, hh:mm a")
                      : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm font-semibold tabular-nums">
                    {voucher.voucherNumber}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        voucher.voucherType === "Sales" ? "pos-daybook-sale-badge" : "pos-daybook-transfer-badge"
                      }
                    >
                      {voucher.voucherType === "Sales" ? "Sale" : "Transfer"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {voucher.locationName || `Location ${voucher.locationId}`}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">
                    {voucher.voucherType === "Sales" ? formatPosVoucherAmount(voucher, formatCashAmount) : "—"}
                  </TableCell>
                  <TableCell
                    className="hidden max-w-[220px] truncate text-muted-foreground md:table-cell"
                    title={voucher.description || ""}
                  >
                    {voucher.description || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {voucher.voucherType === "Sales" && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 rounded-lg"
                            disabled={isPrinting}
                            onClick={() => setPrintVoucherId(voucher.id)}
                            title="Print receipt"
                            aria-label={`Print receipt ${voucher.voucherNumber}`}
                          >
                            <Printer className={`h-4 w-4 ${isPrinting ? "animate-pulse" : ""}`} />
                          </Button>
                          {recordChanges.allowed && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 rounded-lg"
                              disabled={!canResend || isSending}
                              onClick={() => whatsappMutation.mutate(voucher)}
                              title={canResend ? "Resend receipt on WhatsApp" : "You can only resend your own sales"}
                              aria-label={`Resend ${voucher.voucherNumber} on WhatsApp`}
                            >
                              <MessageCircle className={`h-4 w-4 ${isSending ? "animate-pulse" : ""}`} />
                            </Button>
                          )}
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-lg"
                        onClick={() => setSelectedVoucher(voucher)}
                        title="View transaction in popup"
                        aria-label={`View ${voucher.voucherNumber}`}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-lg"
                        onClick={() =>
                          setHiddenRowIds((previous) => {
                            const next = new Set(previous);
                            if (next.has(voucher.id)) next.delete(voucher.id);
                            else next.add(voucher.id);
                            return next;
                          })
                        }
                        title={isHidden ? "Unhide row" : "Hide row"}
                        aria-label={`${isHidden ? "Unhide" : "Hide"} ${voucher.voucherNumber}`}
                      >
                        {isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </ErpListTable>
      )}
    </DaybookResults>
  );
}
