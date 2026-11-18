// Extracted from ./LinkedTradesEditor.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, toCents, useLinkedTradesEditorContentState } from "./useLinkedTradesEditorContentState";

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

export function LinkedTradesEditorContentCardSection2({
  chargeReason,
  grantMutation,
  grantRelation,
  grantScope,
  grantee,
  invoice,
  invoiceNumber,
  newAmounts,
  reallocateMutation,
  reallocatedTotal,
  setChargeReason,
  setGrantRelation,
  setGrantScope,
  setGrantee,
  setInvoiceNumber,
  setLookupId,
  setNewAmounts,
}: Pick<
  ReturnType<typeof useLinkedTradesEditorContentState>,
  | "chargeReason"
  | "grantMutation"
  | "grantRelation"
  | "grantScope"
  | "grantee"
  | "invoice"
  | "invoiceNumber"
  | "newAmounts"
  | "reallocateMutation"
  | "reallocatedTotal"
  | "setChargeReason"
  | "setGrantRelation"
  | "setGrantScope"
  | "setGrantee"
  | "setInvoiceNumber"
  | "setLookupId"
  | "setNewAmounts"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review or redistribute a confirmed invoice</CardTitle>
        <CardDescription>
          Confirmed allocations do not automatically change when a container's purchase price changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="ic-find-invoice">Shared invoice ID</Label>
            <Input
              id="ic-find-invoice"
              value={invoiceNumber}
              inputMode="numeric"
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="Invoice ID"
            />
          </div>
          <Button variant="outline" onClick={() => setLookupId(Number(invoiceNumber) || null)}>
            Load verified invoice
          </Button>
        </div>
        {invoice.isError && (
          <p role="alert" className="text-destructive">
            Invoice not found or you do not have Shared Charge Editor access.
          </p>
        )}
        {invoice.data && (
          <>
            <p className="text-sm">
              <strong>{invoice.data.externalInvoiceKey}</strong> · Version {invoice.data.version} · Original face amount{" "}
              {money(invoice.data.faceAmount)}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Container</TableHead>
                  <TableHead>Destination company</TableHead>
                  <TableHead>Revised allocation (USD)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.data.allocations.map((a) => (
                  <TableRow key={a.tradeId}>
                    <TableCell>{a.containerNumber}</TableCell>
                    <TableCell>{a.destinationCompanyId}</TableCell>
                    <TableCell>
                      <Input
                        aria-label={"Reallocate " + a.containerNumber}
                        inputMode="decimal"
                        value={newAmounts[a.tradeId] ?? a.amount}
                        onChange={(e) => setNewAmounts((old) => ({ ...old, [a.tradeId]: e.target.value }))}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-sm">
              Reallocated {money(reallocatedTotal / 100)} of {money(invoice.data.faceAmount)}.
            </p>
            <div>
              <Label htmlFor="ic-allocation-reason">Reason for redistribution</Label>
              <Input id="ic-allocation-reason" value={chargeReason} onChange={(e) => setChargeReason(e.target.value)} />
            </div>
            <Button
              disabled={reallocateMutation.isPending || reallocatedTotal !== toCents(invoice.data.faceAmount)}
              onClick={() => reallocateMutation.mutate()}
            >
              Apply verified allocation changes
            </Button>
            <div className="border-t pt-4 space-y-2">
              <h3 className="font-medium">Grant Shared Charge Editor access</h3>
              <p className="text-xs text-muted-foreground">
                Only an Owner or Developer can grant access to users in the granting company. Default Admin access does
                not include this permission.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <Label htmlFor="ic-grantee">User ID</Label>
                  <Input id="ic-grantee" value={grantee} onChange={(e) => setGrantee(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="ic-grant-relation">Involved company relationship</Label>
                  <select
                    id="ic-grant-relation"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={grantRelation}
                    onChange={(e) => setGrantRelation(e.target.value)}
                  >
                    <option value="">Choose relationship</option>
                    {[...new Set(invoice.data.allocations.map((a) => a.relationshipId))].map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="ic-grant-scope">Permission scope</Label>
                  <select
                    id="ic-grant-scope"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={grantScope}
                    onChange={(e) => setGrantScope(e.target.value as "invoice" | "relationship")}
                  >
                    <option value="invoice">This invoice only</option>
                    <option value="relationship">All invoices on this company pair</option>
                  </select>
                </div>
              </div>
              <Button
                variant="outline"
                disabled={!grantee.trim() || !grantRelation || grantMutation.isPending}
                onClick={() => grantMutation.mutate()}
              >
                Grant editor permission
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
