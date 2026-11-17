import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CalendarRange, AlertTriangle, CheckCircle } from "lucide-react";
import {
  FiscalPeriodTabCardSection,
  useFiscalPeriodTabState,
  type FiscalPeriodTabProps,
} from "./useFiscalPeriodTabState";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";

export function FiscalPeriodTab(props: FiscalPeriodTabProps) {
  const {
    refetchClosures,
    isClosuresError,
    canReopen,
    closePeriodMutation,
    closures,
    currentCompanyId,
    equityAccounts,
    form,
    formatDisplayDate,
    handleConfirmClose,
    handleFormSubmit,
    isAuthorized,
    isConfirmDialogOpen,
    isLoadingAccounts,
    isLoadingClosures,
    pendingFormData,
    reopenPeriodMutation,
    reopenReason,
    reopenTarget,
    selectedAccount,
    setIsConfirmDialogOpen,
    setReopenReason,
    setReopenTarget,
  } = useFiscalPeriodTabState(props);

  if (!currentCompanyId) {
    return (
      <div className="p-6 text-center text-muted-foreground">Please select a company to manage fiscal periods.</div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <CalendarRange className="h-5 w-5" />
        <h2 className="text-2xl font-semibold">Fiscal Period Closing</h2>
      </div>

      {/* Authorization Warning */}
      {!isAuthorized && (
        <Card className="p-4 border-amber-500/50 bg-amber-500/10">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 mt-0.5" />
            <div>
              <p className="font-medium text-amber-900 dark:text-amber-200">Read-Only Access</p>
              <p className="text-sm text-amber-800 dark:text-amber-300">
                Only Admins and Owners can close fiscal periods. You can view the closure history below.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Close Period Form */}
      <FiscalPeriodTabCardSection
        closePeriodMutation={closePeriodMutation}
        equityAccounts={equityAccounts}
        form={form}
        handleFormSubmit={handleFormSubmit}
        isAuthorized={isAuthorized}
        isLoadingAccounts={isLoadingAccounts}
      />

      {/* Closure History */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Fiscal Period Closure History</h3>
        {isLoadingClosures ? (
          <LoadingState title="Loading closures..." className="py-8" />
        ) : isClosuresError && closures.length === 0 ? (
          <ErrorState onAction={() => void refetchClosures()} actionLabel="Try again" className="py-8" />
        ) : closures.length === 0 ? (
          <EmptyState title="No fiscal periods have been closed yet." className="py-8" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-testid="header-period">Period</TableHead>
                <TableHead data-testid="header-closed-date">Closed Date</TableHead>
                <TableHead data-testid="header-total-income">Total Income</TableHead>
                <TableHead data-testid="header-total-expense">Total Expense</TableHead>
                <TableHead data-testid="header-net-income">Net Income</TableHead>
                <TableHead data-testid="header-status">Status</TableHead>
                <TableHead data-testid="header-notes">Notes</TableHead>
                {canReopen && <TableHead data-testid="header-actions">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {closures.map((closure, index) => {
                const netIncome = parseFloat(closure.netIncome || "0");
                const isProfit = netIncome > 0;

                return (
                  <TableRow key={closure.id} data-testid={`row-closure-${closure.id}`}>
                    <TableCell data-testid={`text-period-${closure.id}`}>
                      {formatDisplayDate(closure.periodStartDate)} - {formatDisplayDate(closure.periodEndDate)}
                    </TableCell>
                    <TableCell data-testid={`text-closed-date-${closure.id}`}>
                      {formatDisplayDate(closure.createdAt)}
                    </TableCell>
                    <TableCell data-testid={`text-total-income-${closure.id}`}>
                      $
                      {parseFloat(closure.totalIncome || "0").toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell data-testid={`text-total-expense-${closure.id}`}>
                      $
                      {parseFloat(closure.totalExpense || "0").toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell
                      className={isProfit ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}
                      data-testid={`text-net-income-${closure.id}`}
                    >
                      {isProfit ? "+" : ""}$
                      {netIncome.toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell data-testid={`text-status-${closure.id}`}>
                      <Badge
                        variant="outline"
                        className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/50"
                      >
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {closure.status}
                      </Badge>
                    </TableCell>
                    <TableCell data-testid={`text-notes-${closure.id}`}>{closure.notes || "-"}</TableCell>
                    {canReopen && (
                      <TableCell>
                        {index === 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setReopenTarget(closure)}
                            data-testid={`button-reopen-${closure.id}`}
                          >
                            Reopen
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <AlertDialog
        open={reopenTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReopenTarget(null);
            setReopenReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen fiscal period</AlertDialogTitle>
            <AlertDialogDescription className="text-left">
              Reopening removes the closing journal, restores the income and expense opening balances, and unlocks the
              books for this period. Enter a reason; it is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={reopenReason}
            onChange={(event) => setReopenReason(event.target.value)}
            placeholder="Reason"
            data-testid="input-reopen-reason"
          />
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reopen">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (reopenTarget) reopenPeriodMutation.mutate({ closureId: reopenTarget.id, reason: reopenReason });
              }}
              disabled={!reopenReason.trim() || reopenPeriodMutation.isPending}
              data-testid="button-confirm-reopen"
            >
              {reopenPeriodMutation.isPending ? "Reopening..." : "Reopen period"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation Dialog */}
      <AlertDialog open={isConfirmDialogOpen} onOpenChange={setIsConfirmDialogOpen}>
        <AlertDialogContent data-testid="dialog-confirm-close">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Confirm Fiscal Period Closing
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-left">
              <p>
                This action will close the fiscal period and create closing vouchers that transfer all Income and
                Expense account balances to Retained Earnings. This operation cannot be undone.
              </p>
              <p>
                After closing, the books are locked through the period end date: no voucher dated on or before it can be
                created, edited or deleted. Corrections must be posted in a later, open period.
              </p>
              {pendingFormData && (
                <div className="bg-muted p-4 rounded-lg space-y-2 text-sm">
                  <div>
                    <span className="font-medium">Period:</span> {formatDisplayDate(pendingFormData.periodStartDate)} to{" "}
                    {formatDisplayDate(pendingFormData.periodEndDate)}
                  </div>
                  <div>
                    <span className="font-medium">Retained Earnings Account:</span> {selectedAccount?.name} (
                    {selectedAccount?.code})
                  </div>
                  {pendingFormData.notes && (
                    <div>
                      <span className="font-medium">Notes:</span> {pendingFormData.notes}
                    </div>
                  )}
                </div>
              )}
              <p className="text-destructive font-medium">Are you sure you want to proceed?</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closePeriodMutation.isPending} data-testid="button-cancel-close">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmClose}
              disabled={closePeriodMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="button-confirm-close"
            >
              {closePeriodMutation.isPending ? "Closing..." : "Yes, Close Period"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
