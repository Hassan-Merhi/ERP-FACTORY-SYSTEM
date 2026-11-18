import { Loader2, PlayCircle, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  ERPRunPayrollViewSection,
  useERPRunPayrollViewState,
  type ERPRunPayrollViewProps,
} from "./ERPRunPayrollViewSection";
import {
  ERPRunPayrollViewDialogSection,
  ERPRunPayrollViewTabsContentSection,
} from "./ERPRunPayrollViewTabsContentSection";

export function ERPRunPayrollView(props: ERPRunPayrollViewProps) {
  const {
    activeTab,
    advanceBalanceByEmployee,
    canChangeExistingRecords,
    canCreate,
    cashAccounts,
    deleteRunId,
    deleteRunMutation,
    exportRunExcel,
    formatAmount,
    isLoading,
    payAccountId,
    payDialogRun,
    payRunMutation,
    payrollRuns,
    previewDate,
    previewItems,
    previewNotes,
    previewTotalBase,
    previewTotalNet,
    printRun,
    runsLoading,
    saveDraftMutation,
    setActiveTab,
    setDeleteRunId,
    setPayAccountId,
    setPayDialogRun,
    setPreviewDate,
    setPreviewNotes,
    setStep,
    setUndoRunId,
    undoRunId,
    undoRunMutation,
    updateDeduction,
  } = useERPRunPayrollViewState(props);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (v === "run" || v === "history") setActiveTab(v);
          setStep(1);
        }}
      >
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Payroll run sections">
            <TabsTrigger value="run" data-testid="tab-run-payroll">
              <PlayCircle className="h-4 w-4 mr-2" />
              Run Payroll
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-payroll-history">
              <History className="h-4 w-4 mr-2" />
              Payroll History
              {payrollRuns.filter((r) => r.status === "DRAFT").length > 0 && (
                <Badge variant="outline" className="ml-2 text-xs no-default-active-elevate">
                  {payrollRuns.filter((r) => r.status === "DRAFT").length} draft
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="run" className="mt-4">
          {/* Step 1 (worker selection) is CompactRunPayrollSelection; this view shows step 2. */}
          <ERPRunPayrollViewSection
            advanceBalanceByEmployee={advanceBalanceByEmployee}
            canCreate={canCreate}
            formatAmount={formatAmount}
            previewDate={previewDate}
            previewItems={previewItems}
            previewNotes={previewNotes}
            previewTotalBase={previewTotalBase}
            previewTotalNet={previewTotalNet}
            saveDraftMutation={saveDraftMutation}
            setPreviewDate={setPreviewDate}
            setPreviewNotes={setPreviewNotes}
            setStep={setStep}
            updateDeduction={updateDeduction}
          />
        </TabsContent>

        {/* ── TAB 2: Payroll History ──────────────────────────────────────── */}
        <ERPRunPayrollViewTabsContentSection
          canChangeExistingRecords={canChangeExistingRecords}
          exportRunExcel={exportRunExcel}
          formatAmount={formatAmount}
          payrollRuns={payrollRuns}
          printRun={printRun}
          runsLoading={runsLoading}
          setDeleteRunId={setDeleteRunId}
          setPayAccountId={setPayAccountId}
          setPayDialogRun={setPayDialogRun}
          setUndoRunId={setUndoRunId}
        />
      </Tabs>

      {/* ── Pay Dialog ─────────────────────────────────────────────────────── */}
      <ERPRunPayrollViewDialogSection
        cashAccounts={cashAccounts}
        formatAmount={formatAmount}
        payAccountId={payAccountId}
        payDialogRun={payDialogRun}
        payRunMutation={payRunMutation}
        setPayAccountId={setPayAccountId}
        setPayDialogRun={setPayDialogRun}
      />

      {/* ── Delete Confirmation ─────────────────────────────────────────────── */}
      <AlertDialog
        open={!!deleteRunId}
        onOpenChange={(open) => {
          if (!open) setDeleteRunId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This draft payroll run will be permanently deleted. No ledger entries were created for it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteRunId && deleteRunMutation.mutate(deleteRunId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteRunMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Undo Confirmation ───────────────────────────────────────────────── */}
      <AlertDialog
        open={!!undoRunId}
        onOpenChange={(open) => {
          if (!open) setUndoRunId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo Payroll Run?</AlertDialogTitle>
            <AlertDialogDescription>
              This will reverse the payroll payment — the ledger entries (salary expense and cash) will be removed, any
              advance deductions applied during this payroll will be restored, and the run will go back to draft status.
              This cannot be undone automatically; you will need to re-pay the run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => undoRunId && undoRunMutation.mutate(undoRunId)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-undo"
            >
              {undoRunMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Undo Payroll"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
