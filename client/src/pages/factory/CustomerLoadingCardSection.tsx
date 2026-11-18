// Extracted from ./CustomerLoading.tsx to keep that module under the source-size cap.
import { History, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCustomerLoadingState } from "./useCustomerLoadingState";

export function CustomerLoadingCardSection({
  customerId,
  customersQuery,
  loadingQuery,
  resetFilters,
  resetSelection,
  setCustomerId,
  setHistoryProduct,
  setLoadingFilter,
  setPage,
  setProformaName,
}: Pick<
  ReturnType<typeof useCustomerLoadingState>,
  | "customerId"
  | "customersQuery"
  | "loadingQuery"
  | "resetFilters"
  | "resetSelection"
  | "setCustomerId"
  | "setHistoryProduct"
  | "setLoadingFilter"
  | "setPage"
  | "setProformaName"
>) {
  return (
    <Card className="overflow-hidden rounded-2xl border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-violet-50 shadow-sm dark:border-indigo-400/35 dark:from-[hsl(var(--factory-hue)_55%_22%)] dark:via-[hsl(var(--factory-hue)_49%_21%)] dark:to-[hsl(var(--factory-hue)_35%_22%)]">
      <CardContent className="flex flex-col gap-4 p-4 sm:p-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-200 sm:flex">
            <UserRound className="h-6 w-6" />
          </div>
          <div className="min-w-0 w-full max-w-xl space-y-2">
            <div className="text-sm font-semibold text-slate-800 dark:text-blue-100">Customer</div>
            <Select
              value={customerId}
              onValueChange={(value) => {
                setCustomerId(value);
                resetFilters();
                resetSelection();
                setProformaName("");
                setHistoryProduct(null);
              }}
            >
              <SelectTrigger
                className="h-11 w-full border-indigo-200 bg-white/90 font-medium shadow-sm focus:ring-indigo-500 dark:border-indigo-400/50 dark:bg-[hsl(var(--factory-hue)_54%_14%)]/90 dark:text-white"
                data-testid="customer-loading-customer-select"
              >
                <SelectValue placeholder={customersQuery.isLoading ? "Loading customers…" : "Choose a customer"} />
              </SelectTrigger>
              <SelectContent>
                {(customersQuery.data ?? []).map((customer) => (
                  <SelectItem key={customer.id} value={String(customer.id)}>
                    {customer.legalName}
                    {customer.code ? ` · ${customer.code}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center xl:justify-end">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <History className="h-4 w-4 shrink-0 text-indigo-600 dark:text-violet-200" />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground dark:text-blue-100/65">Viewing product history for</div>
              <div className="truncate font-semibold text-slate-800 dark:text-white">
                {loadingQuery.data?.customer?.legalName || "Select a customer to begin"}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!customerId}
            onClick={() => {
              setLoadingFilter("LOADED");
              setPage(1);
            }}
            className="shrink-0 border-violet-300 bg-violet-100/80 text-violet-900 hover:bg-violet-200 dark:border-violet-400/65 dark:bg-violet-500/25 dark:text-violet-100 dark:hover:bg-violet-500/40"
            title="Filter to loaded products; click a Loaded status to inspect its history"
          >
            <History className="mr-2 h-4 w-4" />
            Browse Loading History
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
