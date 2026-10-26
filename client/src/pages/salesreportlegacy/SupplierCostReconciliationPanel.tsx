import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCompany } from "@/contexts/CompanyContext";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type NamedOption = { id: number; name: string };
type OptionsResponse = { suppliers: NamedOption[]; stockGroups: NamedOption[] };

interface CostReconciliationRow {
  stockItemId: number;
  code: string;
  name: string;
  receivedQty: number;
  soldQty: number;
  stockQty: number;
  qtyGap: number;
  adjustedQtyGap: number;
  stockAdjustmentQty: number;
  canonicalMovementQty: number;
  landedCost: number;
  soldCost: number;
  stockValue: number;
  costGap: number;
  missingReliefCount: number;
  mathMismatchCount: number;
  negativeStockQty: number;
}

interface ReconciliationReport {
  readOnly: true;
  completeness: "partial";
  generatedAt: string;
  supplierName: string;
  stockGroupName: string;
  basis: string;
  warnings: string[];
  summary: {
    containerCount: number;
    containerTotal: number;
    landedCost: number;
    stockValue: number;
    stockRateValue: number;
    revenue: number;
    recordedCostOfSales: number;
    storedProfit: number;
    bookedProfit: number;
    storedProfitDifference: number;
    manualCostOfSales: number;
    manualProfit: number;
    costGapUsingStoredInventory: number;
    costGapUsingRateValuation: number;
    salesLinesMissingHistoricalRelief: number;
    arithmeticMismatchLines: number;
    negativeStockItems: number;
    qtyGapItems: number;
    afterAdjustmentGapItems: number;
  };
  items: CostReconciliationRow[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Supplier cost reconciliation unavailable (" + response.status + ")");
  return (await response.json()) as T;
}

const fmt = (value: number) => Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Metric({ title, value }: { title: string; value: number }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{fmt(value)}</div>
    </div>
  );
}

