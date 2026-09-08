import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
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
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { Company, ExchangeRate } from "@shared/schema";
import type { Serialized } from "@shared/apiTypes";

const exchangeRateFormSchema = z.object({
  rate: z
    .string()
    .min(1, "Rate is required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Rate must be a positive number",
    }),
  effectiveDate: z.string().min(1, "Date is required"),
});

type ExchangeRateFormData = z.infer<typeof exchangeRateFormSchema>;

export function ExchangeRateSettings() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const [showForm, setShowForm] = useState(false);

  const form = useForm<ExchangeRateFormData>({
    resolver: zodResolver(exchangeRateFormSchema),
    defaultValues: {
      rate: "",
      effectiveDate: format(new Date(), "yyyy-MM-dd"),
    },
  });

  const { data: company } = useQuery<Serialized<Company>>({
    queryKey: [`/api/companies/${selectedCompany?.id}`],
    enabled: !!selectedCompany?.id,
  });

  const { data: exchangeRates = [], isLoading } = useQuery<Serialized<ExchangeRate>[]>({
    queryKey: ["/api/exchange-rates"],
    enabled: !!selectedCompany?.id && !!company?.displayCurrency,
  });

  const { data: latestRate } = useQuery({
    queryKey: ["/api/exchange-rates/latest", company?.baseCurrency, company?.displayCurrency],
    queryFn: async () => {
      if (!company?.baseCurrency || !company?.displayCurrency) return null;
      const res = await fetch(
        `/api/exchange-rates/latest?fromCurrency=${company.baseCurrency}&toCurrency=${company.displayCurrency}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!company?.baseCurrency && !!company?.displayCurrency,
  });

  const createRateMutation = useMutation({
    mutationFn: async (data: ExchangeRateFormData) => {
      return apiRequest("POST", "/api/exchange-rates", {
        fromCurrency: company?.baseCurrency,
        toCurrency: company?.displayCurrency,
        rate: data.rate,
        effectiveDate: data.effectiveDate,
      });
    },
    onSuccess: async () => {
      toast({
        title: "Exchange rate saved",
        description: "Cash account balances have been revalued at the new rate.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates"] });
      await queryClient.refetchQueries({ queryKey: ["/api/exchange-rates/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/balance-sheet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      form.reset({ rate: "", effectiveDate: format(new Date(), "yyyy-MM-dd") });
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
          <Button onClick={() => setShowForm(!showForm)} size="sm" data-testid="button-add-exchange-rate">
            <Plus className="h-4 w-4 mr-1" />
            Set Today's Rate
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {latestRate && (
          <div className="p-4 bg-muted rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Current Rate</p>
                <p className="text-2xl font-bold">
                  $1 {company?.baseCurrency} = {parseFloat(latestRate.rate).toLocaleString()} {company?.displayCurrency}
                </p>
              </div>
              <Badge variant="secondary">Effective: {formatDisplayDate(latestRate.effectiveDate)}</Badge>
            </div>
          </div>
        )}

        {showForm && (
          <Card className="border-dashed">
            <CardContent className="pt-4">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            $1 {company?.baseCurrency} = X {company?.displayCurrency}
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type="number"
                              step="0.01"
                              placeholder="e.g., 600"
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
                      disabled={createRateMutation.isPending}
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
                {exchangeRates.slice(0, 10).map((rate) => (
                  <TableRow key={rate.id} data-testid={`row-exchange-rate-${rate.id}`}>
                    <TableCell>{formatDisplayDate(rate.effectiveDate)}</TableCell>
                    <TableCell className="font-mono">{parseFloat(rate.rate).toLocaleString()}</TableCell>
                    <TableCell className="text-muted-foreground">
                      $1 {rate.fromCurrency} = {parseFloat(rate.rate).toLocaleString()} {rate.toCurrency}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!isLoading && exchangeRates.length === 0 && !latestRate && (
          <p className="text-muted-foreground text-sm text-center py-4">
            No exchange rates set yet. Click "Set Today's Rate" to add the first rate.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
