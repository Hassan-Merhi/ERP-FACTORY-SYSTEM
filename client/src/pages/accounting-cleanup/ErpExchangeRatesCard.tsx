import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, getAppDate, queryClient } from "@/lib/queryClient";
import type { ClientErrorLike } from "@/lib/clientError";

import { RateFileImportPanel } from "./RateFileImportPanel";
import { canonicalDecimal, type RecordedRate } from "./rateFileImport";

interface CompanyRateRow {
  id: number;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
}

export function companyRecordedRates(rates: CompanyRateRow[]): RecordedRate[] {
  return rates.map((rate) => ({
    fromCurrency: rate.fromCurrency.toUpperCase(),
    toCurrency: rate.toCurrency.toUpperCase(),
    effectiveDate: String(rate.effectiveDate).slice(0, 10),
    rate: String(rate.rate),
    id: rate.id,
  }));
}

/**
 * Dated company exchange rates (exchange_rates), which ERP vouchers, POS sales,
 * purchase orders and Retail journals are rated at (the rate recorded on or
 * before the document date; phase 24). Entry and file import both go through
 * the audited Admin/Owner routes.
 */
export function ErpExchangeRatesCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const today = getAppDate();
  const [fromCurrency, setFromCurrency] = useState("");
  const [toCurrency, setToCurrency] = useState("USD");
  const [rate, setRate] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today);

  const { data: rates = [], isLoading } = useQuery<CompanyRateRow[]>({ queryKey: ["/api/exchange-rates"] });
  const sorted = [...rates].sort(
    (a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)) || b.id - a.id
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates"] });
    queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates/latest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates/check-today"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/exchange-rates", {
        fromCurrency,
        toCurrency,
        rate: canonicalDecimal(rate),
        effectiveDate,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Rate saved" });
      setRate("");
      refresh();
    },
    onError: (error: ClientErrorLike) =>
      toast({ title: "Failed to save rate", description: error.message, variant: "destructive" }),
  });

  const submit = () => {
    if (!/^[A-Z]{3}$/.test(fromCurrency) || !/^[A-Z]{3}$/.test(toCurrency) || fromCurrency === toCurrency) {
      return toast({ title: "Enter two different three-letter currency codes", variant: "destructive" });
    }
    const canonical = canonicalDecimal(rate);
    if (!canonical || /^0(\.0*)?$/.test(canonical)) {
      return toast({ title: "Enter a positive rate", variant: "destructive" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      return toast({ title: "Enter the date the rate applies from", variant: "destructive" });
    }
    if (effectiveDate > today) return toast({ title: "A rate cannot be dated after today", variant: "destructive" });
    save.mutate();
  };

  return (
    <div className="space-y-4" data-testid="card-erp-exchange-rates">
      <p className="text-sm text-muted-foreground">
        1 FROM = rate TO. For a currency against USD either direction works (EUR → USD 1.15, or USD → XOF 600); the rate
        recorded on or before a document's date is used, never a later one.
      </p>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No company rate is recorded yet.</p>
      ) : (
        <Table maxHeight="18rem" scrollLabel="Company exchange rates">
          <TableHeader>
            <TableRow>
              <TableHead>Pair</TableHead>
              <TableHead>Effective from</TableHead>
              <TableHead className="text-end">Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.slice(0, 100).map((row) => (
              <TableRow key={row.id} data-testid={`row-erp-rate-${row.id}`}>
                <TableCell className="font-mono">{`${row.fromCurrency} → ${row.toCurrency}`}</TableCell>
                <TableCell className="whitespace-nowrap">{String(row.effectiveDate).slice(0, 10)}</TableCell>
                <TableCell className="text-end font-mono tabular-nums">{String(row.rate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canEdit && (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <Input
            value={fromCurrency}
            onChange={(event) => setFromCurrency(event.target.value.trim().toUpperCase())}
            placeholder="From (e.g. EUR)"
            aria-label="From currency"
            className="sm:w-32"
            data-testid="input-erp-rate-from"
          />
          <Input
            value={toCurrency}
            onChange={(event) => setToCurrency(event.target.value.trim().toUpperCase())}
            placeholder="To (e.g. USD)"
            aria-label="To currency"
            className="sm:w-32"
            data-testid="input-erp-rate-to"
          />
          <Input
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            placeholder="Rate"
            aria-label="Rate"
            inputMode="decimal"
            className="sm:w-36"
            data-testid="input-erp-rate-rate"
          />
          <Input
            type="date"
            value={effectiveDate}
            max={today}
            onChange={(event) => setEffectiveDate(event.target.value)}
            aria-label="Effective from"
            className="sm:w-44"
            data-testid="input-erp-rate-date"
          />
          <Button
            onClick={submit}
            disabled={save.isPending}
            className="col-span-2 sm:col-span-1"
            data-testid="button-save-erp-rate"
          >
            {save.isPending ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            Save dated rate
          </Button>
        </div>
      )}
      {canEdit && (
        <RateFileImportPanel
          kind="company"
          recorded={companyRecordedRates(rates)}
          importUrl="/api/exchange-rates/batch"
          today={today}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
