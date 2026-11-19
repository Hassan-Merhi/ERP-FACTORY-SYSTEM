import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { PageHeader } from "@/components/PageHeader";
import { Package, Trash2, ShoppingCart, AlertTriangle, RefreshCw, Layers, Truck } from "lucide-react";
import { RowsExportMenu, type RowsExportColumn, type RowsExportSheet } from "@/components/export/RowsExportMenu";
import {
  SectionTable,
  fmtKg,
  fmtMoney,
  fmtN,
  groupByCategory,
  type BucketRow,
  type SectionKey,
  type SectionTotal,
} from "./BaleLedgerSectionTable";

interface LedgerData {
  currentStock: BucketRow[];
  wasteStock: BucketRow[];
  sold: BucketRow[];
  wasteDispatched: BucketRow[];
  pendingLoading: BucketRow[];
  totals: {
    currentStock: SectionTotal;
    wasteStock: SectionTotal;
    sold: SectionTotal;
    wasteDispatched: SectionTotal;
    pendingLoading: SectionTotal;
    grand: SectionTotal;
  };
}

const LEDGER_EXPORT_SECTIONS: readonly [SectionKey, string][] = [
  ["currentStock", "Current Stock"],
  ["wasteStock", "Wipers & Garbages"],
  ["sold", "Stock Sold"],
  ["pendingLoading", "Pending Loading"],
  ["wasteDispatched", "Waste Dispatched"],
];

const LEDGER_EXPORT_COLUMNS: RowsExportColumn<BucketRow>[] = [
  { header: "Category", value: (row) => row.categoryName || "—" },
  { header: "Product", value: (row) => row.productName },
  { header: "Bales", value: (row) => row.baleCount, type: "number" },
  { header: "Weight (kg)", value: (row) => row.totalWeightKg, type: "number" },
  {
    header: "Avg Sell/Bale",
    value: (row) => (row.baleCount > 0 && row.totalCost > 0 ? row.totalCost / row.baleCount : null),
    type: "number",
  },
  { header: "Total Sell Value", value: (row) => (row.totalCost > 0 ? row.totalCost : null), type: "number" },
];

/** One worksheet per ledger section, rows grouped by category as on screen. */
function ledgerExportSheets(data: LedgerData | undefined): RowsExportSheet<BucketRow>[] {
  if (!data) return [];
  return LEDGER_EXPORT_SECTIONS.map(([key, name]) => {
    const total = data.totals[key];
    return {
      name,
      rows: groupByCategory(data[key]).flatMap((group) => group.items),
      columns: LEDGER_EXPORT_COLUMNS,
      footer: [
        "Subtotal",
        null,
        total.baleCount,
        total.totalWeightKg,
        total.baleCount > 0 && total.totalCost > 0 ? total.totalCost / total.baleCount : null,
        total.totalCost > 0 ? total.totalCost : null,
      ],
    };
  });
}

