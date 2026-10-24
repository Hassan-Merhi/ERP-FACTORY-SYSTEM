import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Currency = "USD" | "ZMW";
type CashAccount = {
  accountKind: "ledger" | "bank";
  id: number;
  name: string;
  code: string;
  nativeBalancesByCurrency: Record<string, string>;
  totalsProvisional: boolean;
};
type CashSummary = { accounts: CashAccount[]; currentZmwPerUsd: string | null };
type RateRow = { rate: string } | null;

const keyForAccount = (account: CashAccount) => account.accountKind + ":" + account.id;

export function ZambiaCashCurrencyTransfer() {
  const { selectedCompany } = useCompany();
  const { displayCurrency, baseCurrency } = useCurrencyContext();
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  const { toast } = useToast();
  const companyId = selectedCompany?.id;
  const enabled = !!companyId && baseCurrency === "USD" && displayCurrency === "ZMW";
  const canPost = currentUser?.role === "Admin" || currentUser?.role === "Owner" || currentUser?.role === "Developer";

  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [fromCurrency, setFromCurrency] = useState<Currency>("USD");
  const toCurrency: Currency = fromCurrency === "USD" ? "ZMW" : "USD";
  const [amount, setAmount] = useState("");
  const [transferDate, setTransferDate] = useState("");
  const [note, setNote] = useState("");
  const requestId = useRef<string | null>(null);

  const { data: daily } = useQuery<{ today: string }>({
    queryKey: ["/api/exchange-rates/check-today", companyId, "currency-transfer"],
    queryFn: async () => {
      const result = await fetch("/api/exchange-rates/check-today?companyId=" + companyId, { credentials: "include" });
      if (!result.ok) throw new Error("Cannot load Zambia's business date");
      return result.json();
    },
    enabled,
  });
  useEffect(() => {
    setSource("");
    setDestination("");
    setAmount("");
    setTransferDate("");
    requestId.current = null;
  }, [companyId]);
  useEffect(() => {
    if (daily?.today && !transferDate) setTransferDate(daily.today);
  }, [daily?.today, transferDate]);

  const { data: summary } = useQuery<CashSummary>({
    queryKey: ["/api/accounts/multi-currency/cash-bank-revaluation", companyId, "zambia-transfer"],
    queryFn: async () => {
      const res = await fetch("/api/accounts/multi-currency/cash-bank-revaluation", { credentials: "include" });
      if (!res.ok) throw new Error("Unable to load cash and bank balances");
      return res.json();
    },
    enabled: enabled && canPost,
    staleTime: 0,
  });
  const { data: historicalRate, isFetching: rateLoading } = useQuery<RateRow>({
    queryKey: ["/api/exchange-rates/latest", companyId, "USD", "ZMW", transferDate, "currency-transfer"],
    queryFn: async () => {
      const args = new URLSearchParams({
        companyId: String(companyId),
        fromCurrency: "USD",
        toCurrency: "ZMW",
        asOf: transferDate,
      });
      const res = await fetch("/api/exchange-rates/latest?" + args, { credentials: "include" });
      if (!res.ok) throw new Error("Cannot fetch historical company rate");
      return res.json();
    },
    enabled: enabled && !!transferDate,
    staleTime: 0,
  });

  const accounts = summary?.accounts ?? [];
  const fromAccount = accounts.find((account) => keyForAccount(account) === source);
  const toAccount = accounts.find((account) => keyForAccount(account) === destination);
  const rate = Number(historicalRate?.rate);
  const numberAmount = Number(amount);
  const validAmount = /^\d{1,12}(?:\.\d{1,2})?$/.test(amount) && numberAmount > 0;
  const toAmount =
    validAmount && Number.isFinite(rate) && rate > 0
      ? (fromCurrency === "USD" ? numberAmount * rate : numberAmount / rate).toFixed(2)
      : null;
  const available = fromAccount ? Number(fromAccount.nativeBalancesByCurrency[fromCurrency] ?? "0") : 0;
  const valid =
    canPost &&
    enabled &&
    source !== destination &&
    !!fromAccount &&
    !!toAccount &&
    validAmount &&
    !rateLoading &&
    Number.isFinite(rate) &&
    rate > 0 &&
    !!toAmount &&
    Number(toAmount) > 0 &&
    !!transferDate &&
    (!daily?.today || transferDate <= daily.today) &&
    !fromAccount.totalsProvisional &&
    available >= numberAmount;

  const mutate = useMutation({
    mutationFn: async () => {
      if (!valid || !fromAccount || !toAccount || !historicalRate) throw new Error("Transfer details are not valid.");
      if (!requestId.current) requestId.current = crypto.randomUUID();
      const res = await apiRequest("POST", "/api/accounts/multi-currency/zambia-transfer", {
        from: { kind: fromAccount.accountKind, id: fromAccount.id },
        to: { kind: toAccount.accountKind, id: toAccount.id },
        fromCurrency,
        toCurrency,
        amount,
        rate: historicalRate.rate,
        transferDate,
        clientRequestId: requestId.current,
        description: note.trim() || null,
      });
      return res.json() as Promise<{ voucherNumber: string; replayed: boolean }>;
    },
    onSuccess: (posted) => {
      toast({
        title: posted.replayed ? "Previously posted transfer" : "Currency transfer posted",
        description: "Voucher " + posted.voucherNumber,
      });
      requestId.current = null;
      setAmount("");
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/multi-currency"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
    onError: (error: Error) => {
      toast({ title: "Transfer not posted", description: error.message, variant: "destructive" });
      // Preserve the same clientRequestId on retry to prevent double posting
      // when a network failure follows a successful database commit.
    },
  });

  if (!enabled || !canPost) return null;
  return (
    <Card data-testid="zambia-cash-currency-transfer">
      <CardHeader>
        <CardTitle className="text-base">USD / ZMW Cash &amp; Bank Currency Transfer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Converts between cash/bank currency balances using the rate approved for the transfer date. Posts one balanced
          journal; historical vouchers are never revalued.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Funds leaving</Label>
            <Select
              value={source}
              onValueChange={(v) => {
                setSource(v);
                requestId.current = null;
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Source cash/bank account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={keyForAccount(a)} value={keyForAccount(a)}>
                    {a.name} ({a.accountKind}) — {fromCurrency} {a.nativeBalancesByCurrency[fromCurrency] ?? "0"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Funds arriving</Label>
            <Select
              value={destination}
              onValueChange={(v) => {
                setDestination(v);
                requestId.current = null;
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Destination cash/bank account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={keyForAccount(a)} value={keyForAccount(a)}>
                    {a.name} ({a.accountKind})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Source currency</Label>
            <Select
              value={fromCurrency}
              onValueChange={(v) => {
                setFromCurrency(v as Currency);
                requestId.current = null;
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD → ZMW</SelectItem>
                <SelectItem value="ZMW">ZMW → USD</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Transfer date</Label>
            <Input
              type="date"
              value={transferDate}
              max={daily?.today}
              onChange={(e) => {
                setTransferDate(e.target.value);
                requestId.current = null;
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>Source amount ({fromCurrency})</Label>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                requestId.current = null;
              }}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1">
            <Label>Purpose (optional)</Label>
            <Input
              value={note}
              maxLength={400}
              onChange={(e) => {
                setNote(e.target.value);
                requestId.current = null;
              }}
              placeholder="Cash exchanged"
            />
          </div>
        </div>
        <p className="text-sm" data-testid="zambia-transfer-preview">
          {rateLoading
            ? "Loading approved rate…"
            : historicalRate?.rate
              ? `1 USD = ${historicalRate.rate} ZMW · Destination receives ${toAmount ?? "—"} ${toCurrency}`
              : "No approved USD/ZMW rate for the selected date. Transfer is blocked."}
        </p>
        {fromAccount?.totalsProvisional && (
          <p className="text-sm text-destructive">
            Resolve source account's historical currency amounts before transferring.
          </p>
        )}
        {validAmount && available < numberAmount && (
          <p className="text-sm text-destructive">Insufficient native {fromCurrency} funds in the source account.</p>
        )}
        <Button
          disabled={!valid || mutate.isPending}
          onClick={() => mutate.mutate()}
          data-testid="button-post-zambia-cash-transfer"
        >
          {mutate.isPending ? "Posting transfer…" : "Post Currency Transfer"}
        </Button>
      </CardContent>
    </Card>
  );
}
