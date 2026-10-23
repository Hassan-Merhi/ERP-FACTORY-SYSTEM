import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type Domain = "customer" | "supplier" | "factory_supplier" | "rentals";
interface Allocation {
  matchId: number;
  otherEntryId: number;
  amount: string;
}
interface OpenItem {
  entryId: number;
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  businessDate: string;
  dueDate: string | null;
  overdueDays: number | null;
  side: "charge" | "settlement";
  currency: string;
  originalAmount: string;
  matchedAmount: string;
  outstandingAmount: string;
  currencyVerified: boolean;
  status: string;
  allocations: Allocation[];
}
interface PartyView {
  items: OpenItem[];
  openingBalance: { amount: string; side: string | null; includedInMatching: false };
  currencies: Record<
    string,
    {
      charges: string;
      settlements: string;
      unapplied: string;
      outstanding: string;
    }
  >;
}
interface RentalView {
  currency: string;
  items: Array<{
    year: number;
    month: number;
    dueDate: string;
    expectedAmount: string;
    paidAmount: string;
    outstandingAmount: string;
    status: string;
    paymentIds: number[];
  }>;
  totals: { expected: string; paidAgainstDue: string; outstanding: string; advanceForOtherMonths: string };
}
type Result = PartyView | RentalView;

function isRental(view: Result): view is RentalView {
  return "totals" in view;
}
async function fetchView(url: string): Promise<Result> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || "Reconciliation could not be loaded");
  return body as Result;
}