/** Independent, read-only snapshot; intentionally never patches historical transactions. */
export function SupplierCostReconciliationPanel() {
  const { selectedCompany } = useCompany();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [stockGroupId, setStockGroupId] = useState("");
  const [showAll, setShowAll] = useState(false);

  const options = useQuery<OptionsResponse>({
    queryKey: ["/api/sales-report/supplier-reconciliation/options", selectedCompany?.id],
    queryFn: () => getJson("/api/sales-report/supplier-reconciliation/options"),
    enabled: open && !!selectedCompany?.id,
    staleTime: 30_000,
  });
  const reportUrl = "/api/sales-report/supplier-reconciliation?supplierId=" +
    encodeURIComponent(supplierId) + "&stockGroupId=" + encodeURIComponent(stockGroupId);
  const report = useQuery<ReconciliationReport>({
    queryKey: [reportUrl, selectedCompany?.id],
    queryFn: () => getJson(reportUrl),
    enabled: open && !!selectedCompany?.id && !!supplierId && !!stockGroupId,
    staleTime: 30_000,
  });

  const data = report.data;
  const flagged = data?.items.filter((row) =>
    Math.abs(row.qtyGap) > 0.0005 ||
    Math.abs(row.costGap) > 0.01 ||
    row.mathMismatchCount > 0 ||
    row.negativeStockQty < 0
  ) ?? [];
  const displayed = showAll ? data?.items ?? [] : flagged;

  return (
    <section className="rounded-xl border bg-card" data-testid="supplier-cost-reconciliation">
      <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((previous) => !previous)} aria-expanded={open}>
        <span className="flex items-center gap-2 text-sm font-semibold">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Supplier stock and cost reconciliation
        </span>
        <span className="text-xs text-muted-foreground">Read-only · Current stock snapshot</span>
      </button>
      {open && (
        <div className="space-y-4 border-t p-4">
          <p className="text-xs text-muted-foreground">
            Select a supplier and matching stock group. This compares offloaded landed costs with recorded
            sales and current inventory; it does not establish exact historical supplier attribution or
            update any vouchers, stock, or payables.
          </p>
          {options.isError && <p role="alert" className="text-sm text-destructive">Unable to load suppliers or groups.</p>}
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <label className="text-xs font-medium">Supplier</label>
              <Select value={supplierId} onValueChange={(value) => { setSupplierId(value); setShowAll(false); }}>
                <SelectTrigger aria-label="Supplier"><SelectValue placeholder="Choose supplier" /></SelectTrigger>
                <SelectContent>{(options.data?.suppliers ?? []).map((item) =>
                  <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                )}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Stock group</label>
              <Select value={stockGroupId} onValueChange={(value) => { setStockGroupId(value); setShowAll(false); }}>
                <SelectTrigger aria-label="Stock group"><SelectValue placeholder="Choose stock group" /></SelectTrigger>
                <SelectContent>{(options.data?.stockGroups ?? []).map((item) =>
                  <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>
                )}</SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={() => void report.refetch()}
              disabled={!supplierId || !stockGroupId || report.isFetching}>
              <RefreshCw className="mr-2 h-4 w-4" /> Recheck
            </Button>
          </div>
          {report.isLoading && supplierId && stockGroupId && <p className="text-sm text-muted-foreground">Reading current records…</p>}
          {report.isError && <p role="alert" className="text-sm text-destructive">Reconciliation failed. Check your selections and retry.</p>}
          {data && (
            <>
              <div className="text-xs text-muted-foreground">
                {data.supplierName} / {data.stockGroupName} · {data.summary.containerCount} offloaded containers
                · {new Date(data.generatedAt).toLocaleString()} · Historical coverage: partial
              </div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Metric title="Recorded sales" value={data.summary.revenue} />
                <Metric title="Recorded sales cost" value={data.summary.recordedCostOfSales} />
                <Metric title="Sales minus cost" value={data.summary.bookedProfit} />
                <Metric title="Stored profit difference" value={data.summary.storedProfitDifference} />
                <Metric title="Offloaded landed cost" value={data.summary.landedCost} />
                <Metric title="Stock at saved total value" value={data.summary.stockValue} />
                <Metric title="Manual profit (rate × qty)" value={data.summary.manualProfit} />
                <Metric title="Manual less booked profit" value={data.summary.manualProfit - data.summary.bookedProfit} />
              </div>
              <p className="text-xs text-muted-foreground">
                {data.summary.qtyGapItems} stock codes show a quantity difference before adjustments;
                {" "}{data.summary.afterAdjustmentGapItems} after logged adjustments.
                {" "}{data.summary.salesLinesMissingHistoricalRelief} sale lines lack a separate historical stock-relief value;
                {" "}{data.summary.arithmeticMismatchLines} stored profit lines differ from sales minus cost.
                {" "}{data.summary.negativeStockItems} codes have negative stock at a location.
              </p>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Item variances ({flagged.length} flagged)</h3>
                <Button variant="outline" size="sm" onClick={() => setShowAll((prior) => !prior)}>
                  {showAll ? "Only flagged" : "All stock items"}
                </Button>
              </div>
              <div className="max-h-96 overflow-auto rounded-lg border">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-2 py-2 text-left">Code</th>
                      <th className="px-2 py-2 text-right">Received</th>
                      <th className="px-2 py-2 text-right">Sold</th>
                      <th className="px-2 py-2 text-right">Stock</th>
                      <th className="px-2 py-2 text-right">Qty gap</th>
                      <th className="px-2 py-2 text-right">After adjustments</th>
                      <th className="px-2 py-2 text-right">Cost gap</th>
                      <th className="px-2 py-2 text-right">Missing relief</th>
                    </tr>
                  </thead>
                  <tbody>{displayed.map((row) =>
                    <tr key={row.stockItemId} className="border-t">
                      <td className="px-2 py-2 font-medium" title={row.name}>{row.code}</td>
                      <td className="px-2 py-2 text-right">{row.receivedQty}</td>
                      <td className="px-2 py-2 text-right">{row.soldQty}</td>
                      <td className="px-2 py-2 text-right">{row.stockQty}</td>
                      <td className="px-2 py-2 text-right">{row.qtyGap}</td>
                      <td className="px-2 py-2 text-right">{row.adjustedQtyGap}</td>
                      <td className="px-2 py-2 text-right font-mono">{fmt(row.costGap)}</td>
                      <td className="px-2 py-2 text-right">{row.missingReliefCount}</td>
                    </tr>
                  )}</tbody>
                </table>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                {data.warnings.map((warning) => <p key={warning}>• {warning}</p>)}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
