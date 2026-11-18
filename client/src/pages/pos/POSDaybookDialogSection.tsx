// Extracted from ./POSDaybook.tsx to keep that module under the source-size cap.
import { Lock, MessageCircle, Pencil, Undo2, X } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { posDaybookEditEligibility, posDaybookEditMessages } from "@shared/posDaybookEditPolicy";
import { posDaybookTransferText } from "@shared/posDaybookTransferText";
import { POSDaybookEditPanel } from "./POSDaybookEditPanel";
import { POSDaybookTransferDetails } from "./POSDaybookTransferDetails";
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
  currentUser,
  canSeeProfitCost,
  detailsLoading,
  formatCashAmount,
  isAdminOrOwner,
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
  | "currentUser"
  | "canSeeProfitCost"
  | "detailsLoading"
  | "formatCashAmount"
  | "isAdminOrOwner"
  | "optionalMutation"
  | "recordChanges"
  | "selectedVoucher"
  | "setOptionalVoucher"
  | "setPrintVoucherId"
  | "setSelectedVoucher"
  | "voucherDetails"
  | "whatsappMutation"
>) {
  const [editing, setEditing] = useState(false);
  const isTransfer = Boolean(selectedVoucher && selectedVoucher.voucherType !== "Sales");
  const { selectedCompany } = useCompany();
  const { data: liveAccess } = useQuery<{
    role: string;
    daybookEditDays: number;
    posViewOnly: boolean;
    businessDate: string;
  }>({
    queryKey: ["/api/pos/daybook-edit-status", selectedCompany?.id, selectedVoucher?.id],
    enabled: Boolean(selectedCompany?.id && selectedVoucher),
    queryFn: async () => {
      const response = await fetch("/api/pos/daybook-edit-status", { credentials: "include" });
      if (!response.ok) throw new Error(posDaybookEditMessages.accessCheckFailed);
      return response.json();
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const posUser = (liveAccess?.role ?? currentUser?.role) === "POS";
  const permission = posDaybookEditEligibility({
    originalDate: selectedVoucher?.voucherDate || "",
    businessDate: liveAccess?.businessDate ?? "",
    editDays: Number(liveAccess?.daybookEditDays ?? 0),
    isOwnSale: Boolean(selectedVoucher && String(selectedVoucher.userId) === String(currentUser?.id)),
    viewOnly: Boolean(liveAccess?.posViewOnly ?? currentUser?.posViewOnly),
  });
  const canEditSelected = Boolean(
    selectedVoucher?.voucherType === "Sales" &&
    !selectedVoucher.optional &&
    recordChanges.allowed &&
    (posUser ? Boolean(liveAccess && permission.allowed) : canEditDaybook)
  );
  return (
    <Dialog
      open={Boolean(selectedVoucher)}
      onOpenChange={(open) => {
        if (!open) {
          setEditing(false);
          setSelectedVoucher(null);
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isTransfer ? posDaybookTransferText.heading : editing ? "Edit POS Sale" : "POS Sale Details"} -{" "}
            {selectedVoucher?.voucherNumber}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto">
          {editing && voucherDetails ? (
            <POSDaybookEditPanel
              key={voucherDetails.id}
              sale={voucherDetails}
              onCancel={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          ) : detailsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-14 w-full" />
              ))}
            </div>
          ) : voucherDetails && isTransfer ? (
            <POSDaybookTransferDetails transfer={voucherDetails.transferData} />
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
        {!editing && <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => setSelectedVoucher(null)}>
            <X className="mr-2 h-4 w-4" />
            Close
          </Button>
          {!isTransfer && <ExportButton
            kind="print"
            variant="outline"
            disabled={!voucherDetails}
            onClick={() => voucherDetails && setPrintVoucherId(voucherDetails.id)}
          />}
          {!isTransfer && recordChanges.allowed && (
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
          {!isTransfer && recordChanges.allowed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      disabled={!canEditSelected || !voucherDetails}
                      onClick={() => setEditing(true)}
                      data-testid="pos-daybook-edit-sale"
                    >
                      {canEditSelected ? <Pencil className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                      Edit Transaction
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canEditSelected && (
                  <TooltipContent>
                    {posUser && permission.reason === "outside-window"
                      ? "This sale is outside your configured Daybook editing window."
                      : "You do not have permission to edit this sale."}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )}
        </div>}
      </DialogContent>
    </Dialog>
  );
}
