import { Ship, Building2, Package, Boxes, ChevronDown, Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { OtwNotes, OtwCurrencyInline } from "./ContainerBadges";
import { otwContainerByCurrency, otwNum, otwFmtCcy, otwCcySymbol, OTW_STATUS_LABEL } from "./otwHelpers";
import type { ContainerWithSupplier } from "./otwHelpers";

interface OtwSupplierGroup {
  supplierId: number | null;
  supplierName: string;
  containers: ContainerWithSupplier[];
  totalKg: number;
  totalsByCurrency: Record<string, number>;
}

interface OtwGrandTotals {
  containers: number;
  kg: number;
  totalsByCurrency: Record<string, number>;
}

interface OtwSummaryViewProps {
  otwContainers: ContainerWithSupplier[];
  otwSupplierGroups: OtwSupplierGroup[];
  otwGrandTotals: OtwGrandTotals;
  openOtwGroups: Set<string>;
  toggleOtwGroup: (key: string) => void;
  fmtOtwKg: (n: number) => string;
  onViewContainer: (c: ContainerWithSupplier) => void;
}

export function OtwSummaryView({
  otwContainers,
  otwSupplierGroups,
  otwGrandTotals,
  openOtwGroups,
  toggleOtwGroup,
  fmtOtwKg,
  onViewContainer,
}: OtwSummaryViewProps) {
  return (
    <div className="space-y-5" data-testid="factory-containers-summary">
      <OtwNotes />

      {otwContainers.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card/80 shadow-sm">
          <div className="py-16 text-center">
            <Ship className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-muted-foreground">No containers currently on the way.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-3" aria-label="Container suppliers">
            {otwSupplierGroups.map((group, idx) => {
              const key = String(group.supplierId ?? "none");
              const isOpen = openOtwGroups.has(key);
              return (
                <Collapsible key={key} open={isOpen} onOpenChange={() => toggleOtwGroup(key)}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className={`group flex w-full flex-wrap items-center gap-x-4 gap-y-3 border border-border/70 bg-card/90 px-4 py-4 text-left shadow-sm transition-all hover:border-blue-500/35 hover:bg-blue-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 dark:border-blue-200/10 dark:bg-slate-900/60 dark:hover:bg-slate-800/80 sm:flex-nowrap sm:px-5 ${isOpen ? "rounded-t-2xl border-b-0 bg-blue-500/5 dark:bg-slate-800/80" : "rounded-2xl"}`}
                      data-testid={`row-otw-supplier-${key}`}
                      aria-label={`${group.supplierName}, ${group.containers.length} containers`}
                    >
                      <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${idx % 2 === 0 ? "bg-blue-500/10 text-blue-600 dark:text-blue-300" : "bg-violet-500/10 text-violet-600 dark:text-violet-300"}`}>
                        <Building2 className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight sm:text-base">{group.supplierName}</span>
                      <Badge variant="secondary" className="shrink-0 rounded-full border border-border/60 px-2.5 py-1 text-xs font-semibold">
                        {group.containers.length} ctr{group.containers.length !== 1 ? "s" : ""}
                      </Badge>
                      <span className="hidden w-28 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground sm:block">
                        {fmtOtwKg(group.totalKg)} kg
                      </span>
                      <span className="min-w-[110px] shrink-0 text-right text-foreground">
                        <OtwCurrencyInline amounts={group.totalsByCurrency} />
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="overflow-x-auto rounded-b-2xl border border-t-0 border-border/70 bg-card/90 dark:border-blue-200/10 dark:bg-slate-900/60">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-b border-border/60 bg-blue-500/5 hover:bg-blue-500/5 dark:bg-slate-800/60">
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2 pl-4">
                              Container
                            </TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                              Origin
                            </TableHead>
                            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                              KG
                            </TableHead>
                            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                              Value
                            </TableHead>
                            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                              Status
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.containers.map((c) => {
                            const byCurrency = otwContainerByCurrency(c);
                            return (
                              <TableRow
                                key={c.id}
                                className="cursor-pointer border-border/40 transition-colors hover:bg-blue-500/5 dark:hover:bg-blue-400/10"
                                onClick={() => onViewContainer(c)}
                                data-testid={`row-otw-container-${c.id}`}
                              >
                                <TableCell className="font-mono font-semibold">{c.containerNumber}</TableCell>
                                <TableCell className="text-muted-foreground">{c.origin || "—"}</TableCell>
                                <TableCell className="text-right font-mono">{fmtOtwKg(otwNum(c.totalKg))}</TableCell>
                                <TableCell className="text-right">
                                  <OtwCurrencyInline amounts={byCurrency} />
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">{OTW_STATUS_LABEL[c.status] || c.status}</Badge>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                        <tfoot>
                          <TableRow className="border-t border-border/70 bg-blue-500/5 font-medium dark:bg-slate-800/50">
                            <TableCell colSpan={2} className="text-muted-foreground">
                              Supplier total
                            </TableCell>
                            <TableCell className="text-right font-mono font-semibold">
                              {fmtOtwKg(group.totalKg)} kg
                            </TableCell>
                            <TableCell className="text-right">
                              <OtwCurrencyInline amounts={group.totalsByCurrency} />
                            </TableCell>
                            <TableCell />
                          </TableRow>
                        </tfoot>
                      </Table>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>

          <div className="sticky bottom-0 z-20 overflow-hidden rounded-2xl border border-blue-500/20 bg-card/95 shadow-lg shadow-blue-950/5 backdrop-blur-xl dark:border-blue-300/15 dark:bg-slate-900/95" data-testid="div-otw-grand-total">
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-blue-500 to-violet-500" />
            <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)] sm:gap-0 sm:p-5">
              <div className="flex items-center gap-3 sm:border-r sm:border-border/70 sm:pr-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-300">
                  <Package className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Containers</p>
                  <p className="font-mono text-2xl font-bold tabular-nums tracking-tight" data-testid="text-otw-grand-containers">
                    {otwGrandTotals.containers}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 sm:border-r sm:border-border/70 sm:px-5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-300">
                  <Boxes className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total KG</p>
                  <p className="font-mono text-2xl font-bold tabular-nums tracking-tight" data-testid="text-otw-grand-kg">
                    {fmtOtwKg(otwGrandTotals.kg)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 sm:pl-5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                  <Coins className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Total Value by Currency</p>
                  <div className="flex flex-wrap gap-x-6 gap-y-2" data-testid="text-otw-grand-totals">
                    {Object.entries(otwGrandTotals.totalsByCurrency)
                      .filter(([, v]) => v > 0)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([ccy, amt]) => (
                        <div key={ccy} className="flex flex-col">
                          <span className="text-xs text-muted-foreground">{ccy}</span>
                          <span className="whitespace-nowrap font-mono text-xl font-bold tabular-nums tracking-tight">
                            {otwFmtCcy(otwCcySymbol(ccy), amt)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
