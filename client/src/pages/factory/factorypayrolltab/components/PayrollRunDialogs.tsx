import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { FactoryPayrollState } from "../useFactoryPayroll";
import { PayrollPreviewDialog } from "./PayrollPreviewDialog";

export function PayrollRunDialogs({ payroll }: { payroll: FactoryPayrollState }) {
  return (
    <>
      {/* Run Payroll Dialog */}
      <Dialog open={payroll.runOpen} onOpenChange={payroll.setRunOpen}>
        <DialogContent className="max-w-2xl flex flex-col max-h-[90vh]" data-testid="dialog-run-payroll">
          <DialogHeader className="shrink-0">
            <DialogTitle>Run Payroll</DialogTitle>
            <DialogDescription>
              Configure the payroll period and settings, then preview before generating.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 pr-1 min-h-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Period Start</Label>
                <Input
                  type="date"
                  value={payroll.runForm.periodStart}
                  onChange={(e) => payroll.setRunForm((f) => ({ ...f, periodStart: e.target.value }))}
                  data-testid="input-period-start"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Period End</Label>
                <Input
                  type="date"
                  value={payroll.runForm.periodEnd}
                  onChange={(e) => payroll.setRunForm((f) => ({ ...f, periodEnd: e.target.value }))}
                  data-testid="input-period-end"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Days Count (auto)</Label>
                <Input
                  type="number"
                  placeholder="Auto-calculated"
                  value={payroll.runForm.daysCount}
                  onChange={(e) => payroll.setRunForm((f) => ({ ...f, daysCount: e.target.value }))}
                  data-testid="input-days-count"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Bonus Per Worker</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={payroll.runForm.bonusPerWorker}
                  onChange={(e) => payroll.setRunForm((f) => ({ ...f, bonusPerWorker: e.target.value }))}
                  data-testid="input-bonus"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cash Account (optional, used at payment)</Label>
              <Select
                value={payroll.runForm.cashAccountId}
                onValueChange={(v) => payroll.setRunForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-cash-account">
                  <SelectValue placeholder="Select account (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {payroll.cashAccounts?.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} ({a.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Workers</Label>
              <div className="flex gap-3">
                <Button
                  variant={payroll.runForm.targetAll ? "default" : "outline"}
                  size="sm"
                  onClick={() => payroll.setRunForm((f) => ({ ...f, targetAll: true, pickedWorkerIds: [] }))}
                  data-testid="button-all-workers"
                >
                  All Active ({payroll.activeWorkers.length})
                </Button>
                <Button
                  variant={!payroll.runForm.targetAll ? "default" : "outline"}
                  size="sm"
                  onClick={() => payroll.setRunForm((f) => ({ ...f, targetAll: false }))}
                  data-testid="button-select-workers"
                >
                  Select Workers
                </Button>
              </div>
              {!payroll.runForm.targetAll && (
                <div className="max-h-40 overflow-y-auto border rounded-md p-2 space-y-1">
                  {payroll.activeWorkers.map((w) => (
                    <div key={w.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`worker-${w.id}`}
                        checked={payroll.runForm.pickedWorkerIds.includes(w.id)}
                        onCheckedChange={(v) =>
                          payroll.setRunForm((f) => ({
                            ...f,
                            pickedWorkerIds: v
                              ? [...f.pickedWorkerIds, w.id]
                              : f.pickedWorkerIds.filter((id) => id !== w.id),
                          }))
                        }
                        data-testid={`checkbox-worker-${w.id}`}
                      />
                      <label htmlFor={`worker-${w.id}`} className="text-sm cursor-pointer">
                        {w.fullName} — {w.position || "—"}
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes (optional)</Label>
              <Input
                value={payroll.runForm.notes}
                onChange={(e) => payroll.setRunForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. March 2026 payroll"
                data-testid="input-payroll-notes"
              />
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => payroll.setRunOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => payroll.previewMutation.mutate()}
              disabled={payroll.previewMutation.isPending}
              data-testid="button-preview-payroll"
            >
              <ChevronDown className="h-4 w-4 mr-2" />
              {payroll.previewMutation.isPending ? "Loading..." : "Preview"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Preview Dialog */}
      <PayrollPreviewDialog payroll={payroll} />
    </>
  );
}
