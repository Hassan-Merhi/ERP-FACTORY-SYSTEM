// Extracted from ./POSDaybook.tsx to keep that module under the source-size cap.
import { Lock, MessageCircle, Pencil, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/formatNumber";
import { usePOSDaybookState } from "./usePOSDaybookState";
import { formatPosVoucherAmount, formatPosZmwUnitPrice, formatPosZmwLineTotal } from "./posdaybook/zmwDisplay";

export function POSDaybookDialogSection({
  canEditDaybook,
  canSeeProfitCost,
  detailsLoading,
  formatCashAmount,
  isAdminOrOwner,
  navigate,
  optionalMutation,
  recordChanges,
  selectedVoucher,
  setOptionalVoucher,
  setPrintVoucherId,
  setSelectedVoucher,
  voucherDetails,
  whatsappMutation,
}: Pick<
  ReturnType<typeof usePOSDaybookState>,
  | "canEditDaybook"
  | "canSeeProfitCost"
  | "detailsLoading"
  | "formatCashAmount"
  | "isAdminOrOwner"
  | "navigate"
  | "optionalMutation"
  | "recordChanges"
  | "selectedVoucher"
  | "setOptionalVoucher"
  | "setPrintVoucherId"
  | "setSelectedVoucher"
  | "voucherDetails"
  | "whatsappMutation"
>) {
  return (
    <Dialog open={Boolean(selectedVoucher)} onOpenChange={(open) => !open && setSelectedVoucher(null)}>
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>POS Sale Details - {selectedVoucher?.voucherNumber}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto">
          {detailsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-14 w-full" />
              ))}
            </div>
          ) : voucherDetails ? (
            <div className="space-y-4">
              <div className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
                <div>
                  <span className="text-muted-foreground">Receipt:</span> {voucherDetails.voucherNumber}
                </div>
                <div>
                  <span className="text-muted-foreground">Date:</span> {voucherDetails.voucherDate}
                </div>
                <div>
                  <span className="text-muted-foreground">Location:</span>{" "}
                  {voucherDetails.locationName || `Location ${voucherDetails.locationId}`}
                </div>
                <div>
                  <span className="text-muted-foreground">Type:</span> {voucherDetails.voucherType}
                </div>
                {voucherDetails.customerName && (
                  <div>
                    <span className="text-muted-foreground">Customer:</span> {voucherDetails.customerName}
                  </div>
                )}
                {voucherDetails.isCreditSale && <div className="font-semibold">Credit sale</div>}
                {voucherDetails.description && (
                  <div className="sm:col-span-2">
                    <span className="text-muted-foreground">Notes:</span> {voucherDetails.description}
                  </div>
                )}
              </div>
              <div className="table-responsive">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      {canSeeProfitCost && <TableHead className="text-right">Cost</TableHead>}
                      {canSeeProfitCost && <TableHead className="text-right">Profit</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(voucherDetails.salesItems || []).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.stockItemName || `Item ${item.stockItemId}`}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatNumber(Number(item.quantity || 0), 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatPosZmwUnitPrice(voucherDetails, item.sellingPrice, formatCashAmount)}
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {formatPosZmwLineTotal(voucherDetails, item.quantity, item.sellingPrice, formatCashAmount)}
                        </TableCell>
                        {canSeeProfitCost && (
                          <TableCell className="text-right font-mono">
                            {formatCashAmount(Number(item.costPrice || 0))}
                          </TableCell>
                        )}
                        {canSeeProfitCost && (
                          <TableCell className="text-right font-mono">
                            {formatCashAmount(Number(item.profit || 0))}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex justify-end text-lg font-semibold">
                Total: {formatPosVoucherAmount(voucherDetails, formatCashAmount)}
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">Sale details could not be loaded.</div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => setSelectedVoucher(null)}>
            <X className="mr-2 h-4 w-4" />
            Close
          </Button>
          <ExportButton
            kind="print"
            variant="outline"
            disabled={!voucherDetails}
            onClick={() => voucherDetails && setPrintVoucherId(voucherDetails.id)}
          />
          {recordChanges.allowed && (
            <Button
              variant="outline"
              disabled={!voucherDetails || whatsappMutation.isPending}
              onClick={() => voucherDetails && whatsappMutation.mutate(voucherDetails)}
            >
              <MessageCircle className="mr-2 h-4 w-4" />
              Resend WhatsApp
            </Button>
          )}
          {recordChanges.allowed &&
            isAdminOrOwner &&
            selectedVoucher?.voucherType === "Sales" &&
            !selectedVoucher.optional && (
              <Button
                variant="outline"
                disabled={optionalMutation.isPending}
                onClick={() => setOptionalVoucher(selectedVoucher)}
                data-testid="pos-daybook-make-optional"
              >
                <Undo2 className="mr-2 h-4 w-4" />
                Make Optional
              </Button>
            )}
          {recordChanges.allowed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      disabled={!canEditDaybook || !selectedVoucher}
                      onClick={() => selectedVoucher && navigate(`/pos/edit/${selectedVoucher.id}`)}
                    >
                      {canEditDaybook ? <Pencil className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                      Edit Transaction
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canEditDaybook && <TooltipContent>Editing is disabled in Settings for this user.</TooltipContent>}
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
