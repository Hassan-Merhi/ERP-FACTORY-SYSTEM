/**
 * CategoryProductBreakdown — extracted sub-component.
 *
 * Extracted from DailyProductionReport.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, Tag } from "lucide-react";
import { fmtKg, fmtMoney } from "../utils";

export function CategoryProductBreakdown({
  categories,
  products,
  totalBales,
  totalWeightKg,
  totalValue,
  hideCosts = false,
  valuationMode = "cost",
}: {
  categories: { categoryName: string; qty: number; totalWeightKg: number; totalValue: number }[];
  products: {
    articleCode: string;
    productName: string;
    categoryName: string;
    qty: number;
    totalWeightKg: number;
    costPricePerBale: number;
    pricePerBale: number;
    totalValue: number;
  }[];
  totalBales: number;
  totalWeightKg: number;
  totalValue: number;
  hideCosts?: boolean;
  valuationMode?: "cost" | "selling";
}) {
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());

  const allOpen = categories.length > 0 && openCats.size === categories.length;

  function toggle(cat: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function toggleAll() {
    if (allOpen) {
      setOpenCats(new Set());
    } else {
      setOpenCats(new Set(categories.map((c) => c.categoryName)));
    }
  }

  const productsByCategory = useMemo(() => {
    const map = new Map<string, typeof products>();
    for (const p of products) {
      const key = p.categoryName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [products]);

  return (
    <div className="overflow-x-auto">
      <div className="space-y-1 min-w-[420px]">
        {/* Header row */}
        <div
          className={
            hideCosts
              ? "grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-2 pb-1 border-b items-center"
              : "grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-2 pb-1 border-b items-center"
          }
        >
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category</span>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleAll}
            data-testid="button-toggle-all-categories"
            className="h-6 text-xs px-2"
          >
            {allOpen ? "Collapse All" : "Show All"}
          </Button>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right w-16">
            Qty
          </span>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right w-24">
            Weight
          </span>
          {!hideCosts && (
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right w-24">
              Value
            </span>
          )}
        </div>

        {categories.map((cat) => {
          const isOpen = openCats.has(cat.categoryName);
          const catProducts = productsByCategory.get(cat.categoryName) ?? [];
          return (
            <div
              key={cat.categoryName}
              data-testid={`section-category-${cat.categoryName.replace(/\s+/g, "-").toLowerCase()}`}
            >
              {/* Category row — clickable */}
              <button
                className={
                  hideCosts
                    ? "w-full grid grid-cols-[1fr_auto_auto] gap-x-4 px-2 py-2 rounded-md hover-elevate text-left items-center"
                    : "w-full grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-2 py-2 rounded-md hover-elevate text-left items-center"
                }
                onClick={() => toggle(cat.categoryName)}
              >
                <span className="flex items-center gap-1.5 font-medium text-sm">
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  {cat.categoryName}
                  <Badge variant="secondary" className="text-xs ml-1 no-default-active-elevate">
                    {catProducts.length} products
                  </Badge>
                </span>
                <span className="text-sm font-mono text-right w-16">{cat.qty.toLocaleString()}</span>
                <span className="text-sm font-mono text-right w-24">{fmtKg(cat.totalWeightKg)}</span>
                {!hideCosts && (
                  <span className="text-sm font-mono font-semibold text-right w-24">{fmtMoney(cat.totalValue)}</span>
                )}
              </button>

              {/* Products sub-table */}
              {isOpen && catProducts.length > 0 && (
                <div className="ml-6 mb-2 overflow-x-auto border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Article Code</TableHead>
                        <TableHead className="text-xs">Product</TableHead>
                        <TableHead className="text-xs text-right">Qty</TableHead>
                        <TableHead className="text-xs text-right">Weight</TableHead>
                        {!hideCosts && (
                          <TableHead className="text-xs text-right">
                            {valuationMode === "selling" ? "Selling / Bale" : "Cost / Bale"}
                          </TableHead>
                        )}
                        {!hideCosts && <TableHead className="text-xs text-right">Value</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {catProducts.map((p) => (
                        <TableRow key={p.articleCode} data-testid={`row-product-${p.articleCode}`}>
                          <TableCell className="text-xs font-mono py-1.5">{p.articleCode}</TableCell>
                          <TableCell className="text-xs py-1.5">{p.productName}</TableCell>
                          <TableCell className="text-xs text-right font-mono py-1.5">
                            {p.qty.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-xs text-right font-mono py-1.5">
                            {fmtKg(p.totalWeightKg)}
                          </TableCell>
                          {!hideCosts && (
                            <TableCell className="text-xs text-right font-mono py-1.5">
                              {fmtMoney(p.pricePerBale)}
                            </TableCell>
                          )}
                          {!hideCosts && (
                            <TableCell className="text-xs text-right font-mono font-semibold py-1.5">
                              {fmtMoney(p.totalValue)}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          );
        })}

        {/* Totals footer */}
        <div
          className={
            hideCosts
              ? "grid grid-cols-[1fr_auto_auto] gap-x-4 px-2 pt-2 border-t"
              : "grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-2 pt-2 border-t"
          }
        >
          <span className="text-sm font-semibold text-muted-foreground">Totals</span>
          <span className="text-sm font-mono font-bold text-right w-16">{totalBales.toLocaleString()}</span>
          <span className="text-sm font-mono font-bold text-right w-24">{fmtKg(totalWeightKg)}</span>
          {!hideCosts && (
            <span className="text-sm font-mono font-bold text-right w-24">{fmtMoney(totalValue)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
