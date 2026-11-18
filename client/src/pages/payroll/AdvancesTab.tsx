import { confirmAction } from "@/components/ConfirmHost";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Pencil,
  Trash2,
  ArrowDownCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Banknote,
  TrendingDown,
  Activity,
} from "lucide-react";
import { type SalaryAdvance } from "./payrollSchemas";
import { AdvanceReassignDialog } from "./AdvanceReassignDialog";
import { AddWorkerDeductionDialog } from "./AddWorkerDeductionDialog";
import { AdvancesTabSection, useAdvancesTabState, type AdvancesTabProps } from "./useAdvancesTabState";
import {
  AdvancesTabDialogSection,
  AdvancesTabTabsContentSection,
  AdvancesTabTabsContentSection2,
} from "./AdvancesTabDialogSection";

export function AdvancesTab(props: AdvancesTabProps) {
  const {
    addWorkerDeductionDialogOpen,
    addWorkerDeductionForm,
    addWorkerDeductionMutation,
    advanceDialogOpen,
    advanceForm,
    advanceMutation,
    advancesLoading,
    canCreateAdvance,
    canReassignAdvance,
    cashAccounts,
    deductionDialogOpen,
    deductionForm,
    deductionMutation,
    deductionsLoading,
    deleteAdvanceMutation,
    deleteWorkerDeductionMutation,
    formatAmount,
    formatDisplayDate,
    modeApiRequest,
    outstanding,
    paid,
    reassignTarget,
    recordChanges,
    repayments,
    repaymentsLoading,
    selectedAdvance,
    selectedCompany,
    setAddWorkerDeductionDialogOpen,
    setAdvanceDialogOpen,
    setDeductionDialogOpen,
    setReassignTarget,
    setSelectedAdvance,
    setShowPaid,
    setStatusFilter,
    setWorkerFilter,
    showPaid,
    stats,
    statusFilter,
    workerDeductions,
    workerFilter,
    workerStaff,
  } = useAdvancesTabState(props);

  if (advancesLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderAdvanceRows = (rows: SalaryAdvance[]) =>
    rows.map((advance) => (
      <TableRow key={advance.id}>
        <TableCell>
          <span className="font-medium">{advance.employeeName}</span>
        </TableCell>
        <TableCell>{formatDisplayDate(advance.advanceDate)}</TableCell>
        <TableCell className="text-right font-mono">{formatAmount(parseFloat(advance.amount))}</TableCell>
        <TableCell className="text-right font-mono font-bold text-amber-600 dark:text-amber-400">
          {formatAmount(parseFloat(advance.remainingBalance))}
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="text-[11px]">
            {advance.isOpeningBalance ? "Opening Balance" : "Advance"}
          </Badge>
        </TableCell>
        <TableCell>
          {advance.fullyPaid ? (
            <Badge variant="default" className="bg-green-500">
              Fully Paid
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-500 text-amber-500">
              Outstanding
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-[180px] truncate">{advance.notes || "—"}</TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            {canReassignAdvance && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setReassignTarget(advance);
                }}
                title="Change worker for this advance"
                aria-label={`Change worker for advance #${advance.id}`}
                data-testid={`button-reassign-advance-${advance.id}`}
              >
                <Pencil className="h-4 w-4 text-blue-500" />
              </Button>
            )}
            {recordChanges.allowed && !advance.fullyPaid && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setSelectedAdvance(advance);
                  deductionForm.setValue("deductionAmount", advance.remainingBalance);
                  setDeductionDialogOpen(true);
                }}
                title="Record Repayment"
                data-testid={`button-repay-advance-${advance.id}`}
              >
                <ArrowDownCircle className="h-4 w-4 text-green-600" />
              </Button>
            )}
            {recordChanges.allowed && (
              <Button
                size="icon"
                variant="ghost"
                className="text-destructive"
                onClick={async () => {
                  if (
                    await confirmAction({ title: "Are you sure you want to delete this advance?", tone: "destructive" })
                  ) {
                    deleteAdvanceMutation.mutate(advance.id);
                  }
                }}
                data-testid={`button-delete-advance-${advance.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    ));

  const advanceTableHeaders = (
    <TableRow>
      <TableHead>Worker</TableHead>
      <TableHead>Date</TableHead>
      <TableHead className="text-right">Amount</TableHead>
      <TableHead className="text-right">Remaining</TableHead>
      <TableHead>Type</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Notes</TableHead>
      <TableHead className="text-right">Actions</TableHead>
    </TableRow>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight max-sm:text-xl">Advances + Deductions</h2>
          <p className="text-muted-foreground">Manage and track worker salary advances and repayments</p>
        </div>
      </div>

      <Tabs defaultValue="advances">
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Advance and deduction sections">
            <TabsTrigger value="advances">Advances</TabsTrigger>
            <TabsTrigger value="repayments">Repayments</TabsTrigger>
            <TabsTrigger value="worker-deductions">Worker Deductions</TabsTrigger>
          </TabsList>
        </div>

        {/* ── Advances sub-tab ── */}
        <TabsContent value="advances" className="space-y-4 pt-4">
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="border rounded-md p-4 flex items-center gap-3">
              <Banknote className="h-8 w-8 text-blue-500 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Total Given</p>
                <p className="text-lg font-bold">{formatAmount(stats.total)}</p>
              </div>
            </div>
            <div className="border rounded-md p-4 flex items-center gap-3">
              <TrendingDown className="h-8 w-8 text-amber-500 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Outstanding</p>
                <p className="text-lg font-bold">{formatAmount(stats.outstanding)}</p>
              </div>
            </div>
            <div className="border rounded-md p-4 flex items-center gap-3">
              <Activity className="h-8 w-8 text-green-500 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Active Advances</p>
                <p className="text-lg font-bold">{stats.active}</p>
              </div>
            </div>
          </div>

          {/* Filters + actions */}
          <AdvancesTabSection
            canCreateAdvance={canCreateAdvance}
            setAdvanceDialogOpen={setAdvanceDialogOpen}
            setStatusFilter={setStatusFilter}
            setWorkerFilter={setWorkerFilter}
            statusFilter={statusFilter}
            workerFilter={workerFilter}
            workerStaff={workerStaff}
          />

          {/* Outstanding table */}
          <div className="border rounded-md">
            <Table mobileLayout="cards">
              <TableHeader>{advanceTableHeaders}</TableHeader>
              <TableBody>
                {outstanding.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No outstanding advances
                    </TableCell>
                  </TableRow>
                ) : (
                  renderAdvanceRows(outstanding)
                )}
              </TableBody>
            </Table>
          </div>

          {/* Collapsible fully-paid section */}
          {paid.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40 transition-colors"
                onClick={() => setShowPaid((v) => !v)}
                data-testid="button-toggle-paid-advances"
              >
                <span className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">
                    Fully Paid
                  </Badge>
                  <span className="text-muted-foreground">
                    {paid.length} advance{paid.length !== 1 ? "s" : ""}
                  </span>
                </span>
                {showPaid ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {showPaid && (
                <Table mobileLayout="cards">
                  <TableHeader>{advanceTableHeaders}</TableHeader>
                  <TableBody>{renderAdvanceRows(paid)}</TableBody>
                </Table>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── Repayments sub-tab ── */}
        <AdvancesTabTabsContentSection2
          formatAmount={formatAmount}
          formatDisplayDate={formatDisplayDate}
          repayments={repayments}
          repaymentsLoading={repaymentsLoading}
        />

        {/* ── Worker Deductions sub-tab ── */}
        <AdvancesTabTabsContentSection
          deductionsLoading={deductionsLoading}
          deleteWorkerDeductionMutation={deleteWorkerDeductionMutation}
          formatAmount={formatAmount}
          formatDisplayDate={formatDisplayDate}
          recordChanges={recordChanges}
          setAddWorkerDeductionDialogOpen={setAddWorkerDeductionDialogOpen}
          workerDeductions={workerDeductions}
        />
      </Tabs>

      <AdvanceReassignDialog
        target={reassignTarget}
        workers={workerStaff}
        companyId={selectedCompany?.id}
        apiRequest={modeApiRequest}
        onClose={() => setReassignTarget(null)}
      />

      {/* ── Add Advance Dialog ── */}
      <AdvancesTabDialogSection
        advanceDialogOpen={advanceDialogOpen}
        advanceForm={advanceForm}
        advanceMutation={advanceMutation}
        cashAccounts={cashAccounts}
        setAdvanceDialogOpen={setAdvanceDialogOpen}
        workerStaff={workerStaff}
      />

      {/* ── Add Worker Deduction Dialog ── */}
      <AddWorkerDeductionDialog
        open={addWorkerDeductionDialogOpen}
        onOpenChange={setAddWorkerDeductionDialogOpen}
        form={addWorkerDeductionForm}
        workerStaff={workerStaff}
        isPending={addWorkerDeductionMutation.isPending}
        onSubmit={(data) => addWorkerDeductionMutation.mutate(data)}
      />

      {/* ── Record Repayment Dialog ── */}
      <Dialog open={deductionDialogOpen} onOpenChange={setDeductionDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Repayment</DialogTitle>
            <DialogDescription>Manually record a repayment for {selectedAdvance?.employeeName}.</DialogDescription>
          </DialogHeader>
          <Form {...deductionForm}>
            <form onSubmit={deductionForm.handleSubmit((data) => deductionMutation.mutate(data))} className="space-y-4">
              <FormField
                control={deductionForm.control}
                name="deductionAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Repayment Amount</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-repayment-amount" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deductionForm.control}
                name="payrollMonth"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reference Month (YYYY-MM)</FormLabel>
                    <FormControl>
                      <Input type="month" {...field} data-testid="input-repayment-month" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={deductionMutation.isPending}
                data-testid="button-save-repayment"
              >
                {deductionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit Repayment
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
