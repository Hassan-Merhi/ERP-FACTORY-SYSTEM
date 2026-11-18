import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { VoucherWithItems } from "./posdaybook/types";
import { posDaybookTransferText } from "@shared/posDaybookTransferText";

/** No pricing, internal valuation, account entries or edit actions in POS transfer details. */
export function POSDaybookTransferDetails({ transfer }: { transfer: VoucherWithItems["transferData"] }) {
  if (!transfer) {
    return <div className="py-6 text-center text-muted-foreground">{posDaybookTransferText.unavailable}</div>;
  }

  return (
    <div className="space-y-4" data-testid="pos-daybook-transfer-details">
      <div className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground">{posDaybookTransferText.from}</span>{" "}
          <span data-testid="pos-transfer-source">{transfer.sourceLocationName || posDaybookTransferText.multiSource}</span>
        </div>
        <div>
          <span className="text-muted-foreground">{posDaybookTransferText.to}</span>{" "}
          <span data-testid="pos-transfer-destination">{transfer.destinationLocationName}</span>
        </div>
        <div>
          <span className="text-muted-foreground">{posDaybookTransferText.status}</span>{" "}
          <Badge variant="secondary">{transfer.inventoryApplied ? posDaybookTransferText.stockApplied : posDaybookTransferText.stockPending}</Badge>
        </div>
        {transfer.notes && (
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">{posDaybookTransferText.notes}</span> {transfer.notes}
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{posDaybookTransferText.item}</TableHead>
              <TableHead className="hidden sm:table-cell">{posDaybookTransferText.source}</TableHead>
              <TableHead className="text-right">{posDaybookTransferText.quantity}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfer.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="font-medium">{item.stockItemName || item.stockItemCode}</div>
                  <div className="text-xs text-muted-foreground">{item.stockItemCode}</div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{item.sourceLocationName || transfer.sourceLocationName}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.quantity} {item.stockItemUom || ""}
                </TableCell>
              </TableRow>
            ))}
            {transfer.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  {posDaybookTransferText.noItems}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
