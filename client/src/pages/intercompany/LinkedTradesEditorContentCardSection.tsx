// Extracted from ./LinkedTradesEditor.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, useLinkedTradesEditorContentState } from "./useLinkedTradesEditorContentState";
export { LinkedTradesEditorContentCardSection2 } from "./LinkedTradesEditorContentCardSection2";

export function LinkedTradesEditorContentCardSection({
  copy,
  detail,
  editMutation,
  editTrades,
  embedded,
  list,
  postingDate,
  reason,
  rows,
  selected,
  setPostingDate,
  setReason,
  setRows,
  setSelected,
  validScopedSelection,
}: Pick<
  ReturnType<typeof useLinkedTradesEditorContentState>,
  | "copy"
  | "detail"
  | "editMutation"
  | "editTrades"
  | "embedded"
  | "list"
  | "postingDate"
  | "reason"
  | "rows"
  | "selected"
  | "setPostingDate"
  | "setReason"
  | "setRows"
  | "setSelected"
  | "validScopedSelection"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Linked purchase orders</CardTitle>
        <CardDescription>
          Choose a container in this company, then edit quantities, rates or item descriptions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.isLoading && <p>Loading linked containers…</p>}
        {list.isError && (
          <p role="alert" className="text-sm text-destructive">
            Linked PO editing is restricted to authorized company Owners, Admins and Developers. Invoice-scoped editors
            can use the invoice section below.
          </p>
        )}
        {embedded && list.isSuccess && editTrades.length === 0 && (
          <p className="text-sm text-muted-foreground">{copy.noActiveLinked}</p>
        )}
        {!embedded && (
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
            {editTrades.map((t) => (
              <Button
                key={t.tradeId}
                type="button"
                variant={selected === t.tradeId ? "default" : "outline"}
                onClick={() => setSelected(t.tradeId)}
              >
                {t.containerNumber} · {money(t.landedCost)}
              </Button>
            ))}
          </div>
        )}
        {detail.isError && (
          <p role="alert" className="text-destructive">
            Could not load the linked PO; refresh the company and container selection.
          </p>
        )}
        {validScopedSelection && detail.data && (
          <>
            <div className="rounded-md border p-3 text-sm">
              <strong>{detail.data.containerNumber}</strong> · Revision {detail.data.version} · Confirmed landed cost{" "}
              {money(detail.data.landedCost)} · Status {detail.data.physicalStatus}
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Original PO</TableHead>
                    <TableHead>Item description</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Rate (USD)</TableHead>
                    <TableHead>Original line total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.lines.map((line) => {
                    const edited = rows.find((row) => row.lineLinkId === line.lineLinkId);
                    return (
                      <TableRow key={line.lineLinkId}>
                        <TableCell>{line.sourcePoNumber}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={"Description for " + line.sourcePoNumber + " line " + line.lineLinkId}
                            value={edited?.itemName ?? line.itemName}
                            onChange={(e) =>
                              setRows((old) =>
                                old.map((row) =>
                                  row.lineLinkId === line.lineLinkId ? { ...row, itemName: e.target.value } : row
                                )
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={"Quantity for line " + line.lineLinkId}
                            value={edited?.quantity ?? line.quantity}
                            inputMode="decimal"
                            onChange={(e) =>
                              setRows((old) =>
                                old.map((row) =>
                                  row.lineLinkId === line.lineLinkId ? { ...row, quantity: e.target.value } : row
                                )
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={"Rate for line " + line.lineLinkId}
                            value={edited?.rate ?? line.rate}
                            inputMode="decimal"
                            onChange={(e) =>
                              setRows((old) =>
                                old.map((row) =>
                                  row.lineLinkId === line.lineLinkId ? { ...row, rate: e.target.value } : row
                                )
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>{money(line.lineTotal)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ic-edit-date">Adjustment posting date</Label>
                <Input
                  id="ic-edit-date"
                  type="date"
                  value={postingDate}
                  onChange={(e) => setPostingDate(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="ic-edit-reason">Reason / source evidence</Label>
                <Input id="ic-edit-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            </div>
            <Button
              disabled={editMutation.isPending || detail.data.physicalStatus !== "OTW"}
              onClick={() => editMutation.mutate()}
            >
              {editMutation.isPending ? "Validating both companies…" : "Synchronize this linked purchase order"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
