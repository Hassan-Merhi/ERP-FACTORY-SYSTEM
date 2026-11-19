// Extracted from ./IntercompanyLifecycle.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, newKey, useIntercompanyLifecycleContentState } from "./useIntercompanyLifecycleContentState";

export function IntercompanyLifecycleContentCard({
  query,
  setArrivalVerified,
  setCancelKey,
  setCashUnchanged,
  setCostVerified,
  setDeleteBothConfirmed,
  setEvidence,
  setGoodsNotReceived,
  setLocationId,
  setReason,
  setReceiptKey,
  setRedistributed,
  setSelectedTradeId,
  visibleTrades,
}: Pick<
  ReturnType<typeof useIntercompanyLifecycleContentState>,
  | "query"
  | "setArrivalVerified"
  | "setCancelKey"
  | "setCashUnchanged"
  | "setCostVerified"
  | "setDeleteBothConfirmed"
  | "setEvidence"
  | "setGoodsNotReceived"
  | "setLocationId"
  | "setReason"
  | "setReceiptKey"
  | "setRedistributed"
  | "setSelectedTradeId"
  | "visibleTrades"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Linked container lifecycle</CardTitle>
        <CardDescription>
          No action here changes or removes a physical Properties container. Received stock cannot be canceled without a
          separate audited inventory and COGS correction.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isError && (
          <p role="alert" className="text-destructive">
            Cannot access the verified linked trade records.
          </p>
        )}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Container</TableHead>
                <TableHead>ERP destination</TableHead>
                <TableHead>Confirmed cost</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleTrades.map((row) => (
                <TableRow key={row.tradeId}>
                  <TableCell>{row.containerNumber}</TableCell>
                  <TableCell>Company #{row.destinationCompanyId}</TableCell>
                  <TableCell>{money(row.landedCost)}</TableCell>
                  <TableCell>
                    {row.canceled
                      ? "Canceled " + row.canceled.date
                      : row.received
                        ? "Received " + row.received.date
                        : row.state === "active"
                          ? "In transit"
                          : row.state}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedTradeId(row.tradeId);
                        setLocationId("");
                        setEvidence("");
                        setReason("");
                        setArrivalVerified(false);
                        setCostVerified(false);
                        setGoodsNotReceived(false);
                        setCashUnchanged(false);
                        setRedistributed(false);
                        setReceiptKey(newKey());
                        setCancelKey(newKey());
                        setDeleteBothConfirmed(false);
                      }}
                    >
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
