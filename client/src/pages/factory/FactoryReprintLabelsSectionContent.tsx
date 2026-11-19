// Extracted from ./FactoryReprintLabelsSection.tsx
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useFactoryReprintLabelsState } from "./useFactoryReprintLabelsState";

export function FactoryReprintLabelsSectionContent({
  balesData,
  filteredBales,
  selectedIds,
  toggleSelect,
}: Pick<
  Pick<
    ReturnType<typeof useFactoryReprintLabelsState>,
    | "allFilteredSelected"
    | "articleCodeFilters"
    | "articleCodeSearch"
    | "articlePickerOpen"
    | "balesData"
    | "balesLoading"
    | "deselectAll"
    | "filteredBales"
    | "handlePrint"
    | "recordChanges"
    | "search"
    | "selectAll"
    | "selectedIds"
    | "setArticleCodeFilters"
    | "setArticleCodeSearch"
    | "setArticlePickerOpen"
    | "setSearch"
    | "toggleSelect"
    | "uniqueArticleCodes"
    | "balesError"
    | "refetchBales"
  >,
  "balesData" | "filteredBales" | "selectedIds" | "toggleSelect"
>) {
  return (
    <>
      <div className="text-xs text-muted-foreground">
        Showing {filteredBales.length} of {balesData.length} bales
        {selectedIds.size > 0 && (
          <span className="ml-2 font-medium text-foreground">· {selectedIds.size} selected</span>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block rounded-md border overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="sticky top-0 z-30 bg-muted">
            <tr className="h-10">
              <th className="w-10 px-3"></th>
              <th className="text-left px-3 font-medium">Reference No.</th>
              <th className="text-left px-3 font-medium">Bale Name</th>
              <th className="text-left px-3 font-medium">Article Code</th>
              <th className="text-right px-3 font-medium">Weight (KG)</th>
              <th className="text-right px-3 font-medium">Pcs</th>
            </tr>
          </thead>
          <tbody>
            {filteredBales.map((row) => {
              const checked = selectedIds.has(row.bale.id);
              const articleCode = row.product?.articleCode || row.bale.articleCode || row.bale.category || "-";
              const prodName = row.bale.productName || row.product?.name || row.bale.category || "-";
              return (
                <tr
                  key={row.bale.id}
                  className={`border-t h-11 cursor-pointer transition-colors ${checked ? "bg-primary/5" : "hover:bg-muted/30"}`}
                  onClick={() => toggleSelect(row.bale.id)}
                  data-testid={`row-bale-${row.bale.id}`}
                >
                  <td className="px-3 text-center">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleSelect(row.bale.id)}
                      data-testid={`checkbox-bale-${row.bale.id}`}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className="px-3 font-mono text-xs text-muted-foreground">
                    {row.bale.referenceNumber || row.bale.baleCode}
                  </td>
                  <td className="px-3 font-medium">{prodName}</td>
                  <td className="px-3 font-mono text-xs text-muted-foreground">{articleCode}</td>
                  <td className="px-3 text-right font-mono">
                    {parseFloat(row.bale.weightKg).toLocaleString(undefined, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                  </td>
                  <td className="px-3 text-right font-mono">{row.bale.quantity}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-2">
        {filteredBales.map((row) => {
          const checked = selectedIds.has(row.bale.id);
          const articleCode = row.product?.articleCode || row.bale.articleCode || row.bale.category || "-";
          const prodName = row.bale.productName || row.product?.name || row.bale.category || "-";
          return (
            <Card
              key={row.bale.id}
              className={`p-3 cursor-pointer transition-colors ${checked ? "ring-2 ring-primary" : ""}`}
              onClick={() => toggleSelect(row.bale.id)}
              data-testid={`card-bale-${row.bale.id}`}
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleSelect(row.bale.id)}
                  data-testid={`checkbox-bale-mobile-${row.bale.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{prodName}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">
                    {row.bale.referenceNumber || row.bale.baleCode}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span>{articleCode}</span>
                    <span>
                      {parseFloat(row.bale.weightKg).toLocaleString(undefined, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}{" "}
                      KG
                    </span>
                    <span>{row.bale.quantity} pc(s)</span>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
