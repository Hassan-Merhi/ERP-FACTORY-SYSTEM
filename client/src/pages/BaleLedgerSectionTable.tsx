// Extracted from ./BaleLedger.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatUsd } from "@/lib/moneyDisplay";

interface BaleDetail {
  ref: string;
  weightKg: number;
  totalCost: number;
}

export interface BucketRow {
  productId: number | null;
  productName: string;
  articleCode: string;
  categoryName: string;
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
}

export interface SectionTotal {
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
}

export function fmtMoney(n: number): string {
  if (n === 0) return "$0";
  const rounded = Math.round(n * 100) / 100;
  if (rounded % 1 === 0) {
    return formatUsd(rounded, 0);
  }
  return formatUsd(rounded, 2);
}

export function fmtKg(n: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(n);
}

export function fmtN(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

type SectionKey = "currentStock" | "wasteStock" | "sold" | "wasteDispatched" | "pendingLoading";

interface SectionProps {
  section: SectionKey;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  badgeColor: string;
  rows: BucketRow[];
  total: SectionTotal;
  defaultOpen?: boolean;
  showSoldPrice?: boolean;
}

function BaleDetailRows({
  section,
  productId,
  rowAvgRate,
  totalWeightKg,
  totalCost,
  baleCount,
  colSpan,
}: {
  section: SectionKey;
  productId: number | null;
  rowAvgRate: number;
  totalWeightKg: number;
  totalCost: number;
  baleCount: number;
  colSpan: number;
}) {
  const { data, isLoading } = useQuery<{ baleDetails: BaleDetail[] }>({
    queryKey: ["/api/factory/bale-ledger/details", section, productId ?? "null"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/bale-ledger/details?section=${section}&productId=${productId ?? "null"}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch bale details");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  if (isLoading) {
    return (
      <TableRow className="bg-muted/20">
        <TableCell colSpan={colSpan} className="py-2 px-5 text-xs text-muted-foreground italic">
          Loading bale details…
        </TableCell>
      </TableRow>
    );
  }

  const baleDetails = data?.baleDetails || [];
  const hasBaleDetails = baleDetails.some((d) => d.ref || d.totalCost > 0);

  if (!hasBaleDetails) {
    return (
      <TableRow className="bg-muted/20">
        <TableCell colSpan={colSpan} className="py-2 px-5 text-xs text-muted-foreground italic">
          No individual bale records found.
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow className="bg-muted/20">
      <TableCell colSpan={colSpan} className="py-0 px-0">
        <div className="pl-8 pr-3 py-2">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-30 bg-muted">
              <tr className="border-b border-border/50">
                <th className="text-left py-1 pr-4 font-medium text-muted-foreground">Ref #</th>
                <th className="text-right py-1 pr-4 font-medium text-muted-foreground">Weight (kg)</th>
                <th className="text-right py-1 pr-4 font-medium text-muted-foreground">Qty</th>
                <th className="text-right py-1 pr-4 font-medium text-muted-foreground">Avg Cost/Bale</th>
                <th className="text-right py-1 font-medium text-muted-foreground">Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {baleDetails.map((d, di) => (
                <tr key={di} className="border-b border-border/20 last:border-0">
                  <td className="py-1 pr-4 font-mono">{d.ref || "—"}</td>
                  <td className="py-1 pr-4 text-right text-muted-foreground">{fmtKg(d.weightKg)}</td>
                  <td className="py-1 pr-4 text-right text-muted-foreground">1</td>
                  <td className="py-1 pr-4 text-right text-muted-foreground">
                    {d.totalCost > 0 ? fmtMoney(d.totalCost) : "—"}
                  </td>
                  <td className="py-1 text-right font-medium">{d.totalCost > 0 ? fmtMoney(d.totalCost) : "—"}</td>
                </tr>
              ))}
              {baleDetails.length > 1 && (
                <tr className="font-semibold border-t border-border/50">
                  <td className="py-1 pr-4 text-muted-foreground">Total</td>
                  <td className="py-1 pr-4 text-right">{fmtKg(totalWeightKg)}</td>
                  <td className="py-1 pr-4 text-right">{baleCount}</td>
                  <td className="py-1 pr-4 text-right">{rowAvgRate > 0 ? fmtMoney(rowAvgRate) : "—"}</td>
                  <td className="py-1 text-right">{totalCost > 0 ? fmtMoney(totalCost) : "—"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </TableCell>
    </TableRow>
  );
}

function groupByCategory(rows: BucketRow[]): { category: string; items: BucketRow[] }[] {
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
