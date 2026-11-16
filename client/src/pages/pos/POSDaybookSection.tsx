// Extracted from ./POSDaybook.tsx to keep that module under the source-size cap.
import { format, isValid } from "date-fns";
import { Eye, EyeOff, MessageCircle, Printer, ReceiptText, Search, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePOSDaybookState } from "./usePOSDaybookState";

export function POSDaybookSection({
  currentUser,
  formatCashAmount,
  hiddenRowIds,
  isLoading,
  isLoadingUser,
  isPOS,
  navigate,
  printVoucherId,
  recordChanges,
  searchedVouchers,
  setFilter,
  setHiddenRowIds,
  setPrintVoucherId,
  setSelectedVoucher,
  setTransactionKind,
  setTransactionSearch,
  showHidden,
  transactionKind,
  transactionSearch,
  visibleVouchers,
  whatsappMutation,
}: Pick<
  ReturnType<typeof usePOSDaybookState>,
  | "currentUser"
  | "formatCashAmount"
  | "hiddenRowIds"
  | "isLoading"
  | "isLoadingUser"
  | "isPOS"
  | "navigate"
  | "printVoucherId"
  | "recordChanges"
  | "searchedVouchers"
  | "setFilter"
  | "setHiddenRowIds"
  | "setPrintVoucherId"
  | "setSelectedVoucher"
  | "setTransactionKind"
  | "setTransactionSearch"
  | "showHidden"
  | "transactionKind"
  | "transactionSearch"
  | "visibleVouchers"
  | "whatsappMutation"
>) {
  return (
    <section className="pos-daybook-transactions" aria-label="Transactions">
      <div className="pos-daybook-toolbar flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Transactions</h2>
          <span className="pos-daybook-count rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
            {searchedVouchers.length}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="pos-daybook-search flex min-h-10 min-w-[170px] flex-1 items-center gap-2 rounded-xl px-3 sm:flex-none">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={transactionSearch}
              onChange={(event) => setTransactionSearch(event.target.value)}
              aria-label="Search POS transactions"
              placeholder="Search transactions..."
              className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground sm:w-44"
              data-testid="pos-daybook-search"
            />
          </label>
          <div
            className="pos-daybook-type-tabs flex shrink-0 items-center gap-0.5 rounded-xl p-1"
            role="group"
            aria-label="Transaction type"
          >
            {(["all", "sales", "transfers"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={transactionKind === kind}
                className="pos-daybook-type-tab rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors"
                onClick={() => setTransactionKind(kind)}
              >
                {kind === "all" ? "All" : kind === "sales" ? "Sales" : "Transfers"}
              </button>
            ))}
          </div>
          <Button
            variant={showHidden ? "secondary" : "outline"}
            size="sm"
            className="min-h-10 rounded-xl"
            onClick={() => setFilter("showHidden", (value) => !value)}
            disabled={hiddenRowIds.size === 0}
          >
            {showHidden ? <Eye className="mr-1.5 h-4 w-4" /> : <EyeOff className="mr-1.5 h-4 w-4" />}
            {showHidden ? "Showing hidden" : "Show hidden"}
          </Button>
        </div>
      </div>

      {isLoadingUser || isLoading ? (
        <div className="space-y-2 p-4" role="status" aria-label="Loading transactions">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : searchedVouchers.length === 0 ? (
        <div className="pos-daybook-empty flex min-h-[300px] flex-col items-center justify-center px-5 py-12 text-center">
          <span className="pos-daybook-empty-icon mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
            <ReceiptText className="h-8 w-8" aria-hidden="true" />
          </span>
          <h3 className="text-base font-semibold">
            {visibleVouchers.length === 0 ? "No transactions found" : "No matching transactions"}
          </h3>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {visibleVouchers.length === 0
              ? "There are no visible POS sales or transfers for the selected date."
              : "Try a different search term or transaction type."}
          </p>
          {isPOS && (
            <Button className="mt-5 rounded-xl shadow-sm" onClick={() => navigate("/pos")}>
              <ShoppingCart className="mr-2 h-4 w-4" />
              New Sale
            </Button>
          )}
        </div>
      ) : (
        <div className="pos-daybook-table-wrap table-responsive">
          <Table>
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
              {searchedVouchers.map((voucher) => {
                const isOwnVoucher = !isPOS || voucher.userId === currentUser?.id;
                const canAct = isOwnVoucher;
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
                      {formatCashAmount(Number(voucher.totalAmount || 0))}
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
                              disabled={!canAct || isPrinting}
                              onClick={() => setPrintVoucherId(voucher.id)}
                              title={canAct ? "Print receipt" : "You can only print your own sales"}
                              aria-label={`Print receipt ${voucher.voucherNumber}`}
                            >
                              <Printer className={`h-4 w-4 ${isPrinting ? "animate-pulse" : ""}`} />
                            </Button>
                            {recordChanges.allowed && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 rounded-lg"
                                disabled={!canAct || isSending}
                                onClick={() => whatsappMutation.mutate(voucher)}
                                title={canAct ? "Resend receipt on WhatsApp" : "You can only resend your own sales"}
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
                          disabled={!canAct}
                          onClick={() => canAct && setSelectedVoucher(voucher)}
                          title={canAct ? "View full sale details" : "You can only view your own sales"}
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
          </Table>
        </div>
      )}
    </section>
  );
}
