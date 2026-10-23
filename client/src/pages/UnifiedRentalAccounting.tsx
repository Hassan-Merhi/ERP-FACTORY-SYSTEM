/** Phase 8: unified rental accounts — operational rent vs posted financial evidence. */
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mod = "ERP" | "FACTORY" | "PROPERTIES";
type Contract = {
  id: number;
  unitId: number;
  unitNumber: string;
  unitType: string;
  locationGroup: string;
  tenantName: string;
  status: string;
  currency: string;
  monthlyRent: string;
  startDate: string;
  endDate: string | null;
  internal: boolean;
  perspective?: "TENANT" | "LANDLORD";
  linkedCompanyId: number | null;
};
type Contracts = { module: Mod; perspective: "MIXED_BY_CONTRACT"; contracts: Contract[]; limitedTo: number };
type Period = {
  ledgerRowId: number | null;
  year: number;
  month: number;
  dueDate: string;
  expected: string;
  paid: string;
  outstanding: string;
  overpayment: string;
  scheduled: string;
  accrualVoucherId: number | null;
  accrualStale: boolean;
  usedPrepaidAccount: boolean;
  usedAdvanceAccount: boolean;
  cachedPaid: string | null;
  cacheDifference: string | null;
  status: string;
  postedPaymentIds: number[];
};
type Payment = {
  id: number;
  date: string;
  period: string;
  status: string;
  amount: string;
  currency: string;
  historicalRate: string;
  voucherId: number | null;
  voucherNumber: string | null;
  groupId: string | null;
  isGuaranteeActivity: boolean;
  ledgerRowId: number | null;
};
type Guarantee = {
  contractPledgeNative: string;
  statementFlag: boolean;
  statedPostedNative: string | null;
  ledgerEvidenceUsd: string;
  vouchers: Array<{
    voucherId: number;
    voucherNumber: string;
    date: string;
    accountCode: string | null;
    signedUsd: string;
  }>;
};
type Expense = {
  id: number;
  voucherId: number;
  voucherNumber: string | null;
  category: string;
  amountUsd: string;
  note: string | null;
  sourceStatus: "active" | "reversed" | "retired" | "optional";
};
type Detail = {
  module: Mod;
  perspective: "TENANT" | "LANDLORD";
  asOfDate: string;
  contract: Contract;
  totals: {
    expectedDue: string;
    postedAgainstDue: string;
    outstanding: string;
    advanceFuturePeriods: string;
    scheduledNotPosted: string;
    maintenanceExpensesBaseUsd: string;
    depositPledgeNative: string;
    depositBalanceEvidenceUsd: string;
  };
  periods: Period[];
  payments: Payment[];
  guarantee: Guarantee;
  expenses: Expense[];
  warnings: string[];
  limitations: Record<string, string>;
};
type Category = "maintenance" | "repairs" | "utilities" | "insurance" | "property_tax" | "other_property_cost";
const CATEGORIES: Category[] = [
  "maintenance",
  "repairs",
  "utilities",
  "insurance",
  "property_tax",
  "other_property_cost",
];
async function get<T>(u: string): Promise<T> {
  const res = await fetch(u, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Rental accounting unavailable");
  return data as T;
}
const name = (v: string) => v.replaceAll("_", " ").replace(/\b\w/g, (x) => x.toUpperCase());
export default function UnifiedRentalAccounting() {
  const [path] = useLocation();
  const mod: Mod = path.startsWith("/factory/") ? "FACTORY" : path.startsWith("/properties/") ? "PROPERTIES" : "ERP";
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const { toast } = useToast();
  const client = useQueryClient();
  const [id, setId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [category, setCategory] = useState<Category>("maintenance");
  const [voucher, setVoucher] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [showPayments, setShowPayments] = useState(false);
  const list = useQuery<Contracts>({
    queryKey: ["/api/accounting/rentals/contracts", companyId, mod],
    queryFn: () => get("/api/accounting/rentals/contracts?module=" + mod),
    enabled: !!companyId,
    retry: false,
  });
  const selectedId = Number(id);
  const active = Number.isSafeInteger(selectedId) && selectedId > 0;
  const detail = useQuery<Detail>({
    queryKey: ["/api/accounting/rentals/contracts", companyId, mod, id, asOf],
    queryFn: () =>
      get(`/api/accounting/rentals/contracts/${selectedId}?module=${mod}${asOf ? "&asOfDate=" + asOf : ""}`),
    enabled: !!companyId && active,
    retry: false,
  });
  const post = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error("Choose a contract");
      const r = await apiRequest("POST", "/api/accounting/rentals/expense-links", {
        module: mod,
        contractId: selectedId,
        voucherId: Number(voucher),
        category,
        amountUsd: amount,
        clientRequestKey: requestId,
        note: note.trim() || null,
      });
      return r.json();
    },
    onSuccess: async () => {
      toast({ title: "Expense attributed", description: "Voucher and its ledger amounts remain unchanged" });
      setVoucher("");
      setAmount("");
      setNote("");
      setRequestId(crypto.randomUUID());
      await client.invalidateQueries({ queryKey: ["/api/accounting/rentals/contracts"] });
    },
    onError: (e: Error) => toast({ title: "Allocation refused", description: e.message, variant: "destructive" }),
  });
  const voidLink = useMutation({
    mutationFn: async (linkId: number) => {
      const r = await apiRequest("POST", `/api/accounting/rentals/expense-links/${linkId}/void`, {
        reason: voidReason,
      });
      return r.json();
    },
    onSuccess: async () => {
      toast({ title: "Expense link cancelled", description: "Original financial voucher preserved" });
      setVoidReason("");
      await client.invalidateQueries({ queryKey: ["/api/accounting/rentals/contracts"] });
    },
    onError: (e: Error) => toast({ title: "Cannot cancel link", description: e.message, variant: "destructive" }),
  });
  const voucherLink = (n: number) =>
    mod === "FACTORY"
      ? `/factory/voucher-detail/${n}`
      : mod === "PROPERTIES"
        ? `/properties/voucher-detail/${n}`
        : `/voucher-detail/${n}`;
  const totals = detail.data?.totals;
  return (
    <div className="p-3 sm:p-5 space-y-5" data-testid="unified-rental-accounting">
      <div>
        <h1 className="text-2xl font-semibold">Unified Rental Accounting</h1>
        <p className="text-sm text-muted-foreground">
          Tenant-side shops and shared leases show rent payable; landlord-side warehouses show rent receivable.
          Contract-month ledger, payments, advance rent, deposits and property expenses. Financial vouchers remain
          unchanged.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Rental contract</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="rent-accounting-contract">Unit / tenant</Label>
            <select
              id="rent-accounting-contract"
              value={id}
              className="w-full h-10 rounded-md border bg-background px-2 text-sm"
              onChange={(e) => setId(e.target.value)}
            >
              <option value="">Select contract...</option>
              {(list.data?.contracts ?? []).map((c) => (
                <option value={c.id} key={c.id}>
                  #{c.id} · {c.locationGroup}/{c.unitNumber} · {c.tenantName} ({c.currency}, {c.status},{" "}
                  {c.perspective ?? "lease"})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rent-accounting-date">As-of date</Label>
            <Input id="rent-accounting-date" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          {list.isError && <p className="text-destructive text-sm">{(list.error as Error).message}</p>}
          <div className="sm:col-span-3">
            <Button
              variant="outline"
              onClick={() => {
                detail.refetch();
                list.refetch();
              }}
              disabled={detail.isFetching}
            >
              Refresh rental accounts
            </Button>
          </div>
        </CardContent>
      </Card>
      {detail.isError && (
        <p role="alert" className="text-destructive text-sm">
          {(detail.error as Error).message}
        </p>
      )}
      {detail.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {detail.data.contract.locationGroup}/{detail.data.contract.unitNumber} ·{" "}
                {detail.data.contract.tenantName} (
                {detail.data.perspective === "TENANT" ? "Tenant payable" : "Landlord receivable"})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {(
                  [
                    ["Due rent (native)", totals!.expectedDue],
                    ["Posted rent applied (native)", totals!.postedAgainstDue],
                    [detail.data.perspective === "LANDLORD" ? "Rent receivable" : "Rent payable", totals!.outstanding],
                    ["Advance / overpaid rent (native)", totals!.advanceFuturePeriods],
                    ["Scheduled, not posted (native)", totals!.scheduledNotPosted],
                    ["Property expenses allocated (USD)", totals!.maintenanceExpensesBaseUsd],
                    ["Contract deposit pledge (native)", totals!.depositPledgeNative],
                    ["Deposit book evidence (USD)", totals!.depositBalanceEvidenceUsd],
                  ] as Array<[string, string]>
                ).map(([label, v]) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="font-semibold text-lg tabular-nums">{v}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Contract currency: {detail.data.contract.currency} · Monthly rent: {detail.data.contract.monthlyRent} ·
                Contract: {detail.data.contract.startDate} to {detail.data.contract.endDate ?? "ongoing"} · As-of:{" "}
                {detail.data.asOfDate}
              </p>
              {detail.data.warnings.map((w, i) => (
                <p role="alert" key={i} className="text-sm text-destructive">
                  {w}
                </p>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Monthly rent / accrual / arrears</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="max-h-[490px] overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="p-2">Due</th>
                      <th className="p-2 text-right">Expected</th>
                      <th className="p-2 text-right">Paid</th>
                      <th className="p-2 text-right">Outstanding</th>
                      <th className="p-2">Accrual evidence</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.periods.map((p) => (
                      <tr key={p.year + "-" + p.month} className="border-b align-top">
                        <td className="p-2">{p.dueDate}</td>
                        <td className="p-2 text-right tabular-nums">{p.expected}</td>
                        <td className="p-2 text-right tabular-nums">{p.paid}</td>
                        <td className="p-2 text-right tabular-nums">{p.outstanding}</td>
                        <td className="p-2">
                          {p.accrualVoucherId ? (
                            <a className="underline" href={voucherLink(p.accrualVoucherId)}>
                              Voucher #{p.accrualVoucherId}
                            </a>
                          ) : p.accrualStale ? (
                            "Stale accrual link"
                          ) : (
                            "Not accrued"
                          )}
                          {(p.usedPrepaidAccount || p.usedAdvanceAccount) && (
                            <div className="text-xs text-muted-foreground">Advance/prepaid recognition</div>
                          )}
                        </td>
                        <td className="p-2">
                          {p.status}
                          {p.cacheDifference !== null && p.cacheDifference !== "0.00" && (
                            <div className="text-xs text-destructive">Cached paid differs by {p.cacheDifference}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!detail.data.periods.length && (
                  <p className="p-3 text-sm text-muted-foreground">No contractual month is due yet.</p>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Posted / scheduled payment allocations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" size="sm" onClick={() => setShowPayments((x) => !x)}>
                {showPayments ? "Hide payment details" : "View payments and historical rates"}
              </Button>
              {showPayments && (
                <div className="max-h-[430px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Paid / planned date</th>
                        <th className="p-2">Period</th>
                        <th className="p-2">Amount</th>
                        <th className="p-2">Recorded FX</th>
                        <th className="p-2">Posting</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.payments.map((p) => (
                        <tr key={p.id} className="border-b">
                          <td className="p-2">{p.date}</td>
                          <td className="p-2">
                            {p.period}
                            {p.isGuaranteeActivity && <div className="text-xs">Deposit activity, not rent</div>}
                          </td>
                          <td className="p-2">
                            {p.amount} {p.currency}
                          </td>
                          <td className="p-2">{p.historicalRate}</td>
                          <td className="p-2">
                            {p.status}
                            {p.voucherId && (
                              <div>
                                <a className="underline" href={voucherLink(p.voucherId)}>
                                  {p.voucherNumber || "#" + p.voucherId}
                                </a>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Guarantee / security deposit evidence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Pledged deposit in contract currency:
                {" " + detail.data.guarantee.contractPledgeNative} {detail.data.contract.currency}. Posted deposit
                asset/liability movements are shown in booked USD, without converting the original pledge at today's
                rate.
              </p>
              <p className="text-sm">
                Deposit statement flag: {detail.data.guarantee.statementFlag ? "yes" : "no"} · Book evidence:{" "}
                {detail.data.guarantee.ledgerEvidenceUsd} USD
              </p>
              <div className="max-h-[230px] overflow-auto">
                {detail.data.guarantee.vouchers.map((g, i) => (
                  <div key={g.voucherId + ":" + i} className="border-b py-2 flex flex-wrap gap-x-3 text-sm">
                    <span>{g.date}</span>
                    <a className="underline" href={voucherLink(g.voucherId)}>
                      {g.voucherNumber}
                    </a>
                    <span>{g.accountCode}</span>
                    <span className="tabular-nums">{g.signedUsd} USD</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Maintenance / property expense attribution</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Select an existing posted expense voucher and attribute only its expense debit to this rental contract.
                Several units may share one voucher, but total allocations cannot exceed its booked USD expense. This
                creates no new expense, bill, cash movement, or voucher.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label>Posted voucher ID</Label>
                  <Input
                    type="number"
                    min="1"
                    value={voucher}
                    onChange={(e) => {
                      setVoucher(e.target.value);
                      setRequestId(crypto.randomUUID());
                    }}
                    placeholder="Voucher ID"
                  />
                </div>
                <div>
                  <Label>Allocated USD base amount</Label>
                  <Input
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setRequestId(crypto.randomUUID());
                    }}
                    placeholder="e.g. 125.00"
                  />
                </div>
                <div>
                  <Label>Expense category</Label>
                  <select
                    value={category}
                    className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                    onChange={(e) => {
                      setCategory(e.target.value as Category);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    {CATEGORIES.map((c) => (
                      <option value={c} key={c}>
                        {name(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-3">
                  <Label>Explanation / property work details</Label>
                  <Input
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setRequestId(crypto.randomUUID());
                    }}
                    placeholder="Optional expense attribution note"
                  />
                </div>
              </div>
              <Button
                disabled={
                  !Number.isSafeInteger(Number(voucher)) ||
                  Number(voucher) < 1 ||
                  !amount.trim() ||
                  post.isPending ||
                  !!asOf
                }
                onClick={() => post.mutate()}
              >
                Attribute existing expense
              </Button>
              {asOf && (
                <p className="text-xs text-muted-foreground">
                  Historical as-of views are read-only. Clear the as-of date to attribute expenses.
                </p>
              )}
              <div className="max-h-[360px] overflow-auto">
                {detail.data.expenses.map((e) => (
                  <div key={e.id} className="border-b py-2 flex flex-wrap items-center gap-3 text-sm">
                    <span>{name(e.category)}</span>
                    <a href={voucherLink(e.voucherId)} className="underline">
                      {e.voucherNumber || "#" + e.voucherId}
                    </a>
                    <span className="tabular-nums">{e.amountUsd} USD</span>
                    {e.sourceStatus !== "active" && (
                      <span className="text-destructive text-xs">
                        Source voucher {e.sourceStatus} — excluded from current expense total
                      </span>
                    )}
                    {e.note && <span className="text-muted-foreground">{e.note}</span>}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!voidReason.trim() || voidLink.isPending || !!asOf}
                      onClick={() => voidLink.mutate(e.id)}
                    >
                      Remove link
                    </Button>
                  </div>
                ))}
              </div>
              <div>
                <Label>Required reason for removing a linked allocation</Label>
                <Input
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Explain the correction"
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Accounting treatment and limitations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              {Object.values(detail.data.limitations).map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
