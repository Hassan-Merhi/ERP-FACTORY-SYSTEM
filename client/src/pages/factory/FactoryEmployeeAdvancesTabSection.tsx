// Extracted from ./FactoryEmployeeAdvancesTab.tsx to keep that module under the source-size cap.
import { Banknote, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtUsd, today } from "./FactoryEmployeeAdvancesTabTypes";
import { useFactoryEmployeeAdvancesTabState } from "./useFactoryEmployeeAdvancesTabState";
import { ErrorState } from "@/components/ui/page-state";

export function FactoryEmployeeAdvancesTabSection({
  refetch,
  isError,
  advancesData,
  advances,
  empFilter,
  isLoading,
  recordChanges,
  setDeleteConfirm,
  setRepayForm,
  setRepayOpen,
  statusFilter,
}: Pick<
  ReturnType<typeof useFactoryEmployeeAdvancesTabState>,
  | "advances"
  | "empFilter"
  | "isLoading"
  | "recordChanges"
  | "setDeleteConfirm"
  | "setRepayForm"
  | "setRepayOpen"
  | "statusFilter"
  | "advancesData"
  | "isError"
  | "refetch"
>) {
  return (
    <div className="border rounded-xl overflow-x-auto">
      <Table mobileLayout="cards">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="text-xs h-9 font-semibold">Employee</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
            <TableHead className="text-xs h-9 font-semibold text-right">Amount</TableHead>
            <TableHead className="text-xs h-9 font-semibold text-right">Remaining</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Status</TableHead>
            <TableHead className="text-xs h-9 font-semibold">Notes</TableHead>
            <TableHead className="text-xs h-9 w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            [...Array(4)].map((_, i) => (
              <TableRow key={i}>
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
                  <Skeleton className="h-5 w-16 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell></TableCell>
              </TableRow>
            ))
          ) : isError && !advancesData ? (
            <TableRow>
              <TableCell colSpan={7}>
                <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="border-0" />
              </TableCell>
            </TableRow>
          ) : advances.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7}>
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Banknote className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">No advances found</p>
                  <p className="text-xs text-muted-foreground">
                    {statusFilter !== "all" || empFilter !== "all"
                      ? "Try adjusting your filters"
                      : "Add an advance to get started"}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            advances.map((adv) => (
              <TableRow key={adv.id} className="hover:bg-muted/40" data-testid={`row-advance-${adv.id}`}>
                <TableCell className="font-medium py-3">
                  {adv.firstName} {adv.lastName}
                </TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground">{adv.advanceDate}</TableCell>
                <TableCell className="py-3 text-right font-mono text-sm">{fmtUsd(adv.amount)}</TableCell>
                <TableCell className="py-3 text-right font-mono text-sm">
                  {adv.fullyPaid ? (
                    <span className="text-muted-foreground/40">—</span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400">{fmtUsd(adv.remainingBalance)}</span>
                  )}
                </TableCell>
                <TableCell className="py-3">
                  <Badge
                    variant="secondary"
                    className={`text-xs no-default-active-elevate ${
                      adv.fullyPaid
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    }`}
                  >
                    {adv.fullyPaid ? "Paid" : "Open"}
                  </Badge>
                </TableCell>
                <TableCell className="py-3 text-sm text-muted-foreground max-w-32 truncate">
                  {adv.notes || "—"}
                </TableCell>
                <TableCell className="py-3">
                  {recordChanges.allowed && (
                    <div className="flex gap-1 justify-end">
                      {!adv.fullyPaid && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRepayOpen(adv);
                            setRepayForm({
                              repaymentDate: today(),
                              amount: adv.remainingBalance,
                              cashAccountId: "",
                              notes: "",
                            });
                          }}
                          data-testid={`button-repay-${adv.id}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" /> Repay
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeleteConfirm(adv)}
                        data-testid={`button-delete-advance-${adv.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
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
