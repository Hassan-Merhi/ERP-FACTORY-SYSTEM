import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money, useIntercompanyLifecycleContentState } from "./useIntercompanyLifecycleContentState";
import { IntercompanyLifecycleContentCard } from "./IntercompanyLifecycleContentCard";

export function IntercompanyLifecycleContent(props: { physicalContainerId?: number; embedded?: boolean }) {
  const {
    arrivalVerified,
    canCancel,
    canReceive,
    cancel,
    cashUnchanged,
    companyId,
    copy,
    costVerified,
    date,
    deleteBothConfirmed,
    deleteLinked,
    embedded,
    evidence,
    goodsNotReceived,
    locationId,
    normalizeInternalProfit,
    profitNettingConfirmed,
    query,
    reason,
    receive,
    receivingOptions,
    redistributed,
    selectedCompany,
    setArrivalVerified,
    setCancelKey,
    setCashUnchanged,
    setCostVerified,
    setDate,
    setDeleteBothConfirmed,
    setEvidence,
    setGoodsNotReceived,
    setLocationId,
    setProfitNettingConfirmed,
    setReason,
    setReceiptKey,
    setRedistributed,
    setSelectedTradeId,
    trade,
    visibleTrades,
  } = useIntercompanyLifecycleContentState(props);

  return (
    <div
      className={embedded ? "space-y-4" : "mx-auto max-w-6xl space-y-6 pb-10"}
      data-testid="intercompany-phase5-lifecycle"
    >
      {!embedded && (
        <PageHeader
          title="Intercompany Receiving & Cancellation"
          subtitle="Receive into the actual destination ERP, or reverse an unreceived internal sale. The original physical container and cash transfers are never duplicated."
        />
      )}
      {!embedded && (
        <IntercompanyLifecycleContentCard
          query={query}
          setArrivalVerified={setArrivalVerified}
          setCancelKey={setCancelKey}
          setCashUnchanged={setCashUnchanged}
          setCostVerified={setCostVerified}
          setDeleteBothConfirmed={setDeleteBothConfirmed}
          setEvidence={setEvidence}
          setGoodsNotReceived={setGoodsNotReceived}
          setLocationId={setLocationId}
          setReason={setReason}
          setReceiptKey={setReceiptKey}
          setRedistributed={setRedistributed}
          setSelectedTradeId={setSelectedTradeId}
          visibleTrades={visibleTrades}
        />
      )}
      {embedded && query.isLoading && <p className="text-sm text-muted-foreground">{copy.loading}</p>}
      {embedded && query.isError && (
        <p role="alert" className="text-sm text-destructive">
          {copy.failed}
        </p>
      )}
      {embedded && !query.isLoading && !query.isError && visibleTrades.length === 0 && (
        <p className="text-sm text-muted-foreground">{copy.unlinked}</p>
      )}
      {trade && (
        <Card>
          <CardHeader>
            <CardTitle>{trade.containerNumber} — verified company pair</CardTitle>
            <CardDescription>
              Properties #{trade.sourceCompanyId} / ERP #{trade.destinationCompanyId}. Confirmed landed cost{" "}
              {money(trade.landedCost)}. Trade version {trade.version}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {trade.canceled && (
              <p>Trade canceled. Original supplier invoices and real cash transactions remain auditable.</p>
            )}
            {trade.received && (
              <p>
                Stock received in ERP location #{trade.received.locationId}, voucher #{trade.received.voucherId}.
                Further receipt and cancellation are disabled.
              </p>
            )}
            {trade.state === "active" && !trade.received && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ic-phase5-date">Actual posting date</Label>
                    <Input id="ic-phase5-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="ic-phase5-reason">Documented accounting reason</Label>
                    <Input id="ic-phase5-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="ic-phase5-evidence">Arrival or cancellation supporting evidence</Label>
                    <Input id="ic-phase5-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
                  </div>
                </div>
                {(companyId === trade.destinationCompanyId ||
                  (selectedCompany?.companyType === "properties" &&
                    ["Owner", "Developer"].includes(selectedCompany?.role ?? ""))) && (
                  <div className="space-y-3 rounded-lg border p-4">
                    <h3 className="font-semibold">Receive into this ERP company</h3>
                    <p className="text-sm text-muted-foreground">
                      Reclassifies only the verified linked cost from Goods in Transit into the ERP INVENTORY account.
                      Existing negative-stock or residual-value situations are refused.
                    </p>
                    <Label htmlFor="ic-phase5-location">
                      Actual receiving warehouse in ERP #{trade.destinationCompanyId}
                    </Label>
                    <select
                      id="ic-phase5-location"
                      value={locationId}
                      onChange={(e) => setLocationId(e.target.value)}
                      className="w-full rounded-md border bg-background p-2"
                    >
                      <option value="">Choose ERP location</option>
                      {receivingOptions.data?.locations.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground" data-testid="intercompany-inventory-account-status">
                      {receivingOptions.isLoading
                        ? "Verifying the ERP warehouse and INVENTORY account…"
                        : receivingOptions.data?.inventoryAccountStatus === "ready"
                          ? "Verified ERP INVENTORY account automatically selected."
                          : "No unique active ERP INVENTORY asset account exists. Resolve the account in the destination ERP before receiving."}
                    </p>
                    {receivingOptions.isError && (
                      <p role="alert" className="text-sm text-destructive">
                        {receivingOptions.error?.message}
                      </p>
                    )}
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={arrivalVerified} onCheckedChange={(v) => setArrivalVerified(v === true)} />I
                      verified the physical goods arrived at this ERP warehouse
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={costVerified} onCheckedChange={(v) => setCostVerified(v === true)} />I verified
                      this confirmed landed cost includes all approved charges
                    </label>
                    <Button disabled={!canReceive} onClick={() => receive.mutate()}>
                      {receive.isPending ? "Validating stock and GIT…" : "Receive stock and post GIT reclassification"}
                    </Button>
                  </div>
                )}
                {!trade.accountingNetted && trade.state === "active" && !trade.received && !trade.canceled && (
                  <div className="space-y-3 rounded-lg border p-4">
                    <h3 className="font-semibold">Normalize old intercompany accounting</h3>
                    <p className="text-sm text-muted-foreground">
                      For an older at-cost imported PO, clear the technical internal Sales and COGS balances with an
                      audited journal. The parent intercompany debit and external supplier credit stay unchanged. No
                      cash, stock, or original voucher is removed.
                    </p>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={profitNettingConfirmed}
                        onCheckedChange={(v) => setProfitNettingConfirmed(v === true)}
                      />
                      I confirm that only technical internal Sales and COGS should be netted.
                    </label>
                    <Button
                      disabled={
                        !profitNettingConfirmed ||
                        !["Owner", "Developer"].includes(selectedCompany?.role ?? "") ||
                        normalizeInternalProfit.isPending
                      }
                      onClick={() => normalizeInternalProfit.mutate()}
                    >
                      {normalizeInternalProfit.isPending
                        ? "Verifying original vouchers…"
                        : "Normalize parent intercompany accounts"}
                    </Button>
                  </div>
                )}
                <div className="space-y-3 rounded-lg border p-4">
                  <h3 className="font-semibold">Delete original linked POs and vouchers</h3>
                  <p className="text-sm text-muted-foreground">
                    Physically deletes both companies' connected POs, their original vouchers and the unused linked
                    container in one transaction. Creates no reversal vouchers. Only allowed before receipt, payments,
                    shared charges or other activity. The deletion audit remains.
                  </p>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={deleteBothConfirmed}
                      onCheckedChange={(value) => setDeleteBothConfirmed(value === true)}
                    />
                    I understand that both companies' POs and original vouchers will be permanently deleted.
                  </label>
                  <Button
                    variant="destructive"
                    disabled={
                      !deleteBothConfirmed ||
                      !["Owner", "Developer"].includes(selectedCompany?.role ?? "") ||
                      deleteLinked.isPending
                    }
                    onClick={() => deleteLinked.mutate()}
                  >
                    {deleteLinked.isPending ? "Checking both companies…" : "Delete linked POs and vouchers"}
                  </Button>
                </div>
                <div className="space-y-3 rounded-lg border p-4">
                  <h3 className="font-semibold">Cancel before goods are received</h3>
                  <p className="text-sm text-muted-foreground">
                    Requires Owner/Developer permission. Cancels the internal sale and GIT/payable with balancing
                    vouchers; keeps the external supplier purchase, bank movements and original-pair credit history.
                  </p>
                  {trade.pendingSharedAllocation && (
                    <p role="alert" className="text-destructive">
                      A confirmed shared invoice still allocates cost to this container. A dedicated Shared Charge
                      Editor must first redistribute that amount to other active linked containers while preserving the
                      invoice total.
                    </p>
                  )}
                  {trade.hasSharedInvoices && !trade.pendingSharedAllocation && (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={redistributed} onCheckedChange={(v) => setRedistributed(v === true)} />I
                      reviewed the authorized shared-invoice redistribution and unchanged external face total
                    </label>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={goodsNotReceived} onCheckedChange={(v) => setGoodsNotReceived(v === true)} />I
                    confirm neither destination inventory nor downstream sales/transfers have received these goods
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={cashUnchanged} onCheckedChange={(v) => setCashUnchanged(v === true)} />I
                    understand this does not refund or reverse any real cash or bank payment
                  </label>
                  <Button variant="destructive" disabled={!canCancel} onClick={() => cancel.mutate()}>
                    {cancel.isPending ? "Checking both ledgers…" : "Cancel internal trade with paired accounting"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Route-level wrapper stays compatible with wouter RouteComponentProps. */
export default function IntercompanyLifecycle() {
  return <IntercompanyLifecycleContent />;
}
