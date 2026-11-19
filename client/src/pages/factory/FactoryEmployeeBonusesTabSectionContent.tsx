// Extracted from ./FactoryEmployeeBonusesTabSection.tsx
import { CalendarDays, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  bonusDate,
  bonusName,
  dateLabel,
  fmt,
  useFactoryEmployeeBonusesTabState,
} from "./useFactoryEmployeeBonusesTabState";

export function FactoryEmployeeBonusesTabSectionContent({
  recordChanges,
  setDeleteConfirm,
  shownBonuses,
  visibleColumns,
}: Pick<
  Pick<
    ReturnType<typeof useFactoryEmployeeBonusesTabState>,
    | "bonuses"
    | "empFilter"
    | "employees"
    | "endDate"
    | "exportBonusesCsv"
    | "isLoading"
    | "recordChanges"
    | "search"
    | "setAddOpen"
    | "setDeleteConfirm"
    | "setEmpFilter"
    | "setEndDate"
    | "setSearch"
    | "setShowFilters"
    | "setStartDate"
    | "setVisibleColumns"
    | "showFilters"
    | "shownBonuses"
    | "startDate"
    | "totalBonuses"
    | "visibleColumns"
  >,
  "recordChanges" | "setDeleteConfirm" | "shownBonuses" | "visibleColumns"
>) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-border/80 shadow-sm sm:block">
        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-slate-100/90 dark:bg-slate-900/90">
            <TableRow>
              <TableHead className="min-w-40 py-3 text-xs font-semibold uppercase tracking-wide">
                <span className="flex items-center gap-2">
                  <UserRound className="h-4 w-4 text-emerald-600" />
                  Employee Name
                </span>
              </TableHead>
              <TableHead className="min-w-36 py-3 text-xs font-semibold uppercase tracking-wide">
                <span className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-emerald-600" />
                  Date
                </span>
              </TableHead>
              {visibleColumns.amount && (
                <TableHead className="text-right text-xs font-semibold uppercase tracking-wide">Amount</TableHead>
              )}
              {visibleColumns.notes && (
                <TableHead className="text-xs font-semibold uppercase tracking-wide">Notes</TableHead>
              )}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownBonuses.map((b) => (
              <TableRow
                key={b.id}
                className="even:bg-muted/20 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/15"
                data-testid={`row-bonus-${b.id}`}
              >
                <TableCell className="py-3.5 font-semibold" data-testid={`bonus-name-${b.id}`}>
                  {bonusName(b)}
                </TableCell>
                <TableCell className="py-3.5 text-sm text-muted-foreground" data-testid={`bonus-date-${b.id}`}>
                  {dateLabel(bonusDate(b))}
                </TableCell>
                {visibleColumns.amount && (
                  <TableCell className="py-3.5 text-right font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {fmt(b.amount)}
                  </TableCell>
                )}
                {visibleColumns.notes && (
                  <TableCell
                    className="max-w-72 truncate py-3.5 text-sm text-muted-foreground"
                    title={b.notes || undefined}
                  >
                    {b.notes || "—"}
                  </TableCell>
                )}
                <TableCell>
                  {recordChanges.allowed && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="hover:bg-destructive/10"
                      aria-label={"Reverse bonus for " + bonusName(b)}
                      onClick={() => setDeleteConfirm(b)}
                      data-testid={`button-delete-bonus-${b.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="sm:hidden space-y-2">
        {shownBonuses.map((b) => (
          <Card key={b.id} className="rounded-xl border-border/70 shadow-sm" data-testid={`card-bonus-${b.id}`}>
            <CardContent className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm break-words">{bonusName(b)}</p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {dateLabel(bonusDate(b))}
                  </p>
                  {visibleColumns.notes && b.notes ? (
                    <p className="text-xs text-muted-foreground mt-1 break-words">{b.notes}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {visibleColumns.amount && (
                    <span className="font-mono text-emerald-600 dark:text-emerald-400 text-sm font-semibold tabular-nums">
                      {fmt(b.amount)}
                    </span>
                  )}
                  {recordChanges.allowed && (
                    <Button size="icon" variant="ghost" onClick={() => setDeleteConfirm(b)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
