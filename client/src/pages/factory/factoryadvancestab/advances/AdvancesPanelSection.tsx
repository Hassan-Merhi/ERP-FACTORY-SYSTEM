// Extracted from ./AdvancesPanel.tsx to keep that module under the source-size cap.
import { Banknote, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { fmt } from "../utils";
import { useAdvancesPanelState } from "./useAdvancesPanelState";

export function AdvancesPanelSection({
  canChangeExistingRecords,
  filterStatus,
  filterWorker,
  filtered,
  formatDate,
  isLoading,
  selectedIds,
  setDeleteTarget,
  setReverseTarget,
  setSelectedIds,
}: Pick<
  ReturnType<typeof useAdvancesPanelState>,
  | "canChangeExistingRecords"
  | "filterStatus"
  | "filterWorker"
  | "filtered"
  | "formatDate"
  | "isLoading"
  | "selectedIds"
  | "setDeleteTarget"
  | "setReverseTarget"
  | "setSelectedIds"
>) {
  return (
    <div className="border rounded-xl overflow-x-auto">
      <Table mobileLayout="cards">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-10 h-9">
              <Checkbox
                checked={filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id))}
                onCheckedChange={(checked) => {
                  if (checked) {
                    setSelectedIds(new Set(filtered.map((a) => a.id)));
                  } else {
                    setSelectedIds(new Set());
                  }
                }}
                data-testid="checkbox-select-all"
                aria-label="Select all"
              />
            </TableHead>
            <TableHead className="text-xs h-9 font-semibold">Worker</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
            <TableHead className="text-xs h-9 font-semibold text-right">Amount</TableHead>
            <TableHead className="text-xs h-9 font-semibold text-right">Remaining</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Type</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Status</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Notes</TableHead>
            <TableHead className="text-xs h-9 w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            [...Array(5)].map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-4 w-4" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-28" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16 ml-auto" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-16 ml-auto" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell></TableCell>
              </TableRow>
            ))
          ) : filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9}>
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Banknote className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">No advances found</p>
                  <p className="text-xs text-muted-foreground">
                    {filterWorker !== "all" || filterStatus !== "all"
                      ? "Try adjusting your filters"
                      : "Record an advance to get started"}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((adv) => (
              <TableRow
                key={adv.id}
                className={`hover:bg-muted/40 ${selectedIds.has(adv.id) ? "bg-muted/30" : ""}`}
                data-testid={`row-advance-${adv.id}`}
              >
                <TableCell className="py-3">
                  <Checkbox
                    checked={selectedIds.has(adv.id)}
                    onCheckedChange={(checked) => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(adv.id);
                        else next.delete(adv.id);
                        return next;
                      });
                    }}
                    data-testid={`checkbox-advance-${adv.id}`}
                    aria-label={`Select advance for ${adv.workerName}`}
                  />
                </TableCell>
                <TableCell className="font-medium py-3" data-testid={`text-advance-worker-${adv.id}`}>
                  {adv.workerName}
                </TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground" data-testid={`text-advance-date-${adv.id}`}>
                  {formatDate(adv.advanceDate)}
                </TableCell>
                <TableCell className="py-3 text-right font-mono text-sm" data-testid={`text-advance-amount-${adv.id}`}>
                  {fmt(adv.amount)}
                </TableCell>
                <TableCell
                  className="py-3 text-right font-mono text-sm"
                  data-testid={`text-advance-remaining-${adv.id}`}
                >
                  {fmt(adv.remainingBalance)}
                </TableCell>
                <TableCell className="py-3">
                  <Badge
                    variant="secondary"
                    className={`text-xs no-default-active-elevate ${
                      adv.repaymentType === "manual_repayment"
                        ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                        : "bg-muted text-muted-foreground"
                    }`}
                    data-testid={`badge-advance-type-${adv.id}`}
                  >
                    {adv.repaymentType === "manual_repayment" ? "Loan" : "Salary Ded."}
                  </Badge>
                </TableCell>
                <TableCell className="py-3">
                  <Badge
                    variant="secondary"
                    className={`text-xs no-default-active-elevate ${
                      adv.fullyPaid
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    }`}
                    data-testid={`badge-advance-status-${adv.id}`}
                  >
                    {adv.fullyPaid ? "Paid" : "Outstanding"}
                  </Badge>
                </TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground max-w-[200px] truncate">
                  {adv.notes || "\u2014"}
                </TableCell>
                <TableCell className="py-3">
                  {canChangeExistingRecords && (
                    <div className="flex items-center gap-1">
                      {adv.fullyPaid ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setReverseTarget(adv)}
                          title="Reverse this advance"
                          data-testid={`button-reverse-advance-${adv.id}`}
                        >
                          <RotateCcw className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteTarget(adv)}
                          data-testid={`button-delete-advance-${adv.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
