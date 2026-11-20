import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./AdvancesTab.tsx to keep that module under the source-size cap.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TabsContent } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import { Checkbox } from "@/components/ui/checkbox";
import { useAdvancesTabState } from "./useAdvancesTabState";
export { AdvancesTabTabsContentSection } from "./AdvancesTabTabsContentSection";

export function AdvancesTabTabsContentSection2({
  formatAmount,
  formatDisplayDate,
  repayments,
  repaymentsLoading,
}: Pick<
  ReturnType<typeof useAdvancesTabState>,
  "formatAmount" | "formatDisplayDate" | "repayments" | "repaymentsLoading"
>) {
  return (
    <TabsContent value="repayments" className="pt-4">
      {repaymentsLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="border rounded-md">
          <Table mobileLayout="cards">
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Payroll Month</TableHead>
                <TableHead className="text-right">Repayment Amount</TableHead>
                <TableHead className="text-right">Advance Remaining After</TableHead>
                <TableHead>Date Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repayments.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    No repayments recorded yet
                  </TableCell>
                </TableRow>
              ) : (
                repayments.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <span className="font-medium">{r.workerName || `Employee #${r.employeeId}`}</span>
                    </TableCell>
                    <TableCell>{r.payrollMonth}</TableCell>
                    <TableCell className="text-right font-mono text-green-600 dark:text-green-400 font-bold">
                      {formatAmount(parseFloat(r.deductionAmount || "0"))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {formatAmount(parseFloat(r.advanceRemaining || "0"))}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {r.createdAt ? formatDisplayDate(r.createdAt.split("T")[0]) : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </TabsContent>
  );
}

export function AdvancesTabDialogSection({
  advanceDialogOpen,
  advanceForm,
  advanceMutation,
  cashAccounts,
  setAdvanceDialogOpen,
  workerStaff,
}: Pick<
  ReturnType<typeof useAdvancesTabState>,
  "advanceDialogOpen" | "advanceForm" | "advanceMutation" | "cashAccounts" | "setAdvanceDialogOpen" | "workerStaff"
>) {
  return (
    <Dialog open={advanceDialogOpen} onOpenChange={setAdvanceDialogOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Salary Advance</DialogTitle>
          <DialogDescription>Record a cash advance given to a worker.</DialogDescription>
        </DialogHeader>
        <Form {...advanceForm}>
          <form onSubmit={advanceForm.handleSubmit((data) => advanceMutation.mutate(data))} className="space-y-4">
            <FormField
              control={advanceForm.control}
              name="employeeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Worker</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-advance-worker">
                        <SelectValue placeholder="Select worker" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {workerStaff.map((w) => (
                        <SelectItem key={w.id} value={String(w.id)}>
                          {w.code} - {w.firstName} {w.lastName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={advanceForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        {...field}
                        data-testid="input-advance-amount"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={advanceForm.control}
                name="advanceDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        value={field.value ? format(field.value, "yyyy-MM-dd") : ""}
                        onChange={(e) => field.onChange(new Date(e.target.value))}
                        data-testid="input-advance-date"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={advanceForm.control}
              name="isOpeningBalance"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>Opening Balance</FormLabel>
                    <p className="text-xs text-muted-foreground">
                      Tick if this is an existing balance from before system startup.
                    </p>
                  </div>
                </FormItem>
              )}
            />
            {!advanceForm.watch("isOpeningBalance") && (
              <FormField
                control={advanceForm.control}
                name="cashAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cash Account</FormLabel>
                    <UnifiedAccountPicker
                      options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="Select account"
                      testId="select-advance-cash"
                      ariaLabel="Cash account"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={advanceForm.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea {...field} data-testid="textarea-advance-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={advanceMutation.isPending}
              data-testid="button-save-advance"
            >
              {advanceMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Advance
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
