import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RefreshCw, TrendingUp, Clock } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { format } from "date-fns";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { canEditExchangeRates } from "@/lib/exchangeRateEditors";

const rateFormSchema = z.object({
  rate: z
    .string()
    .min(1, "Rate is required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Rate must be a positive number",
    }),
});

type RateFormData = z.infer<typeof rateFormSchema>;

interface DailyRateCompany {
  baseCurrency?: string | null;
  displayCurrency?: string | null;
}

interface DailyExchangeRate {
  rate?: string | number | null;
  effectiveDate?: string | Date | null;
}

interface DailyRateModalProps {
  companyId: number;
}

// ---------------------------------------------------------------------------
// localStorage helpers — persist "rate was set today" across remounts / tabs.
// Key format:  daily-rate-done-{companyId}-{YYYY-MM-DD}
// The check is per-company and per-calendar-day so it expires automatically
// when the date changes (no need for explicit cleanup of the current day's key).
// ---------------------------------------------------------------------------
const LS_PREFIX = "daily-rate-done";

function lsKey(companyId: number, date: string) {
  return `${LS_PREFIX}-${companyId}-${date}`;
}

function isDoneToday(companyId: number, date: string): boolean {
  try {
    return localStorage.getItem(lsKey(companyId, date)) === "1";
  } catch {
    return false;
  }
}

function markDoneToday(companyId: number, date: string): void {
  try {
    localStorage.setItem(lsKey(companyId, date), "1");
    // Prune stale entries for this company (keep only today's).
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${LS_PREFIX}-${companyId}-`) && key !== lsKey(companyId, date)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorage may be unavailable (private browsing, quota, etc.) — silent fallback.
  }
}

export function DailyRateModal({ companyId }: DailyRateModalProps) {
  const { toast } = useToast();
  const { selectedCompany: _selectedCompany } = useCompany();
  const [isOpen, setIsOpen] = useState(false);
  // Only a user who may save a rate (Admin/Owner/Developer, wave 14) is prompted for it.
  const { data: currentUser } = useQuery(authenticatedUserQueryOptions());
  const canEditRate = canEditExchangeRates(currentUser?.role);

  const form = useForm<RateFormData>({
    resolver: zodResolver(rateFormSchema),
    defaultValues: {
      rate: "",
    },
  });

  const { data: company } = useQuery<DailyRateCompany>({
    queryKey: [`/api/companies/${companyId}`],
    enabled: !!companyId,
  });

  const { data: todayRateCheck, isLoading: isCheckingRate } = useQuery<{
    hasRate: boolean;
    latestRate?: DailyExchangeRate;
    today: string;
  }>({
    queryKey: ["/api/exchange-rates/check-today", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/exchange-rates/check-today?companyId=${companyId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to check rate");
      return res.json();
    },
    enabled: canEditRate && !!companyId && !!company?.displayCurrency && company.displayCurrency !== "none",
    // The backend is the single source of truth for whether today's rate has been set
    // company-wide.  Always refetch on focus so multi-user saves propagate promptly.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const previousRate = todayRateCheck?.latestRate;
  const previousRateValue = previousRate?.rate ? parseFloat(String(previousRate.rate)) : null;
  const previousRateDate = previousRate?.effectiveDate
    ? new Date(previousRate.effectiveDate).toLocaleDateString()
    : null;

  // -------------------------------------------------------------------------
  // Decide whether to show the modal.
  //
  // Rules:
  //  1. Backend says rate is already set → mark done in localStorage, close.
  //  2. Rate was already set (or modal already shown) today in THIS browser →
  //     skip (persists across tabs, page reloads, and component remounts).
  //  3. Otherwise → show.
  //
  // We deliberately do NOT auto-open when the modal was manually dismissed
  // without saving — that only suppresses for the remainder of the browser
  // session via the `isOpen` state (the localStorage key is only written on
  // successful save).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!canEditRate || isCheckingRate || !todayRateCheck || !company) return;

    const today = todayRateCheck.today;

    if (todayRateCheck.hasRate) {
      // Backend confirms rate exists — write the localStorage flag so we don't
      // show the modal again for this (company, day) in any tab or after a reload.
      markDoneToday(companyId, today);
      setIsOpen(false);
      return;
    }

    // Already handled in this browser today (rate was saved earlier).
    if (isDoneToday(companyId, today)) return;

    // No rate set yet and not previously dismissed → show.
    if (company.displayCurrency && company.displayCurrency !== "none") {
      if (previousRateValue) {
        form.setValue("rate", String(previousRateValue));
      }
      setIsOpen(true);
    }
  }, [canEditRate, todayRateCheck, isCheckingRate, company, companyId, previousRateValue, form]);

  const createRateMutation = useMutation({
    mutationFn: async (data: RateFormData) => {
      return apiRequest("POST", "/api/exchange-rates", {
        fromCurrency: company?.baseCurrency,
        toCurrency: company?.displayCurrency,
        rate: data.rate,
        // Use the company's own business date (from the backend check-today response),
        // not this browser's local clock — so every user's save lands on the same shared
        // daily row regardless of their device/timezone.
        effectiveDate: todayRateCheck?.today || format(new Date(), "yyyy-MM-dd"),
      });
    },
    onSuccess: async () => {
      const today = todayRateCheck?.today || format(new Date(), "yyyy-MM-dd");
      // Persist "rate set today" so the modal doesn't reappear in any tab or
      // after remounting until tomorrow.
      markDoneToday(companyId, today);

      toast({ title: "Today's exchange rate has been set" });
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates"] });
      await queryClient.refetchQueries({ queryKey: ["/api/exchange-rates/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/exchange-rates/check-today", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/balance-sheet"] });
      setIsOpen(false);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: RateFormData) => {
    createRateMutation.mutate(data);
  };

  // "Use Previous Rate" must actually persist today's shared company rate (copied from
  // the most recent earlier rate) — merely closing the popup left no row for today, which
  // is why the popup kept reappearing for every user even after someone clicked this.
  const handleUsePrevious = () => {
    if (previousRateValue) {
      createRateMutation.mutate({ rate: String(previousRateValue) });
    } else {
      setIsOpen(false);
    }
  };

  if (!company?.displayCurrency || company.displayCurrency === "none") {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Set Today's Exchange Rate
          </DialogTitle>
          <DialogDescription>
            No exchange rate has been set for today (
            {format(todayRateCheck?.today ? new Date(`${todayRateCheck.today}T00:00:00`) : new Date(), "MMM d, yyyy")}
            ).
          </DialogDescription>
        </DialogHeader>

        {previousRateValue && previousRateDate && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">
              Last rate ({previousRateDate}):{" "}
              <strong className="text-foreground">
                1 {company?.baseCurrency} = {previousRateValue.toLocaleString()} {company?.displayCurrency}
              </strong>
              {" — "}still being used for display
            </span>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="rate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    1 {company?.baseCurrency} = X {company?.displayCurrency} (today)
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      step="0.01"
                      placeholder="e.g., 600"
                      autoFocus
                      data-testid="input-daily-rate"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleUsePrevious}
                disabled={createRateMutation.isPending}
                data-testid="button-skip-rate"
              >
                {previousRateValue ? "Use Previous Rate" : "Skip for Now"}
              </Button>
              <Button type="submit" disabled={createRateMutation.isPending} data-testid="button-save-daily-rate">
                {createRateMutation.isPending && <RefreshCw className="h-4 w-4 mr-2 animate-spin" />}
                Set Today's Rate
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
