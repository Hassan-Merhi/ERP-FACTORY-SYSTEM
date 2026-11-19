// Extracted from ./LinkedTradesEditorContentCardSection.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, toCents, useLinkedTradesEditorContentState } from "./useLinkedTradesEditorContentState";

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