export default function AccountingOpenItems() {
  const [path] = useLocation();
  const isFactory = path.startsWith("/factory/");
  const isProperties = path.startsWith("/properties/");
  const options: Domain[] = isProperties
    ? ["rentals"]
    : isFactory
      ? ["customer", "factory_supplier", "rentals"]
      : ["customer", "supplier", "rentals"];
  const [domain, setDomain] = useState<Domain>(isProperties ? "rentals" : "customer");
  const [partyId, setPartyId] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [chargeId, setChargeId] = useState("");
  const [settlementId, setSettlementId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const requestRef = useRef<{ payload: string; key: string } | null>(null);
  const { toast } = useToast();
  const client = useQueryClient();
  const rentalModule = isProperties ? "PROPERTIES" : isFactory ? "FACTORY" : "ERP";
  const id = Number(partyId);
  const ready = Number.isSafeInteger(id) && id > 0;
  const url = useMemo(() => {
    if (!ready) return null;
    const q = new URLSearchParams();
    if (asOfDate) q.set("asOfDate", asOfDate);
    if (domain === "rentals") {
      q.set("module", rentalModule);
      q.set("contractId", String(id));
      return "/api/accounting/open-items/rentals?" + q.toString();
    }
    q.set("domain", domain);
    q.set("partyId", String(id));
    return "/api/accounting/open-items?" + q.toString();
  }, [ready, domain, rentalModule, id, asOfDate]);
  const query = useQuery<Result>({
    queryKey: ["/api/accounting/open-items/view", url],
    queryFn: () => fetchView(url!),
    enabled: !!url,
    retry: false,
  });
  const apply = useMutation({
    mutationFn: async () => {
      const payload = {
        domain,
        partyId: id,
        chargeEntryId: Number(chargeId),
        settlementEntryId: Number(settlementId),
        amount,
        reason: reason || null,
      };
      const fingerprint = JSON.stringify(payload);
      const key = requestRef.current?.payload === fingerprint ? requestRef.current.key : crypto.randomUUID();
      requestRef.current = { payload: fingerprint, key };
      const response = await apiRequest("POST", "/api/accounting/open-items/matches", {
        ...payload,
        idempotencyKey: key,
      });
      return response.json();
    },
    onSuccess: () => {
      requestRef.current = null;
      toast({ title: "Entries matched" });
      client.invalidateQueries({ queryKey: ["/api/accounting/open-items/view"] });
    },
    onError: (error: Error) => toast({ title: "Matching refused", description: error.message, variant: "destructive" }),
  });
  const unmatch = useMutation({
    mutationFn: async (matchId: number) => {
      const response = await apiRequest("POST", `/api/accounting/open-items/matches/${matchId}/void`, {
        reason: voidReason,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Match cancelled; original vouchers unchanged" });
      client.invalidateQueries({ queryKey: ["/api/accounting/open-items/view"] });
    },
    onError: (error: Error) =>
      toast({ title: "Cancellation refused", description: error.message, variant: "destructive" }),
  });
  const view = query.data;
  const party = view && !isRental(view) ? view : null;
  const rent = view && isRental(view) ? view : null;
  const voucherHref = (id: number) =>
    isFactory
      ? `/factory/voucher-detail/${id}`
      : isProperties
        ? `/properties/voucher-detail/${id}`
        : `/voucher-detail/${id}`;
  const optionsLabel: Record<Domain, string> = {
    customer: "Customers",
    supplier: "ERP suppliers",
    factory_supplier: "Factory suppliers",
    rentals: "Rentals",
  };

  return (
    <div className="space-y-4 p-3 sm:p-5" data-testid="page-accounting-open-items">
      <div>
        <h1 className="text-2xl font-semibold">Open-item reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Match payments to posted charges; accounting entries, currencies and balances remain unchanged.
        </p>
      </div>
      <Card>
        <CardContent className="grid gap-3 pt-5 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="open-item-domain">Area</Label>
            <select
              id="open-item-domain"
              className="h-10 w-full rounded-md border bg-background px-2"
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value as Domain);
                setPartyId("");
              }}
            >
              {options.map((v) => (
                <option key={v} value={v}>
                  {optionsLabel[v]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="open-item-party"> {domain === "rentals" ? "Rental contract ID" : "Party ID"} </Label>
            <Input
              id="open-item-party"
              type="number"
              min={1}
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              placeholder="Enter ID"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="open-item-date">As of date (optional)</Label>
            <Input id="open-item-date" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              disabled={!ready || query.isFetching}
              onClick={() => query.refetch()}
              className="w-full"
            >
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
      {query.isLoading && ready && <p className="text-sm text-muted-foreground">Loading entries…</p>}
      {query.isError && (
        <p className="text-sm text-destructive" role="alert">
          {(query.error as Error).message}
        </p>
      )}
      {!ready && (
        <p className="text-sm text-muted-foreground">
          Select an area and enter the corresponding ID to view its items.
        </p>
      )}
      {rent && (
        <Card>
          <CardHeader>
            <CardTitle>
              Rental {rentalModule} · {rent.currency}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {Object.entries(rent.totals).map(([key, value]) => (
                <div key={key}>
                  <p className="text-muted-foreground">{key.replace(/([A-Z])/g, " $1")}</p>
                  <p className="font-semibold tabular-nums">
                    {value} {rent.currency}
                  </p>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Due month</th>
                    <th className="p-2">Due date</th>
                    <th className="p-2 text-right">Expected</th>
                    <th className="p-2 text-right">Paid</th>
                    <th className="p-2 text-right">Unpaid</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rent.items.map((row) => (
                    <tr key={row.year + "-" + row.month} className="border-b">
                      <td className="p-2">
                        {row.year}-{String(row.month).padStart(2, "0")}
                      </td>
                      <td className="p-2">{row.dueDate}</td>
                      <td className="p-2 text-right tabular-nums">{row.expectedAmount}</td>
                      <td className="p-2 text-right tabular-nums">{row.paidAmount}</td>
                      <td className="p-2 text-right tabular-nums">{row.outstandingAmount}</td>
                      <td className="p-2">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      {party && (
        <>
          <p className="text-xs text-muted-foreground">
            Original party opening balance: {party.openingBalance.amount}
            {party.openingBalance.side ? " (" + party.openingBalance.side + ")" : ""}. Opening balances are displayed
            separately and are not automatically converted into invoices or included in the matching totals.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(party.currencies).flatMap(([currency, totals]) => [
              <Card key={currency + "-outstanding"}>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground">Unpaid charges · {currency}</p>
                  <p className="text-xl font-semibold tabular-nums">{totals.outstanding}</p>
                </CardContent>
              </Card>,
              <Card key={currency + "-unapplied"}>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground">Unapplied payments/credits · {currency}</p>
                  <p className="text-xl font-semibold tabular-nums">{totals.unapplied}</p>
                </CardContent>
              </Card>,
            ])}
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Posted documents and matching history</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Voucher</th>
                      <th className="p-2">Date</th>
                      <th className="p-2">Type</th>
                      <th className="p-2 text-right">Original</th>
                      <th className="p-2 text-right">Matched</th>
                      <th className="p-2 text-right">Remaining</th>
                      <th className="p-2">Action / links</th>
                    </tr>
                  </thead>
                  <tbody>
                    {party.items.map((item) => (
                      <tr key={item.entryId} className="border-b align-top">
                        <td className="p-2">
                          <a className="underline" href={voucherHref(item.voucherId)}>
                            {item.voucherNumber}
                          </a>
                          <div className="text-xs text-muted-foreground">Entry {item.entryId}</div>
                        </td>
                        <td className="p-2">
                          {item.businessDate}
                          {item.dueDate && <div className="text-xs text-muted-foreground">Due {item.dueDate}</div>}
                          {item.overdueDays !== null && item.overdueDays > 0 && (
                            <div className="text-xs text-destructive">{item.overdueDays} days overdue</div>
                          )}
                        </td>
                        <td className="p-2">
                          {item.side} · {item.voucherType}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {item.originalAmount} {item.currency}
                          {!item.currencyVerified && (
                            <div className="text-xs text-destructive">Currency unverified — USD base displayed</div>
                          )}
                        </td>
                        <td className="p-2 text-right tabular-nums">{item.matchedAmount}</td>
                        <td className="p-2 text-right tabular-nums">
                          {item.outstandingAmount} <div className="text-xs">{item.status}</div>
                        </td>
                        <td className="p-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              item.side === "charge"
                                ? setChargeId(String(item.entryId))
                                : setSettlementId(String(item.entryId))
                            }
                          >
                            Select {item.side === "charge" ? "charge" : "payment"}
                          </Button>
                          {item.allocations.map((link) => (
                            <div key={link.matchId} className="mt-1 text-xs text-muted-foreground">
                              Match #{link.matchId}: entry {link.otherEntryId} · {link.amount}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!voidReason.trim() || unmatch.isPending}
                                onClick={() => unmatch.mutate(link.matchId)}
                              >
                                Unmatch
                              </Button>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Match a posted payment or credit</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Charge entry ID</Label>
                <Input type="number" value={chargeId} onChange={(e) => setChargeId(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Payment / credit entry ID</Label>
                <Input type="number" value={settlementId} onChange={(e) => setSettlementId(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Amount in original currency</Label>
                <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Matching note (optional)</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  disabled={!chargeId || !settlementId || !amount || apply.isPending || !!asOfDate}
                  onClick={() => apply.mutate()}
                >
                  Match items
                </Button>
              </div>
              <div className="space-y-1 sm:col-span-3">
                <Label>Reason when cancelling a match</Label>
                <Input
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Required before Unmatch"
                />
              </div>
              {asOfDate && (
                <p className="text-xs text-muted-foreground sm:col-span-3">
                  Historical view is read-only. Clear the as-of date to match current items.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
