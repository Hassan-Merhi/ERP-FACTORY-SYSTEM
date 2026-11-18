import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, HandCoins, Calendar, User } from "lucide-react";
import { OffloadDialog } from "@/components/OffloadDialog";
import { ContainerDetailDialog1 } from "./ContainerDetailDialog1";
import { ContainerDetailPriceImportDialog } from "./ContainerDetailPriceImportDialog";
import type { useContainerDetailModel } from "../useContainerDetailModel";
import PropertiesIntercompanyContainerWorkflow from "../PropertiesIntercompanyContainerWorkflow";
import LinkedDestinationContainerEditor from "../LinkedDestinationContainerEditor";
import { ContainerDetailFreightDialog } from "./ContainerDetailFreightDialog";
import { useContainerDetailErpViewModel, deriveContainerErpView } from "./ContainerDetailErpViewModel";
import { ContainerErpSellDialog } from "./ContainerErpSellDialog";
import { ContainerErpPurchaseOrders } from "./ContainerErpPurchaseOrders";
import { ContainerErpHeader } from "./ContainerErpHeader";

export type Model = ReturnType<typeof useContainerDetailModel>;
export function ContainerDetailErpView({ model }: { model: Model }) {
  const m = useContainerDetailErpViewModel({ model });
  // Defensive guard: by this point isSupplierPartner is false (handled above) and the
  // earlier `!containerData && !isSupplierPartner` check already returned if missing,
  // but TS can't infer that across the two branches — this re-confirms it for display only.
  if (!m.containerData) return null;

  const containerData = m.containerData;
  const v = deriveContainerErpView({ containerData, m });

  return (
    <div className="space-y-5">
      {/* ── Page header ── */}
      <ContainerErpHeader m={m} v={v} containerData={m.containerData} />

      {m.isPropertiesContainer && <PropertiesIntercompanyContainerWorkflow containerId={v.container.id} />}
      {!m.isPropertiesContainer && <LinkedDestinationContainerEditor containerId={v.container.id} />}

      {m.containerSale && (
        <Card className="border-green-500">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HandCoins className="h-5 w-5 text-green-600" />
              Container Sold
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sold to</p>
                <p className="font-semibold" data-testid="text-sale-customer">
                  {m.saleCustomer?.legalName || "Unknown Customer"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sale Date</p>
                <p className="font-semibold" data-testid="text-sale-date">
                  {m.formatDisplayDate(m.containerSale.saleDate)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sale Price</p>
                <p className="font-semibold" data-testid="text-sale-price">
                  {m.formatAmount(m.containerSale.containerCost)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Commission</p>
                <p className="font-semibold" data-testid="text-sale-commission">
                  {m.formatAmount(m.containerSale.commission)}
                </p>
              </div>
            </div>
            <div className="pt-2 border-t">
              <p className="text-sm text-muted-foreground">Total Amount</p>
              <p className="text-xl font-bold" data-testid="text-sale-total">
                {m.formatAmount(m.containerSale.totalAmount)}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Supplier</p>
          <p className="text-base font-semibold leading-tight" data-testid="text-supplier">
            {v.supplier ? v.supplier.legalName : "—"}
          </p>
          {v.supplier && <p className="text-xs text-muted-foreground">{v.supplier.code}</p>}
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Items Total</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="text-items-total">
            {m.formatAmount(v.itemsTotal)}
          </p>
          <p className="text-xs text-muted-foreground">
            {v.pos.reduce((sum: number, po) => sum + po.items.length, 0)} items in {v.pos.length} PO(s)
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Grand Total</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="text-grand-total">
            {m.formatAmount(v.grandTotal)}
          </p>
          {v.chargesTotal > 0 && (
            <p className="text-xs text-muted-foreground">
              Including {m.formatAmount(Math.abs(v.chargesTotal))} in charges
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-0.5">Purchase Orders</h2>
      </div>
      <ContainerErpPurchaseOrders m={m} v={v} />

      {v.charges.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <div className="px-4 py-3 bg-muted/40 border-b">
            <p className="text-sm font-semibold">Extra Charges</p>
          </div>
          <table className="w-full text-sm min-w-[360px]">
            <thead>
              <tr className="border-b">
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Misc Type
                </th>
                <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {v.charges.map((c, i: number) => (
                <tr key={i} className="border-t first:border-t-0">
                  <td className="px-4 py-2.5 text-muted-foreground">{c.chargeType}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                    {m.formatAmount(parseFloat(c.amount || "0"))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/20">
                <td className="px-4 py-2.5 font-semibold">Total Charges</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{m.formatAmount(v.chargesTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</p>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Items Total</span>
            <span className="tabular-nums font-medium">{m.formatAmount(v.itemsTotal)}</span>
          </div>
          {v.chargesTotal !== 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Charges Total</span>
              <span className="tabular-nums font-medium">{m.formatAmount(v.chargesTotal)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Qty</span>
            <span className="tabular-nums font-medium">{v.fmtQty(v.totalBales)}</span>
          </div>
          <div className="flex justify-between pt-2 border-t font-bold">
            <span>Grand Total</span>
            <span className="tabular-nums text-base">{m.formatAmount(v.grandTotal)}</span>
          </div>
        </div>
      </div>

      {!m.isPropertiesContainer && (
        <OffloadDialog
          open={m.showOffloadDialog}
          onOpenChange={m.setShowOffloadDialog}
          containerId={parseInt(m.containerId!)}
          containerNumber={v.container.containerNumber}
          totalBales={v.totalBales}
        />
      )}

      <ContainerErpSellDialog m={m} v={v} />

      <Dialog open={m.showUploadDialog} onOpenChange={m.setShowUploadDialog}>
        <DialogContent data-testid="dialog-upload-doc">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>Upload a document for this container</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Document Type</label>
              <Select value={m.uploadDocTypeId} onValueChange={m.setUploadDocTypeId}>
                <SelectTrigger data-testid="select-doc-type">
                  <SelectValue placeholder="Select document type" />
                </SelectTrigger>
                <SelectContent>
                  {(m.docsData?.docTypes || []).map((dt) => (
                    <SelectItem key={dt.id} value={String(dt.id)}>
                      {dt.label}
                      {dt.isRequired ? " *" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">File</label>
              <Input
                type="file"
                ref={m.fileInputRef}
                onChange={(e) => m.setUploadFile(e.target.files?.[0] || null)}
                data-testid="input-doc-file"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => m.setShowUploadDialog(false)} data-testid="button-cancel-upload">
                Cancel
              </Button>
              <Button
                disabled={!m.uploadDocTypeId || !m.uploadFile || m.uploadDocMutation.isPending}
                onClick={() =>
                  m.uploadDocMutation.mutate({ docTypeId: Number(m.uploadDocTypeId), file: m.uploadFile! })
                }
                data-testid="button-submit-upload"
              >
                {m.uploadDocMutation.isPending ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ContainerDetailFreightDialog model={model} isPropertiesContainer={m.isPropertiesContainer} />

      <ContainerDetailDialog1 model={model} />
      <DeleteConfirmDialog
        open={!!m.pendingDelete}
        onOpenChange={(open) => {
          if (!open) m.setPendingDelete(null);
        }}
        onConfirm={() => {
          m.pendingDelete?.();
          m.setPendingDelete(null);
        }}
      />

      <ContainerDetailPriceImportDialog model={model} />
    </div>
  );
}
