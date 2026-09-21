import { Calculator, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { FactoryWorkerFormFields } from "./FactoryWorkerFormFields";
import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
}

export function FactoryWorkersDialogs({ model }: FactoryWorkersModelProps) {
  const {
    createOpen,
    setCreateOpen,
    editingWorker,
    setEditingWorker,
    endContractWorker,
    setEndContractWorker,
    endStep,
    setEndStep,
    endStart,
    setEndStart,
    endEnd,
    setEndEnd,
    endCalculating,
    endResult,
    setEndResult,
    endCashAccountId,
    setEndCashAccountId,
    endSubmitting,
    cashAccounts,
    workers,
    categoryDialogOpen,
    setCategoryDialogOpen,
    editingCategory,
    catName,
    setCatName,
    catWorkerIds,
    createCatMutation,
    updateCatMutation,
    toggleCatWorker,
    handleSaveCategory,
    createMutation,
    updateMutation,
    resetForm,
    handleSubmit,
    handleCalculate,
    handleEndContract,
    balance,
  } = model;

  return (
    <>
      {/* Category dialog */}
      <Dialog
        open={categoryDialogOpen}
        onOpenChange={(open) => {
          if (!open) setCategoryDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-category-form">
          <DialogHeader>
            <DialogTitle>{editingCategory ? "Edit Category" : "New Category"}</DialogTitle>
            <DialogDescription>
              {editingCategory
                ? "Update the category name and worker assignments."
                : "Create a group of workers for easy filtering."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">Category Name *</Label>
              <Input
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                placeholder="e.g. Pressing Team A"
                data-testid="input-cat-name"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Workers</Label>
              <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
                {(workers ?? [])
                  .filter((w) => w.active || catWorkerIds.includes(w.id))
                  .map((w) => (
                    <label
                      key={w.id}
                      className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover-elevate ${!w.active ? "opacity-50" : ""}`}
                      data-testid={`label-cat-worker-${w.id}`}
                    >
                      <Checkbox
                        checked={catWorkerIds.includes(w.id)}
                        onCheckedChange={() => {
                          if (w.active || catWorkerIds.includes(w.id)) toggleCatWorker(w.id);
                        }}
                        disabled={!w.active && !catWorkerIds.includes(w.id)}
                        data-testid={`checkbox-cat-worker-${w.id}`}
                      />
                      <span className="text-sm flex-1">{w.fullName}</span>
                      {!w.active && (
                        <Badge variant="secondary" className="text-xs no-default-active-elevate">
                          Inactive
                        </Badge>
                      )}
                    </label>
                  ))}
                {(workers ?? []).filter((w) => w.active || catWorkerIds.includes(w.id)).length === 0 && (
                  <p className="text-sm text-muted-foreground px-3 py-4 text-center">No workers available</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {catWorkerIds.filter((id) => (workers ?? []).find((w) => w.id === id && w.active)).length} active
                workers selected. Inactive workers are automatically excluded.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryDialogOpen(false)} data-testid="button-cancel-cat">
              Cancel
            </Button>
            <Button
              onClick={handleSaveCategory}
              disabled={createCatMutation.isPending || updateCatMutation.isPending}
              data-testid="button-save-cat"
            >
              {createCatMutation.isPending || updateCatMutation.isPending
                ? "Saving..."
                : editingCategory
                  ? "Update"
                  : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOpen || editingWorker !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditingWorker(null);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="dialog-worker-form">
          <DialogHeader>
            <DialogTitle>{editingWorker ? "Edit Worker" : "Add Worker"}</DialogTitle>
            <DialogDescription>
              {editingWorker ? "Update worker details" : "Fill in the worker details below"}
            </DialogDescription>
          </DialogHeader>
          <FactoryWorkerFormFields model={model} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                setEditingWorker(null);
                resetForm();
              }}
              data-testid="button-cancel-worker"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="button-submit-worker"
            >
              {createMutation.isPending || updateMutation.isPending
                ? "Saving..."
                : editingWorker
                  ? "Update"
                  : "Add Worker"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={endContractWorker !== null}
        onOpenChange={(open) => {
          if (!open) setEndContractWorker(null);
        }}
      >
        <DialogContent data-testid="dialog-end-contract">
          <DialogHeader>
            <DialogTitle>End Contract — {endContractWorker?.fullName}</DialogTitle>
            <DialogDescription>
              {endStep === 1
                ? "Set the period to calculate the final settlement."
                : "Review the settlement and choose how to pay."}
            </DialogDescription>
          </DialogHeader>

          {endStep === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Period Start</Label>
                  <Input
                    type="date"
                    value={endStart}
                    onChange={(e) => setEndStart(e.target.value)}
                    data-testid="input-end-start"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Period End</Label>
                  <Input
                    type="date"
                    value={endEnd}
                    onChange={(e) => setEndEnd(e.target.value)}
                    data-testid="input-end-end"
                  />
                </div>
              </div>
              <Button
                onClick={handleCalculate}
                disabled={endCalculating || !endStart || !endEnd}
                className="w-full"
                data-testid="button-calculate-settlement"
              >
                <Calculator className="h-4 w-4 mr-2" />
                {endCalculating ? "Calculating..." : "Calculate Settlement"}
              </Button>
            </div>
          )}

          {endStep === 2 && endResult && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-md border p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Earned</p>
                  <p className="font-semibold text-sm" data-testid="text-settlement-earned">
                    ${parseFloat(endResult.earned).toFixed(2)}
                  </p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Already Paid</p>
                  <p className="font-semibold text-sm" data-testid="text-settlement-paid">
                    ${parseFloat(endResult.paid).toFixed(2)}
                  </p>
                </div>
                <div
                  className={`rounded-md border p-3 text-center ${parseFloat(endResult.advances) > 0 ? "border-orange-300 bg-orange-50 dark:bg-orange-900/20" : ""}`}
                >
                  <p className="text-xs text-muted-foreground mb-1">Advances</p>
                  <p className="font-semibold text-sm" data-testid="text-settlement-advances">
                    ${parseFloat(endResult.advances).toFixed(2)}
                  </p>
                </div>
                <div
                  className={`rounded-md border p-3 text-center ${balance > 0 ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20" : "border-green-300 bg-green-50 dark:bg-green-900/20"}`}
                >
                  <p className="text-xs text-muted-foreground mb-1">Balance Owed</p>
                  <p className="font-semibold text-sm" data-testid="text-settlement-balance">
                    ${balance.toFixed(2)}
                  </p>
                </div>
              </div>

              {balance > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs">Cash Account (for Pay Now)</Label>
                  <Select value={endCashAccountId} onValueChange={setEndCashAccountId}>
                    <SelectTrigger data-testid="select-end-cash-account">
                      <SelectValue placeholder="Select account..." />
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
              )}

              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setEndStep(1);
                    setEndResult(null);
                  }}
                  data-testid="button-back-step"
                >
                  <X className="h-4 w-4" />
                </Button>
                {balance > 0 ? (
                  <>
                    <Button
                      className="flex-1"
                      onClick={() => handleEndContract(true)}
                      disabled={endSubmitting || !endCashAccountId}
                      data-testid="button-pay-now"
                    >
                      {endSubmitting ? "Processing..." : `Pay Now $${balance.toFixed(2)}`}
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => handleEndContract(false)}
                      disabled={endSubmitting}
                      data-testid="button-pay-later"
                    >
                      Pay Later — End Contract
                    </Button>
                  </>
                ) : (
                  <Button
                    className="flex-1"
                    onClick={() => handleEndContract(false)}
                    disabled={endSubmitting}
                    data-testid="button-end-contract-confirm"
                  >
                    {endSubmitting ? "Processing..." : "End Contract"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
