import { Users, ChevronDown, ChevronRight, Loader2, PlayCircle, Banknote, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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

import type { Employee } from "./types";
import { getAvatarColor, getInitials } from "./utils";
import {
  ERPRunPayrollViewSection,
  ERPRunPayrollViewSection2,
  useERPRunPayrollViewState,
  type ERPRunPayrollViewProps,
} from "./ERPRunPayrollViewSection";
import {
  ERPRunPayrollViewDialogSection,
  ERPRunPayrollViewTabsContentSection,
} from "./ERPRunPayrollViewTabsContentSection";
import { EmptyState } from "@/components/ui/page-state";

export function ERPRunPayrollView(props: ERPRunPayrollViewProps) {
  const {
    activeTab,
    advanceBalanceByEmployee,
    canChangeExistingRecords,
    canCreate,
    cashAccounts,
    deleteRunId,
    deleteRunMutation,
    enterPreview,
    expandedGroups,
    exportRunExcel,
    filtered,
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
    searchQuery,
    selectedWorkers,
    setActiveTab,
    setDeleteRunId,
    setPayAccountId,
    setPayDialogRun,
    setPreviewDate,
    setPreviewNotes,
    setSearchQuery,
    setStep,
    setUndoRunId,
    step,
    toggleGroup,
    toggleGroupSelection,
    toggleWorker,
    totalSelectedBase,
    undoRunId,
    undoRunMutation,
    ungroupedWorkers,
    updateDeduction,
    workerById,
    workerGroups,
    workers,
  } = useERPRunPayrollViewState(props);

  function renderWorkerCard(worker: Employee) {
    if (!filtered.has(worker.id)) return null;
    const fullName = [worker.firstName, worker.lastName].filter(Boolean).join(" ");
    const isSelected = selectedWorkers.has(worker.id);
    const advanceBalance = advanceBalanceByEmployee[worker.id] || 0;
    const salary = parseFloat(worker.monthlySalary || "0");
    return (
      <div
        key={worker.id}
        className={`cursor-pointer rounded-md transition-all ${isSelected ? "ring-2 ring-primary" : ""}`}
        onClick={() => toggleWorker(worker.id)}
        data-testid={`card-worker-${worker.id}`}
      >
        <Card className={`hover-elevate h-full ${isSelected ? "bg-primary/5" : ""}`}>
          <CardContent className="p-4 flex flex-col h-full">
            <div className="flex items-start justify-between mb-3">
              <Avatar className={`h-12 w-12 text-sm font-semibold ${getAvatarColor(fullName)}`}>
                <AvatarFallback className={getAvatarColor(fullName)}>{getInitials(fullName)}</AvatarFallback>
              </Avatar>
              <Badge variant={worker.active ? "default" : "secondary"} className="text-xs no-default-active-elevate">
                {worker.active ? "Active" : "Inactive"}
              </Badge>
            </div>
            <div className="flex-1">
              <p className="font-semibold text-sm leading-tight">{fullName}</p>
              {worker.department && <p className="text-xs text-muted-foreground mt-0.5">{worker.department}</p>}
            </div>
            <div className="mt-3 pt-3 border-t space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{formatAmount(salary)}</span>
              </div>
              {advanceBalance > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <Banknote className="h-3 w-3" />
                    Advance
                  </span>
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                    -{formatAmount(advanceBalance)}
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  function renderGroup(label: string, memberIds: number[], groupKey: number | string) {
    const visible = memberIds.filter((id) => filtered.has(id) && workerById[id]);
    if (visible.length === 0) return null;
    const isExpanded = expandedGroups[groupKey] ?? true;
    const allSel = visible.every((id) => selectedWorkers.has(id));
    const someSel = visible.some((id) => selectedWorkers.has(id));
    return (
      <div key={groupKey} className="space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => toggleGroup(groupKey)}
            className="flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors"
            data-testid={`group-toggle-${groupKey}`}
          >
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {label}
            <span className="text-xs font-normal text-muted-foreground">({visible.length})</span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            onClick={() => toggleGroupSelection(memberIds)}
            data-testid={`group-select-all-${groupKey}`}
          >
            {allSel ? "Deselect all" : someSel ? "Select rest" : "Select all"}
          </Button>
        </div>
        {isExpanded && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visible.map((id) => renderWorkerCard(workerById[id]))}
          </div>
        )}
      </div>
    );
  }

  const hasResults = workers.some((w) => filtered.has(w.id));

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
          {step === 1 ? (
            <>
              <ERPRunPayrollViewSection2
                enterPreview={enterPreview}
                formatAmount={formatAmount}
                previewDate={previewDate}
                searchQuery={searchQuery}
                selectedWorkers={selectedWorkers}
                setPreviewDate={setPreviewDate}
                setSearchQuery={setSearchQuery}
                totalSelectedBase={totalSelectedBase}
              />

              {!hasResults ? (
                <EmptyState
                  icon={Users}
                  title={searchQuery ? "No workers match your search" : "No active workers found"}
                  className="py-20"
                />
              ) : (
                <div className="space-y-6">
                  {workerGroups.map((group) =>
                    renderGroup(
                      group.name,
                      (group.members || []).map((m) => m.id),
                      group.id
                    )
                  )}
                  {ungroupedWorkers.filter((w) => filtered.has(w.id)).length > 0 &&
                    renderGroup(
                      "Ungrouped",
                      ungroupedWorkers.map((w) => w.id),
                      "ungrouped"
                    )}
                </div>
              )}
            </>
          ) : (
            /* ── Step 2: Preview & Save as Draft ───────────────────────── */
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
          )}
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
