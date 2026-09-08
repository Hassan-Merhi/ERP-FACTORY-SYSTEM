import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CalendarRange, AlertTriangle, CheckCircle } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { FiscalPeriodClosure, LedgerAccount } from "@shared/schema";
import type { Serialized } from "@shared/apiTypes";

const fiscalCloseSchema = z
  .object({
    periodStartDate: z.string().min(1, "Start date is required"),
    periodEndDate: z.string().min(1, "End date is required"),
    retainedEarningsAccountId: z.string().min(1, "Retained earnings account is required"),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      const start = new Date(data.periodStartDate);
      const end = new Date(data.periodEndDate);
      return start <= end;
    },
    {
      message: "Start date must be before or equal to end date",
      path: ["periodEndDate"],
    }
  );

type FiscalCloseFormData = z.infer<typeof fiscalCloseSchema>;

interface FiscalPeriodTabProps {
  currentCompanyId: number | undefined;
  userRole: string | undefined;
}

export function FiscalPeriodTab({ currentCompanyId, userRole }: FiscalPeriodTabProps) {
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<FiscalCloseFormData | null>(null);

  const isAuthorized = userRole === "Admin" || userRole === "Owner" || userRole === "Developer";

  // Fetch Equity ledger accounts for the current company
  const { data: equityAccounts = [], isLoading: isLoadingAccounts } = useQuery<Serialized<LedgerAccount>[]>({
    queryKey: ["/api/ledger-accounts", { companyId: currentCompanyId, accountType: "Equity" }],
    queryFn: async () => {
      if (!currentCompanyId) return [];
      const response = await fetch(`/api/ledger-accounts?accountType=Equity`);
      if (!response.ok) throw new Error("Failed to fetch equity accounts");
      const allAccounts: Serialized<LedgerAccount>[] = await response.json();
      return allAccounts.filter((acc) => acc.companyId === currentCompanyId);
    },
    enabled: !!currentCompanyId,
  });

  // Fetch fiscal period closures for the current company
  const { data: closures = [], isLoading: isLoadingClosures } = useQuery<Serialized<FiscalPeriodClosure>[]>({
    queryKey: ["/api/fiscal-period/closures", { companyId: currentCompanyId }],
    enabled: !!currentCompanyId,
  });

  const form = useForm<FiscalCloseFormData>({
    resolver: zodResolver(fiscalCloseSchema),
    defaultValues: {
      periodStartDate: "",
      periodEndDate: "",
      retainedEarningsAccountId: "",
      notes: "",
    },
  });

  const closePeriodMutation = useMutation({
    mutationFn: async (data: FiscalCloseFormData) => {
      const res = await apiRequest("POST", "/api/fiscal-period/close", {
        ...data,
        retainedEarningsAccountId: parseInt(data.retainedEarningsAccountId),
      });
      return await res.json();
    },
    onSuccess: () => {
      toast({
        title: "Fiscal Period Closed",
        description:
          "The fiscal period has been successfully closed. All Income and Expense accounts have been transferred to Retained Earnings.",
      });
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ["/api/fiscal-period/closures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      form.reset();
      setIsConfirmDialogOpen(false);
      setPendingFormData(null);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to close fiscal period",
      });
      setIsConfirmDialogOpen(false);
      setPendingFormData(null);
    },
  });

  const handleFormSubmit = (data: FiscalCloseFormData) => {
    setPendingFormData(data);
    setIsConfirmDialogOpen(true);
  };

  const handleConfirmClose = () => {
    if (pendingFormData) {
      closePeriodMutation.mutate(pendingFormData);
    }
  };

  const selectedAccount = equityAccounts.find(
    (acc) => acc.id.toString() === pendingFormData?.retainedEarningsAccountId
  );

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
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Close Fiscal Period</h3>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleFormSubmit)} className="space-y-4" noValidate>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="periodStartDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period Start Date *</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="date"
                        disabled={!isAuthorized || closePeriodMutation.isPending}
                        data-testid="input-period-start-date"
                      />
                    </FormControl>
                    <FormDescription>First day of the fiscal period</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="periodEndDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period End Date *</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="date"
                        disabled={!isAuthorized || closePeriodMutation.isPending}
                        data-testid="input-period-end-date"
                      />
                    </FormControl>
                    <FormDescription>Last day of the fiscal period</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="retainedEarningsAccountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Retained Earnings Account *</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!isAuthorized || closePeriodMutation.isPending}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-retained-earnings">
                        <SelectValue placeholder="Select equity account" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {isLoadingAccounts ? (
                        <SelectItem value="loading" disabled>
                          Loading accounts...
                        </SelectItem>
                      ) : equityAccounts.length === 0 ? (
                        <SelectItem value="none" disabled>
                          No equity accounts found
                        </SelectItem>
                      ) : (
                        equityAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id.toString()}>
                            {account.name} ({account.code})
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <FormDescription>Net income will be transferred to this account</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Add any notes about this fiscal period closing..."
                      disabled={!isAuthorized || closePeriodMutation.isPending}
                      data-testid="input-notes"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end border-t pt-4">
              <Button
                type="submit"
                disabled={!isAuthorized || closePeriodMutation.isPending || equityAccounts.length === 0}
                data-testid="button-close-period"
              >
                {closePeriodMutation.isPending ? "Closing Period..." : "Close Fiscal Period"}
              </Button>
            </div>
          </form>
        </Form>
      </Card>

      {/* Closure History */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Fiscal Period Closure History</h3>
        {isLoadingClosures ? (
          <div className="text-center py-8 text-muted-foreground">Loading closures...</div>
        ) : closures.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No fiscal periods have been closed yet.</div>
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {closures.map((closure) => {
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
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

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
