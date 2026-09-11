import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, Trash2, Check, Send, Plus } from "lucide-react";

import type { Location, PosDraftSummary, PosStockPrintRow } from "./posTypes";

export interface POSDialogsProps {
  zeroStockAlert: boolean;
  setZeroStockAlert: (open: boolean) => void;
  zeroStockItem: string;
  showDraftDialog: boolean;
  setShowDraftDialog: (open: boolean) => void;
  drafts: PosDraftSummary[];
  handleLoadDraft: (id: number) => void;
  deleteDraftMutation: { isPending?: boolean; mutate: (id: number) => void };
  showPrintDialog: boolean;
  setShowPrintDialog: (open: boolean) => void;
  editVoucherId?: string;
  handleNewSale: () => void;
  navigate: (path: string) => void;
  activeLocation: Location | null;
  invoiceWaStatus: string;
  handleSendInvoiceWhatsApp: () => void;
  sendingInvoiceWhatsApp: boolean;
  stockWaStatus: string;
  handleSendStockWhatsApp: () => void;
  sendingWhatsApp: boolean;
  handlePrint: () => void;
  isCreditSale: boolean;
  showStockPrompt: boolean;
  setShowStockPrompt: (open: boolean) => void;
  stockInventoryLoading: boolean;
  handleStockPrint: () => void;
  handleSendWhatsAppReport: () => void;
  stockInventory: PosStockPrintRow[];
  stockPrintRef: React.RefObject<HTMLDivElement | null>;
}

