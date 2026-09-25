/**
 * Voucher detail dialog for the All Daybook page.
 *
 * Owns the dialog frame, the date/type/description header and the footer
 * actions, and dispatches the entries panel by voucher type. The dispatch
 * order is the original if-chain from TransactionJournal.tsx, so a voucher
 * that fails a panel's guard still falls through to the ledger listing.
 */
import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate } from "../utils";
import { voucherEditPath } from "@/pages/daybook/voucherEditRoute";
import { VoucherTypeBadge } from "./VoucherTypeBadge";
import { createDetailFormatters } from "./detail/panelTypes";
import { PaymentReceiptPanel } from "./detail/PaymentReceiptPanel";
import { SalesPanel } from "./detail/SalesPanel";
import { StockAdjustmentPanel, StockTransferPanel } from "./detail/StockMovementPanel";
import { LedgerEntriesPanel, PurchasePanel } from "./detail/PurchasePanel";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

const TRANSFER_TYPES = ["Stock Transfer", "StockTransfer", "Transfer"];
const ADJUSTMENT_TYPES = ["Production", "Consumption", "Mixed"];

function DetailPanels({ model }: { model: TransactionJournalModel }) {
  const { detailData, viewEntries, viewPurchaseOrder, viewPurchaseItems, entryBalances } = model;
  const { fmt, fmtNum } = createDetailFormatters(model.formatCashAmount);
  const vtype = detailData!.voucher.voucherType;

  // Categorise rows
  const stockRows = viewEntries.filter((e) => e.isStockItem);
  const ledgerRows = viewEntries.filter((e) => !e.isStockItem);

  if (vtype === "Payment" || vtype === "Receipt") {
    return <PaymentReceiptPanel vtype={vtype} viewEntries={viewEntries} entryBalances={entryBalances} fmt={fmt} />;
  }

  if ((vtype === "Sales" || vtype === "POS") && stockRows.length > 0) {
    return (
      <SalesPanel
        stockRows={stockRows}
        ledgerRows={ledgerRows}
        entryBalances={entryBalances}
        fmt={fmt}
        fmtNum={fmtNum}
      />
    );
  }

  if (TRANSFER_TYPES.includes(vtype) && stockRows.length > 0) {
    return <StockTransferPanel stockRows={stockRows} fmt={fmt} fmtNum={fmtNum} />;
  }

  if (ADJUSTMENT_TYPES.includes(vtype) && stockRows.length > 0) {
    return <StockAdjustmentPanel vtype={vtype} stockRows={stockRows} fmt={fmt} fmtNum={fmtNum} />;
  }

  if (vtype === "Purchase" && viewPurchaseOrder) {
    return (
      <PurchasePanel
        po={viewPurchaseOrder}
        companyId={detailData!.voucher.companyId}
        viewEntries={viewEntries}
        viewPurchaseItems={viewPurchaseItems}
        entryBalances={entryBalances}
        openInCompany={model.openInCompany}
        fmt={fmt}
        fmtNum={fmtNum}
      />
    );
  }

  // Default: ledger entries (Payment / Receipt / Journal / etc.)
  const entries = viewEntries.length > 0 ? viewEntries : detailData!.entries;
  return <LedgerEntriesPanel entries={entries} entryBalances={entryBalances} fmt={fmt} />;
}

export function JournalDetailDialog({ model }: { model: TransactionJournalModel }) {
  const { detailData, detailLoading, viewEntriesLoading } = model;
  return (
    <Dialog open={model.drawerOpen} onOpenChange={model.setDrawerOpen}>
      <DialogContent className="w-full max-w-[95vw] md:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Voucher Details</DialogTitle>
          <DialogDescription>View voucher information</DialogDescription>
        </DialogHeader>

        {detailLoading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : detailData ? (
          <div className="flex flex-col gap-4">
            {/* Date + Type + Company row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Date</p>
                <p className="text-sm font-semibold">{fmtDate(detailData.voucher.voucherDate)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Type</p>
                <div className="flex items-center gap-1 flex-wrap">
                  <VoucherTypeBadge type={detailData.voucher.voucherType} />
                  {detailData.voucher.optional && (
                    <Badge variant="outline" className="text-xs">
                      Optional
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Description */}
            {(detailData.voucher.description || detailData.voucher.narration) && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description</p>
                <p className="text-sm">{detailData.voucher.description || detailData.voucher.narration}</p>
              </div>
            )}

            {/* Rich entries panel — mirrors normal Daybook view structure */}
            {viewEntriesLoading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <DetailPanels model={model} />
            )}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">Could not load voucher details.</div>
        )}
        {/* Footer actions: a DialogFooter, so the phone sheet keeps them pinned while entries scroll
            (the same View Voucher behaviour as Daybook). */}
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button variant="outline" onClick={() => model.setDrawerOpen(false)} data-testid="button-detail-close">
            Close
          </Button>
          {detailData && !detailLoading && (
            <Button
              variant="default"
              onClick={() => {
                model.setDrawerOpen(false);
                // Same destination as Daybook's Edit; the Daybook remains the fallback for types
                // without an editor, where it explains that editing is not supported.
                model.openInCompany(
                  detailData.voucher.companyId,
                  voucherEditPath(detailData.voucher) ?? `/daybook?voucherId=${detailData.voucher.id}`
                );
              }}
              data-testid="button-detail-edit"
            >
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
