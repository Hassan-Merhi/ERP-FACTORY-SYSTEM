import { CheckCircle2, Trash2, CalendarDays, Printer, Wrench, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDate } from "../utils";
import type { FactoryPayrollState } from "../useFactoryPayroll";

export function PayrollPaymentDialogs({ payroll }: { payroll: FactoryPayrollState }) {
  const {
    payOpen,
    setPayOpen,
    payTargetId,
    setPayTargetId,
    payCashAccountId,
    setPayCashAccountId,
    payPaymentDate,
    setPayPaymentDate,
    selectedIds,
    bulkPayOpen,
    setBulkPayOpen,
    bulkCashAccountId,
    setBulkCashAccountId,
    bulkPaymentDate,
    setBulkPaymentDate,
    deleteTargetId,
    setDeleteTargetId,
    undoTargetId,
    setUndoTargetId,
    deleteBatchGroup,
    setDeleteBatchGroup,
    repairOpen,
    setRepairOpen,
    repairResult,
    fixAcctOpen,
    setFixAcctOpen,
    fixAcctTargetId,
    setFixAcctTargetId,
    fixAcctCashId,
    setFixAcctCashId,
    paidPayrollIds,
    printSummaryOpen,
    setPrintSummaryOpen,
    attendanceDetail,
    setAttendanceDetail,
    payrolls,
    cashAccounts,
    markPaidMutation,
    bulkMarkPaidMutation,
    deleteMutation,
    undoMutation,
    batchDeleteMutation,
    repairMutation,
    fixAcctMutation,
    printSummaryPDF,
  } = payroll;
  return (
    <>
      {/* Attendance Detail Dialog */}
      <Dialog
        open={attendanceDetail !== null}
        onOpenChange={(open) => {
          if (!open) setAttendanceDetail(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-attendance-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              Attendance Details — {attendanceDetail?.name}
            </DialogTitle>
          </DialogHeader>
          {attendanceDetail && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              {attendanceDetail.presentDates.length === 0 &&
              attendanceDetail.absentDates.length === 0 &&
              attendanceDetail.halfDayDates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No attendance records for this period.</p>
              ) : (
                <>
                  {attendanceDetail.presentDates.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-green-700 dark:text-green-400 mb-1">
                        Present ({attendanceDetail.presentDates.length})
                      </p>
                      <div className="space-y-0.5">
                        {attendanceDetail.presentDates.map((e) => (
                          <div key={e.date} className="flex items-center justify-between text-sm py-0.5">
                            <span className="font-mono text-muted-foreground">{e.date}</span>
                            <Badge
                              variant="outline"
                              className="text-xs border-green-400 text-green-700 dark:text-green-400"
                            >
                              {e.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {attendanceDetail.halfDayDates.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">
                        Half Day ({attendanceDetail.halfDayDates.length})
                      </p>
                      <div className="space-y-0.5">
                        {attendanceDetail.halfDayDates.map((e) => (
                          <div key={e.date} className="flex items-center justify-between text-sm py-0.5">
                            <span className="font-mono text-muted-foreground">{e.date}</span>
                            <Badge
                              variant="outline"
                              className="text-xs border-amber-400 text-amber-700 dark:text-amber-400"
                            >
                              {e.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {attendanceDetail.absentDates.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1">
                        Absent ({attendanceDetail.absentDates.length})
                      </p>
                      <div className="space-y-0.5">
                        {attendanceDetail.absentDates.map((e) => (
                          <div key={e.date} className="flex items-center justify-between text-sm py-0.5">
                            <span className="font-mono text-muted-foreground">{e.date}</span>
                            <Badge variant="outline" className="text-xs border-red-400 text-red-700 dark:text-red-400">
                              {e.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttendanceDetail(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single Pay Dialog */}
      <Dialog
        open={payOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPayOpen(false);
            setPayTargetId(null);
          }
        }}
      >
        <DialogContent data-testid="dialog-mark-paid">
          <DialogHeader>
            <DialogTitle>Pay Worker</DialogTitle>
            <DialogDescription>
              Select the payment date and cash or bank account. This will settle the payroll liability.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Payment Date</Label>
              <Input
                type="date"
                value={payPaymentDate}
                onChange={(e) => setPayPaymentDate(e.target.value)}
                data-testid="input-pay-payment-date"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cash / Bank Account</Label>
              <Select value={payCashAccountId} onValueChange={setPayCashAccountId}>
                <SelectTrigger data-testid="select-pay-cash-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} ({a.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                payTargetId &&
                markPaidMutation.mutate({ id: payTargetId, cashId: payCashAccountId, paymentDate: payPaymentDate })
              }
              disabled={markPaidMutation.isPending || !payPaymentDate}
              data-testid="button-confirm-pay"
            >
              {markPaidMutation.isPending ? "Saving..." : "Confirm Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fix Accounting Dialog — generate missing voucher for old PAID payrolls */}
      <Dialog
        open={fixAcctOpen}
        onOpenChange={(open) => {
          if (!open) {
            setFixAcctOpen(false);
            setFixAcctTargetId(null);
          }
        }}
      >
        <DialogContent className="max-w-sm" data-testid="dialog-fix-accounting">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-amber-500" />
              Generate Accounting Entry
            </DialogTitle>
            <DialogDescription>
              This payroll was marked paid without recording a cash account. Select which account the money came from to
              generate the missing payment voucher.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Cash / Bank Account</Label>
              <Select value={fixAcctCashId} onValueChange={setFixAcctCashId}>
                <SelectTrigger data-testid="select-fix-cash-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} ({a.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFixAcctOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => fixAcctTargetId && fixAcctMutation.mutate({ id: fixAcctTargetId, cashId: fixAcctCashId })}
              disabled={fixAcctMutation.isPending || !fixAcctCashId}
              data-testid="button-confirm-fix-acct"
            >
              {fixAcctMutation.isPending ? "Generating..." : "Generate Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Pay Dialog */}
      <Dialog open={bulkPayOpen} onOpenChange={setBulkPayOpen}>
        <DialogContent data-testid="dialog-bulk-pay">
          <DialogHeader>
            <DialogTitle>Pay {selectedIds.size} Records</DialogTitle>
            <DialogDescription>
              Select the payment date and cash or bank account for this bulk payment. This settles the payroll liability
              for all selected workers.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Payment Date</Label>
              <Input
                type="date"
                value={bulkPaymentDate}
                onChange={(e) => setBulkPaymentDate(e.target.value)}
                data-testid="input-bulk-payment-date"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cash / Bank Account</Label>
              <Select value={bulkCashAccountId} onValueChange={setBulkCashAccountId}>
                <SelectTrigger data-testid="select-bulk-cash-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} ({a.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkPayOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => bulkMarkPaidMutation.mutate({ cashId: bulkCashAccountId, paymentDate: bulkPaymentDate })}
              disabled={bulkMarkPaidMutation.isPending || !bulkPaymentDate}
              data-testid="button-confirm-bulk-pay"
            >
              {bulkMarkPaidMutation.isPending ? "Processing..." : "Confirm Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Post-payment: Print Summary Dialog */}
      <Dialog open={printSummaryOpen} onOpenChange={setPrintSummaryOpen}>
        <DialogContent data-testid="dialog-print-summary">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              Payment Recorded
            </DialogTitle>
            <DialogDescription>
              {paidPayrollIds.length} worker{paidPayrollIds.length !== 1 ? "s" : ""} marked as paid. You can print a
              compact payment summary PDF.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrintSummaryOpen(false)}>
              Close
            </Button>
            <Button onClick={printSummaryPDF} data-testid="button-print-summary">
              <Printer className="h-4 w-4 mr-2" />
              Print Summary PDF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Undo Confirmation */}
      {(() => {
        const undoTarget = undoTargetId ? (payrolls || []).find((p) => p.id === undoTargetId) : null;
        const isPaid = undoTarget?.status === "PAID";
        return (
          <Dialog open={undoTargetId !== null} onOpenChange={(open) => !open && setUndoTargetId(null)}>
            <DialogContent data-testid="dialog-undo">
              <DialogHeader>
                <DialogTitle>Undo Payroll</DialogTitle>
                <DialogDescription>
                  {isPaid
                    ? "This will revert the payroll back to Draft, remove the payment record, and delete all related accounting entries. Advance deductions will also be restored."
                    : "This will delete the draft payroll and restore any advance deductions made at generation time."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setUndoTargetId(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => undoTargetId && undoMutation.mutate(undoTargetId)}
                  disabled={undoMutation.isPending}
                  data-testid="button-confirm-undo"
                >
                  {undoMutation.isPending ? "Undoing..." : "Undo"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* Batch Delete Confirmation */}
      <Dialog open={deleteBatchGroup !== null} onOpenChange={(open) => !open && setDeleteBatchGroup(null)}>
        <DialogContent data-testid="dialog-delete-batch">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete Entire Batch
            </DialogTitle>
            <DialogDescription>
              This will reverse all {deleteBatchGroup?.records.length} payroll record
              {deleteBatchGroup?.records.length !== 1 ? "s" : ""} for{" "}
              <strong>
                {deleteBatchGroup
                  ? `${fmtDate(deleteBatchGroup.periodStart, (d) => d.toString())} – ${fmtDate(deleteBatchGroup.periodEnd, (d) => d.toString())}`
                  : ""}
              </strong>
              . All payments will be undone, accounting entries deleted, and advance deductions restored.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteBatchGroup(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteBatchGroup && batchDeleteMutation.mutate(deleteBatchGroup)}
              disabled={batchDeleteMutation.isPending}
              data-testid="button-confirm-delete-batch"
            >
              {batchDeleteMutation.isPending ? "Deleting..." : "Delete Batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteTargetId !== null} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Payroll and Reverse Accounting</DialogTitle>
            <DialogDescription>
              This will reverse any posted payroll payment and associated journal entries, remove the payroll record, and restore its advance deductions. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTargetId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTargetId && deleteMutation.mutate(deleteTargetId)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Repair Ledger Dialog */}
      <Dialog
        open={repairOpen}
        onOpenChange={(open) => {
          if (!open) setRepairOpen(false);
        }}
      >
        <DialogContent data-testid="dialog-repair-ledger">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-green-600" />
              Repair Ledger
            </DialogTitle>
            <DialogDescription>
              This scans for payment vouchers that were left behind when payrolls were undone or advances were deleted —
              the ones making your cash account balance incorrect. It will permanently remove them from the ledger.
            </DialogDescription>
          </DialogHeader>

          {repairResult && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
              <p className="font-medium text-foreground">Repair complete</p>
              <p className="text-muted-foreground">
                Payroll payment vouchers removed:{" "}
                <span className="font-semibold text-foreground">{repairResult.deletedPayrollVouchers}</span>
              </p>
              <p className="text-muted-foreground">
                Advance payment vouchers removed:{" "}
                <span className="font-semibold text-foreground">{repairResult.deletedAdvanceVouchers}</span>
              </p>
              <p className="text-muted-foreground">
                Total removed: <span className="font-semibold text-foreground">{repairResult.total}</span>
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setRepairOpen(false)}>
              {repairResult ? "Close" : "Cancel"}
            </Button>
            {!repairResult && (
              <Button
                onClick={() => repairMutation.mutate()}
                disabled={repairMutation.isPending}
                data-testid="button-confirm-repair"
              >
                {repairMutation.isPending ? "Scanning & repairing..." : "Run Repair"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
