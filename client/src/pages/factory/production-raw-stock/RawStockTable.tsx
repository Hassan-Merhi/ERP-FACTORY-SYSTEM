import { useState, useMemo } from "react";
import { formatNumber } from "@/lib/formatNumber";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ChevronDown, Eye, EyeOff, FlaskRound, Plus, MinusCircle, Layers } from "lucide-react";
import { SupplierMixBatchHistoryDialog } from "./SupplierMixBatchHistoryDialog";

interface RawStockRow {
  supplierName: string;
  supplierId: number | null;
  categoryId: number | null;
  categoryName: string | null;
  sourceType?: string;
  currencyCode?: string;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  freeKg?: string;
  costPerKg: string;
  costPerKgUsd?: string;
  valueRemaining: string;
  valueRemainingUsd: string;
  lastOffloaded: string;
}

interface RawStockTableProps {
  rawStock: RawStockRow[];
  onAdjust: (row: RawStockRow) => void;
  onDeduct: (row: RawStockRow) => void;
  onAddToBatch: (row: RawStockRow) => void;
  onNewMaterial: () => void;
}

export function RawStockTable({ rawStock, onAdjust, onDeduct, onAddToBatch }: RawStockTableProps) {
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({ Uncategorized: true });
  const [historyDialog, setHistoryDialog] = useState<{ supplierId: number; supplierName: string } | null>(null);
  const [showZeroBalance, setShowZeroBalance] = useState(false);

  const zeroBalanceCount = useMemo(
    () => (rawStock || []).filter((row) => parseFloat(row.freeKg || "0") <= 0.001).length,
    [rawStock]
  );
  const visibleStock = useMemo(
    () => (showZeroBalance ? rawStock || [] : (rawStock || []).filter((row) => parseFloat(row.freeKg || "0") > 0.001)),
    [rawStock, showZeroBalance]
  );

  const groupedStock = useMemo(() => {
    const groups: Record<string, RawStockRow[]> = {};
    visibleStock.forEach((r) => {
      const cat = r.categoryName || "Uncategorized";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(r);
    });
    return groups;
  }, [visibleStock]);

  const categories = useMemo(() => Object.keys(groupedStock).sort(), [groupedStock]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const openHistory = (row: RawStockRow) => {
    if (row.supplierId) setHistoryDialog({ supplierId: row.supplierId, supplierName: row.supplierName });
  };

  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {showZeroBalance
              ? "Showing all sources, including empty balances."
              : "Sources with no free balance are hidden."}
          </p>
          {zeroBalanceCount > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowZeroBalance((visible) => !visible)}
              className="h-8 gap-2 rounded-lg border-slate-300 bg-background px-3 text-xs font-semibold shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/5 hover:shadow-md dark:border-slate-700"
              aria-pressed={showZeroBalance}
              data-testid="button-toggle-zero-balance"
            >
              {showZeroBalance ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showZeroBalance ? "Hide 0 Balance" : `Show 0 Balance (${zeroBalanceCount})`}
            </Button>
          )}
        </div>

        <div className="space-y-3 md:hidden" data-testid="raw-stock-mobile-list">
          {categories.length === 0 ? (
            <div className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              {zeroBalanceCount > 0 ? "All sources currently have a zero free balance." : "No raw stock available"}
            </div>
          ) : (
            categories.map((cat) => {
              const rows = groupedStock[cat];
              const isExpanded = expandedCategories[cat];
              const catFree = rows.reduce((sum, row) => sum + parseFloat(row.freeKg || "0"), 0);
              const catValue = rows.reduce((sum, row) => sum + parseFloat(row.valueRemainingUsd), 0);

              return (
                <div key={`mobile-cat-${cat}`} className="overflow-hidden rounded-xl border bg-card shadow-sm">
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center justify-between gap-3 bg-muted/30 px-3 py-2.5 text-left"
                    onClick={() => toggleCategory(cat)}
                    data-testid={`button-mobile-raw-stock-category-${cat}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0" />
                        )}
                        <FlaskRound className="h-4 w-4 shrink-0 text-primary/70" />
                        <span className="truncate text-sm font-semibold">{cat}</span>
                        <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
                          {rows.length}
                        </Badge>
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                      <div className="font-mono font-semibold text-foreground">{formatNumber(catFree)} kg</div>
                      <div className="font-mono">${formatNumber(catValue)}</div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="divide-y">
                      {rows.map((row, idx) => (
                        <div
                          key={`mobile-${cat}-${idx}`}
                          className="space-y-3 p-3"
                          data-testid={`card-raw-stock-mobile-${row.supplierId}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <button
                                type="button"
                                className="max-w-full truncate text-left text-sm font-semibold text-foreground hover:text-primary hover:underline"
                                onClick={() => openHistory(row)}
                                data-testid={`link-mobile-supplier-name-${row.supplierId}`}
                              >
                                {row.supplierName}
                              </button>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                <span>Last offload: {new Date(row.lastOffloaded).toLocaleDateString()}</span>
                                {row.sourceType === "OPENING_BALANCE" && (
                                  <span className="inline-flex items-center rounded border border-blue-100 bg-blue-50 px-1.5 font-medium text-blue-600 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                                    OB
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Available</div>
                              <div className="font-mono text-base font-bold text-foreground">
                                {formatNumber(parseFloat(row.freeKg || "0"))} kg
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="rounded-lg bg-muted/40 p-2">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Received</div>
                              <div className="mt-0.5 font-mono font-medium">{formatNumber(parseFloat(row.receivedKg))} kg</div>
                            </div>
                            <div className="rounded-lg bg-muted/40 p-2">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Used</div>
                              <div className="mt-0.5 font-mono font-medium">{formatNumber(parseFloat(row.usedKg))} kg</div>
                            </div>
                            <div className="rounded-lg bg-muted/40 p-2">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Value</div>
                              <div className="mt-0.5 font-mono font-medium">
                                ${formatNumber(parseFloat(row.valueRemainingUsd))}
                              </div>
                            </div>
                            <div className="rounded-lg bg-muted/40 p-2">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cost / kg</div>
                              <div className="mt-0.5 font-mono font-medium">
                                ${parseFloat(row.costPerKgUsd || "0").toFixed(6)}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-w-0 gap-1 px-2 text-xs text-primary"
                              onClick={() => onAdjust(row)}
                              data-testid={`button-adjust-mobile-${row.supplierId}`}
                            >
                              <Plus className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">Adjust</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-w-0 gap-1 px-2 text-xs text-destructive"
                              onClick={() => onDeduct(row)}
                              data-testid={`button-deduct-mobile-${row.supplierId}`}
                            >
                              <MinusCircle className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">Deduct</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-w-0 gap-1 px-2 text-xs text-emerald-600"
                              onClick={() => onAddToBatch(row)}
                              data-testid={`button-batch-mobile-${row.supplierId}`}
                            >
                              <Layers className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">Batch</span>
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="hidden overflow-hidden rounded-md border bg-card shadow-sm md:block">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[300px] py-4">Source / Supplier</TableHead>
                <TableHead className="text-right py-4">Total Received</TableHead>
                <TableHead className="text-right py-4">Total Used</TableHead>
                <TableHead className="text-right py-4 font-semibold text-foreground">Available (Free)</TableHead>
                <TableHead className="text-right py-4">Value (USD)</TableHead>
                <TableHead className="w-[120px] py-4"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    {zeroBalanceCount > 0
                      ? "All sources currently have a zero free balance."
                      : "No raw stock available"}
                  </TableCell>
                </TableRow>
              ) : (
                categories.map((cat) => {
                  const rows = groupedStock[cat];
                  const isExpanded = expandedCategories[cat];
                  const catReceived = rows.reduce((s, r) => s + parseFloat(r.receivedKg), 0);
                  const catUsed = rows.reduce((s, r) => s + parseFloat(r.usedKg), 0);
                  const catFree = rows.reduce((s, r) => s + parseFloat(r.freeKg || "0"), 0);
                  const catValue = rows.reduce((s, r) => s + parseFloat(r.valueRemainingUsd), 0);

                  return (
                    <>
                      <TableRow
                        key={`cat-${cat}`}
                        className="bg-muted/30 cursor-pointer hover:bg-muted/50 group/cat select-none"
                        onClick={() => toggleCategory(cat)}
                      >
                        <TableCell className="font-semibold py-3 flex items-center gap-2">
                          <div className="flex items-center justify-center w-5 h-5 rounded hover:bg-muted transition-colors">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </div>
                          <FlaskRound className="h-4 w-4 text-primary/70" />
                          {cat}
                          <Badge
                            variant="outline"
                            className="ml-2 font-normal text-[10px] px-1.5 h-4.5 bg-background/50"
                          >
                            {rows.length} source{rows.length !== 1 ? "s" : ""}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm py-3 text-muted-foreground">
                          {formatNumber(catReceived)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm py-3 text-muted-foreground">
                          {formatNumber(catUsed)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm py-3 font-semibold text-foreground">
                          {formatNumber(catFree)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm py-3 text-muted-foreground">
                          ${formatNumber(catValue)}
                        </TableCell>
                        <TableCell className="py-3" />
                      </TableRow>

                      {isExpanded &&
                        rows.map((row, idx) => (
                          <TableRow
                            key={`${cat}-${idx}`}
                            className="group hover:bg-accent/5 transition-colors"
                            data-testid={`row-raw-stock-${row.supplierId}`}
                          >
                            <TableCell className="pl-12 py-3">
                              <div className="flex flex-col">
                                <button
                                  className="font-medium text-sm text-foreground hover:text-primary hover:underline text-left w-fit cursor-pointer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openHistory(row);
                                  }}
                                  data-testid={`link-supplier-name-${row.supplierId}`}
                                >
                                  {row.supplierName}
                                </button>
                                <span className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
                                  Last offload: {new Date(row.lastOffloaded).toLocaleDateString()}
                                  {row.sourceType === "OPENING_BALANCE" && (
                                    <span className="inline-flex items-center px-1.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800 font-medium">
                                      OB
                                    </span>
                                  )}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground py-3">
                              {formatNumber(parseFloat(row.receivedKg))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground py-3">
                              {formatNumber(parseFloat(row.usedKg))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm py-3 font-medium text-foreground">
                              {formatNumber(parseFloat(row.freeKg || "0"))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground py-3">
                              <div className="flex flex-col items-end">
                                <span>${formatNumber(parseFloat(row.valueRemainingUsd))}</span>
                                <span className="text-[10px] opacity-60">
                                  {/* Rate is the received-weighted purchase cost/kg — it must only
                                  move when new stock is received (offload/ADD adjustment),
                                  never when existing stock is drawn down by a mix batch. Do
                                  NOT derive it from valueRemainingUsd/freeKg — that ratio
                                  shifts with usage and drifted from the true rate. */}
                                  ${parseFloat(row.costPerKgUsd || "0").toFixed(6)}
                                  /kg
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="py-3 text-right pr-4">
                              <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-primary hover:bg-primary/10"
                                  onClick={() => onAdjust(row)}
                                  title="Adjust stock cost/qty"
                                  data-testid={`button-adjust-${row.supplierId}`}
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-destructive hover:bg-destructive/10"
                                  onClick={() => onDeduct(row)}
                                  title="Deduct damaged/wasted stock"
                                  data-testid={`button-deduct-${row.supplierId}`}
                                >
                                  <MinusCircle className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-emerald-600 hover:bg-emerald-50"
                                  onClick={() => onAddToBatch(row)}
                                  title="Add to mix batch"
                                  data-testid={`button-batch-${row.supplierId}`}
                                >
                                  <Layers className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                    </>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {historyDialog && (
        <SupplierMixBatchHistoryDialog
          supplierId={historyDialog.supplierId}
          supplierName={historyDialog.supplierName}
          open={!!historyDialog}
          onClose={() => setHistoryDialog(null)}
        />
      )}
    </>
  );
}
