import { Plus, Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import {
  FactoryWorkerBonusesTabDialogSection,
  useFactoryWorkerBonusesTabState,
} from "./useFactoryWorkerBonusesTabState";
import { FactoryWorkerBonusesTabContent, fmt } from "./FactoryWorkerBonusesTabContent";

export default function FactoryWorkerBonusesTab() {
  const {
    AdminDialog,
    addForm,
    addMutation,
    addOpen,
    bonuses,
    cashAccounts,
    deleteConfirm,
    deleteMutation,
    isLoading,
    payForm,
    payMutation,
    payOpen,
    pendingTotal,
    recordChanges,
    setAddForm,
    setAddOpen,
    setDeleteConfirm,
    setPayForm,
    setPayOpen,
    setStatusFilter,
    setWorkerFilter,
    statusFilter,
    workerFilter,
    workers,
    wrapAdminAction,
  } = useFactoryWorkerBonusesTabState();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Worker</Label>
            <Select value={workerFilter} onValueChange={setWorkerFilter}>
              <SelectTrigger className="w-44" data-testid="select-worker-filter">
                <SelectValue placeholder="All workers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Workers</SelectItem>
                {workers.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Status</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as React.SetStateAction<"all" | "pending" | "paid">)}
            >
              <SelectTrigger className="w-32" data-testid="select-bonus-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RowsExportMenu
            title="Worker Bonuses"
            rows={bonuses}
            columns={[
              { header: "Worker", value: (b) => b.workerName },
              { header: "Date", value: (b) => b.bonusDate },
              { header: "Amount (USD)", value: (b) => parseFloat(b.amount || "0"), type: "number" },
              {
                header: "Status",
                value: (b) => (b.status === "paid" ? "Paid" : b.status === "reversed" ? "Reversed" : "Pending"),
              },
              { header: "Notes", value: (b) => (b.notes || "") + (b.voucherId ? ` · Voucher #${b.voucherId}` : "") },
            ]}
            resource="factory.payroll"
            size="default"
            data-testid="button-export-worker-bonuses"
          />
          {recordChanges.canCreate("POST", "/api/factory/worker-bonuses") && (
            <Button onClick={() => setAddOpen(true)} data-testid="button-add-worker-bonus">
              <Plus className="h-4 w-4 mr-2" /> Add Bonus
            </Button>
          )}
        </div>
      </div>

      {!isLoading && pendingTotal > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
          <Gift className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-sm text-amber-800 dark:text-amber-200">
            Pending bonuses (unpaid): <strong>{fmt(pendingTotal)}</strong>
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : bonuses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Gift className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No bonuses recorded.</p>
          </CardContent>
        </Card>
      ) : (
        <FactoryWorkerBonusesTabContent
          bonuses={bonuses}
          recordChanges={recordChanges}
          setDeleteConfirm={setDeleteConfirm}
          setPayForm={setPayForm}
          setPayOpen={setPayOpen}
        />
      )}

      <FactoryWorkerBonusesTabDialogSection
        addForm={addForm}
        addMutation={addMutation}
        addOpen={addOpen}
        setAddForm={setAddForm}
        setAddOpen={setAddOpen}
        workers={workers}
        wrapAdminAction={wrapAdminAction}
      />

      <Dialog open={!!payOpen} onOpenChange={(o) => !o && setPayOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Bonus as Paid</DialogTitle>
            <DialogDescription>
              {payOpen && `Paying bonus of ${fmt(payOpen.amount)} to ${payOpen.workerName}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Payment Date</Label>
              <Input
                type="date"
                value={payForm.paidDate}
                onChange={(e) => setPayForm((f) => ({ ...f, paidDate: e.target.value }))}
                data-testid="input-pay-date"
              />
            </div>
            <div>
              <Label>Cash Account</Label>
              <Select
                value={payForm.cashAccountId}
                onValueChange={(v) => setPayForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-pay-account">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => payMutation.mutate(), "Pay Bonus")}
              disabled={payMutation.isPending || !payForm.cashAccountId}
              data-testid="button-confirm-pay-bonus"
            >
              {payMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Mark Paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Bonus</DialogTitle>
            <DialogDescription>
              Delete bonus of {deleteConfirm && fmt(deleteConfirm.amount)} for {deleteConfirm?.workerName}?
              {deleteConfirm?.status === "paid"
                ? " This bonus was paid — its accounting voucher and entries will be removed as well."
                : ""}
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
              data-testid="button-confirm-delete-worker-bonus"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
