import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { Package } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface StockItem {
  id: number;
  code: string;
  name: string;
  closing: {
    quantity: number;
    rate: number;
    value: number;
  };
}

interface ClosingStockDetailData {
  items: StockItem[];
  totals: {
    quantity: number;
    rate: number;
    value: number;
  };
}

function formatNumber(value: number | null | undefined, decimals: number = 2): string {
  if (value == null || isNaN(value)) return "";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatQty(value: number): string {
  if (value === 0) return "";
  return `${formatNumber(value)} BL`;
}

function _formatValue(value: number): string {
  if (value === 0) return "";
  return formatNumber(value);
}

export default function ClosingStockDetail() {
  const params = useParams<{ groupId: string }>();
  const handleBack = useBackToParent();
  useEscapeToParent();
  const searchString = useSearch();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();

  const groupName = new URLSearchParams(searchString).get("name") || "Stock Group";
  const groupId = params.groupId;

  const { data, isLoading } = useQuery<ClosingStockDetailData>({
    queryKey: ["/api/reports/closing-stock-summary", groupId, "items", selectedCompany?.id],
    queryFn: async () => {
      const response = await fetch(`/api/reports/closing-stock-summary/${groupId}/items`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch closing stock items");
      return response.json();
    },
    enabled: !!selectedCompany?.id && !!groupId,
  });

  return (
    <div className="space-y-6 sm:p-6">
      <PageHeader
        title={groupName}
        icon={<Package className="h-5 w-5" />}
        onBack={handleBack}
        meta={<span>Closing Stock Items - {selectedCompany?.name}</span>}
      />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <div className="bg-primary text-primary-foreground min-w-[420px]">
            <div className="grid grid-cols-5 p-3 font-semibold text-sm">
              <div className="col-span-2">Item Name</div>
              <div className="col-span-3 text-center border-l border-primary-foreground/30">Closing Balance</div>
            </div>
            <div className="grid grid-cols-5 px-3 pb-2 text-xs">
              <div className="col-span-2"></div>
              <div className="text-right">Quantity</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Value</div>
            </div>
          </div>

          <div className="divide-y">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : data?.items && data.items.length > 0 ? (
              <>
                {data.items.map((item) => (
                  <div key={item.id} className="grid grid-cols-5 p-3" data-testid={`row-stock-item-${item.id}`}>
                    <div className="col-span-2 font-medium">
                      <span className="text-muted-foreground text-sm mr-2">[{item.code}]</span>
                      {item.name}
                    </div>
                    <div className="text-right font-mono text-sm">{formatQty(item.closing.quantity)}</div>
                    <div className="text-right font-mono text-sm">{formatAmount(item.closing.rate)}</div>
                    <div className="text-right font-mono text-sm">{formatAmount(item.closing.value)}</div>
                  </div>
                ))}
              </>
            ) : (
              <div className="p-8 text-center text-muted-foreground">No items found in this stock group.</div>
            )}
          </div>

          {data?.totals && (
            <div className="bg-muted/50 border-t-2 border-primary min-w-[420px]">
              <div className="grid grid-cols-5 p-3 font-bold">
                <div className="col-span-2">Total</div>
                <div className="text-right font-mono">{formatNumber(data.totals.quantity)} BL</div>
                <div className="text-right font-mono">{formatAmount(data.totals.rate)}</div>
                <div className="text-right font-mono">{formatAmount(data.totals.value)}</div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
