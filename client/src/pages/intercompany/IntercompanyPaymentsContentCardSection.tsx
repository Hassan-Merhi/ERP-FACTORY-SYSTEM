// Extracted from ./IntercompanyPayments.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money } from "./IntercompanyPaymentsTypes";
import { useIntercompanyPaymentsContentState } from "./useIntercompanyPaymentsContentState";

export function IntercompanyPaymentsContentCardSection({
  allocation,
  canConfirm,
  chosen,
  confirm,
  destAccounts,
  destConfirmed,
  destinationCash,
  evidence,
  historicalRate,
  manuallyAllocated,
  nativeAmount,
  paymentDate,
  reason,
  setAllocation,
  setCurrency,
  setDestConfirmed,
  setDestinationCash,
  setEvidence,
  setHistoricalRate,
  setNativeAmount,
  setPaymentDate,
  setReason,
  setSourceCash,
  setSourceConfirmed,
  setTransferReference,
  sourceAccounts,
  sourceCash,
  sourceConfirmed,
  transactionCurrency,
  transferReference,
  usdAmount,
}: Pick<
  ReturnType<typeof useIntercompanyPaymentsContentState>,
  | "allocation"
  | "canConfirm"
  | "chosen"
  | "confirm"
  | "destAccounts"
  | "destConfirmed"
  | "destinationCash"
  | "evidence"
  | "historicalRate"
  | "manuallyAllocated"
  | "nativeAmount"
  | "paymentDate"
  | "reason"
  | "setAllocation"
  | "setCurrency"
  | "setDestConfirmed"
  | "setDestinationCash"
  | "setEvidence"
  | "setHistoricalRate"
  | "setNativeAmount"
  | "setPaymentDate"
  | "setReason"
  | "setSourceCash"
  | "setSourceConfirmed"
  | "setTransferReference"
  | "sourceAccounts"
  | "sourceCash"
  | "sourceConfirmed"
  | "transactionCurrency"
  | "transferReference"
  | "usdAmount"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm actual payment and receipt</CardTitle>
        <CardDescription>
          A bank/cash withdrawal and receipt must both be real and confirmed. A payment without chosen POs remains
          unapplied credit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="ic-payment-date">Actual payment date</Label>
            <Input
              id="ic-payment-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ic-payment-native">Actual amount</Label>
            <Input
              id="ic-payment-native"
              value={nativeAmount}
              inputMode="decimal"
              onChange={(e) => setNativeAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label htmlFor="ic-payment-currency">Original currency</Label>
            <select
              id="ic-payment-currency"
              value={transactionCurrency}
              onChange={(e) => {
                const c = e.target.value as "USD" | "CFA" | "ZMW";
                setCurrency(c);
                setHistoricalRate(c === "USD" ? "1" : "");
              }}
              className="w-full rounded-md border bg-background p-2"
            >
              <option value="USD">USD</option>
              <option value="CFA">CFA</option>
              <option value="ZMW">ZMW</option>
            </select>
          </div>
          <div>
            <Label htmlFor="ic-payment-fx">Historical exchange rate (currency units per USD)</Label>
            <Input
              id="ic-payment-fx"
              value={historicalRate}
              disabled={transactionCurrency === "USD"}
              inputMode="decimal"
              onChange={(e) => setHistoricalRate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ic-source-bank">Properties — confirmed receiving cash/bank</Label>
            <select
              id="ic-source-bank"
              value={sourceCash}
              onChange={(e) => setSourceCash(e.target.value)}
              className="w-full rounded-md border bg-background p-2"
            >
              <option value="">Select actual receipt account</option>
              {sourceAccounts.map((a) => (
                <option key={a.type + ":" + a.id} value={a.type + ":" + a.id}>
                  {a.type.toUpperCase()} · {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ic-dest-bank">ERP — confirmed paying cash/bank</Label>
            <select
              id="ic-dest-bank"
              value={destinationCash}
              onChange={(e) => setDestinationCash(e.target.value)}
              className="w-full rounded-md border bg-background p-2"
            >
              <option value="">Select actual payment account</option>
              {destAccounts.map((a) => (
                <option key={a.type + ":" + a.id} value={a.type + ":" + a.id}>
                  {a.type.toUpperCase()} · {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="ic-bank-reference">Bank / cash transfer reference</Label>
            <Input
              id="ic-bank-reference"
              value={transferReference}
              onChange={(e) => setTransferReference(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="ic-payment-evidence">Proof of both actual money movements</Label>
            <Input
              id="ic-payment-evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="Bank statements or receipt references"
            />
          </div>
          <div>
            <Label htmlFor="ic-payment-reason">Accounting reason</Label>
            <Input id="ic-payment-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <p className="text-sm">
          Historical USD amount:{" "}
          <strong>{Number.isFinite(usdAmount) ? money(usdAmount) : "Enter a verified rate"}</strong>. Choose exact
          manual allocations below. The remainder is kept as credit for this pair.
        </p>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Container</TableHead>
                <TableHead>Confirmed landed cost</TableHead>
                <TableHead>Already paid</TableHead>
                <TableHead>Outstanding</TableHead>
                <TableHead>Allocate now (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chosen.map((p) => (
                <TableRow key={p.tradeId}>
                  <TableCell>{p.containerNumber}</TableCell>
                  <TableCell>{money(p.landedCost)}</TableCell>
                  <TableCell>{money(p.applied)}</TableCell>
                  <TableCell>{money(p.unpaid)}</TableCell>
                  <TableCell>
                    <Input
                      aria-label={"Pay " + p.containerNumber}
                      inputMode="decimal"
                      value={allocation[p.tradeId] ?? ""}
                      placeholder="0.00"
                      onChange={(e) => setAllocation((old) => ({ ...old, [p.tradeId]: e.target.value }))}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-sm">
          Manually allocated: {money(manuallyAllocated)}. New unused credit:{" "}
          {money(Math.max(0, usdAmount - manuallyAllocated))}.
        </p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={sourceConfirmed} onCheckedChange={(v) => setSourceConfirmed(v === true)} />I verified
            that Properties actually received this cash/bank payment
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={destConfirmed} onCheckedChange={(v) => setDestConfirmed(v === true)} />I verified that
            the destination company actually paid this cash/bank amount
          </label>
        </div>
        <Button disabled={!canConfirm} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Validating both company ledgers…" : "Confirm and post both actual payment vouchers"}
        </Button>
      </CardContent>
    </Card>
  );
}
