import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Package, Truck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { SpOffloadDialog } from "@/components/SpOffloadDialog";
import { queryClient } from "@/lib/queryClient";
import type { useContainerDetailModel } from "../useContainerDetailModel";
import { spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";

type Model = ReturnType<typeof useContainerDetailModel>;
const poWords = {
  "en": {
    "back": "Back to Containers",
    "extras": "Extra Charges & Discount"
  },
  "fr": {
    "back": "Retour aux conteneurs",
    "extras": "Frais supplémentaires et remise"
  },
  "ar": {
    "back": "العودة إلى الحاويات",
    "extras": "الرسوم الإضافية والخصم"
  }
} as const;
const amount = (value: number | string | null | undefined) => {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number.isFinite(n) ? n : 0,
  );
};
const qty = (value: number | string | null | undefined) =>
  Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** ERP-style PO presentation, backed only by the original SP container.
 * The PO is a read-only representation of the invoice's stock lines:
 * do not fabricate ERP purchase_orders or duplicate the OTW journal.
 */
export function ContainerDetailSpView({ model }: { model: Model }) {
  const { language } = useApplicationLanguage();
  const copy = poWords[language];
  const { containerId, spContainerData, spDetailLoading, showSpOffloadDialog, setShowSpOffloadDialog } = model;
  if (spDetailLoading) {
    return <div className="space-y-4">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>;
  }
  if (!spContainerData || "message" in spContainerData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <Package className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Container not found</h2>
        <Link href="/containers"><Button variant="outline"><ArrowLeft className="h-4 w-4 mr-1" /> {copy.back}</Button></Link>
      </div>
    );
  }

  const spc = spContainerData;
  const items = spc.lines || [];
  const grossTotal = items.reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.unitRateUsd || 0), 0);
  const totalQty = items.reduce((sum, line) => sum + Number(line.qty || 0), 0);
  const discountPct = Number(spc.discountPct || 0);
  const discountAmount = grossTotal * discountPct / 100;
  const charges = spContainerInvoiceChargeLines(spc);
  const chargesTotal = charges.reduce((sum, c) => sum + c.amountUsd, 0);
  const invoiceTotal = Number(spc.invoiceTotalUsd || 0);
  const isOffloaded = spc.status === "offloaded";
  const isCancelled = spc.status === "cancelled";
  const poNumber = spc.invoiceNumber || `PO for ${spc.containerNumber || spc.id}`;

  return (
    <div className="space-y-4 sm:space-y-6" data-testid="sp-container-detail">
      <div className="flex items-center gap-2">
        <Link href="/containers">
          <Button variant="ghost" size="icon" aria-label="Back to containers" data-testid="button-sp-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <PageHeader title={`Container ${spc.containerNumber || spc.id}`}
            subtitle={`${spc.supplierName || "Internal source"} · Invoice date ${spc.invoiceDate}`} />
        </div>
        <Badge variant="outline" className={isOffloaded ? "text-green-600 border-green-600/40" : isCancelled ? "" : "text-blue-600 border-blue-600/40"}>
          {isOffloaded ? "OFFLOADED" : isCancelled ? "CANCELLED" : "OTW"}
        </Badge>
        {!isOffloaded && !isCancelled && (
          <Button onClick={() => setShowSpOffloadDialog(true)} data-testid="button-sp-offload">
            <Truck className="h-4 w-4 mr-2" /> Offload Container
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</p>
          <p className="text-base font-semibold">{spc.supplierName || "—"}</p>
          <p className="text-xs text-muted-foreground">Invoice {poNumber}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Items Total</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="text-items-total">{amount(grossTotal)}</p>
          <p className="text-xs text-muted-foreground">{items.length} items in 1 PO · {qty(totalQty)} units</p>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Grand Total</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="text-grand-total">{amount(invoiceTotal)}</p>
          {chargesTotal !== 0 && <p className="text-xs text-muted-foreground">Includes {amount(chargesTotal)} in invoice charges</p>}
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Purchase Orders</h2>
        <Card className="overflow-hidden" data-testid="sp-purchase-order">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 bg-muted/40 border-b">
            <div className="flex gap-3 items-center">
              <span className="font-semibold text-sm" data-testid={`text-po-${poNumber}`}>{poNumber}</span>
              <span className="text-xs text-muted-foreground">USD</span>
            </div>
            <span className="text-sm font-semibold tabular-nums">{amount(grossTotal)}</span>
          </div>
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item Name</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((line) => {
                  const lineTotal = Number(line.qty || 0) * Number(line.unitRateUsd || 0);
                  return (
                    <TableRow key={line.id} data-testid={`row-sp-line-${line.id}`}>
                      <TableCell className="font-medium py-2">{line.description || line.articleCode}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{qty(line.qty)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{amount(line.unitRateUsd)}</TableCell>
                      <TableCell className={`text-right tabular-nums font-semibold ${lineTotal < 0 ? "text-red-500" : ""}`}>{amount(lineTotal)}</TableCell>
                    </TableRow>
                  );
                })}
                {items.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-8">No line items</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          <div className="md:hidden divide-y">
            {items.map((line) => (
              <div key={line.id} className="px-4 py-3 text-sm">
                <p className="font-medium mb-2">{line.description || line.articleCode}</p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="block text-muted-foreground">Qty</span>{qty(line.qty)}</div>
                  <div><span className="block text-muted-foreground">Rate</span>{amount(line.unitRateUsd)}</div>
                  <div><span className="block text-muted-foreground">Total</span>
                    <strong>{amount(Number(line.qty || 0) * Number(line.unitRateUsd || 0))}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {(charges.length > 0 || Math.abs(discountAmount) >= 0.005) && (
        <div className="rounded-lg border bg-card overflow-hidden" data-testid="sp-container-invoice-charges">
          <div className="px-4 py-3 bg-muted/40 border-b">
            <p className="text-sm font-semibold">{copy.extras}</p>
          </div>
          <Table>
            <TableHeader><TableRow><TableHead>Misc Type</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
            <TableBody>
              {charges.map((c) => (
                <TableRow key={c.kind}>
                  <TableCell>{c.description}</TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${c.amountUsd < 0 ? "text-red-500" : ""}`}>{amount(c.amountUsd)}</TableCell>
                </TableRow>
              ))}
              {Math.abs(discountAmount) >= 0.005 && (
                <TableRow>
                  <TableCell>Discount ({discountPct.toFixed(2)}%)</TableCell>
                  <TableCell className="text-right tabular-nums font-medium text-red-500">{amount(-Math.abs(discountAmount))}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 space-y-2" data-testid="sp-po-summary">
        <p className="text-xs font-semibold text-muted-foreground uppercase">Summary</p>
        <div className="text-sm space-y-2">
          <div className="flex justify-between"><span>Items Total</span><span className="tabular-nums">{amount(grossTotal)}</span></div>
          {chargesTotal !== 0 && <div className="flex justify-between"><span>Charges Total</span><span className="tabular-nums">{amount(chargesTotal)}</span></div>}
          {Math.abs(discountAmount) >= 0.005 && <div className="flex justify-between text-red-500"><span>Discount</span><span className="tabular-nums">{amount(-Math.abs(discountAmount))}</span></div>}
          <div className="flex justify-between"><span>Total Qty</span><span className="tabular-nums">{qty(totalQty)}</span></div>
          <div className="flex justify-between font-bold border-t pt-2"><span>Grand Total</span><span className="text-base tabular-nums">{amount(invoiceTotal)}</span></div>
        </div>
      </div>

      {(spc.prepaid || []).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Prepaid Charges</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(spc.prepaid || []).map((p) => (
              <div key={p.id} className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm">
                <span>{p.chargeType} · {p.notes || p.agentName || "—"}</span>
                <span className="tabular-nums">{amount(p.amountPaidUsd)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {isOffloaded && spc.offload && (
        <Card>
          <CardHeader><CardTitle className="text-base">Offload Summary</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">Offload Date: {spc.offload.offloadDate}</p>
            {(spc.offloadCharges || []).map((c) => (
              <div key={c.id} className="flex justify-between gap-2 border-b pb-2 text-sm">
                <span>{c.chargeType} · {c.description || ""}</span>
                <span>{amount(c.amountUsd)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {spc.notes && <Card><CardContent className="pt-4 text-sm">{spc.notes}</CardContent></Card>}

      <SpOffloadDialog
        open={showSpOffloadDialog}
        onOpenChange={setShowSpOffloadDialog}
        container={spc}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${containerId}`] });
          queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
        }}
      />
    </div>
  );
}
