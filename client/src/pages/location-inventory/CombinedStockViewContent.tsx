// Extracted from ./CombinedStockView.tsx
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CombinedStockViewProps } from "./CombinedStockViewTypes";
import { useCombinedStockViewState } from "./useCombinedStockViewState";

export function CombinedStockViewContent({
  allStockGroupFilter,
  allStockSelectedRowIndex,
  filteredCombinedRows,
  formatAmount,
  mobileCards,
  openMovement,
  uniqueCategories,
  visibleLocations,
}: Pick<
  CombinedStockViewProps,
  "allStockGroupFilter" | "allStockSelectedRowIndex" | "filteredCombinedRows" | "formatAmount" | "openMovement"
> &
  Pick<ReturnType<typeof useCombinedStockViewState>, "mobileCards" | "uniqueCategories" | "visibleLocations">) {
  return (
    <table {...mobileCards.tableProps} className="w-full text-sm border-collapse">
      <thead className="sticky top-0 z-30 bg-muted">
        <tr className="bg-muted/60 border-b">
          <th className="text-left px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap sticky left-0 bg-muted/60 z-10">
            Item Name
          </th>
          {uniqueCategories.length > 0 && (
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">Category</th>
          )}
          {visibleLocations.map((loc) => (
            <th key={loc.name} className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">
              {loc.name}
            </th>
          ))}
          <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap border-l">Total</th>
          <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">Avg Cost</th>
          <th className="text-right px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">Total Value</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {(() => {
          const rows = [];
          let lastGroup = "";
          let rowIdx = 0;
          for (const row of filteredCombinedRows) {
            const currentIdx = rowIdx++;
            // Group separator when group changes
            if (!allStockGroupFilter && row.stockGroupName !== lastGroup) {
              lastGroup = row.stockGroupName;
              const groupRows = filteredCombinedRows.filter((r) => r.stockGroupName === row.stockGroupName);
              const groupTotal = groupRows.reduce((s, r) => s + r.totalQty, 0);
              const groupValue = groupRows.reduce((s, r) => s + r.totalValue, 0);
              rows.push(
                <tr key={`group-${row.stockGroupName}`} className="bg-muted/30">
                  <td
                    colSpan={visibleLocations.length + 4 + (uniqueCategories.length > 0 ? 1 : 0)}
                    className="px-4 py-1.5 sticky left-0 bg-muted/30 z-10"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {row.stockGroupName}
                        <span className="ml-2 font-normal normal-case text-muted-foreground/70">
                          ({groupRows.length} item{groupRows.length !== 1 ? "s" : ""})
                        </span>
                      </span>
                      <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {groupTotal.toLocaleString(undefined, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 2,
                        })}{" "}
                        units
                        {groupValue !== 0 && <span className="ml-3">{formatAmount(groupValue)}</span>}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            }
            const isSelected = allStockSelectedRowIndex === currentIdx;
            rows.push(
              <tr
                key={row.stockItemId}
                className={cn("transition-colors", isSelected ? "bg-accent text-accent-foreground" : "hover-elevate")}
                data-testid={`row-allstock-${row.stockItemId}`}
                data-allstock-row-index={currentIdx}
              >
                <td
                  className={cn(
                    "px-4 py-2 font-medium whitespace-nowrap sticky left-0 z-10 transition-colors cursor-pointer",
                    isSelected ? "bg-accent" : "bg-background"
                  )}
                  title="View stock movement across all locations"
                  onClick={() => openMovement(null, null, row.stockItemId, row.stockItemName)}
                  data-testid={`button-allstock-name-${row.stockItemId}`}
                >
                  <span className="hover:underline">{row.stockItemName}</span>
                </td>
                {uniqueCategories.length > 0 && (
                  <td className="px-4 py-2 whitespace-nowrap" data-testid={`allstock-category-${row.stockItemId}`}>
                    {row.categoryName ? (
                      <Badge variant="secondary" className="text-xs font-normal">
                        {row.categoryName}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs">—</span>
                    )}
                  </td>
                )}
                {visibleLocations.map((loc) => {
                  const cellQty = row.qtyByLocationName[loc.name] || 0;
                  return (
                    <td
                      key={loc.name}
                      className="px-4 py-2 text-right font-mono whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline"
                      title={cellQty !== 0 ? `View movement at ${loc.name}` : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (cellQty !== 0) openMovement(loc.id, loc.name, row.stockItemId, row.stockItemName);
                      }}
                    >
                      {cellQty !== 0 ? (
                        <span className={cellQty < 0 ? "text-red-600 dark:text-red-400" : undefined}>
                          {cellQty.toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-4 py-2 text-right font-mono font-semibold whitespace-nowrap border-l">
                  {row.totalQty.toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </td>
                <td className="px-4 py-2 text-right font-mono text-muted-foreground whitespace-nowrap">
                  {row.avgCost > 0 ? formatAmount(row.avgCost) : <span className="text-muted-foreground/30">—</span>}
                </td>
                <td className="px-4 py-2 text-right font-mono whitespace-nowrap">
                  {row.totalValue !== 0 ? (
                    <span className={cn("font-medium", row.totalValue < 0 && "text-red-600 dark:text-red-400")}>
                      {formatAmount(row.totalValue)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/30">—</span>
                  )}
                </td>
              </tr>
            );
          }
          return rows;
        })()}
      </tbody>
      {/* Grand total footer */}
      <tfoot>
        <tr className="bg-muted/50 border-t-2 font-semibold">
          <td className="px-4 py-2.5 whitespace-nowrap sticky left-0 bg-muted/50 z-10">
            Total ({filteredCombinedRows.length} items)
          </td>
          {uniqueCategories.length > 0 && <td className="px-4 py-2.5" />}
          {visibleLocations.map((loc) => {
            const locTotal = filteredCombinedRows.reduce((s, r) => s + (r.qtyByLocationName[loc.name] || 0), 0);
            return (
              <td key={loc.name} className="px-4 py-2.5 text-right font-mono whitespace-nowrap text-muted-foreground">
                {locTotal !== 0 ? (
                  <span className={locTotal < 0 ? "text-red-600 dark:text-red-400" : undefined}>
                    {locTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </span>
                ) : (
                  <span className="opacity-30">—</span>
                )}
              </td>
            );
          })}
          <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap border-l">
            {filteredCombinedRows
              .reduce((s, r) => s + r.totalQty, 0)
              .toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          </td>
          <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap text-muted-foreground">—</td>
          <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap">
            {formatAmount(filteredCombinedRows.reduce((s, r) => s + r.totalValue, 0))}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
