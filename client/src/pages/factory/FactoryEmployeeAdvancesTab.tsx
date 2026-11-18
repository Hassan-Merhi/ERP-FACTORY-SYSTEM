import { Plus, Banknote, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmt, fmtUsd } from "./FactoryEmployeeAdvancesTabTypes";
import { useFactoryEmployeeAdvancesTabState } from "./useFactoryEmployeeAdvancesTabState";
import { FactoryEmployeeAdvancesTabSection } from "./FactoryEmployeeAdvancesTabSection";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";

export default function FactoryEmployeeAdvancesTab() {
  const {
    refetch,
    isError,
    advancesData,
    addForm,
    addMutation,
    addOpen,
    advances,
    cashAccounts,
    deleteConfirm,
    deleteMutation,
    empFilter,
    employees,
    isLoading,
    recordChanges,
    repayForm,
    repayMutation,
    repayOpen,
    setAddForm,
    setAddOpen,
    setDeleteConfirm,
    setEmpFilter,
    setRepayForm,
    setRepayOpen,
    setStatusFilter,
    statusFilter,
    totalOutstanding,
  } = useFactoryEmployeeAdvancesTabState();

  return (
    <div className="space-y-5">
      {/* Filter + actions row */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={empFilter} onValueChange={setEmpFilter}>
          <SelectTrigger className="w-44" data-testid="select-emp-filter">
            <SelectValue placeholder="All employees" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Employees</SelectItem>
            {employees.map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>
                {e.firstName} {e.lastName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as React.SetStateAction<"open" | "all" | "paid">)}
        >
          <SelectTrigger className="w-36" data-testid="select-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="paid">Fully Paid</SelectItem>
          </SelectContent>
        </Select>
        {!isLoading && advances.some((a) => !a.fullyPaid) && (
          <div className="flex items-center gap-2 rounded-lg border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 px-3 py-1.5 text-sm">
            <Banknote className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-muted-foreground">Outstanding</span>
            <span className="font-semibold font-mono text-amber-700 dark:text-amber-300">
              {fmtUsd(totalOutstanding)}
            </span>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RowsExportMenu
            title="Employee Advances"
            rows={advances}
            columns={[
              { header: "Employee", value: (adv) => `${adv.firstName} ${adv.lastName}` },
              { header: "Date", value: (adv) => adv.advanceDate },
              { header: "Amount (USD)", value: (adv) => parseFloat(String(adv.amount ?? 0)), type: "number" },
              {
                header: "Remaining (USD)",
                value: (adv) => (adv.fullyPaid ? null : parseFloat(String(adv.remainingBalance ?? 0))),
                type: "number",
              },
              { header: "Status", value: (adv) => (adv.fullyPaid ? "Paid" : "Open") },
              { header: "Notes", value: (adv) => adv.notes },
            ]}
            resource="factory.payroll"
            size="default"
            data-testid="button-export-employee-advances"
          />
          {recordChanges.canCreate("POST", "/api/factory/employee-advances") && (
            <Button onClick={() => setAddOpen(true)} data-testid="button-add-advance">
              <Plus className="h-4 w-4 mr-2" /> Add Advance
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <FactoryEmployeeAdvancesTabSection
        refetch={refetch}
        isError={isError}
        advancesData={advancesData}
        advances={advances}
        empFilter={empFilter}
        isLoading={isLoading}
        recordChanges={recordChanges}
        setDeleteConfirm={setDeleteConfirm}
        setRepayForm={setRepayForm}
        setRepayOpen={setRepayOpen}
        statusFilter={statusFilter}
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Employee Advance</DialogTitle>
            <DialogDescription>Record an advance paid to an employee.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee</Label>
              <Select value={addForm.employeeId} onValueChange={(v) => setAddForm((f) => ({ ...f, employeeId: v }))}>
                <SelectTrigger data-testid="select-add-employee">
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.firstName} {e.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={addForm.advanceDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, advanceDate: e.target.value }))}
                  data-testid="input-advance-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={addForm.amount}
                  onChange={(e) => setAddForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-advance-amount"
                />
              </div>
            </div>
            <div>
              <Label>Cash Account (optional)</Label>
              <Select
                value={addForm.cashAccountId}
                onValueChange={(v) => setAddForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-cash-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes..."
                value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-advance-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !addForm.employeeId || !addForm.amount}
              data-testid="button-confirm-add-advance"
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Advance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!repayOpen} onOpenChange={(o) => !o && setRepayOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Repayment</DialogTitle>
            <DialogDescription>
              {repayOpen && `Advance of ${fmt(repayOpen.amount)} — Remaining: ${fmt(repayOpen.remainingBalance)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={repayForm.repaymentDate}
                  onChange={(e) => setRepayForm((f) => ({ ...f, repaymentDate: e.target.value }))}
                  data-testid="input-repay-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={repayForm.amount}
                  onChange={(e) => setRepayForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-repay-amount"
                />
              </div>
            </div>
            <div>
              <Label>Cash Account (optional)</Label>
              <Select
                value={repayForm.cashAccountId}
                onValueChange={(v) => setRepayForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes..."
                value={repayForm.notes}
                onChange={(e) => setRepayForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-repay-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepayOpen(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => repayMutation.mutate()}
              disabled={repayMutation.isPending || !repayForm.amount}
              data-testid="button-confirm-repay"
            >
              {repayMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Record Repayment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Advance</DialogTitle>
            <DialogDescription>
              This will permanently delete the advance of {deleteConfirm && fmt(deleteConfirm.amount)} for{" "}
              {deleteConfirm?.firstName} {deleteConfirm?.lastName} along with all repayments. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-advance"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
