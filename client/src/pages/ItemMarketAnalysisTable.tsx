import { Fragment } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ErpListTable } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { StatusBadge, formatNativePurchase, SalePriceBreakdown } from "./itemMarketAnalysisParts";
import type { ItemMarketAnalysisModel } from "./itemMarketAnalysisModel";

export function ItemMarketAnalysisTable({ m }: { m: ItemMarketAnalysisModel }) {
  return (
    <div className="overflow-x-auto">
      <ErpListTable pageKey="market-analysis" companyId={m.selectedCompany?.id} scrollLabel="Market price analysis">
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            {m.multiCompany && <TableHead>Company</TableHead>}
            <TableHead className="text-right">Imports</TableHead>
            <TableHead className="text-right">Imported Qty</TableHead>
            <TableHead className="text-right">
              {m.includeOffloadingCost ? "Purchase + Offloading" : "Purchase Value"}
            </TableHead>
            <TableHead className="text-right">
              {m.includeOffloadingCost ? "Avg Cost + Offloading" : "Avg Purchase"}
            </TableHead>
            <TableHead className="text-right">Sold Qty</TableHead>
            <TableHead className="text-right">Avg Sell</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Profit</TableHead>
            <TableHead className="text-right">Margin</TableHead>
            {m.multiCompany && <TableHead>Top Profit Company</TableHead>}
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {m.isLoading &&
            Array.from({ length: 6 }).map((_, index) => (
              <TableRow key={index}>
                <TableCell colSpan={m.multiCompany ? 13 : 11}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            ))}

          {!m.isLoading &&
            m.multiCompany &&
            m.visibleGroupedRows.map((group) => {
              const expanded = m.expandedItemCode === group.itemKey;
              const mixedCurrency = group.purchaseCurrencies.length > 1;
              const topCompany = m.topProfitCompanyByItem.get(group.itemKey);
              const topProfitClass = "text-emerald-600 dark:text-emerald-400";

              return (
                <Fragment key={group.itemKey}>
                  <TableRow data-testid={`row-item-market-group-${group.itemKey}`}>
                    <TableCell>
                      <div className="max-w-[260px] truncate font-medium">{group.name}</div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 px-2"
                        onClick={() => {
                          m.setExpandedItemCode(expanded ? null : group.itemKey);
                          m.setExpandedSalePriceKey(null);
                        }}
                        data-testid={`button-item-market-expand-${group.itemKey}`}
                      >
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {m.selectedCompanyNames.length} Companies
                      </Button>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(group.importCount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(group.importedQty)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {mixedCurrency ? (
                        <span className="text-xs text-muted-foreground">Mixed currencies</span>
                      ) : (
                        formatNativePurchase(
                          m.includeOffloadingCost ? group.purchaseValueWithOffloading : group.purchaseValue,
                          group.purchaseCurrencies
                        )
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNativePurchase(
                        m.includeOffloadingCost ? group.weightedPurchaseCostWithOffloading : group.weightedPurchaseCost,
                        group.purchaseCurrencies
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(group.soldQty)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.formatAmount(group.avgSellingPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.formatAmount(group.revenue)}</TableCell>
                    <TableCell
                      className={`text-right font-medium tabular-nums ${
                        group.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {m.formatAmount(group.profit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{group.marginPct.toFixed(1)}%</TableCell>
                    <TableCell>
                      {topCompany?.kind === "equal" ? (
                        <span className="font-medium">Equal</span>
                      ) : topCompany?.kind === "winner" ? (
                        <div>
                          <div className="font-medium">{topCompany.companyName}</div>
                          <div className={`text-xs tabular-nums ${topProfitClass}`}>
                            {m.formatAmount(topCompany.profit)} · {topCompany.marginPct.toFixed(1)}%
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={group.marketStatus} />
                    </TableCell>
                  </TableRow>

                  {expanded && (
                    <TableRow key={`${group.itemKey}:companies`}>
                      <TableCell colSpan={13} className="bg-muted/20 p-0">
                        <div className="p-3">
                          <div className="mb-2 text-xs font-medium text-muted-foreground">
                            Company breakdown for {group.name}
                          </div>
                          <div className="overflow-x-auto rounded-md border">
                            <ErpListTable
                              pageKey="market-company-breakdown"
                              companyId={m.selectedCompany?.id}
                              showDensityControl={false}
                              scrollLabel="Market company breakdown"
                            >
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Company</TableHead>
                                  <TableHead className="text-right">Imports</TableHead>
                                  <TableHead className="text-right">Imported Qty</TableHead>
                                  <TableHead className="text-right">
                                    {m.includeOffloadingCost ? "Purchase + Offloading" : "Purchase Value"}
                                  </TableHead>
                                  <TableHead className="text-right">
                                    {m.includeOffloadingCost ? "Avg Cost + Offloading" : "Avg Purchase"}
                                  </TableHead>
                                  <TableHead className="text-right">Sold Qty</TableHead>
                                  <TableHead className="text-right">Avg Sell</TableHead>
                                  <TableHead className="text-right">Revenue</TableHead>
                                  <TableHead className="text-right">Profit</TableHead>
                                  <TableHead className="text-right">Margin</TableHead>
                                  <TableHead>Status</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {m.selectedCompanyNames.map((company) => {
                                  const row = group.companyRows.find((entry) => entry.companyId === company.id);
                                  if (!row) {
                                    return (
                                      <TableRow key={company.id}>
                                        <TableCell>
                                          <div className="font-medium">{company.name}</div>
                                        </TableCell>
                                        <TableCell colSpan={10} className="text-center text-xs text-muted-foreground">
                                          No import or sales activity for this item code in the selected period.
                                        </TableCell>
                                      </TableRow>
                                    );
                                  }

                                  const rowMixedCurrency = row.purchaseCurrencies.length > 1;
                                  const salePriceKey = `${company.id}:${row.stockItemId}`;
                                  const salePriceExpanded = m.expandedSalePriceKey === salePriceKey;

                                  return (
                                    <Fragment key={company.id}>
                                      <TableRow>
                                        <TableCell>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 gap-1.5 px-2"
                                            onClick={() =>
                                              m.setExpandedSalePriceKey(salePriceExpanded ? null : salePriceKey)
                                            }
                                          >
                                            {salePriceExpanded ? (
                                              <ChevronDown className="h-4 w-4" />
                                            ) : (
                                              <ChevronRight className="h-4 w-4" />
                                            )}
                                            <span className="font-medium">{row.companyName}</span>
                                          </Button>
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatNumber(row.importCount)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatNumber(row.importedQty)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {rowMixedCurrency ? (
                                            <span className="text-xs text-muted-foreground">Mixed currencies</span>
                                          ) : (
                                            formatNativePurchase(
                                              m.includeOffloadingCost
                                                ? row.purchaseValueWithOffloading
                                                : row.purchaseValue,
                                              row.purchaseCurrencies
                                            )
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatNativePurchase(
                                            m.includeOffloadingCost
                                              ? row.weightedPurchaseCostWithOffloading
                                              : row.weightedPurchaseCost,
                                            row.purchaseCurrencies
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatNumber(row.soldQty)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {m.formatAmount(row.avgSellingPrice)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {m.formatAmount(row.revenue)}
                                        </TableCell>
                                        <TableCell
                                          className={`text-right font-medium tabular-nums ${
                                            row.profit < 0
                                              ? "text-red-600 dark:text-red-400"
                                              : "text-emerald-600 dark:text-emerald-400"
                                          }`}
                                        >
                                          {m.formatAmount(row.profit)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {row.marginPct.toFixed(1)}%
                                        </TableCell>
                                        <TableCell>
                                          <StatusBadge status={row.marketStatus} />
                                        </TableCell>
                                      </TableRow>
                                      {salePriceExpanded && (
                                        <TableRow>
                                          <TableCell colSpan={11} className="bg-muted/10 p-3">
                                            <SalePriceBreakdown
                                              companyId={row.companyId}
                                              stockItemId={row.stockItemId}
                                              startDate={m.period.fromDate}
                                              endDate={m.period.toDate}
                                            />
                                          </TableCell>
                                        </TableRow>
                                      )}
                                    </Fragment>
                                  );
                                })}
                              </TableBody>
                            </ErpListTable>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}

          {!m.isLoading &&
            !m.multiCompany &&
            m.visibleRows.map((row) => {
              const rowKey = `${row.companyId}:${row.stockItemId}`;
              const mixedCurrency = row.purchaseCurrencies.length > 1;
              const salePriceExpanded = m.expandedSalePriceKey === rowKey;

              return (
                <Fragment key={rowKey}>
                  <TableRow data-testid={`row-item-market-${row.companyId}-${row.stockItemId}`}>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 max-w-[280px] gap-1.5 px-2"
                        onClick={() => m.setExpandedSalePriceKey(salePriceExpanded ? null : rowKey)}
                      >
                        {salePriceExpanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0" />
                        )}
                        <span className="truncate font-medium">{row.name}</span>
                      </Button>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.importCount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.importedQty)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {mixedCurrency ? (
                        <span className="text-xs text-muted-foreground">Mixed currencies</span>
                      ) : (
                        formatNativePurchase(
                          m.includeOffloadingCost ? row.purchaseValueWithOffloading : row.purchaseValue,
                          row.purchaseCurrencies
                        )
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNativePurchase(
                        m.includeOffloadingCost ? row.weightedPurchaseCostWithOffloading : row.weightedPurchaseCost,
                        row.purchaseCurrencies
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(row.soldQty)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.formatAmount(row.avgSellingPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.formatAmount(row.revenue)}</TableCell>
                    <TableCell
                      className={`text-right font-medium tabular-nums ${
                        row.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {m.formatAmount(row.profit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.marginPct.toFixed(1)}%</TableCell>
                    <TableCell>
                      <StatusBadge status={row.marketStatus} />
                    </TableCell>
                  </TableRow>
                  {salePriceExpanded && (
                    <TableRow>
                      <TableCell colSpan={11} className="bg-muted/10 p-3">
                        <SalePriceBreakdown
                          companyId={row.companyId}
                          stockItemId={row.stockItemId}
                          startDate={m.period.fromDate}
                          endDate={m.period.toDate}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}

          {!m.isLoading && (m.multiCompany ? m.groupedRows.length === 0 : m.rows.length === 0) && (
            <TableRow>
              <TableCell colSpan={m.multiCompany ? 13 : 11} className="py-10 text-center text-sm text-muted-foreground">
                No imported or sold items match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </ErpListTable>
    </div>
  );
}