export default function BaleLedger() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<LedgerData>({
    queryKey: ["/api/factory/bale-ledger"],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const grand = data?.totals.grand;
  const [firstSheet, ...otherSheets] = ledgerExportSheets(data);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 sm:px-6 sm:pt-4">
        <PageHeader
          title="Bale Production Ledger"
          subtitle="Complete lifecycle view — stock in hand, wipers/garbages, sold, and waste"
          icon={<Layers className="h-5 w-5" />}
        >
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
            className="gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <RowsExportMenu
            title="Bale Production Ledger"
            sheetName={firstSheet?.name}
            rows={firstSheet?.rows ?? []}
            columns={LEDGER_EXPORT_COLUMNS}
            footer={firstSheet?.footer}
            extraSheets={otherSheets}
            resource="erp.inventory"
            size="default"
          />
        </PageHeader>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 sm:p-6">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i}>
                <CardHeader className="py-3 px-4">
                  <Skeleton className="h-5 w-64" />
                  <Skeleton className="h-3 w-48 mt-1" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : isError && !data ? (
          <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
        ) : (
          <>
            <SectionTable
              section="currentStock"
              title="Current Stock — In Hand"
              subtitle="Bales in stock (IN_STOCK / FINALIZED), excluding wipers and garbages"
              icon={<Package className="w-4 h-4 text-green-600" />}
              badgeColor="text-green-700 border-green-200"
              rows={data?.currentStock || []}
              total={data?.totals.currentStock || { baleCount: 0, totalWeightKg: 0, totalCost: 0 }}
              defaultOpen={false}
            />

            <SectionTable
              section="wasteStock"
              title="Wipers & Garbages — In Hand"
              subtitle="Waste-category bales currently in stock (IN_STOCK / FINALIZED)"
              icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
              badgeColor="text-amber-700 border-amber-200"
              rows={data?.wasteStock || []}
              total={data?.totals.wasteStock || { baleCount: 0, totalWeightKg: 0, totalCost: 0 }}
              defaultOpen={false}
            />

            <SectionTable
              section="sold"
              title="Stock Sold"
              subtitle="Bales that have been dispatched and sold to customers"
              icon={<ShoppingCart className="w-4 h-4 text-blue-600" />}
              badgeColor="text-blue-700 border-blue-200"
              rows={data?.sold || []}
              total={data?.totals.sold || { baleCount: 0, totalWeightKg: 0, totalCost: 0 }}
              defaultOpen={false}
              showSoldPrice={true}
            />

            <SectionTable
              section="pendingLoading"
              title="Pending Loading / Verified"
              subtitle="Bales reserved for orders currently in Loading, Pending Verification, or Verified status"
              icon={<Truck className="w-4 h-4 text-purple-500" />}
              badgeColor="text-purple-700 border-purple-200"
              rows={data?.pendingLoading || []}
              total={data?.totals.pendingLoading || { baleCount: 0, totalWeightKg: 0, totalCost: 0 }}
              defaultOpen={false}
            />

            <SectionTable
              section="wasteDispatched"
              title="Waste Dispatched"
              subtitle="Bales removed from stock via waste disposal (Waste Dispatch records)"
              icon={<Trash2 className="w-4 h-4 text-destructive" />}
              badgeColor="text-destructive border-destructive/30"
              rows={data?.wasteDispatched || []}
              total={data?.totals.wasteDispatched || { baleCount: 0, totalWeightKg: 0, totalCost: 0 }}
              defaultOpen={false}
            />

            {grand && (
              <Card className="border-primary/20 bg-primary/5">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div>
                      <p className="font-bold text-sm">Total Production (All Time)</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Sum of all sections — complete production output
                      </p>
                    </div>
                    <div className="flex items-center gap-6 flex-wrap">
                      <div className="text-center">
                        <p className="text-xl font-bold" data-testid="grand-total-bales">
                          {fmtN(grand.baleCount)}
                        </p>
                        <p className="text-xs text-muted-foreground">total bales</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xl font-bold" data-testid="grand-total-weight">
                          {fmtKg(grand.totalWeightKg)}
                        </p>
                        <p className="text-xs text-muted-foreground">kg produced</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xl font-bold" data-testid="grand-total-cost">
                          {fmtMoney(grand.totalCost)}
                        </p>
                        <p className="text-xs text-muted-foreground">total sell value</p>
                      </div>
                      {grand.baleCount > 0 && grand.totalCost > 0 && (
                        <div className="text-center">
                          <p className="text-xl font-bold">{fmtMoney(grand.totalCost / grand.baleCount)}</p>
                          <p className="text-xs text-muted-foreground">avg/bale</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {data && (
                    <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t pt-4 sm:grid-cols-5">
                      {[
                        {
                          label: "In Hand (Regular)",
                          bales: data.totals.currentStock.baleCount,
                          kg: data.totals.currentStock.totalWeightKg,
                          cost: data.totals.currentStock.totalCost,
                          color: "text-green-600",
                        },
                        {
                          label: "In Hand (Waste Cat.)",
                          bales: data.totals.wasteStock.baleCount,
                          kg: data.totals.wasteStock.totalWeightKg,
                          cost: data.totals.wasteStock.totalCost,
                          color: "text-amber-600",
                        },
                        {
                          label: "Pending Loading / Verified",
                          bales: data.totals.pendingLoading.baleCount,
                          kg: data.totals.pendingLoading.totalWeightKg,
                          cost: data.totals.pendingLoading.totalCost,
                          color: "text-purple-600",
                        },
                        {
                          label: "Sold",
                          bales: data.totals.sold.baleCount,
                          kg: data.totals.sold.totalWeightKg,
                          cost: data.totals.sold.totalCost,
                          color: "text-blue-600",
                        },
                        {
                          label: "Waste Dispatched",
                          bales: data.totals.wasteDispatched.baleCount,
                          kg: data.totals.wasteDispatched.totalWeightKg,
                          cost: data.totals.wasteDispatched.totalCost,
                          color: "text-destructive",
                        },
                      ].map((s) => (
                        <div key={s.label} className="text-xs">
                          <p className={`font-semibold ${s.color}`}>{s.label}</p>
                          <p className="text-muted-foreground">
                            {fmtN(s.bales)} bales · {fmtKg(s.kg)} kg
                          </p>
                          {s.cost > 0 && <p className="text-muted-foreground">{fmtMoney(s.cost)}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