export function POSDialogs({
  zeroStockAlert,
  setZeroStockAlert,
  zeroStockItem,
  showDraftDialog,
  setShowDraftDialog,
  drafts,
  handleLoadDraft,
  deleteDraftMutation,
  showPrintDialog,
  setShowPrintDialog,
  editVoucherId,
  handleNewSale,
  navigate,
  activeLocation,
  invoiceWaStatus,
  handleSendInvoiceWhatsApp,
  sendingInvoiceWhatsApp,
  stockWaStatus,
  handleSendStockWhatsApp,
  sendingWhatsApp,
  handlePrint,
  isCreditSale: _isCreditSale,
  showStockPrompt,
  setShowStockPrompt,
  stockInventoryLoading,
  handleStockPrint,
  handleSendWhatsAppReport,
  stockInventory,
  stockPrintRef,
}: POSDialogsProps) {
  return (
    <>
      {/* Zero Stock Alert Dialog */}
      <AlertDialog open={zeroStockAlert} onOpenChange={setZeroStockAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Out of Stock
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium">{zeroStockItem}</span> cannot be added because it has 0 stock available.
              Please check inventory or select a different item.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={() => setZeroStockAlert(false)} data-testid="button-close-alert">
              OK
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Draft Restore Dialog */}
      <AlertDialog open={showDraftDialog} onOpenChange={setShowDraftDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Drafts</AlertDialogTitle>
            <AlertDialogDescription>
              You have {drafts.length} unsaved transaction drafts for this location.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[300px] overflow-y-auto space-y-2 my-4">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className="flex items-center justify-between p-3 border rounded-md hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0 mr-4 cursor-pointer" onClick={() => handleLoadDraft(draft.id)}>
                  {(() => {
                    const count = parseInt(String(draft.item_count ?? draft.itemCount ?? 0), 10);
                    const totalQty = parseFloat(String(draft.total_qty ?? draft.totalQty ?? 0));
                    const totalAmount = parseFloat(String(draft.total_amount ?? draft.totalAmount ?? 0));
                    return (
                      <>
                        <p className="text-sm font-medium">
                          {count === 0
                            ? "Empty draft"
                            : `${count} item${count !== 1 ? "s" : ""} · ${totalQty % 1 === 0 ? totalQty : totalQty.toFixed(2)} qty`}
                        </p>
                        {count > 0 && (
                          <p className="text-xs text-muted-foreground font-medium">
                            Total: $
                            {totalAmount.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {new Date(
                            String(draft.updated_at || draft.updatedAt || draft.created_at || draft.createdAt || "")
                          ).toLocaleString()}
                        </p>
                      </>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleLoadDraft(draft.id)}
                    data-testid={`button-load-draft-${draft.id}`}
                  >
                    <Check className="h-4 w-4 text-green-600" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteDraftMutation.mutate(draft.id)}
                    disabled={deleteDraftMutation.isPending}
                    data-testid={`button-delete-draft-${draft.id}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setShowDraftDialog(false)} data-testid="button-close-drafts">
              Close
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Print Dialog */}
      <AlertDialog
        open={showPrintDialog}
        onOpenChange={(open) => {
          if (!open) {
            if (editVoucherId) setShowPrintDialog(false);
            else handleNewSale();
          }
        }}
      >
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Print Invoice</AlertDialogTitle>
            <AlertDialogDescription>
              Sale has been saved successfully. Would you like to print the invoice?
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (editVoucherId) {
                  setShowPrintDialog(false);
                  navigate("/pos-daybook");
                } else {
                  handleNewSale();
                }
              }}
              data-testid="button-cancel-print"
            >
              Close
            </Button>
            {!editVoucherId && (
              <Button variant="outline" onClick={handleNewSale} className="gap-2" data-testid="button-new-sale-print">
                <Plus className="h-4 w-4" />
                New Sale
              </Button>
            )}
            {activeLocation?.whatsappGroupChatId &&
              (() => {
                if (invoiceWaStatus === "sending") {
                  return (
                    <Button variant="outline" disabled className="gap-2" data-testid="button-invoice-wa-sending">
                      <span className="animate-spin inline-block">
                        <Send className="h-4 w-4" />
                      </span>
                      Sending Invoice…
                    </Button>
                  );
                }
                if (invoiceWaStatus === "sent") {
                  return (
                    <Button
                      variant="outline"
                      disabled
                      className="gap-2 opacity-60"
                      data-testid="button-invoice-wa-sent"
                    >
                      <Send className="h-4 w-4" />
                      Invoice Sent
                    </Button>
                  );
                }
                return (
                  <Button
                    variant="outline"
                    onClick={handleSendInvoiceWhatsApp}
                    disabled={sendingInvoiceWhatsApp}
                    className="gap-2"
                    data-testid="button-send-whatsapp-invoice"
                  >
                    <Send className="h-4 w-4" />
                    {invoiceWaStatus === "failed" ? "Retry Invoice" : "Resend Invoice"}
                  </Button>
                );
              })()}
            {!editVoucherId &&
              (() => {
                const hasWa = !!activeLocation?.whatsappGroupChatId;
                if (stockWaStatus === "sending") {
                  return (
                    <Button variant="outline" disabled className="gap-2" data-testid="button-stock-wa-sending">
                      <span className="animate-spin inline-block">
                        <Send className="h-4 w-4" />
                      </span>
                      Sending Stock…
                    </Button>
                  );
                }
                if (stockWaStatus === "sent") {
                  return (
                    <Button variant="outline" disabled className="gap-2 opacity-60" data-testid="button-stock-wa-sent">
                      <Send className="h-4 w-4" />
                      Stock Sent
                    </Button>
                  );
                }
                if (stockWaStatus === "not_configured") {
                  return (
                    <Button
                      variant="outline"
                      disabled
                      className="gap-2 opacity-60"
                      data-testid="button-stock-wa-none"
                      title="WhatsApp group not configured for this location"
                    >
                      <Send className="h-4 w-4" />
                      No WhatsApp Group
                    </Button>
                  );
                }
                return (
                  <Button
                    variant="outline"
                    onClick={handleSendStockWhatsApp}
                    disabled={sendingWhatsApp || !hasWa}
                    className="gap-2"
                    data-testid="button-send-whatsapp-stock"
                    title={
                      hasWa
                        ? "Send current stock levels to WhatsApp group"
                        : "WhatsApp group not configured for this location"
                    }
                  >
                    <Send className="h-4 w-4" />
                    {stockWaStatus === "failed" ? "Retry Stock" : "Send Stock"}
                  </Button>
                );
              })()}
            <Button onClick={() => handlePrint()} className="gap-2" data-testid="button-confirm-print">
              <Check className="h-4 w-4" />
              Print Now
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Stock Report Prompt Dialog */}
      <AlertDialog open={showStockPrompt} onOpenChange={setShowStockPrompt}>
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Location Stock Report</AlertDialogTitle>
            <AlertDialogDescription>
              View and share current stock levels for {activeLocation?.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="max-h-[300px] overflow-y-auto my-4 border rounded-md">
            {stockInventoryLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading inventory...</div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="border-b">
                    <th className="text-left p-2 font-medium">Item</th>
                    <th className="text-right p-2 font-medium">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {stockInventory.map((item, idx) => (
                    <tr key={idx} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-2">
                        <div className="font-medium">{item.stockItemName}</div>
                        <div className="text-xs text-muted-foreground font-mono">{item.stockItemCode}</div>
                      </td>
                      <td className={`p-2 text-right font-mono ${item.stock <= 0 ? "text-destructive" : ""}`}>
                        {item.stock}
                      </td>
                    </tr>
                  ))}
                  {stockInventory.length === 0 && (
                    <tr>
                      <td colSpan={2} className="p-8 text-center text-muted-foreground">
                        No inventory items found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setShowStockPrompt(false)} data-testid="button-close-stock-report">
              Close
            </Button>
            <Button
              variant="outline"
              onClick={handleSendWhatsAppReport}
              disabled={sendingWhatsApp || !activeLocation?.whatsappGroupChatId}
              className="gap-2"
              data-testid="button-share-stock-wa"
            >
              <Send className="h-4 w-4" />
              Share on WhatsApp
            </Button>
            <Button
              onClick={handleStockPrint}
              disabled={stockInventoryLoading}
              className="gap-2"
              data-testid="button-print-stock-report"
            >
              <Check className="h-4 w-4" />
              Print Report
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden printer template for stock report */}
      <div style={{ display: "none" }}>
        <div
          ref={stockPrintRef as React.RefObject<HTMLDivElement>}
          className="p-8 bg-white text-black"
          style={{ width: "800px", fontFamily: "monospace" }}
        >
          <div className="text-center border-b-2 border-black pb-4 mb-4">
            <h1 className="text-2xl font-bold uppercase">Stock Level Report</h1>
            <p className="text-lg">
              Location: {activeLocation?.name} ({activeLocation?.code})
            </p>
            <p className="text-sm">Printed: {new Date().toLocaleString()}</p>
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="text-left py-2">ITEM DESCRIPTION</th>
                <th className="text-left py-2">CODE</th>
                <th className="text-right py-2">QTY</th>
              </tr>
            </thead>
            <tbody>
              {stockInventory.map((item, idx) => (
                <tr key={idx} className="border-b border-gray-300">
                  <td className="py-2 font-bold">{item.stockItemName}</td>
                  <td className="py-2">{item.stockItemCode}</td>
                  <td className="py-2 text-right font-bold">{item.stock}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-black">
                <td colSpan={2} className="py-2 font-bold text-right">
                  TOTAL UNITS:
                </td>
                <td className="py-2 text-right font-bold">
                  {stockInventory.reduce((sum, item) => sum + (Number(item.stock) || 0), 0)}
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="mt-8 text-center text-sm border-t pt-4">
            <p>*** END OF REPORT ***</p>
          </div>
        </div>
      </div>
    </>
  );
}
