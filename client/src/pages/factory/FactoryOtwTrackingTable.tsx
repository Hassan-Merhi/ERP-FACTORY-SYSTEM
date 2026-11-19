// Extracted from ./FactoryOtwTrackingTab.tsx
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Radio, Pencil, CheckCircle2, Clock, Copy, LayoutList, AlertTriangle, FileCheck2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { calcDelayDays, ccySym, containerCost, fmtAmt, isOverdue, num } from "./factoryotwtrackingtab/utils";
import { EtaCell } from "./factoryotwtrackingtab/components/EtaCell";
import { NotesCell } from "./factoryotwtrackingtab/components/NotesCell";
import type { OtwTrackingTabProps } from "./factoryotwtrackingtab/types";
import type { FactoryOtwTrackingTabModel } from "./FactoryOtwTrackingTabModel";

export function FactoryOtwTrackingTable({
  m,
  onEdit,
}: {
  m: FactoryOtwTrackingTabModel;
  onEdit: OtwTrackingTabProps["onEdit"];
}) {
  return (
    <section
      aria-label="OTW container list"
      className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">{m.filtered.length}</strong> of {m.otwContainers.length} active
            containers
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            On time {m.onTime}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            Overdue {m.delayed}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            No ETA {m.missingEta}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <FileCheck2 className="h-3.5 w-3.5 text-blue-500" />
            Docs {m.docsReceived}/{m.filtered.length}
          </span>
        </div>
        <Button
          variant={m.detailedView ? "secondary" : "outline"}
          size="sm"
          className="h-8 rounded-lg"
          onClick={() => m.setDetailedView((v) => !v)}
          aria-pressed={m.detailedView}
          data-testid="button-otw-detailed-view"
        >
          <LayoutList className="mr-1.5 h-4 w-4" /> {m.detailedView ? "Compact view" : "Detailed view"}
        </Button>
      </div>
      {m.filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Radio className="h-9 w-9 opacity-30" />
          <p className="text-sm">No containers match your filters.</p>
          <Button variant="outline" size="sm" onClick={m.clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <Table mobileLayout="cards" className="text-xs whitespace-nowrap" wrapperClassName="overflow-x-auto">
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-slate-100/90 hover:bg-slate-100/90 dark:bg-[hsl(var(--factory-hue)_49%_16%)] dark:hover:bg-[hsl(var(--factory-hue)_49%_16%)]">
              <TableHead className="w-10 font-semibold">#</TableHead>
              <TableHead className="font-semibold">Container #</TableHead>
              <TableHead className="font-semibold">Supplier</TableHead>
              <TableHead className="font-semibold">ETA</TableHead>
              <TableHead className="text-right font-semibold">Cost</TableHead>
              <TableHead className="text-right font-semibold">Freight</TableHead>
              {m.detailedView && <TableHead className="text-right font-semibold">Commission</TableHead>}
              {m.detailedView && <TableHead className="text-right font-semibold">Duty</TableHead>}
              {m.detailedView && <TableHead className="font-semibold">Location</TableHead>}
              <TableHead className="text-right font-semibold">Weight (KG)</TableHead>
              <TableHead className="font-semibold">Delayed</TableHead>
              <TableHead className="text-center font-semibold">Docs</TableHead>
              <TableHead className="min-w-[150px] font-semibold">Notes</TableHead>
              <TableHead className="w-20 text-right font-semibold">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {m.filtered.map((c, idx) => {
              const cost = containerCost(c);
              const frSym = ccySym(c.freightCurrencyCode || c.currencyCode);
              const commSym = ccySym(c.commissionCurrencyCode || "USD");
              const dutySym = ccySym(c.currencyCode);
              const delayDays = calcDelayDays(c);
              const overdue = isOverdue(c);
              return (
                <TableRow
                  key={c.id}
                  className={cn(
                    "border-b border-border/45 transition-colors hover:bg-blue-500/[0.035] dark:hover:bg-blue-400/[0.07]",
                    overdue && "border-l-2 border-l-red-500/70"
                  )}
                  data-testid={"row-otw-container-" + c.id}
                >
                  <TableCell className="py-3 text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="py-3 font-mono font-semibold text-foreground">
                    {c.containerNumber || "—"}
                  </TableCell>
                  <TableCell className="py-3 font-medium text-foreground/85">{c.supplierName || "—"}</TableCell>
                  <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
                    <EtaCell
                      containerId={c.id}
                      arrivalDate={c.arrivalDate}
                      overdue={overdue}
                      onSave={m.saveEta}
                      readOnly={!m.recordChanges.allowed}
                    />
                  </TableCell>
                  <TableCell className="py-3 text-right font-semibold tabular-nums">
                    {cost.amount > 0 ? fmtAmt(cost.symbol, cost.amount) : "—"}
                  </TableCell>
                  <TableCell className="py-3 text-right tabular-nums text-muted-foreground">
                    {num(c.freight) > 0 ? fmtAmt(frSym, num(c.freight)) : "—"}
                  </TableCell>
                  {m.detailedView && (
                    <TableCell className="py-3 text-right tabular-nums text-muted-foreground">
                      {num(c.commissionAmount) > 0 ? fmtAmt(commSym, num(c.commissionAmount)) : "—"}
                    </TableCell>
                  )}
                  {m.detailedView && (
                    <TableCell className="py-3 text-right tabular-nums text-muted-foreground">
                      {num(c.dutyAmount) > 0 ? fmtAmt(dutySym, num(c.dutyAmount)) : "—"}
                    </TableCell>
                  )}
                  {m.detailedView && (
                    <TableCell className="py-3 text-muted-foreground">{c.destination || "—"}</TableCell>
                  )}
                  <TableCell className="py-3 text-right tabular-nums text-foreground/80">
                    {c.totalKg ? Number(c.totalKg).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}
                  </TableCell>
                  <TableCell className="py-3">
                    {delayDays > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-red-500/10 px-2 py-1 font-semibold text-red-700 dark:text-red-300">
                        <Clock className="h-3 w-3" />
                        {delayDays}d
                      </span>
                    ) : c.arrivalDate ? (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" />
                        On time
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" />
                        No ETA
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={!!c.otwDocsReceived}
                      onCheckedChange={(v) => m.toggleDoc(c.id, !!v)}
                      disabled={!m.recordChanges.allowed}
                      data-testid={"checkbox-docs-" + c.id}
                      aria-label={"Docs received for " + (c.containerNumber || "container")}
                    />
                  </TableCell>
                  <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
                    <NotesCell
                      containerId={c.id}
                      note={c.otwNote ?? ""}
                      onSave={m.saveNote}
                      readOnly={!m.recordChanges.allowed}
                    />
                  </TableCell>
                  <TableCell className="py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg"
                        title="Copy container number"
                        aria-label={"Copy number " + (c.containerNumber || "")}
                        data-testid={"button-otw-copy-" + c.id}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(c.containerNumber || "");
                            m.toast({ title: "Container number copied" });
                          } catch {
                            m.toast({ title: "Could not copy container number", variant: "destructive" });
                          }
                        }}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      {onEdit && m.recordChanges.allowed && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg"
                          title="Edit container"
                          aria-label={"Edit " + (c.containerNumber || "container")}
                          onClick={() => onEdit(c)}
                          data-testid={"button-otw-edit-" + c.id}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          Showing {m.filtered.length} of {m.otwContainers.length} containers
        </span>
        {m.recordChanges.allowed && <span className="hidden sm:inline">Click an ETA or note to edit</span>}
      </div>
    </section>
  );
}
