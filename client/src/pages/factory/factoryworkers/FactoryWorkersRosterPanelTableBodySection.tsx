// Extracted from ./FactoryWorkersRosterPanel.tsx to keep that module under the source-size cap.
import { Info, Pencil, UserCheck, Users, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getAvatarColor, getInitials } from "./utils";
import { useFactoryWorkersRosterPanelState } from "./useFactoryWorkersRosterPanelState";
import { formatUsd } from "@/lib/moneyDisplay";

export function FactoryWorkersRosterPanelTableBodySection({
  amountDue,
  canChangeExistingRecords,
  docCounts,
  filteredWorkers,
  isLoading,
  openEdit,
  openEndContract,
  reactivateMutation,
  searchQuery,
  setLocation,
  statusFilter,
}: Pick<
  ReturnType<typeof useFactoryWorkersRosterPanelState>,
  | "amountDue"
  | "canChangeExistingRecords"
  | "docCounts"
  | "filteredWorkers"
  | "isLoading"
  | "openEdit"
  | "openEndContract"
  | "reactivateMutation"
  | "searchQuery"
  | "setLocation"
  | "statusFilter"
>) {
  return (
    <TableBody>
      {isLoading ? (
        [...Array(6)].map((_, i) => (
          <TableRow key={i}>
            <TableCell className="pl-3 pr-1">
              <Skeleton className="h-4 w-5 mx-auto" />
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <Skeleton className="h-4 w-32" />
              </div>
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-20" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-14 ml-auto" />
            </TableCell>
            <TableCell></TableCell>
            <TableCell></TableCell>
            <TableCell></TableCell>
            <TableCell>
              <Skeleton className="h-5 w-12 rounded-full" />
            </TableCell>
            <TableCell></TableCell>
          </TableRow>
        ))
      ) : filteredWorkers.length === 0 ? (
        <TableRow>
          <TableCell colSpan={11}>
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium" data-testid="text-empty">
                No workers found
              </p>
              <p className="text-xs text-muted-foreground">
                {searchQuery || statusFilter !== "All"
                  ? "Try adjusting your search or filters"
                  : "Add your first worker to get started"}
              </p>
            </div>
          </TableCell>
        </TableRow>
      ) : (
        filteredWorkers.map((worker, idx) => (
          <TableRow
            key={worker.id}
            className="group cursor-pointer transition-colors hover:bg-primary/5 dark:hover:bg-blue-400/[0.08]"
            onClick={() => setLocation(`/factory/workers/${worker.id}`)}
            data-testid={`row-worker-${worker.id}`}
          >
            <TableCell className="py-3 pl-3 pr-1 text-center text-xs text-muted-foreground font-mono tabular-nums">
              {idx + 1}
            </TableCell>
            <TableCell className="py-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                  <Avatar className={`h-8 w-8 text-xs font-semibold ${getAvatarColor(worker.fullName)}`}>
                    {worker.photoUrl ? <AvatarImage src={worker.photoUrl} /> : null}
                    <AvatarFallback className={getAvatarColor(worker.fullName)}>
                      {getInitials(worker.fullName)}
                    </AvatarFallback>
                  </Avatar>
                  <span
                    className={`absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-background ${(docCounts[worker.id] ?? 0) > 0 ? "bg-emerald-500" : "bg-red-400"}`}
                    title={
                      (docCounts[worker.id] ?? 0) > 0
                        ? `${docCounts[worker.id]} document(s) uploaded`
                        : "No documents uploaded"
                    }
                    data-testid={`dot-docs-${worker.id}`}
                  />
                </div>
                <div className="flex flex-col min-w-0">
                  {worker.employeeCode && (
                    <span
                      className="text-xs font-mono text-muted-foreground leading-tight"
                      data-testid={`text-code-${worker.id}`}
                    >
                      {worker.employeeCode}
                    </span>
                  )}
                  <span
                    className="font-medium text-sm leading-snug wrap-break-word"
                    data-testid={`text-name-${worker.id}`}
                  >
                    {worker.fullName}
                  </span>
                </div>
              </div>
            </TableCell>
            <TableCell className="py-3 text-sm text-muted-foreground truncate">
              {worker.position || <span className="text-muted-foreground/40">—</span>}
            </TableCell>
            <TableCell className="py-3 text-sm text-muted-foreground truncate">
              {worker.nationality ? (
                <span>{worker.nationality}</span>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </TableCell>
            <TableCell className="py-3 text-sm text-muted-foreground truncate">
              {worker.city || worker.country ? (
                <span>{worker.city || worker.country}</span>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </TableCell>
            <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground">
              {worker.baseSalary ? (
                formatUsd(parseFloat(worker.baseSalary), 0, 3)
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </TableCell>
            <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground">
              {parseFloat(worker.transportAllowance || "0") > 0 ? (
                formatUsd(parseFloat(worker.transportAllowance || "0"), 0, 3)
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </TableCell>
            <TableCell className="py-3 text-right font-mono text-sm">
              {parseFloat(worker.pendingAdvanceBalance || "0") > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {formatUsd(parseFloat(worker.pendingAdvanceBalance || "0"), 0, 3)}
                </span>
              ) : (
                <span className="text-muted-foreground/40">—</span>
              )}
            </TableCell>

            {/* ── Due Today ─────────────────────────────────── */}
            <TableCell className="py-3 text-right font-mono text-sm" onClick={(e) => e.stopPropagation()}>
              {(() => {
                const due = amountDue[worker.id];
                if (!due) return <span className="text-muted-foreground/40">—</span>;
                const absenceDays = (due as typeof due & { absenceDays?: number }).absenceDays ?? 0;
                const fmt = (n: number) =>
                  `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                const fmtDate = (s: string) =>
                  new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
                return (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className={[
                          "flex items-center gap-1 ml-auto rounded-sm px-1.5 py-0.5 transition-colors",
                          "hover:bg-muted/60 cursor-pointer select-none",
                          due.net > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/50",
                        ].join(" ")}
                      >
                        {due.net > 0 ? fmt(due.net) : "Paid up"}
                        <Info className="h-3 w-3 opacity-50 shrink-0" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3 text-sm" align="end" side="left">
                      <p className="font-semibold text-foreground mb-1">Due Today</p>
                      <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                        Period: {fmtDate(due.periodStart)} → {fmtDate(due.periodEnd)}
                        {due.lastPaidThrough && (
                          <span className="block">Last paid through {fmtDate(due.lastPaidThrough)}</span>
                        )}
                      </p>
                      <div className="space-y-1.5">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Base salary</span>
                          <span className="font-mono">{fmt(due.base)}</span>
                        </div>
                        {due.transport > 0 && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Transport</span>
                            <span className="font-mono">+{fmt(due.transport)}</span>
                          </div>
                        )}
                        {(due.absenceDeducted ?? 0) > 0 && (
                          <div className="flex justify-between text-rose-600 dark:text-rose-400">
                            <span>
                              Absences deducted ({absenceDays} {absenceDays === 1 ? "day" : "days"})
                            </span>
                            <span className="font-mono">−{fmt(due.absenceDeducted)}</span>
                          </div>
                        )}
                        {due.advanceDeducted > 0 && (
                          <div className="flex justify-between text-amber-600 dark:text-amber-400">
                            <span>Advance deducted</span>
                            <span className="font-mono">−{fmt(due.advanceDeducted)}</span>
                          </div>
                        )}
                        <div className="flex justify-between border-t pt-1.5 font-semibold">
                          <span>Net due</span>
                          <span
                            className={`font-mono ${due.net > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
                          >
                            {fmt(due.net)}
                          </span>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground/50 mt-2 leading-relaxed">
                        Calendar-day proration · Absences &amp; advances deducted
                      </p>
                    </PopoverContent>
                  </Popover>
                );
              })()}
            </TableCell>

            <TableCell className="py-3">
              <Badge
                variant="secondary"
                className={`text-xs no-default-active-elevate ${
                  worker.active
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground"
                }`}
                data-testid={`badge-status-${worker.id}`}
              >
                {worker.active ? "Active" : "Inactive"}
              </Badge>
            </TableCell>
            <TableCell className="py-3">
              {canChangeExistingRecords && (
                <div
                  className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => openEdit(worker)}
                    data-testid={`button-edit-worker-${worker.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {worker.active ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEndContract(worker)}
                      data-testid={`button-end-contract-${worker.id}`}
                    >
                      <UserX className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => reactivateMutation.mutate(worker.id)}
                      disabled={reactivateMutation.isPending}
                      data-testid={`button-reactivate-${worker.id}`}
                    >
                      <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
                    </Button>
                  )}
                </div>
              )}
            </TableCell>
          </TableRow>
        ))
      )}
    </TableBody>
  );
}

export function FactoryWorkersRosterPanelTableHeaderSection() {
  return (
    <TableHeader className="sticky top-0 z-30">
      <TableRow className="border-b border-border/70 bg-muted/65 dark:bg-slate-900/80 hover:bg-muted/65 dark:hover:bg-slate-900/80">
        <TableHead className="w-10 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2 pl-3 pr-1">
          #
        </TableHead>
        <TableHead className="w-[18%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Worker
        </TableHead>
        <TableHead className="w-[16%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Position
        </TableHead>
        <TableHead className="w-[11%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Nationality
        </TableHead>
        <TableHead className="w-[12%] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Location
        </TableHead>
        <TableHead className="w-[10%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Salary
        </TableHead>
        <TableHead className="w-[8%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Transport
        </TableHead>
        <TableHead className="w-[8%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Advance
        </TableHead>
        <TableHead className="w-[10%] text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Due Today
        </TableHead>
        <TableHead className="w-[80px] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
          Status
        </TableHead>
        <TableHead className="w-[64px] py-2"></TableHead>
      </TableRow>
    </TableHeader>
  );
}
