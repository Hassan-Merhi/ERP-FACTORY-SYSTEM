// Extracted from ./BaleLedger.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fmtMoney, fmtKg, BaleDetailRows, type BucketRow, type SectionProps } from "./BaleLedgerSectionTableParts";
export { fmtMoney, fmtKg, type BucketRow, type SectionTotal, type SectionKey } from "./BaleLedgerSectionTableParts";

export function fmtN(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function groupByCategory(rows: BucketRow[]): { category: string; items: BucketRow[] }[] {
  const map = new Map<string, BucketRow[]>();
  for (const row of rows) {
    const cat = row.categoryName || "—";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(row);
  }
  return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
}

export function SectionTable({
  section,
  title,
  subtitle,
  icon,
  badgeColor,
  rows,
  total,
  defaultOpen = false,
  showSoldPrice = false,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  function toggleRow(key: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const avgRate = total.baleCount > 0 && total.totalCost > 0 ? total.totalCost / total.baleCount : 0;
  const groups = groupByCategory(rows);
  const colSpan = showSoldPrice ? 7 : 5;

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader
            className="cursor-pointer hover-elevate select-none py-3 px-4"
            data-testid={`section-toggle-${title.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                {open ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
                <div className="flex items-center gap-2">
                  {icon}
                  <div>
                    <CardTitle className="text-sm">{title}</CardTitle>
                    <p className="text-xs text-muted-foreground font-normal mt-0.5">{subtitle}</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs flex-wrap">
                <Badge variant="outline" className={`text-xs ${badgeColor}`}>
                  {fmtN(total.baleCount)} bales
                </Badge>
                <span className="text-muted-foreground">{fmtKg(total.totalWeightKg)} kg</span>
                <span className="font-semibold">{fmtMoney(total.totalCost)}</span>
                {avgRate > 0 && <span className="text-muted-foreground">avg {fmtMoney(avgRate)}/bale</span>}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4 pt-0 text-center">No records.</p>
            ) : (
              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs py-2 px-3">Product</TableHead>
                    <TableHead className="text-xs py-2 px-3 text-right">Bales</TableHead>
                    <TableHead className="text-xs py-2 px-3 text-right">Weight (kg)</TableHead>
                    <TableHead className="text-xs py-2 px-3 text-right">Avg Sell/Bale</TableHead>
                    <TableHead className="text-xs py-2 px-3 text-right">Total Sell Value</TableHead>
                    {showSoldPrice && (
                      <>
                        <TableHead className="text-xs py-2 px-3 text-right">Avg Sold Rate</TableHead>
                        <TableHead className="text-xs py-2 px-3 text-right">Total Sold</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map(({ category, items }) => {
                    const catBales = items.reduce((s, r) => s + r.baleCount, 0);
                    const catWeight = items.reduce((s, r) => s + r.totalWeightKg, 0);
                    const catCost = items.reduce((s, r) => s + r.totalCost, 0);
                    const catAvg = catBales > 0 && catCost > 0 ? catCost / catBales : 0;

                    return [
                      <TableRow key={`cat-${category}`} className="bg-muted/40">
                        <TableCell
                          colSpan={colSpan}
                          className="py-1.5 px-3 text-xs font-semibold text-muted-foreground tracking-wide"
                        >
                          <div className="flex items-center justify-between gap-4 flex-wrap">
                            <span>{category}</span>
                            <div className="flex items-center gap-4 font-normal">
                              <span>{fmtN(catBales)} bales</span>
                              <span>{fmtKg(catWeight)} kg</span>
                              {catAvg > 0 && <span>avg {fmtMoney(catAvg)}/bale</span>}
                              {catCost > 0 && <span className="font-semibold">{fmtMoney(catCost)}</span>}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>,
                      ...items.flatMap((r, i) => {
                        const rowKey = `${category}-${r.productId ?? "null"}-${i}`;
                        const isOpen = expandedRows.has(rowKey);
                        const rowAvgRate = r.baleCount > 0 && r.totalCost > 0 ? r.totalCost / r.baleCount : 0;

                        return [
                          <TableRow
                            key={rowKey}
                            data-testid={`row-product-${r.productId ?? i}`}
                            className={isOpen ? "bg-muted/10" : ""}
                          >
                            <TableCell className="py-2 px-3 pl-5">
                              <button
                                className="text-xs font-medium text-left hover:underline cursor-pointer flex items-center gap-1 group"
                                onClick={() => toggleRow(rowKey)}
                                data-testid={`btn-expand-${r.productId ?? i}`}
                                title="Click to see individual bale details"
                              >
                                {isOpen ? (
                                  <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                                )}
                                {r.productName}
                              </button>
                            </TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs">{fmtN(r.baleCount)}</TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs">{fmtKg(r.totalWeightKg)}</TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">
                              {rowAvgRate > 0 ? fmtMoney(rowAvgRate) : "—"}
                            </TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs font-medium">
                              {r.totalCost > 0 ? fmtMoney(r.totalCost) : "—"}
                            </TableCell>
                            {showSoldPrice && (
                              <>
                                <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">—</TableCell>
                                <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">—</TableCell>
                              </>
                            )}
                          </TableRow>,
                          isOpen ? (
                            <BaleDetailRows
                              key={`${rowKey}-detail`}
                              section={section}
                              productId={r.productId}
                              rowAvgRate={rowAvgRate}
                              totalWeightKg={r.totalWeightKg}
                              totalCost={r.totalCost}
                              baleCount={r.baleCount}
                              colSpan={colSpan}
                            />
                          ) : null,
                        ].filter(Boolean);
                      }),
                    ];
                  })}
                  <TableRow className="bg-muted/30 font-semibold">
                    <TableCell className="text-xs py-2 px-3">Subtotal</TableCell>
                    <TableCell className="text-right text-xs py-2 px-3">{fmtN(total.baleCount)}</TableCell>
                    <TableCell className="text-right text-xs py-2 px-3">{fmtKg(total.totalWeightKg)}</TableCell>
                    <TableCell className="text-right text-xs py-2 px-3 text-muted-foreground">
                      {avgRate > 0 ? fmtMoney(avgRate) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 px-3">
                      {total.totalCost > 0 ? fmtMoney(total.totalCost) : "—"}
                    </TableCell>
                    {showSoldPrice && (
                      <>
                        <TableCell className="text-right text-xs py-2 px-3 text-muted-foreground">—</TableCell>
                        <TableCell className="text-right text-xs py-2 px-3 text-muted-foreground">—</TableCell>
                      </>
                    )}
                  </TableRow>
                </TableBody>
              </Table>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
