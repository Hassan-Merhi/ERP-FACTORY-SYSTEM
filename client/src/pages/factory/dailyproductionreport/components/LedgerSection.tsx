/**
 * LedgerSection — extracted sub-component.
 *
 * Extracted from DailyProductionReport.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BaleWeightEditDialog, type WeightEditBale } from "@/components/BaleWeightEditDialog";
import type { LedgerSectionProps } from "../types";
import { fmtL, fmtML, fmtNL, groupByCategory } from "../utils";

export function LedgerSection({
  title,
  subtitle,
  icon,
  badgeColor,
  rows,
  total,
  defaultOpen = false,
  showSoldPrice = false,
}: LedgerSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [weightEditBale, setWeightEditBale] = useState<WeightEditBale | null>(null);
  const queryClient = useQueryClient();
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
          <CardHeader className="cursor-pointer hover-elevate select-none py-3 px-4">
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
                  {fmtNL(total.baleCount)} bales
                </Badge>
                <span className="text-muted-foreground">{fmtL(total.totalWeightKg)} kg</span>
                <span className="font-semibold">{fmtML(total.totalCost)}</span>
                {avgRate > 0 && <span className="text-muted-foreground">avg {fmtML(avgRate)}/bale</span>}
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
                              <span>{fmtNL(catBales)} bales</span>
                              <span>{fmtL(catWeight)} kg</span>
                              {catAvg > 0 && <span>avg {fmtML(catAvg)}/bale</span>}
                              {catCost > 0 && <span className="font-semibold">{fmtML(catCost)}</span>}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>,
                      ...items.flatMap((r, i) => {
                        const rowKey = `${category}-${r.productId ?? "null"}-${i}`;
                        const isOpen = expandedRows.has(rowKey);
                        const rowAvgRate = r.baleCount > 0 && r.totalCost > 0 ? r.totalCost / r.baleCount : 0;
                        const hasBaleDetails = (r.baleDetails ?? []).some((d) => d.ref || d.totalCost > 0);
                        return [
                          <TableRow key={rowKey} className={isOpen ? "bg-muted/10" : ""}>
                            <TableCell className="py-2 px-3 pl-5">
                              <button
                                className="text-xs font-medium text-left hover:underline cursor-pointer flex items-center gap-1 group"
                                onClick={() => toggleRow(rowKey)}
                              >
                                {isOpen ? (
                                  <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                                )}
                                {r.productName}
                              </button>
                            </TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs">{fmtNL(r.baleCount)}</TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs">{fmtL(r.totalWeightKg)}</TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">
                              {rowAvgRate > 0 ? fmtML(rowAvgRate) : "—"}
                            </TableCell>
                            <TableCell className="py-2 px-3 text-right text-xs font-medium">
                              {r.totalCost > 0 ? fmtML(r.totalCost) : "—"}
                            </TableCell>
                            {showSoldPrice && (
                              <>
                                <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">—</TableCell>
                                <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">—</TableCell>
                              </>
                            )}
                          </TableRow>,
                          isOpen && hasBaleDetails ? (
                            <TableRow key={`${rowKey}-detail`} className="bg-muted/20">
                              <TableCell colSpan={colSpan} className="py-0 px-0">
                                <div className="pl-8 pr-3 py-2">
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                      <thead className="sticky top-0 z-30 bg-muted/50">
                                        <tr className="border-b border-border/50">
                                          <th className="text-left py-1 pr-4 font-medium text-muted-foreground">
                                            Ref #
                                          </th>
                                          <th className="text-right py-1 pr-4 font-medium text-muted-foreground">
                                            Weight (kg)
                                          </th>
                                          <th className="text-right py-1 pr-4 font-medium text-muted-foreground">
                                            Qty
                                          </th>
                                          <th className="text-right py-1 pr-4 font-medium text-muted-foreground">
                                            Avg Cost/Bale
                                          </th>
                                          <th className="text-right py-1 font-medium text-muted-foreground">
                                            Total Cost
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {(r.baleDetails ?? []).map((d, di) => (
                                          <tr key={di} className="border-b border-border/20 last:border-0">
                                            <td className="py-1 pr-4 font-mono">{d.ref || "—"}</td>
                                            <td className="py-1 pr-4 text-right text-muted-foreground">
                                              <button
                                                className="group flex items-center gap-1 ml-auto hover:text-foreground"
                                                onClick={() =>
                                                  d.id &&
                                                  setWeightEditBale({
                                                    id: d.id,
                                                    referenceNumber: d.ref,
                                                    weightKg: d.weightKg,
                                                  })
                                                }
                                                title="Correct weight"
                                              >
                                                {fmtL(d.weightKg)}
                                                <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 shrink-0" />
                                              </button>
                                            </td>
                                            <td className="py-1 pr-4 text-right text-muted-foreground">1</td>
                                            <td className="py-1 pr-4 text-right text-muted-foreground">
                                              {d.totalCost > 0 ? fmtML(d.totalCost) : "—"}
                                            </td>
                                            <td className="py-1 text-right font-medium">
                                              {d.totalCost > 0 ? fmtML(d.totalCost) : "—"}
                                            </td>
                                          </tr>
                                        ))}
                                        {(r.baleDetails ?? []).length > 1 && (
                                          <tr className="font-semibold border-t border-border/50">
                                            <td className="py-1 pr-4 text-muted-foreground">Total</td>
                                            <td className="py-1 pr-4 text-right">{fmtL(r.totalWeightKg)}</td>
                                            <td className="py-1 pr-4 text-right">{r.baleCount}</td>
                                            <td className="py-1 pr-4 text-right">
                                              {rowAvgRate > 0 ? fmtML(rowAvgRate) : "—"}
                                            </td>
                                            <td className="py-1 text-right">
                                              {r.totalCost > 0 ? fmtML(r.totalCost) : "—"}
                                            </td>
                                          </tr>
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          ) : isOpen ? (
                            <TableRow key={`${rowKey}-empty`} className="bg-muted/20">
                              <TableCell colSpan={colSpan} className="py-2 px-5 text-xs text-muted-foreground italic">
                                No individual bale records found.
                              </TableCell>
                            </TableRow>
                          ) : null,
                        ].filter(Boolean);
                      }),
                    ];
                  })}
                  <TableRow className="bg-muted/30 font-semibold">
                    <TableCell className="text-xs py-2 px-3">Subtotal</TableCell>
                    <TableCell className="text-right text-xs py-2 px-3">{fmtNL(total.baleCount)}</TableCell>
                    <TableCell className="text-right text-xs py-2 px-3">{fmtL(total.totalWeightKg)}</TableCell>
                    <TableCell className="text-right text-xs py-2 px-3 text-muted-foreground">
                      {avgRate > 0 ? fmtML(avgRate) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 px-3">
                      {total.totalCost > 0 ? fmtML(total.totalCost) : "—"}
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
      <BaleWeightEditDialog
        bale={weightEditBale}
        onClose={() => setWeightEditBale(null)}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-ledger"] });
          setWeightEditBale(null);
        }}
      />
    </Card>
  );
}
