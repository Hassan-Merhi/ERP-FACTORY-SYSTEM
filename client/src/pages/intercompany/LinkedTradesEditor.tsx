import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableRow, TableHeader } from "@/components/ui/table";
import { money, toCents, useLinkedTradesEditorContentState } from "./useLinkedTradesEditorContentState";
import {
  LinkedTradesEditorContentCardSection,
  LinkedTradesEditorContentCardSection2,
} from "./LinkedTradesEditorContentCardSection";

export function LinkedTradesEditorContent(props: { physicalContainerId?: number; embedded?: boolean }) {
  const {
    chargeDate,
    chargeReason,
    chargeType,
    chosen,
    confirmMutation,
    copy,
    detail,
    editMutation,
    editTrades,
    embedded,
    face,
    grantMutation,
    grantRelation,
    grantScope,
    grantee,
    invoice,
    invoiceEvidence,
    invoiceKey,
    invoiceNumber,
    isProperties,
    list,
    manual,
    newAmounts,
    postingDate,
    previewMutation,
    proposal,
    proposedTotal,
    reallocateMutation,
    reallocatedTotal,
    reason,
    rows,
    selected,
    setChargeDate,
    setChargeReason,
    setChargeType,
    setChosen,
    setFace,
    setGrantRelation,
    setGrantScope,
    setGrantee,
    setInvoiceEvidence,
    setInvoiceKey,
    setInvoiceNumber,
    setLookupId,
    setManual,
    setNewAmounts,
    setPostingDate,
    setProposal,
    setReason,
    setRows,
    setSelected,
    trades,
    validScopedSelection,
  } = useLinkedTradesEditorContentState(props);

  return (
    <div
      className={embedded ? "space-y-4" : "mx-auto max-w-6xl space-y-6 pb-12"}
      data-testid="intercompany-linked-editor"
    >
      {!embedded && (
        <PageHeader
          title="Linked Container POs & Shared Charges"
          subtitle="Price edits and confirmed costs remain synchronized between Properties and the destination ERP company."
        />
      )}
      <p className="text-sm text-muted-foreground">
        Each edit is a single audited transaction. Original supplier vouchers remain unchanged. Offloaded or sold
        containers are protected until the inventory adjustment workflow is available.
      </p>

      <LinkedTradesEditorContentCardSection
        copy={copy}
        detail={detail}
        editMutation={editMutation}
        editTrades={editTrades}
        embedded={embedded}
        list={list}
        postingDate={postingDate}
        reason={reason}
        rows={rows}
        selected={selected}
        setPostingDate={setPostingDate}
        setReason={setReason}
        setRows={setRows}
        setSelected={setSelected}
        validScopedSelection={validScopedSelection}
      />

      {isProperties && (
        <Card>
          <CardHeader>
            <CardTitle>Confirm a shared freight or handling invoice</CardTitle>
            <CardDescription>
              Preview a purchase-value-weighted allocation. Override amounts before confirming the immutable external
              invoice face value.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              <div>
                <Label htmlFor="ic-invoice-key">Original invoice reference</Label>
                <Input id="ic-invoice-key" value={invoiceKey} onChange={(e) => setInvoiceKey(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ic-invoice-face">Invoice total (USD)</Label>
                <Input
                  id="ic-invoice-face"
                  value={face}
                  onChange={(e) => {
                    setFace(e.target.value);
                    setProposal(null);
                  }}
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label htmlFor="ic-invoice-type">Charge type</Label>
                <select
                  id="ic-invoice-type"
                  value={chargeType}
                  onChange={(e) => setChargeType(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="freight">Freight</option>
                  <option value="surcharge">Surcharge</option>
                  <option value="fumigation">Fumigation</option>
                  <option value="documentCharges">Documents</option>
                  <option value="otherCharges">Handling / other</option>
                </select>
              </div>
              <div>
                <Label htmlFor="ic-invoice-date">Posting date</Label>
                <Input
                  id="ic-invoice-date"
                  type="date"
                  value={chargeDate}
                  onChange={(e) => setChargeDate(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ic-evidence">Verified invoice document / evidence</Label>
              <Input id="ic-evidence" value={invoiceEvidence} onChange={(e) => setInvoiceEvidence(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {trades.map((t) => (
                <label key={t.tradeId} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                  <Checkbox
                    checked={chosen.includes(t.tradeId)}
                    onCheckedChange={(v) => {
                      setChosen((old) =>
                        v === true
                          ? [...old.filter((id) => id !== t.tradeId), t.tradeId]
                          : old.filter((id) => id !== t.tradeId)
                      );
                      setProposal(null);
                    }}
                  />
                  {t.containerNumber}
                </label>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!chosen.length || !face || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              Preview proportional allocation
            </Button>
            {proposal && (
              <div className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Confirmed allocation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {proposal.allocations.map((a) => (
                      <TableRow key={a.tradeId}>
                        <TableCell>{a.containerNumber}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={"Shared amount for " + a.containerNumber}
                            value={manual[a.tradeId] ?? a.suggestedAmount}
                            inputMode="decimal"
                            onChange={(e) => setManual((old) => ({ ...old, [a.tradeId]: e.target.value }))}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-sm">
                  Allocated {money(proposedTotal / 100)} of {money(face)}.
                  {proposedTotal !== toCents(face) ? " The invoice must balance before confirmation." : ""}
                </p>
                <Button
                  disabled={
                    confirmMutation.isPending || proposedTotal !== toCents(face) || !invoiceKey || !invoiceEvidence
                  }
                  onClick={() => confirmMutation.mutate()}
                >
                  Confirm and post shared invoice
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <LinkedTradesEditorContentCardSection2
        chargeReason={chargeReason}
        grantMutation={grantMutation}
        grantRelation={grantRelation}
        grantScope={grantScope}
        grantee={grantee}
        invoice={invoice}
        invoiceNumber={invoiceNumber}
        newAmounts={newAmounts}
        reallocateMutation={reallocateMutation}
        reallocatedTotal={reallocatedTotal}
        setChargeReason={setChargeReason}
        setGrantRelation={setGrantRelation}
        setGrantScope={setGrantScope}
        setGrantee={setGrantee}
        setInvoiceNumber={setInvoiceNumber}
        setLookupId={setLookupId}
        setNewAmounts={setNewAmounts}
      />
    </div>
  );
}

/** Route-level wrapper stays compatible with wouter RouteComponentProps. */
export default function LinkedTradesEditor() {
  return <LinkedTradesEditorContent />;
}
