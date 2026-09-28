import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Package, AlertTriangle, Pencil } from "lucide-react";
import { BaleWeightEditDialog, type WeightEditBale } from "@/components/BaleWeightEditDialog";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { cn } from "@/lib/utils";
import { EmptyState, LoadingRows } from "@/components/ui/display-state";
import { PageShell, PageActions, financialNumberClassName as financialNumberClass } from "@/components/ui/page-shell";

interface StockBale {
  id: number;
  referenceNumber: string;
  baleCode: string;
  weightKg: string;
  stockEntryDate: string | null;
  finalizedAt: string | null;
  productionDate: string | null;
  workerName: string | null;
  lockedInLoading: boolean;
}

function fmtDate(val: string | null | undefined): string {
  if (!val) return "—";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function FactoryStockBaleList() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);

  const articleCode = params.get("articleCode") || "";
  const productName = params.get("productName") || articleCode;
  const locationId = params.get("locationId") || "";
  const backUrl = params.get("back") || "";

  const handleBack = () => {
    if (backUrl) navigate(backUrl);
    else navigate(-1 as unknown as -1 & (string | URL));
  };
  useEscapeBack(handleBack);

  const queryParams = new URLSearchParams({ articleCode });
  if (locationId) queryParams.set("locationId", locationId);

  const queryClient = useQueryClient();
  const [weightEditBale, setWeightEditBale] = useState<WeightEditBale | null>(null);

  const { data: bales = [], isLoading } = useQuery<StockBale[]>({
    queryKey: [`/api/factory/bale-stock-list`, articleCode, locationId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/bale-stock-list?${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load bales");
      return res.json();
    },
    enabled: !!articleCode,
  });

  const available = bales.filter((b) => !b.lockedInLoading);
  const locked = bales.filter((b) => b.lockedInLoading);

  return (
    <PageShell className="max-w-4xl">
      <PageHeader
        title={`IN_STOCK Bales — ${productName}`}
        subtitle={articleCode !== productName ? articleCode : undefined}
        showBackButton={false}
      >
        <PageActions>
          <Badge variant="secondary">{available.length} available</Badge>
          {locked.length > 0 && (
            <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-500/40">
              <AlertTriangle className="h-3 w-3 mr-1" />
              {locked.length} locked in loading
            </Badge>
          )}
        </PageActions>
      </PageHeader>

      {isLoading ? (
        <LoadingRows rows={6} rowClassName="h-9" />
      ) : bales.length === 0 ? (
        <EmptyState
          icon={<Package className="h-5 w-5" />}
          title="No in-stock bales"
          description={`No IN_STOCK bales found for ${articleCode}.`}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="text-left px-3 py-2.5 font-medium border-b text-xs">Reference No.</th>
                <th className="text-left px-3 py-2.5 font-medium border-b text-xs">Bale Code</th>
                <th className="text-right px-3 py-2.5 font-medium border-b text-xs">Weight (kg)</th>
                <th className="text-left px-3 py-2.5 font-medium border-b text-xs">Production Date</th>
                <th className="text-left px-3 py-2.5 font-medium border-b text-xs">Worker</th>
                <th className="text-center px-3 py-2.5 font-medium border-b text-xs">Status</th>
              </tr>
            </thead>
            <tbody>
              {bales.map((bale, idx) => (
                <tr
                  key={bale.id}
                  className={cn(
                    "border-b last:border-0 transition-colors",
                    idx % 2 === 0 ? "bg-background" : "bg-muted/20",
                    bale.lockedInLoading && "opacity-60"
                  )}
                  data-testid={`row-bale-${bale.referenceNumber}`}
                >
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{bale.referenceNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{bale.baleCode}</td>
                  <td className={cn("px-3 py-2 text-xs", financialNumberClass)}>
                    <button
                      className="group flex items-center gap-1 ml-auto hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWeightEditBale({
                          id: bale.id,
                          referenceNumber: bale.referenceNumber,
                          weightKg: bale.weightKg,
                        });
                      }}
                      title="Correct weight"
                    >
                      {parseFloat(bale.weightKg).toFixed(2)}
                      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 shrink-0" />
                    </button>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {fmtDate(bale.productionDate ?? bale.stockEntryDate ?? bale.finalizedAt)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{bale.workerName || "—"}</td>
                  <td className="px-3 py-2 text-center">
                    {bale.lockedInLoading ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 h-5 text-amber-600 dark:text-amber-400 border-amber-500/40"
                      >
                        Loading
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 h-5 text-green-700 dark:text-green-400 border-green-600/40"
                      >
                        Available
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <BaleWeightEditDialog
        bale={weightEditBale}
        onClose={() => setWeightEditBale(null)}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-stock-list"] });
          setWeightEditBale(null);
        }}
      />
    </PageShell>
  );
}
