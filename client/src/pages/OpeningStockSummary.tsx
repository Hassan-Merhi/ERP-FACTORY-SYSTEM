import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Package, ChevronRight } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, LoadingRows } from "@/components/ui/display-state";
import { PageShell, financialNumberClassName } from "@/components/ui/page-shell";
import { cn } from "@/lib/utils";

interface StockGroupSummary {
  id: number;
  code: string;
  name: string;
  opening: {
    quantity: number;
    rate: number;
    value: number;
  };
  closing: {
    quantity: number;
    rate: number;
    value: number;
  };
  itemCount: number;
}

interface OpeningStockData {
  stockGroups: StockGroupSummary[];
  grandTotal: {
    opening: { quantity: number; value: number };
    closing: { quantity: number; value: number };
  };
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

export default function OpeningStockSummary() {
  const [, navigate] = useLocation();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();

  const { data, isLoading } = useQuery<OpeningStockData>({
    queryKey: ["/api/reports/opening-stock-summary", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });

  const handleGroupClick = (groupId: number, groupName: string) => {
    navigate(`/opening-stock/${groupId}?name=${encodeURIComponent(groupName)}`);
  };

  const openingRate =
    data?.grandTotal?.opening?.quantity && data.grandTotal.opening.quantity > 0
      ? data.grandTotal.opening.value / data.grandTotal.opening.quantity
      : 0;
  const closingRate =
    data?.grandTotal?.closing?.quantity && data.grandTotal.closing.quantity > 0
      ? data.grandTotal.closing.value / data.grandTotal.closing.quantity
      : 0;

  return (
    <PageShell>
      <PageHeader
        title="Opening Stock Summary"
        subtitle={selectedCompany?.name}
        icon={<Package className="h-5 w-5" />}
      />

      <Card className="overflow-hidden">
        <div className="bg-primary text-primary-foreground">
          <div className="grid grid-cols-2 p-2 text-xs font-semibold sm:grid-cols-7 sm:p-3 sm:text-sm">
            <div>Particulars</div>
            <div className="border-l border-primary-foreground/30 text-center sm:col-span-3">Opening Balance</div>
            <div className="hidden border-l border-primary-foreground/30 text-center sm:col-span-3 sm:block">
              Closing Balance
            </div>
          </div>
          <div className="grid grid-cols-2 px-2 pb-2 text-xs sm:grid-cols-7 sm:px-3">
            <div />
            <div className="border-l border-primary-foreground/30 pl-2 text-right">Quantity</div>
            <div className="hidden text-right sm:block">Rate</div>
            <div className="hidden text-right sm:block">Value</div>
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
                className="grid w-full grid-cols-2 p-2 text-left hover-elevate focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-7 sm:p-3"
                onClick={() => handleGroupClick(group.id, group.name)}
                data-testid={`row-stock-group-${group.id}`}
              >
                <span className="flex min-w-0 items-center gap-1 truncate text-xs font-medium sm:text-sm">
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{group.name}</span>
                </span>
                <span className={cn(financialNumberClassName, "text-sm")}>{formatQty(group.opening.quantity)}</span>
                <span className={cn(financialNumberClassName, "hidden text-sm sm:block")}>
                  {group.opening.rate === 0 ? "" : formatAmount(group.opening.rate)}
                </span>
                <span className={cn(financialNumberClassName, "hidden text-sm sm:block")}>
                  {group.opening.value === 0 ? "" : formatAmount(group.opening.value)}
                </span>
                <span className={cn(financialNumberClassName, "hidden border-l pl-2 text-sm sm:block")}>
                  {formatQty(group.closing.quantity)}
                </span>
                <span className={cn(financialNumberClassName, "hidden text-sm sm:block")}>
                  {group.closing.rate === 0 ? "" : formatAmount(group.closing.rate)}
                </span>
                <span className={cn(financialNumberClassName, "hidden text-sm sm:block")}>
                  {group.closing.value === 0 ? "" : formatAmount(group.closing.value)}
                </span>
              </button>
            ))
          ) : (
            <EmptyState
              title="No opening stock data"
              description="Opening stock balances will appear here once inventory values are available."
              icon={<Package className="h-5 w-5" />}
            />
          )}
        </div>

        {data?.grandTotal ? (
          <div className="border-t-2 border-primary bg-muted/50">
            <div className="grid grid-cols-2 p-2 font-bold sm:grid-cols-7 sm:p-3">
              <div className="text-xs sm:text-sm">Grand Total</div>
              <div className={financialNumberClassName}>{formatNumber(data.grandTotal.opening.quantity)} BL</div>
              <div className={cn(financialNumberClassName, "hidden sm:block")}>
                {openingRate === 0 ? "" : formatAmount(openingRate)}
              </div>
              <div className={cn(financialNumberClassName, "hidden sm:block")}>
                {data.grandTotal.opening.value === 0 ? "" : formatAmount(data.grandTotal.opening.value)}
              </div>
              <div className={cn(financialNumberClassName, "hidden border-l pl-2 sm:block")}>
                {formatNumber(data.grandTotal.closing.quantity)} BL
              </div>
              <div className={cn(financialNumberClassName, "hidden sm:block")}>
                {closingRate === 0 ? "" : formatAmount(closingRate)}
              </div>
              <div className={cn(financialNumberClassName, "hidden sm:block")}>
                {data.grandTotal.closing.value === 0 ? "" : formatAmount(data.grandTotal.closing.value)}
              </div>
            </div>
          </div>
        ) : null}
      </Card>
    </PageShell>
  );
}
