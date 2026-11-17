// Extracted from ./FiscalPeriodTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
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

export interface FiscalPeriodTabProps {
  currentCompanyId: number | undefined;
  userRole: string | undefined;
}

export function useFiscalPeriodTabState({ currentCompanyId, userRole }: FiscalPeriodTabProps) {
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
  const {
    data: closures = [],
    isLoading: isLoadingClosures,
    isError: isClosuresError,
    refetch: refetchClosures,
  } = useQuery<Serialized<FiscalPeriodClosure>[]>({
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
        title: "Update failed",
        description: error.message || "Failed to close fiscal period",
      });
      setIsConfirmDialogOpen(false);
      setPendingFormData(null);
    },
  });

  const canReopen = userRole === "Admin" || userRole === "Developer";
  const [reopenTarget, setReopenTarget] = useState<Serialized<FiscalPeriodClosure> | null>(null);
  const [reopenReason, setReopenReason] = useState("");

  const reopenPeriodMutation = useMutation({
    mutationFn: async ({ closureId, reason }: { closureId: number; reason: string }) => {
      const res = await apiRequest("POST", `/api/fiscal-period/${closureId}/reopen`, { reason });
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Fiscal Period Reopened", description: "The period is open again." });
      queryClient.invalidateQueries({ queryKey: ["/api/fiscal-period/closures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      setReopenTarget(null);
      setReopenReason("");
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        variant: "destructive",
        title: "Update failed",
        description: error.message || "Failed to reopen fiscal period",
      });
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
  return {
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
  };
}

export function FiscalPeriodTabCardSection({
  closePeriodMutation,
  equityAccounts,
  form,
  handleFormSubmit,
  isAuthorized,
  isLoadingAccounts,
}: Pick<
  ReturnType<typeof useFiscalPeriodTabState>,
  "closePeriodMutation" | "equityAccounts" | "form" | "handleFormSubmit" | "isAuthorized" | "isLoadingAccounts"
>) {
  return (
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
  );
}
