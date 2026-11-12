import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { intercompanyVoucherText } from "@/i18n/intercompanyVoucherTranslations";
import { intercompanyVoucherDetailPath } from "@/pages/vouchers/intercompanyTransferPolicy";

const BASE = "/api/intercompany-container-trading/payments";
const newKey = () => {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
  return "icpay-" + id;
};
const dateNow = () => new Date().toLocaleDateString("en-CA");
const money = (s: string | number | null) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(s || 0));
type Pair = { relationshipId: number; sourceCompanyId: number; destinationCompanyId: number; tradeEnabled: boolean };
type CashRef = { type: "bank" | "cash"; id: number };
type CashAccount = CashRef & { companyId: number; name: string };
type UnpaidPO = {
  tradeId: number;
  version: number;
  containerNumber: string;
  landedCost: string;
  applied: string;
  unpaid: string;
};
type Credit = { paymentId: number; available: string; originalPaymentDate: string };
type Setup = {
  relationshipId: number;
  tradeEnabled: boolean;
  sourceCompanyId: number;
  destinationCompanyId: number;
  cashAccounts: CashAccount[];
  purchaseOrders: UnpaidPO[];
  credits: Credit[];
};
type HistoryPayment = {
  id: number;
  status: "confirmed" | "reversed";
  paymentDate: string;
  transferReference: string;
  currency: string;
  nativeAmount: string;
  historicalRate: string;
  baseAmount: string;
  credit: string;
  sourceVoucherId: number;
  destinationVoucherId: number;
  sourceReversalVoucherId: number | null;
  destinationReversalVoucherId: number | null;
  applied: Array<{ tradeId: number; amount: string }>;
};
const getJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: "include" });
  const value = await response.json().catch(() => ({ message: "Could not read payment data" }));
  if (!response.ok) throw new Error(value.message || "Could not load payment details");
  return value as T;
};
const parseCash = (value: string): CashRef => {
  const [type, id] = value.split(":");
  if ((type !== "bank" && type !== "cash") || !id || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error("Choose an active cash or bank account");
  }
  return { type, id: Number(id) };
};
export function IntercompanyPaymentsContent({ embedded = false }: { embedded?: boolean } = {}) {
  const { selectedCompany } = useCompany();
  const voucherCopy = intercompanyVoucherText(useApplicationLanguageCode());
  const { toast } = useToast();
  const companyId = Number(selectedCompany?.id || 0);
  const [relationshipId, setRelationshipId] = useState<number | null>(null);
  const [transactionCurrency, setCurrency] = useState<"USD" | "CFA" | "ZMW">("USD");
  const [nativeAmount, setNativeAmount] = useState("");
  const [historicalRate, setHistoricalRate] = useState("1");
  const [paymentDate, setPaymentDate] = useState(dateNow);
  const [transferReference, setTransferReference] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("Confirmed intercompany container settlement");
  const [sourceCash, setSourceCash] = useState("");
  const [destinationCash, setDestinationCash] = useState("");
  const [allocation, setAllocation] = useState<Record<number, string>>({});
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [destConfirmed, setDestConfirmed] = useState(false);
  const [requestKey, setRequestKey] = useState(newKey);
  const [reversing, setReversing] = useState<number | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  const [reversalDate, setReversalDate] = useState(dateNow);
  const [reverseReceipt, setReverseReceipt] = useState(false);
  const [reversePayment, setReversePayment] = useState(false);
  const [reversalKey, setReversalKey] = useState(newKey);

  useEffect(() => {
    setRelationshipId(null);
    setSourceCash("");
    setDestinationCash("");
    setAllocation({});
    setSourceConfirmed(false);
    setDestConfirmed(false);
    setReversing(null);
    setNativeAmount("");
    setHistoricalRate("1");
    setCurrency("USD");
    setPaymentDate(dateNow());
    setTransferReference("");
    setEvidence("");
    setRequestKey(newKey());
    setReversalKey(newKey());
    setReversalReason("");
    setReverseReceipt(false);
    setReversePayment(false);
  }, [companyId]);
  const pairs = useQuery<{ relationships: Pair[] }>({
    queryKey: companyQueryKey(BASE + "/relationships", companyId),
    enabled: companyId > 0,
    queryFn: () => getJson(BASE + "/relationships"),
    retry: false,
  });
  const setup = useQuery<Setup>({
    queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/setup", companyId),
    enabled: companyId > 0 && relationshipId != null,
    queryFn: () => getJson(BASE + "/pairs/" + relationshipId + "/setup"),
    retry: false,
  });
  const history = useQuery<{ relationshipId: number; history: HistoryPayment[] }>({
    queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/history", companyId),
    enabled: companyId > 0 && relationshipId != null,
    queryFn: () => getJson(BASE + "/pairs/" + relationshipId + "/history"),
    retry: false,
  });
  useEffect(() => {
    setSourceCash("");
    setDestinationCash("");
    setAllocation({});
    setSourceConfirmed(false);
    setDestConfirmed(false);
    setNativeAmount("");
    setTransferReference("");
    setEvidence("");
    setRequestKey(newKey());
    setReversing(null);
  }, [relationshipId]);
  const refresh = () => {
    // Refresh both the source-side receipt and destination-side payment
    // vouchers from the active company's ordinary Vouchers page.
    for (const key of ["/api/vouchers", "/api/accounts", "/api/bank-accounts", "/api/suppliers"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    queryClient.invalidateQueries({
      queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/setup", companyId),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey(BASE + "/pairs/" + relationshipId + "/history", companyId),
    });
    queryClient.invalidateQueries({
      queryKey: companyQueryKey("/api/intercompany-container-trading/linked-trades", companyId),
    });
  };
  const confirm = useMutation({
    mutationFn: async () => {
      if (!setup.data) throw new Error("Select an involved company pair");
      const allocations = setup.data.purchaseOrders
        .filter((p) => Number(allocation[p.tradeId] || 0) > 0)
        .map((p) => ({ tradeId: p.tradeId, expectedVersion: p.version, amount: allocation[p.tradeId] }));
      const response = await apiRequest("POST", BASE + "/confirm", {
        relationshipId: setup.data.relationshipId,
        requestKey,
        paymentDate,
        currency: transactionCurrency,
        transactionAmount: nativeAmount,
        historicalRate,
        sourceReceiptAccount: parseCash(sourceCash),
        destinationPaymentAccount: parseCash(destinationCash),
        transferReference: transferReference.trim(),
        confirmationEvidence: evidence.trim(),
        reason: reason.trim(),
        confirmedSourceReceipt: sourceConfirmed,
        confirmedDestinationPayment: destConfirmed,
        allocations,
      });
      return response.json() as Promise<{ paymentId: number; usdAmount: string; unallocatedCredit: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Actual payment mirrored in both companies",
        description: "Payment #" + data.paymentId + " posted. Unallocated credit " + money(data.unallocatedCredit),
      });
      setRequestKey(newKey());
      setAllocation({});
      setNativeAmount("");
      setTransferReference("");
      setEvidence("");
      setSourceConfirmed(false);
      setDestConfirmed(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "No cash was posted", description: error.message, variant: "destructive" }),
  });
  const reversal = useMutation({
    mutationFn: async () => {
      if (reversing == null) throw new Error("Select a payment to reverse");
      const response = await apiRequest("POST", BASE + "/" + reversing + "/reverse", {
        requestKey: reversalKey,
        reversalDate,
        reason: reversalReason.trim(),
        confirmedSourceReversal: reverseReceipt,
        confirmedDestinationReversal: reversePayment,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Both payment vouchers reversed together",
        description: "Original vouchers and historical FX evidence were preserved.",
      });
      setReversing(null);
      setReversalKey(newKey());
      setReversalReason("");
      setReverseReceipt(false);
      setReversePayment(false);
      refresh();
    },
    onError: (error: Error) =>
      toast({ title: "Reversal was not posted", description: error.message, variant: "destructive" }),
  });
  const usdAmount = Number(nativeAmount || 0) / Number(historicalRate || 1);
  const manuallyAllocated = Object.values(allocation).reduce((sum, value) => sum + Number(value || 0), 0);
  const invalidPoAllocation = Object.entries(allocation).some(([tradeId, value]) => {
    if (!value.trim()) return false;
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return true;
    const linked = setup.data?.purchaseOrders.find((po) => po.tradeId === Number(tradeId));
    return !linked || Math.round(Number(value) * 100) > Math.round(Number(linked.unpaid) * 100);
  });
  const canConfirm = Boolean(
    setup.data?.tradeEnabled &&
    relationshipId &&
    sourceCash &&
    destinationCash &&
    transferReference.trim().length >= 5 &&
    evidence.trim().length >= 8 &&
    nativeAmount &&
    historicalRate &&
    Number.isFinite(usdAmount) &&
    usdAmount > 0 &&
    sourceConfirmed &&
    destConfirmed &&
    !invalidPoAllocation &&
    manuallyAllocated <= Math.round(usdAmount * 100) / 100 + 0.00001 &&
    !confirm.isPending
  );
  const sourceAccounts = setup.data?.cashAccounts.filter((a) => a.companyId === setup.data?.sourceCompanyId) || [];
  const destAccounts = setup.data?.cashAccounts.filter((a) => a.companyId === setup.data?.destinationCompanyId) || [];
  const chosen = setup.data?.purchaseOrders || [];
  const availableCredit = setup.data?.credits.reduce((n, c) => n + Number(c.available), 0) || 0;
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
                <Checkbox checked={destConfirmed} onCheckedChange={(v) => setDestConfirmed(v === true)} />I verified
                that the destination company actually paid this cash/bank amount
              </label>
            </div>
            <Button disabled={!canConfirm} onClick={() => confirm.mutate()}>
              {confirm.isPending ? "Validating both company ledgers…" : "Confirm and post both actual payment vouchers"}
            </Button>
          </CardContent>
        </Card>
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
