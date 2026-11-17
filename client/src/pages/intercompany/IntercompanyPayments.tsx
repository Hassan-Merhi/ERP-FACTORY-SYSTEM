import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { intercompanyVoucherDetailPath } from "@/pages/vouchers/intercompanyTransferPolicy";
import { money } from "./IntercompanyPaymentsTypes";
import { useIntercompanyPaymentsContentState } from "./useIntercompanyPaymentsContentState";
import { IntercompanyPaymentsContentCardSection } from "./IntercompanyPaymentsContentCardSection";

export function IntercompanyPaymentsContent(props: { embedded?: boolean }) {
  const {
    allocation,
    availableCredit,
    canConfirm,
    chosen,
    companyId,
    confirm,
    destAccounts,
    destConfirmed,
    destinationCash,
    embedded,
    evidence,
    historicalRate,
    history,
    manuallyAllocated,
    nativeAmount,
    pairs,
    paymentDate,
    reason,
    relationshipId,
    reversal,
    reversalDate,
    reversalReason,
    reversePayment,
    reverseReceipt,
    reversing,
    selectedCompany,
    setAllocation,
    setCurrency,
    setDestConfirmed,
    setDestinationCash,
    setEvidence,
    setHistoricalRate,
    setNativeAmount,
    setPaymentDate,
    setReason,
    setRelationshipId,
    setReversalDate,
    setReversalReason,
    setReversePayment,
    setReverseReceipt,
    setReversing,
    setSourceCash,
    setSourceConfirmed,
    setTransferReference,
    setup,
    sourceAccounts,
    sourceCash,
    sourceConfirmed,
    transactionCurrency,
    transferReference,
    usdAmount,
    voucherCopy,
  } = useIntercompanyPaymentsContentState(props);
  return (
    <div
      className={embedded ? "space-y-4" : "mx-auto max-w-6xl space-y-6 pb-10"}
      data-testid="intercompany-mirrored-payments"
    >
      {!embedded && (
        <PageHeader
          title="Intercompany Payments & Credits"
          subtitle="Actual paired bank/cash movements, explicit purchase-order allocations and credit held by each company pair."
        />
      )}
      {embedded && (
        <div className="space-y-2 text-sm" data-testid="intercompany-voucher-transfer-explanation">
          <h2 className="font-semibold">{voucherCopy.transferVoucher}</h2>
          <p className="text-muted-foreground">{voucherCopy.transferExplanation}</p>
          <p className="text-muted-foreground">{voucherCopy.transferSafety}</p>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Select the company pair</CardTitle>
          <CardDescription>
            Payments between Hassan Properties and one destination ERP company remain separate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pairs.isError && (
            <p role="alert" className="text-destructive">
              Company-pair payment access is unavailable.
            </p>
          )}
          <Label htmlFor="ic-payments-pair">Destination company relationship</Label>
          <select
            id="ic-payments-pair"
            className="w-full max-w-lg rounded-md border bg-background p-2"
            value={relationshipId ?? ""}
            onChange={(e) => setRelationshipId(Number(e.target.value) || null)}
          >
            <option value="">Choose an enabled relationship</option>
            {pairs.data?.relationships.map((p) => (
              <option key={p.relationshipId} value={p.relationshipId}>
                Properties #{p.sourceCompanyId} / ERP #{p.destinationCompanyId} {p.tradeEnabled ? "" : "(history only)"}
              </option>
            ))}
          </select>
          {setup.isError && (
            <p role="alert" className="text-destructive">
              Cannot access the verified partner accounts. Check company permissions.
            </p>
          )}
          {setup.data && (
            <p className="text-sm text-muted-foreground">
              Available unused credit belonging to this pair: {money(availableCredit)}. Existing credit is applied
              automatically to new imports, not when existing PO prices are edited.
            </p>
          )}
        </CardContent>
      </Card>

      {setup.data && (
        <IntercompanyPaymentsContentCardSection
          allocation={allocation}
          canConfirm={canConfirm}
          chosen={chosen}
          confirm={confirm}
          destAccounts={destAccounts}
          destConfirmed={destConfirmed}
          destinationCash={destinationCash}
          evidence={evidence}
          historicalRate={historicalRate}
          manuallyAllocated={manuallyAllocated}
          nativeAmount={nativeAmount}
          paymentDate={paymentDate}
          reason={reason}
          setAllocation={setAllocation}
          setCurrency={setCurrency}
          setDestConfirmed={setDestConfirmed}
          setDestinationCash={setDestinationCash}
          setEvidence={setEvidence}
          setHistoricalRate={setHistoricalRate}
          setNativeAmount={setNativeAmount}
          setPaymentDate={setPaymentDate}
          setReason={setReason}
          setSourceCash={setSourceCash}
          setSourceConfirmed={setSourceConfirmed}
          setTransferReference={setTransferReference}
          sourceAccounts={sourceAccounts}
          sourceCash={sourceCash}
          sourceConfirmed={sourceConfirmed}
          transactionCurrency={transactionCurrency}
          transferReference={transferReference}
          usdAmount={usdAmount}
        />
      )}

      {history.data && (
        <Card>
          <CardHeader>
            <CardTitle>Payment, credit and reversal history</CardTitle>
            <CardDescription>
              One bank transfer is recorded once and linked to both company vouchers. Reversals are append-only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actual date</TableHead>
                    <TableHead>Transfer reference</TableHead>
                    <TableHead>Historical payment</TableHead>
                    <TableHead>USD</TableHead>
                    <TableHead>Unused credit</TableHead>
                    <TableHead>{voucherCopy.currentVoucher}</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.data.history.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.paymentDate}</TableCell>
                      <TableCell>{row.transferReference}</TableCell>
                      <TableCell>
                        {row.nativeAmount} {row.currency}
                      </TableCell>
                      <TableCell>{money(row.baseAmount)}</TableCell>
                      <TableCell>{money(row.credit)}</TableCell>
                      <TableCell>
                        {(() => {
                          const href = intercompanyVoucherDetailPath(
                            selectedCompany?.companyType ?? "",
                            setup.data?.sourceCompanyId ?? 0,
                            setup.data?.destinationCompanyId ?? 0,
                            companyId,
                            row.sourceVoucherId,
                            row.destinationVoucherId
                          );
                          return href ? (
                            <Link
                              href={href}
                              className="text-primary underline-offset-2 hover:underline"
                              data-testid={`intercompany-voucher-link-${row.id}`}
                            >
                              {voucherCopy.viewVoucher} #
                              {selectedCompany?.companyType === "properties"
                                ? row.sourceVoucherId
                                : row.destinationVoucherId}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">{voucherCopy.voucherUnavailable}</span>
                          );
                        })()}
                      </TableCell>
                      <TableCell>{row.status}</TableCell>
                      <TableCell>
                        {row.status === "confirmed" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setReversing(row.id);
                              setReverseReceipt(false);
                              setReversePayment(false);
                              setReversalReason("");
                            }}
                          >
                            Reverse both vouchers
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {reversing != null && (
              <div className="space-y-3 rounded-lg border p-4">
                <p className="font-medium">Reverse both actual bank/cash legs of payment #{reversing}</p>
                <p className="text-sm text-muted-foreground">
                  This action does not delete original vouchers. It returns all allocated PO credit to outstanding
                  balances.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ic-reversal-date">Permitted reversal posting date</Label>
                    <Input
                      id="ic-reversal-date"
                      type="date"
                      value={reversalDate}
                      onChange={(e) => setReversalDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="ic-reversal-reason">Documented reversal reason</Label>
                    <Input
                      id="ic-reversal-reason"
                      value={reversalReason}
                      onChange={(e) => setReversalReason(e.target.value)}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={reverseReceipt} onCheckedChange={(v) => setReverseReceipt(v === true)} />
                  Properties cash receipt actually reversed
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={reversePayment} onCheckedChange={(v) => setReversePayment(v === true)} />
                  Destination company's cash payment actually reversed
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    disabled={
                      !reverseReceipt || !reversePayment || reversalReason.trim().length < 3 || reversal.isPending
                    }
                    onClick={() => reversal.mutate()}
                  >
                    Post audited paired reversal
                  </Button>
                  <Button variant="outline" onClick={() => setReversing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Maintain the existing standalone compatibility route until Phase 7 cleanup. */
export default function IntercompanyPayments() {
  return <IntercompanyPaymentsContent />;
}
