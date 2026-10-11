import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest, getAppDate } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Trash2, TrendingUp } from "lucide-react";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { canEditExchangeRates } from "@/lib/exchangeRateEditors";
import { RateFileImportPanel } from "@/pages/accounting-cleanup/RateFileImportPanel";
import type { RecordedRate } from "@/pages/accounting-cleanup/rateFileImport";

interface FactoryFxRateRow {
  id: number;
  currencyCode: string;
  rateToUsd: string;
  effectiveDate: string;
}

/** Factory rates as the import preview compares them (USD per 1 unit). */
export function factoryRecordedRates(rates: FactoryFxRateRow[]): RecordedRate[] {
  return rates.map((rate) => ({
    fromCurrency: rate.currencyCode,
    toCurrency: "USD",
    effectiveDate: String(rate.effectiveDate).slice(0, 10),
    rate: String(rate.rateToUsd),
    id: rate.id,
  }));
}

export function FxRatesCard() {
  const { toast } = useToast();
  const [newCurrency, setNewCurrency] = useState("");
  const [newRate, setNewRate] = useState("");
  // Dated entry (Accounting clean-up, step 2): a back-dated rate applies from
  // its date; a date after today is refused here (the import route refuses it too).
  const today = getAppDate();
  const [newDate, setNewDate] = useState(today);
  // Saving or removing a rate is Admin/Owner/Developer only (enforced by the server).
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  const canEdit = canEditExchangeRates(currentUser?.role);

  const { data: rates = [], isLoading } = useQuery<FactoryFxRateRow[]>({
    queryKey: ["/api/factory/fx-rates"],
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      currencyCode,
      rateToUsd,
      effectiveDate,
    }: {
      currencyCode: string;
      rateToUsd: string;
      effectiveDate: string;
    }) => {
      const res = await apiRequest("POST", "/api/factory/fx-rates", { currencyCode, rateToUsd, effectiveDate });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rate saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-rates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
      setNewCurrency("");
      setNewRate("");
      setNewDate(today);
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Failed to save rate", description: err.message, variant: "destructive" }),
  });

  // Records today's external market rate (server-fetched, audited). Lookups only
  // suggest a fetched rate; it is used as a confirmed rate once it is saved here.
  const saveFetchedMutation = useMutation({
    mutationFn: async (currencyCode: string) => {
      const res = await apiRequest("POST", "/api/factory/fx-rates/fetched", { currencyCode });
      return res.json() as Promise<{ created: boolean }>;
    },
    onSuccess: (data) => {
      toast({ title: data.created ? "Market rate saved" : "A market rate is already saved for today" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-rates"] });
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Failed to save market rate", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (currency: string) => {
      const res = await apiRequest("DELETE", `/api/factory/fx-rates/${currency}`);
      return res.json() as Promise<{ removed: number; kept: unknown[] }>;
    },
    onSuccess: (data) => {
      // Rates a document used and recorded market rates are kept by the server.
      toast({
        title: data.removed > 0 ? "Rate removed" : "No rate removed",
        description: data.kept?.length > 0 ? "Rates used by documents and recorded market rates were kept." : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-rates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Failed to remove rate", description: err.message, variant: "destructive" }),
  });

  const handleAdd = () => {
    const cc = newCurrency.trim().toUpperCase();
    const rate = parseFloat(newRate);
    if (!cc || cc.length < 2 || cc.length > 6)
      return toast({ title: "Enter a valid currency code (2–6 letters)", variant: "destructive" });
    if (isNaN(rate) || rate <= 0) return toast({ title: "Enter a positive rate", variant: "destructive" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate))
      return toast({ title: "Enter the date the rate applies from", variant: "destructive" });
    if (newDate > today) return toast({ title: "A rate cannot be dated after today", variant: "destructive" });
    saveMutation.mutate({ currencyCode: cc, rateToUsd: newRate, effectiveDate: newDate });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-muted-foreground" />
          FX Rates
        </CardTitle>
        <CardDescription>
          Set the exchange rates used to convert foreign-currency supplier balances to USD in Net Position and on
          supplier cards. For example: EUR = 1.18 means 1 EUR = 1.18 USD.{" "}
          <span className="mt-1 block">
            Each rate applies from its date until the next dated rate of that currency; enter past dates to rate older
            documents.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : rates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rates configured yet. Add one below.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead>Rate to USD</TableHead>
                <TableHead>Effective from</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.map((r, index) => (
                <TableRow
                  key={r.id ?? `${r.currencyCode}-${r.effectiveDate}`}
                  data-testid={`row-fxrate-${r.currencyCode}`}
                >
                  <TableCell className="font-mono font-semibold">{r.currencyCode}</TableCell>
                  <TableCell className="font-mono">{parseFloat(r.rateToUsd).toFixed(4)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{r.effectiveDate}</TableCell>
                  <TableCell>
                    {/* Removing is by currency: offered once, on its latest row. */}
                    {canEdit && rates.findIndex((other) => other.currencyCode === r.currencyCode) === index && (
                      <Button
                        aria-label={`Remove unused ${r.currencyCode} rates`}
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(r.currencyCode)}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-fxrate-${r.currencyCode}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {canEdit && (
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:flex-wrap sm:items-center">
            <Input
              placeholder="Currency (e.g. EUR)"
              value={newCurrency}
              onChange={(e) => setNewCurrency(e.target.value.toUpperCase())}
              className="w-full sm:w-36"
              data-testid="input-fxrate-currency"
            />
            <Input
              placeholder="Rate to USD (e.g. 1.18)"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              className="w-full sm:w-48"
              type="number"
              step="0.0001"
              min="0"
              data-testid="input-fxrate-rate"
            />
            <Input
              type="date"
              value={newDate}
              max={today}
              onChange={(e) => setNewDate(e.target.value)}
              className="w-full sm:w-44"
              aria-label="Effective from"
              data-testid="input-fxrate-date"
            />
            <Button onClick={handleAdd} disabled={saveMutation.isPending} data-testid="button-add-fxrate">
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Add / Update Rate
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const cc = newCurrency.trim().toUpperCase();
                if (!/^[A-Z]{3}$/.test(cc))
                  return toast({ title: "Enter a valid currency code (2–6 letters)", variant: "destructive" });
                saveFetchedMutation.mutate(cc);
              }}
              disabled={saveFetchedMutation.isPending}
              data-testid="button-save-fetched-fxrate"
            >
              {saveFetchedMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Save today's market rate
            </Button>
          </div>
        )}
        {canEdit && (
          <RateFileImportPanel
            kind="factory"
            recorded={factoryRecordedRates(rates)}
            importUrl="/api/factory/fx-rates/batch"
            today={today}
            onSaved={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-rates"] });
              queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers/with-balances"] });
              queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
