import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Package, ChevronRight, RefreshCw, Calendar } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";
import { PeriodFilter, type PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, LoadingRows } from "@/components/ui/display-state";
import { PageActions, PageShell, financialNumberClassName } from "@/components/ui/page-shell";
import { cn } from "@/lib/utils";

interface StockGroupSummary {
  id: number;
  code: string;
  name: string;
  closing: {
    quantity: number;
    rate: number;
    value: number;
  };
  itemCount: number;
}

interface ClosingStockData {
  stockGroups: StockGroupSummary[];
  grandTotal: {
    quantity: number;
    rate: number;
    value: number;
  };
}

interface MutationError extends Error {
  _handledGlobally?: boolean;
}

function formatNumber(value: number, decimals: number = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatQty(value: number): string {
  if (value === 0) return "";
  return `${formatNumber(value)} BL`;
}

export default function ClosingStockSummary() {
  const [, navigate] = useLocation();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(getDefaultPeriodValue("today"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  const { data, isLoading } = useQuery<ClosingStockData>({
    queryKey: ["/api/reports/closing-stock-summary", selectedCompany?.id, periodFilter.fromDate, periodFilter.toDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (periodFilter.fromDate) params.append("fromDate", periodFilter.fromDate);
      if (periodFilter.toDate) params.append("toDate", periodFilter.toDate);
      const response = await fetch(`/api/reports/closing-stock-summary?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch closing stock summary");
      return response.json();
    },
    enabled: !!selectedCompany?.id,
  });

  const { toast } = useToast();
  const [showCarryForwardDialog, setShowCarryForwardDialog] = useState(false);
  const [asOfDate, setAsOfDate] = useState<string>(format(new Date(), "yyyy-MM-dd"));

  const carryForwardMutation = useMutation({
    mutationFn: async (date: string) => {
      const response = await apiRequest("POST", "/api/reports/carryforward-closing-stock", { asOfDate: date });
      return response.json();
    },
    onSuccess: (result) => {
      toast({ title: "Success", description: result.message });
      setShowCarryForwardDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/reports/closing-stock-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/opening-stock-summary"] });
    },
    onError: (error: MutationError) => {
      if (error._handledGlobally) return;
      toast({
        title: "Failed",
        description: error.message || "Failed to carry forward closing stock",
        variant: "destructive",
      });
    },
  });

  const handleGroupClick = (groupId: number, groupName: string) => {
    navigate(`/closing-stock/${groupId}?name=${encodeURIComponent(groupName)}`);
  };

  return (
    <PageShell>
      <PageHeader
        title="Closing Stock Summary"
        subtitle={`Current inventory values${selectedCompany?.name ? ` — ${selectedCompany.name}` : ""}`}
        icon={<Package className="h-5 w-5" />}
      >
        <PageActions>
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter-closing-stock" />
          {data?.grandTotal && data.grandTotal.value > 0 ? (
            <Button onClick={() => setShowCarryForwardDialog(true)} data-testid="button-carryforward-stock">
              <RefreshCw className="mr-2 h-4 w-4" />
              Set as Opening Stock
            </Button>
          ) : null}
        </PageActions>
      </PageHeader>

      <Dialog open={showCarryForwardDialog} onOpenChange={setShowCarryForwardDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Closing Stock as Opening Stock</DialogTitle>
            <DialogDescription>
              Select a date to calculate inventory as of that date. This will replace the current opening stock values.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="as-of-date" className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Calculate inventory as of date
              </Label>
              <Input
                id="as-of-date"
                type="date"
                value={asOfDate}
                onChange={(event) => setAsOfDate(event.target.value)}
                data-testid="input-as-of-date"
              />
              <p className="text-xs text-muted-foreground">
                The system will calculate what inventory was on this date by reversing transactions after it.
              </p>
            </div>
            <div className="space-y-2 border-t pt-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Company:</span>
                <span className="font-medium">{selectedCompany?.name}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Current Inventory Value:</span>
                <span className="font-mono font-medium tabular-nums">{formatAmount(data?.grandTotal?.value ?? 0)}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCarryForwardDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => carryForwardMutation.mutate(asOfDate)}
              disabled={carryForwardMutation.isPending}
              data-testid="button-confirm-carryforward"
            >
              {carryForwardMutation.isPending ? "Processing..." : "Set as Opening Stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden">
        <div className="bg-primary text-primary-foreground">
          <div className="grid grid-cols-2 p-2 text-xs font-semibold sm:grid-cols-4 phone-land:grid-cols-2 sm:p-3 sm:text-sm">
            <div>Particulars</div>
            <div className="hidden border-l border-primary-foreground/30 text-center sm:col-span-3 sm:block">
              Closing Balance
            </div>
            <div className="border-l border-primary-foreground/30 pl-2 text-right sm:hidden phone-land:block">
              Quantity
            </div>
          </div>
          <div className="grid grid-cols-2 px-2 pb-2 text-xs sm:grid-cols-4 phone-land:grid-cols-2 sm:px-3">
            <div />
            <div className="hidden border-l border-primary-foreground/30 pl-2 text-right sm:block">Quantity</div>
            <div className="hidden text-right sm:block">Rate</div>
            <div className="hidden text-right sm:block">Value</div>
          </div>
        </div>

        <div className="divide-y">
          {isLoading ? (
            <LoadingRows />
          ) : data?.stockGroups?.length ? (
            data.stockGroups.map((group) => (
              <button
                type="button"
                key={group.id}
                className="grid w-full grid-cols-2 p-2 text-left hover-elevate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-4 phone-land:grid-cols-2 sm:p-3"
                onClick={() => handleGroupClick(group.id, group.name)}
                data-testid={`row-stock-group-${group.id}`}
              >
                <span className="flex min-w-0 items-center gap-1 truncate text-xs font-medium sm:text-sm">
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="truncate">{group.name}</span>
                </span>
                <span className={cn(financialNumberClassName, "text-sm")}>{formatQty(group.closing.quantity)}</span>
                <span className={cn(financialNumberClassName, "hidden text-sm sm:block")}>
                  {group.closing.rate > 0 ? formatAmount(group.closing.rate) : ""}
                </span>
                <span className={cn(financialNumberClassName, "hidden text-sm sm:block")}>
                  {group.closing.value > 0 ? formatAmount(group.closing.value) : ""}
                </span>
              </button>
            ))
          ) : (
            <EmptyState
              title="No closing stock data"
              description="Closing stock balances will appear here for the selected period once inventory values are available."
              icon={<Package className="h-5 w-5" />}
            />
          )}
        </div>

        {data?.grandTotal ? (
          <div className="border-t-2 border-primary bg-muted/50">
            <div className="grid grid-cols-2 p-2 font-bold sm:grid-cols-4 phone-land:grid-cols-2 sm:p-3">
              <div className="text-xs sm:text-sm">Grand Total</div>
              <div className={financialNumberClassName}>{formatNumber(data.grandTotal.quantity)} BL</div>
              <div className={cn(financialNumberClassName, "hidden sm:block phone-land:hidden")}>
                {formatAmount(data.grandTotal.rate)}
              </div>
              <div className={cn(financialNumberClassName, "hidden sm:block phone-land:hidden")}>
                {formatAmount(data.grandTotal.value)}
              </div>
            </div>
          </div>
        ) : null}
      </Card>
    </PageShell>
  );
}
