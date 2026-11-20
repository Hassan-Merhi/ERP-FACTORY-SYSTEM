import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import { Banknote, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fmt } from "../utils";
import { BulkAdvanceDialog } from "../dialogs/BulkAdvanceDialog";
import { RecordAdvanceDialog } from "../dialogs/RecordAdvanceDialog";
import { ReverseAdvanceDialog } from "../dialogs/ReverseAdvanceDialog";
import { RepaymentAuditDialog } from "../dialogs/RepaymentAuditDialog";
import { CashAccountAdjustmentDialog } from "../dialogs/CashAccountAdjustmentDialog";
import { RepayByMonthDialog } from "../dialogs/RepayByMonthDialog";
import { ConfirmRepaymentDialog } from "../dialogs/ConfirmRepaymentDialog";
import { PostAccountingPreviewDialog } from "../dialogs/PostAccountingPreviewDialog";
import { ReconcileBalancesDialog } from "../dialogs/ReconcileBalancesDialog";
import type { useAdvancesModel } from "./useAdvancesModel";
import { useAdvancesPanelState } from "./useAdvancesPanelState";
import { AdvancesPanelSection } from "./AdvancesPanelSection";
import { AdvancesPanelSection2 } from "./AdvancesPanelSection2";

export function AdvancesPanel(props: { model: ReturnType<typeof useAdvancesModel> }) {
  const {
    addOpen,
    advances,
    auditCashBalance,
    auditData,
    auditLoading,
    bulkAmounts,
    bulkCashAccountId,
    bulkForm,
    bulkMutation,
    bulkOpen,
    bulkSelected,
    bulkUpdateCashAccountMutation,
    canChangeExistingRecords,
    cashAccounts,
    cashAdjForm,
    cashAdjMutation,
    cashAdjOpen,
    confirmRepay,
    createMutation,
    deleteMutation,
    deleteTarget,
    filterStatus,
    filterWorker,
    filtered,
    form,
    formatDate,
    isLoading,
    postAccountingMutation,
    postAccountingOpen,
    postCashAccountId,
    reconcileMutation,
    reconcileOpen,
    reconcilePreview,
    reconcilePreviewLoading,
    refetchAudit,
    repayAuditForm,
    repayAuditMutation,
    repayAuditOpen,
    repayByMonthExpanded,
    repayByMonthForm,
    repayByMonthMutation,
    repayByMonthOpen,
    repayingMonth,
    reverseMutation,
    reverseTarget,
    selectedIds,
    setAddOpen,
    setBulkAmounts,
    setBulkCashAccountId,
    setBulkForm,
    setBulkOpen,
    setBulkSelected,
    setCashAdjForm,
    setCashAdjOpen,
    setConfirmRepay,
    setDeleteTarget,
    setFilterStatus,
    setFilterWorker,
    setForm,
    setPostAccountingOpen,
    setPostCashAccountId,
    setReconcileOpen,
    setRepayAuditForm,
    setRepayAuditOpen,
    setRepayByMonthExpanded,
    setRepayByMonthForm,
    setRepayByMonthOpen,
    setRepayingMonth,
    setReverseTarget,
    setSelectedIds,
    stats,
    unvouchered,
    unvoucheredLoading,
    workers,
  } = useAdvancesPanelState(props);
  return (
    <div className="space-y-5">
      {/* Stats pills */}
      <div className="flex flex-wrap gap-3">
        {isLoading ? (
          <>
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-10 w-44 rounded-lg" />
            <Skeleton className="h-10 w-32 rounded-lg" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Banknote className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Total Given</span>
              <span className="font-semibold font-mono" data-testid="text-advances-total-given">
                {fmt(stats.totalGiven)}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Banknote className="h-4 w-4 text-amber-500" />
              <span className="text-muted-foreground">Outstanding</span>
              <span
                className="font-semibold font-mono text-amber-600 dark:text-amber-400"
                data-testid="text-advances-outstanding"
              >
                {fmt(stats.totalOutstanding)}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Active</span>
              <span className="font-semibold" data-testid="text-advances-active-count">
                {stats.outstandingCount}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Filter + actions row */}
      <AdvancesPanelSection2
        canChangeExistingRecords={canChangeExistingRecords}
        filterStatus={filterStatus}
        filterWorker={filterWorker}
        filtered={filtered}
        formatDate={formatDate}
        setAddOpen={setAddOpen}
        setBulkOpen={setBulkOpen}
        setCashAdjOpen={setCashAdjOpen}
        setFilterStatus={setFilterStatus}
        setFilterWorker={setFilterWorker}
        setPostAccountingOpen={setPostAccountingOpen}
        setReconcileOpen={setReconcileOpen}
        setRepayAuditOpen={setRepayAuditOpen}
        setRepayByMonthOpen={setRepayByMonthOpen}
        workers={workers}
      />

      {/* Bulk action bar — visible when rows are selected */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/60 px-4 py-3">
          <span className="text-sm font-medium">
            {selectedIds.size} advance{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
            data-testid="button-clear-selection"
          >
            Clear
          </Button>
          {canChangeExistingRecords && (
            <div className="flex items-center gap-2 ml-auto flex-wrap">
              <UnifiedAccountPicker
                  options={(cashAccounts || []).map((a) => ({ value: String(a.id), name: a.name }))}
                  value={bulkCashAccountId}
                  onChange={setBulkCashAccountId}
                  placeholder={"Select cash account…"}
                  testId={"select-bulk-cash-account"}
                  className="w-52"
                  />
              <Button
                onClick={() => bulkUpdateCashAccountMutation.mutate()}
                disabled={!bulkCashAccountId || bulkUpdateCashAccountMutation.isPending}
                data-testid="button-bulk-update-cash-account"
              >
                {bulkUpdateCashAccountMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Update Cash Account
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <AdvancesPanelSection
        canChangeExistingRecords={canChangeExistingRecords}
        filterStatus={filterStatus}
        filterWorker={filterWorker}
        filtered={filtered}
        formatDate={formatDate}
        isLoading={isLoading}
        selectedIds={selectedIds}
        setDeleteTarget={setDeleteTarget}
        setReverseTarget={setReverseTarget}
        setSelectedIds={setSelectedIds}
      />

      <BulkAdvanceDialog
        bulkAmounts={bulkAmounts}
        bulkForm={bulkForm}
        bulkMutation={bulkMutation}
        bulkOpen={bulkOpen}
        bulkSelected={bulkSelected}
        cashAccounts={cashAccounts}
        setBulkAmounts={setBulkAmounts}
        setBulkForm={setBulkForm}
        setBulkOpen={setBulkOpen}
        setBulkSelected={setBulkSelected}
        workers={workers}
      />

      <RecordAdvanceDialog
        addOpen={addOpen}
        cashAccounts={cashAccounts}
        createMutation={createMutation}
        form={form}
        setAddOpen={setAddOpen}
        setForm={setForm}
        workers={workers}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Advance</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this advance of {fmt(deleteTarget?.amount)} for {deleteTarget?.workerName}
              ?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reverse Advance Dialog */}
      <ReverseAdvanceDialog
        reverseMutation={reverseMutation}
        reverseTarget={reverseTarget}
        setReverseTarget={setReverseTarget}
      />

      {/* ── Repayment Audit Dialog ── */}
      <RepaymentAuditDialog
        auditCashBalance={auditCashBalance}
        auditData={auditData}
        auditLoading={auditLoading}
        cashAccounts={cashAccounts}
        formatDate={formatDate}
        refetchAudit={refetchAudit}
        repayAuditForm={repayAuditForm}
        repayAuditMutation={repayAuditMutation}
        repayAuditOpen={repayAuditOpen}
        setRepayAuditForm={setRepayAuditForm}
        setRepayAuditOpen={setRepayAuditOpen}
      />

      {/* ── Cash Account Adjustment Dialog ── */}
      <CashAccountAdjustmentDialog
        cashAccounts={cashAccounts}
        cashAdjForm={cashAdjForm}
        cashAdjMutation={cashAdjMutation}
        cashAdjOpen={cashAdjOpen}
        setCashAdjForm={setCashAdjForm}
        setCashAdjOpen={setCashAdjOpen}
      />

      {/* ── Repay by Month Dialog ── */}
      <RepayByMonthDialog
        advances={advances}
        cashAccounts={cashAccounts}
        repayByMonthExpanded={repayByMonthExpanded}
        repayByMonthForm={repayByMonthForm}
        repayByMonthMutation={repayByMonthMutation}
        repayByMonthOpen={repayByMonthOpen}
        repayingMonth={repayingMonth}
        setConfirmRepay={setConfirmRepay}
        setRepayByMonthExpanded={setRepayByMonthExpanded}
        setRepayByMonthForm={setRepayByMonthForm}
        setRepayByMonthOpen={setRepayByMonthOpen}
        setRepayingMonth={setRepayingMonth}
      />

      {/* ── Confirm Repay Dialog ── */}
      <ConfirmRepaymentDialog
        cashAccounts={cashAccounts}
        confirmRepay={confirmRepay}
        repayByMonthForm={repayByMonthForm}
        repayByMonthMutation={repayByMonthMutation}
        setConfirmRepay={setConfirmRepay}
        setRepayingMonth={setRepayingMonth}
      />

      <PostAccountingPreviewDialog
        cashAccounts={cashAccounts}
        formatDate={formatDate}
        postAccountingMutation={postAccountingMutation}
        postAccountingOpen={postAccountingOpen}
        postCashAccountId={postCashAccountId}
        setPostAccountingOpen={setPostAccountingOpen}
        setPostCashAccountId={setPostCashAccountId}
        unvouchered={unvouchered}
        unvoucheredLoading={unvoucheredLoading}
      />

      {/* Reconcile confirmation dialog */}
      <ReconcileBalancesDialog
        formatDate={formatDate}
        reconcileMutation={reconcileMutation}
        reconcileOpen={reconcileOpen}
        reconcilePreview={reconcilePreview}
        reconcilePreviewLoading={reconcilePreviewLoading}
        setReconcileOpen={setReconcileOpen}
      />
    </div>
  );
}
