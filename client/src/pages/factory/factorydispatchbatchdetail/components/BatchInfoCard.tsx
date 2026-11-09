/**
 * BatchInfoCard — extracted presentational sub-component.
 *
 * Extracted from FactoryDispatchBatchDetail.tsx during the god-file split.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BatchDetail } from "../types";

type BatchInfoCardProps = Pick<BatchDetail, "batch" | "customerName" | "proforma" | "finalInvoice">;

export function BatchInfoCard({ batch, customerName, proforma, finalInvoice }: BatchInfoCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Batch Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Customer</span>
          <span className="font-medium">{customerName || "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Proforma</span>
          <span>{proforma?.name || "None"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Currency</span>
          <span>{batch.currency}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Price Mode</span>
          <span>{batch.priceMode === "PER_KG" ? "Per Kg" : "Per Bale"}</span>
        </div>
        {batch.destination && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Destination</span>
            <span>{batch.destination}</span>
          </div>
        )}
        {batch.notes && (
          <div>
            <span className="text-muted-foreground text-xs">Notes</span>
            <p className="text-sm mt-0.5">{batch.notes}</p>
          </div>
        )}
        {finalInvoice && (
          <div className="flex justify-between pt-1 border-t">
            <span className="text-muted-foreground">Invoice</span>
            <span className="font-mono font-medium text-green-700 dark:text-green-400">
              {finalInvoice.invoiceNumber}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
