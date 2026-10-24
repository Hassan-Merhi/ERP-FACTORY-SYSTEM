import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { companyRateValueSchema, companyRateDateSchema } from "@shared/companyRatePolicy";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { canEditExchangeRates } from "@/lib/exchangeRateEditors";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RefreshCw, Plus, TrendingUp } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { Company, ExchangeRate } from "@shared/schema";
import type { Serialized } from "@shared/apiTypes";

const exchangeRateFormSchema = z.object({
  rate: companyRateValueSchema,
  effectiveDate: companyRateDateSchema,
});

type ExchangeRateFormData = z.infer<typeof exchangeRateFormSchema>;

export function ExchangeRateSettings() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const [showForm, setShowForm] = useState(false);
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  const canEditRate = canEditExchangeRates(currentUser?.role);

  const form = useForm<ExchangeRateFormData>({
    resolver: zodResolver(exchangeRateFormSchema),
    defaultValues: {
      rate: "",
      effectiveDate: "",
    },
  });

  const { data: company } = useQuery<Serialized<Company>>({
    queryKey: [`/api/companies/${selectedCompany?.id}`],
    enabled: !!selectedCompany?.id,
  });

  const activeCompanyId = selectedCompany?.id;
  const baseCurrency = company?.baseCurrency;
  const displayCurrency = company?.displayCurrency;
  const hasPair = !!activeCompanyId && !!baseCurrency && !!displayCurrency && displayCurrency !== "none";

  const { data: todayRateCheck } = useQuery<{ today: string; hasRate: boolean; missingRate?: boolean }>({
    queryKey: ["/api/exchange-rates/check-today", activeCompanyId],
    queryFn: async () => {
      const res = await fetch(`/api/exchange-rates/check-today?companyId=${activeCompanyId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Cannot load company business date");
      return res.json();
    },
    enabled: hasPair,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  // The business date comes from the server's company timezone, not from the
  // browser clock. Do not provide a guessed date if it is unavailable.
  useEffect(() => {
    if (todayRateCheck?.today && !form.formState.dirtyFields.effectiveDate) {
      form.setValue("effectiveDate", todayRateCheck.today);
    }
  }, [todayRateCheck?.today, form]);

  // A company switch discards the previous company's unsaved rate draft.
  useEffect(() => {
    form.reset({ rate: "", effectiveDate: "" });
    setShowForm(false);
  }, [activeCompanyId, form]);

  const { data: exchangeRates = [], isLoading } = useQuery<Serialized<ExchangeRate>[]>({
    queryKey: ["/api/exchange-rates", activeCompanyId, baseCurrency, displayCurrency],
    queryFn: async () => {
      const query = new URLSearchParams({
        companyId: String(activeCompanyId),
        fromCurrency: baseCurrency || "",
        toCurrency: displayCurrency || "",
      });
      const res = await fetch(`/api/exchange-rates?${query.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load exchange rate history");
      return res.json();
    },
    enabled: hasPair,
  });

  const { data: latestRate } = useQuery<Serialized<ExchangeRate> | null>({
    queryKey: ["/api/exchange-rates/latest", activeCompanyId, baseCurrency, displayCurrency],
    queryFn: async () => {
      const query = new URLSearchParams({
        companyId: String(activeCompanyId),
        fromCurrency: baseCurrency || "",
        toCurrency: displayCurrency || "",
      });
      const res = await fetch(`/api/exchange-rates/latest?${query.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load exchange rate");
      return res.json();
    },
    enabled: hasPair,
    refetchOnWindowFocus: true,
  });

  const createRateMutation = useMutation({
    mutationFn: async (data: ExchangeRateFormData) => {
      if (!canEditRate || !hasPair || !todayRateCheck?.today) {
        throw new Error("Company exchange-rate settings or business date are unavailable.");
      }
      return apiRequest("POST", "/api/exchange-rates", {
        fromCurrency: baseCurrency,
        toCurrency: displayCurrency,
        rate: data.rate,
        effectiveDate: data.effectiveDate,
      });
    },
    onSuccess: async () => {
      toast({
        title: "Exchange rate saved",
        description:
          "Saved for the selected date. Historical vouchers are unchanged; current cash/bank translations update in reports.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates/check-today", activeCompanyId] });
      await queryClient.refetchQueries({ queryKey: ["/api/exchange-rates/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/balance-sheet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      form.reset({ rate: "", effectiveDate: todayRateCheck?.today || "" });
      setShowForm(false);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  if (!company?.displayCurrency || company.displayCurrency === "none") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Exchange Rates
          </CardTitle>
          <CardDescription>Multi-currency is not enabled for this company.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            To enable multi-currency, set a display currency for this company in the Companies settings.
          </p>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = (data: ExchangeRateFormData) => {
    if (!canEditRate || !todayRateCheck?.today) {
      toast({
        title: "Cannot save exchange rate",
        description: "The company business date is unavailable or your role cannot edit rates.",
        variant: "destructive",
      });
      return;
    }
    createRateMutation.mutate(data);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Exchange Rates
            </CardTitle>
            <CardDescription>
              {company?.baseCurrency} to {company?.displayCurrency} conversion rates
            </CardDescription>
          </div>
          {canEditRate && (
            <Button
              onClick={() => setShowForm(!showForm)}
              size="sm"
              disabled={!todayRateCheck?.today}
              data-testid="button-add-exchange-rate"
            >
              <Plus className="h-4 w-4 mr-1" />
              Set Rate
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {latestRate && (
          <div className="p-4 bg-muted rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Latest effective rate (as of the company business date)</p>
                <p className="text-2xl font-bold">
                  1 {company?.baseCurrency} = {parseFloat(latestRate.rate).toLocaleString()} {company?.displayCurrency}
                </p>
              </div>
              <Badge variant="secondary">Effective: {formatDisplayDate(latestRate.effectiveDate)}</Badge>
            </div>
          </div>
        )}

        {todayRateCheck && !todayRateCheck.hasRate && (
          <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="exchange-rate-not-today">
            No rate recorded for {todayRateCheck.today}.{" "}
            {latestRate
              ? "The most recent earlier rate remains available for applicable new transactions."
              : "No usable rate is available. Foreign-currency transactions require a confirmed rate."}
          </p>
        )}
        {showForm && canEditRate && (
          <Card className="border-dashed">
            <CardContent className="pt-4">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            1 {company?.baseCurrency} = X {company?.displayCurrency}
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type="number"
                              step="0.000001"
                              placeholder={`Enter ${displayCurrency} per ${baseCurrency}`}
                              data-testid="input-exchange-rate"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="effectiveDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Effective Date</FormLabel>
                          <FormControl>
                            <Input {...field} type="date" data-testid="input-effective-date" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      disabled={createRateMutation.isPending || !todayRateCheck?.today}
                      data-testid="button-save-exchange-rate"
                    >
                      {createRateMutation.isPending && <RefreshCw className="h-4 w-4 mr-2 animate-spin" />}
                      Save Rate
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowForm(false)}
                      data-testid="button-cancel-exchange-rate"
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {exchangeRates.length > 0 && (
          <div>
            <h4 className="font-medium mb-2">Rate History</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Conversion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exchangeRates.map((rate) => (
                  <TableRow key={rate.id} data-testid={`row-exchange-rate-${rate.id}`}>
                    <TableCell>{formatDisplayDate(rate.effectiveDate)}</TableCell>
                    <TableCell className="font-mono">{parseFloat(rate.rate).toLocaleString()}</TableCell>
                    <TableCell className="text-muted-foreground">
                      1 {rate.fromCurrency} = {parseFloat(rate.rate).toLocaleString()} {rate.toCurrency}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!isLoading && exchangeRates.length === 0 && !latestRate && (
          <p className="text-muted-foreground text-sm text-center py-4">
            No exchange rates set for this company's currency pair.{" "}
            {canEditRate
              ? "Set a rate before accepting foreign-currency transactions."
              : "Ask an Admin or Owner to set a rate."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
