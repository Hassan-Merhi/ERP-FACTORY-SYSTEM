import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ComparisonItem } from "../types";
import { fmtNum } from "../utils";
import type { useFactoryPendingInvoiceVerifyModel } from "../useFactoryPendingInvoiceVerifyModel";

type Model = ReturnType<typeof useFactoryPendingInvoiceVerifyModel>;

export function FactoryPendingInvoiceVerifyDetailCard({ model }: { model: Model }) {
  const {
    navigate,
    statusFilter,
    setStatusFilter,
    verification,
    isAdminOrOwner,
    getStatusBadge,
  } = model;
  return (
    <Card className="mb-6">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="text-lg">Proforma vs Loaded</CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Filter:</span>
                    {(["OVER_LOADED", "UNDER_LOADED", "MISSING_FROM_LOADED", "LOADED_NOT_IN_PROFORMA"] as const).map((s) => {
                      const labels: Record<string, string> = {
                        OVER_LOADED: "Overloaded",
                        UNDER_LOADED: "Under-loaded",
                        MISSING_FROM_LOADED: "Missing",
                        LOADED_NOT_IN_PROFORMA: "Not Requested",
                      };
                      const colors: Record<string, string> = {
                        OVER_LOADED:
                          "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-300 dark:border-green-700",
                        UNDER_LOADED:
                          "bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700",
                        MISSING_FROM_LOADED:
                          "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700",
                        LOADED_NOT_IN_PROFORMA:
                          "bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700",
                      };
                      const activeColors: Record<string, string> = {
                        OVER_LOADED: "bg-green-600 text-white border-green-600",
                        UNDER_LOADED: "bg-yellow-500 text-white border-yellow-500",
                        MISSING_FROM_LOADED: "bg-red-600 text-white border-red-600",
                        LOADED_NOT_IN_PROFORMA: "bg-orange-500 text-white border-orange-500",
                      };
                      const active = statusFilter.has(s);
                      return (
                        <button
                          key={s}
                          onClick={() => {
                            setStatusFilter((prev) => {
                              const next = new Set(prev);
                              if (next.has(s)) next.delete(s);
                              else next.add(s);
                              return next;
                            });
                          }}
                          className={`text-xs px-2 py-1 rounded-md border font-medium transition-colors ${active ? activeColors[s] : colors[s]}`}
                          data-testid={`filter-status-${s.toLowerCase()}`}
                        >
                          {labels[s]}
                        </button>
                      );
                    })}
                    {statusFilter.size > 0 && (
                      <button
                        onClick={() => setStatusFilter(new Set())}
                        className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground"
                        data-testid="filter-clear"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {(() => {
                  const comparisonMap = new Map<string, ComparisonItem>();
                  (verification?.comparison || []).forEach((c) => comparisonMap.set(c.articleCode, c));

                  // Keep the left mismatch table's Stock column consistent with
                  // the Loaded Bales table. Extra loaded items are not proforma
                  // lines, so their stock comes from the loaded-item summary.
                  const loadedStockMap = new Map(
                    (verification?.loadedItems || []).map((group) => [group.articleCode, group.stockQty ?? 0])
                  );
      
                  // Proforma lines that are not a perfect match
                  const mismatchedProformaLines = (verification?.proformaLines || []).filter((line) => {
                    const cmp = comparisonMap.get(line.articleCode);
                    return !cmp || cmp.status !== "MATCH";
                  });
      
                  // Items loaded but never requested in the proforma
                  const proformaCodes = new Set((verification?.proformaLines || []).map((l) => l.articleCode));
                  const loadedNotRequested = (verification?.comparison || []).filter(
                    (c) => c.status === "LOADED_NOT_IN_PROFORMA" && !proformaCodes.has(c.articleCode)
                  );
      
                  type LeftRow =
                    | {
                        kind: "proforma";
                        line: (typeof mismatchedProformaLines)[0];
                        status: ComparisonItem["status"] | undefined;
                      }
                    | { kind: "extra"; cmp: ComparisonItem };
      
                  const statusSortOrder = (s: string | undefined) => {
                    if (s === "OVER_LOADED") return 0;
                    if (s === "UNDER_LOADED") return 1;
                    if (s === "LOADED_NOT_IN_PROFORMA") return 2;
                    return 3;
                  };
      
                  const allLeftRows: LeftRow[] = [
                    ...mismatchedProformaLines.map((line) => ({
                      kind: "proforma" as const,
                      line,
                      status: comparisonMap.get(line.articleCode)?.status,
                    })),
                    ...loadedNotRequested.map((cmp) => ({ kind: "extra" as const, cmp })),
                  ]
                    .sort((a, b) => {
                      const sa = a.kind === "proforma" ? a.status : a.cmp.status;
                      const sb = b.kind === "proforma" ? b.status : b.cmp.status;
                      return statusSortOrder(sa) - statusSortOrder(sb);
                    })
                    .filter((row) => {
                      if (statusFilter.size === 0) return true;
                      const s = row.kind === "proforma" ? row.status : row.cmp.status;
                      return s ? statusFilter.has(s) : false;
                    });
      
                  const getProformaRowClass = (articleCode: string) => {
                    const cmp = comparisonMap.get(articleCode);
                    if (!cmp) return "";
                    if (cmp.status === "UNDER_LOADED" || cmp.status === "MISSING_FROM_LOADED")
                      return "bg-red-50 dark:bg-red-950";
                    if (cmp.status === "OVER_LOADED") return "bg-green-50 dark:bg-green-950";
                    return "";
                  };
      
                  return (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div>
                        <h3 className="font-semibold text-sm mb-3" data-testid="text-proforma-header">
                          Proforma Expected <span className="text-muted-foreground font-normal">(mismatches only)</span>
                        </h3>
                        {allLeftRows.length > 0 ? (
                          <Table wrapperClassName="max-h-[50vh] overflow-auto">
                            <TableHeader className="sticky top-0 z-30 bg-background">
                              <TableRow>
                                <TableHead>Article</TableHead>
                                <TableHead>Product</TableHead>
                                <TableHead className="text-right">Expected</TableHead>
                                <TableHead className="text-right">Loaded</TableHead>
                                <TableHead className="text-right">Remaining</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right">Stock</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {allLeftRows.map((row, i) => {
                                if (row.kind === "extra") {
                                  const { cmp } = row;
                                  const stockQty = cmp.stockQty ?? loadedStockMap.get(cmp.articleCode) ?? 0;
                                  return (
                                    <TableRow
                                      key={`extra-${cmp.articleCode}`}
                                      className="bg-orange-50 dark:bg-orange-950/40"
                                      data-testid={`row-proforma-${cmp.articleCode}`}
                                    >
                                      <TableCell className="font-mono text-sm">{cmp.articleCode}</TableCell>
                                      <TableCell className="text-sm">{cmp.productName}</TableCell>
                                      <TableCell className="text-right font-mono text-muted-foreground">0</TableCell>
                                      <TableCell className="text-right font-mono">{cmp.loadedQty}</TableCell>
                                      <TableCell className="text-right font-mono">
                                        <span className="text-orange-600 dark:text-orange-400 font-medium">
                                          +{fmtNum(cmp.loadedQty)}
                                        </span>
                                      </TableCell>
                                      <TableCell>{getStatusBadge(cmp.status)}</TableCell>
                                      <TableCell
                                        className="text-right font-mono"
                                        data-testid={`text-stock-${cmp.articleCode}`}
                                      >
                                        {stockQty > 0 ? (
                                          <button
                                            className="underline underline-offset-2 cursor-pointer hover-elevate rounded px-0.5 text-foreground font-medium"
                                            onClick={() => {
                                              const p = new URLSearchParams({
                                                articleCode: cmp.articleCode,
                                                productName: cmp.productName,
                                                back: window.location.pathname + window.location.search,
                                              });
                                              navigate(`/factory/stock-bale-list?${p}`);
                                            }}
                                            data-testid={`button-stock-detail-${cmp.articleCode}`}
                                          >
                                            {stockQty}
                                          </button>
                                        ) : (
                                          <span className="text-muted-foreground">0</span>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                }
      
                                const { line } = row;
                                const cmp = comparisonMap.get(line.articleCode);
                                const loaded = cmp?.loadedQty ?? 0;
                                const remaining = line.expectedQty - loaded;
                                return (
                                  <TableRow
                                    key={i}
                                    className={getProformaRowClass(line.articleCode)}
                                    data-testid={`row-proforma-${line.articleCode}`}
                                  >
                                    <TableCell
                                      className="font-mono text-sm"
                                      data-testid={`text-proforma-article-${line.articleCode}`}
                                    >
                                      {line.articleCode}
                                    </TableCell>
                                    <TableCell className="text-sm">{line.productName}</TableCell>
                                    <TableCell className="text-right font-mono">{fmtNum(Number(line.expectedQty))}</TableCell>
                                    <TableCell className="text-right font-mono">{loaded}</TableCell>
                                    <TableCell className="text-right font-mono">
                                      {remaining > 0 ? (
                                        <span className="text-red-600 dark:text-red-400 font-medium">
                                          {fmtNum(remaining)}
                                        </span>
                                      ) : remaining < 0 ? (
                                        <span className="text-green-600 dark:text-green-400 font-medium">
                                          +{fmtNum(Math.abs(remaining))}
                                        </span>
                                      ) : (
                                        <span className="text-muted-foreground">0</span>
                                      )}
                                    </TableCell>
                                    <TableCell>{cmp ? getStatusBadge(cmp.status) : null}</TableCell>
                                    <TableCell
                                      className="text-right font-mono"
                                      data-testid={`text-stock-${line.articleCode}`}
                                    >
                                      {(line.stockQty ?? 0) > 0 ? (
                                        <button
                                          className="underline underline-offset-2 cursor-pointer hover-elevate rounded px-0.5 text-foreground font-medium"
                                          onClick={() => {
                                            const p = new URLSearchParams({
                                              articleCode: line.articleCode,
                                              productName: line.productName,
                                              back: window.location.pathname + window.location.search,
                                            });
                                            navigate(`/factory/stock-bale-list?${p}`);
                                          }}
                                          data-testid={`button-stock-detail-${line.articleCode}`}
                                        >
                                          {line.stockQty}
                                        </button>
                                      ) : (
                                        <span className="text-muted-foreground">0</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        ) : (
                          <p className="text-sm text-muted-foreground" data-testid="text-no-proforma-mismatches">
                            All proforma items matched - no mismatches
                          </p>
                        )}
                      </div>
      
                      <div>
                        <h3 className="font-semibold text-sm mb-3" data-testid="text-loaded-header">
                          Loaded Bales
                        </h3>
                        {verification?.loadedItems && verification.loadedItems.length > 0 ? (
                          <Table wrapperClassName="max-h-[50vh] overflow-auto">
                            <TableHeader className="sticky top-0 z-30 bg-background">
                              <TableRow>
                                <TableHead>Article</TableHead>
                                <TableHead>Product</TableHead>
                                <TableHead className="text-right">Qty</TableHead>
                                <TableHead className="text-right">Weight (kg)</TableHead>
                                {isAdminOrOwner && (
                                  <TableHead className="text-right">
                                    {verification.loadedItems.some((g) => g.pricingMode === "per_kg") ? "Price/KG" : "Price"}
                                  </TableHead>
                                )}
                                {isAdminOrOwner && <TableHead className="text-right">Total Price</TableHead>}
                                <TableHead className="text-right text-teal-500 dark:text-teal-400">Stock</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {verification.loadedItems.map((group, i) => {
                                const isPerKg = group.pricingMode === "per_kg";
                                const pkgRate = group.pricePerKg || 0;
                                // For per-kg: derive rate from actual bale prices if available,
                                // otherwise fall back to the proforma's price_per_kg so the
                                // column never shows 0 when bales were loaded before repricing.
                                const unitRate = isPerKg
                                  ? group.totalPrice > 0 && group.totalWeight > 0
                                    ? group.totalPrice / group.totalWeight
                                    : pkgRate
                                  : parseFloat(group.pricePerBale || "0") ||
                                    (group.totalPrice > 0 && group.qty > 0 ? group.totalPrice / group.qty : 0);
                                const displayTotal =
                                  isPerKg && group.totalPrice === 0 && pkgRate > 0 && group.totalWeight > 0
                                    ? pkgRate * group.totalWeight
                                    : group.totalPrice;
                                return (
                                  <TableRow key={i} data-testid={`row-loaded-${group.articleCode}`}>
                                    <TableCell
                                      className="font-mono text-sm"
                                      data-testid={`text-loaded-article-${group.articleCode}`}
                                    >
                                      {group.articleCode}
                                    </TableCell>
                                    <TableCell className="text-sm">{group.productName}</TableCell>
                                    <TableCell className="text-right font-mono">{group.qty}</TableCell>
                                    <TableCell className="text-right font-mono">{fmtNum(group.totalWeight || 0)}</TableCell>
                                    {isAdminOrOwner && (
                                      <TableCell className="text-right font-mono">{fmtNum(unitRate)}</TableCell>
                                    )}
                                    {isAdminOrOwner && (
                                      <TableCell className="text-right font-mono font-semibold">
                                        {fmtNum(displayTotal)}
                                      </TableCell>
                                    )}
                                    <TableCell
                                      className="text-right font-mono text-teal-600 dark:text-teal-400"
                                      data-testid={`text-loaded-stock-${group.articleCode}`}
                                    >
                                      {(group.stockQty ?? 0) > 0 ? (
                                        <button
                                          className="underline underline-offset-2 cursor-pointer hover-elevate rounded px-0.5 text-teal-600 dark:text-teal-400 font-medium"
                                          onClick={() => {
                                            const p = new URLSearchParams({
                                              articleCode: group.articleCode,
                                              productName: group.productName,
                                              back: window.location.pathname + window.location.search,
                                            });
                                            navigate(`/factory/stock-bale-list?${p}`);
                                          }}
                                          data-testid={`button-loaded-stock-detail-${group.articleCode}`}
                                        >
                                          {group.stockQty}
                                        </button>
                                      ) : (
                                        <span className="text-muted-foreground">0</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        ) : (
                          <p className="text-sm text-muted-foreground" data-testid="text-no-loaded">
                            No loaded bales
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
  );
}
