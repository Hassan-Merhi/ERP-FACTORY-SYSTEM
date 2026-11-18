import { Loader2 } from "lucide-react";
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
import { fmt, useFactoryEmployeeBonusesTabState } from "./useFactoryEmployeeBonusesTabState";
import { FactoryEmployeeBonusesTabSection } from "./FactoryEmployeeBonusesTabSection";

export default function FactoryEmployeeBonusesTab() {
  const {
    AdminDialog,
    addForm,
    addMutation,
    addOpen,
    bonuses,
    deleteConfirm,
    deleteMutation,
    empFilter,
    employees,
    endDate,
    exportBonusesCsv,
    isLoading,
    recordChanges,
    search,
    setAddForm,
    setAddOpen,
    setDeleteConfirm,
    setEmpFilter,
    setEndDate,
    setSearch,
    setShowFilters,
    setStartDate,
    setVisibleColumns,
    showFilters,
    shownBonuses,
    startDate,
    totalBonuses,
    visibleColumns,
    wrapAdminAction,
  } = useFactoryEmployeeBonusesTabState();

  return (
    <div className="space-y-5">
      <FactoryEmployeeBonusesTabSection
        bonuses={bonuses}
        empFilter={empFilter}
        employees={employees}
        endDate={endDate}
        exportBonusesCsv={exportBonusesCsv}
        isLoading={isLoading}
        recordChanges={recordChanges}
        search={search}
        setAddOpen={setAddOpen}
        setDeleteConfirm={setDeleteConfirm}
        setEmpFilter={setEmpFilter}
        setEndDate={setEndDate}
        setSearch={setSearch}
        setShowFilters={setShowFilters}
        setStartDate={setStartDate}
        setVisibleColumns={setVisibleColumns}
        showFilters={showFilters}
        shownBonuses={shownBonuses}
        startDate={startDate}
        totalBonuses={totalBonuses}
        visibleColumns={visibleColumns}
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Employee Bonus</DialogTitle>
            <DialogDescription>
              The bonus amount will be immediately credited to the employee's account balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee</Label>
              <Select value={addForm.employeeId} onValueChange={(v) => setAddForm((f) => ({ ...f, employeeId: v }))}>
                <SelectTrigger data-testid="select-bonus-employee">
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
                  value={addForm.bonusDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, bonusDate: e.target.value }))}
                  data-testid="input-bonus-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={addForm.amount}
                  onChange={(e) => setAddForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-bonus-amount"
                />
              </div>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="e.g. Performance bonus Q1..."
                value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-bonus-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => addMutation.mutate(), "Credit Bonus")}
              disabled={addMutation.isPending || !addForm.employeeId || !addForm.amount}
              data-testid="button-confirm-add-bonus"
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Credit Bonus
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse Bonus</DialogTitle>
            <DialogDescription>
              This will reverse and delete the bonus of <strong>{deleteConfirm && fmt(deleteConfirm.amount)}</strong>{" "}
              for {deleteConfirm?.firstName} {deleteConfirm?.lastName}. The amount will be deducted from their account
              balance. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                wrapAdminAction(() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id), "Reverse Bonus")
              }
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-bonus"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Reverse Bonus
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
