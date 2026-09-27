import {
  Plus,
  Trash2,
  Banknote,
  RotateCcw,
  BookOpen,
  Loader2,
  Users,
  CalendarDays,
  ChevronDown,
  SlidersHorizontal,
  SearchCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

export function AdvancesPanel({ model }: { model: ReturnType<typeof useAdvancesModel> }) {
  const {
    addOpen,
    setAddOpen,
    postAccountingOpen,
    setPostAccountingOpen,
    postCashAccountId,
    setPostCashAccountId,
    filterWorker,
    setFilterWorker,
    filterStatus,
    setFilterStatus,
    deleteTarget,
    setDeleteTarget,
    reverseTarget,
    setReverseTarget,
    selectedIds,
    setSelectedIds,
    bulkCashAccountId,
    setBulkCashAccountId,
    form,
    setForm,
    bulkOpen,
    setBulkOpen,
    bulkForm,
    setBulkForm,
    bulkAmounts,
    setBulkAmounts,
    bulkSelected,
    setBulkSelected,
    advances,
    isLoading,
    workers,
    cashAccounts,
    unvouchered,
    unvoucheredLoading,
    postAccountingMutation,
    repayByMonthOpen,
    setRepayByMonthOpen,
    repayByMonthForm,
    setRepayByMonthForm,
    repayByMonthExpanded,
    setRepayByMonthExpanded,
    repayingMonth,
    setRepayingMonth,
    confirmRepay,
    setConfirmRepay,
    repayByMonthMutation,
    cashAdjOpen,
    setCashAdjOpen,
    cashAdjForm,
    setCashAdjForm,
    cashAdjMutation,
    repayAuditOpen,
    setRepayAuditOpen,
    repayAuditForm,
    setRepayAuditForm,
    auditData,
    auditLoading,
    refetchAudit,
    auditCashBalance,
    repayAuditMutation,
    reconcileOpen,
    setReconcileOpen,
    reconcilePreview,
    reconcilePreviewLoading,
    reconcileMutation,
    createMutation,
    deleteMutation,
    reverseMutation,
    bulkMutation,
    bulkUpdateCashAccountMutation,
    filtered,
    stats,
    formatDate,
  } = model;
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
      <div className="flex flex-wrap items-center gap-3">
        <Select value={filterWorker} onValueChange={setFilterWorker}>
          <SelectTrigger className="w-48" data-testid="select-filter-worker">
            <SelectValue placeholder="All Workers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Workers</SelectItem>
            {(workers || []).map((w) => (
              <SelectItem key={w.id} value={String(w.id)}>
                {w.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-40" data-testid="select-filter-status">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="outstanding">Outstanding</SelectItem>
            <SelectItem value="paid">Fully Paid</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-advances-actions">
                Actions <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => setRepayByMonthOpen(true)} data-testid="button-repay-by-month">
                <CalendarDays className="h-4 w-4" />
                Repay by Month
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPostAccountingOpen(true)} data-testid="button-post-accounting">
                <BookOpen className="h-4 w-4" />
                Post Accounting
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRepayAuditOpen(true)} data-testid="button-repayment-audit">
                <SearchCheck className="h-4 w-4" />
                Repayment Audit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCashAdjOpen(true)} data-testid="button-cash-adjustment">
                <SlidersHorizontal className="h-4 w-4" />
                Cash Adjustment
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setReconcileOpen(true)} data-testid="button-reconcile-advances">
                <RotateCcw className="h-4 w-4" />
                Reconcile Balances
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-advance">
            <Users className="h-4 w-4 mr-2" />
            Bulk Advance
          </Button>
          <Button onClick={() => setAddOpen(true)} data-testid="button-add-advance">
            <Plus className="h-4 w-4 mr-2" />
            Add Advance
          </Button>
        </div>
      </div>

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
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <Select value={bulkCashAccountId} onValueChange={setBulkCashAccountId}>
              <SelectTrigger className="w-52" data-testid="select-bulk-cash-account">
                <SelectValue placeholder="Select cash account…" />
              </SelectTrigger>
              <SelectContent>
                {(cashAccounts || []).map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => bulkUpdateCashAccountMutation.mutate()}
              disabled={!bulkCashAccountId || bulkUpdateCashAccountMutation.isPending}
              data-testid="button-bulk-update-cash-account"
            >
              {bulkUpdateCashAccountMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Update Cash Account
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
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
                  <TableCell
                    className="py-3 text-right font-mono text-sm"
                    data-testid={`text-advance-amount-${adv.id}`}
                  >
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
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

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
