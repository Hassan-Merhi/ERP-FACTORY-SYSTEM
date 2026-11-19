/**
 * DeductionsView — extracted sub-component.
 *
 * Extracted from FactoryAdvancesTab.tsx during the Phase 4 god-file split.
 */
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FactoryWorker } from "@shared/schema";

import { fmt } from "../utils";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { useDeductionsViewState } from "./useDeductionsViewState";

export function DeductionsView() {
  const {
    recordChanges,
    formatDate,
    setAddOpen,
    addOpen,
    setDeleteTarget,
    deleteTarget,
    filterWorker,
    setFilterWorker,
    filterStatus,
    setFilterStatus,
    form,
    setForm,
    workers,
    isLoading,
    createMutation,
    deleteMutation,
    filtered,
    pendingTotal,
    pendingCount,
  } = useDeductionsViewState();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Pending Deductions</p>
            <p className="text-xl font-bold font-mono text-destructive">{fmt(pendingTotal)}</p>
            <p className="text-xs text-muted-foreground">{pendingCount} item(s) — applied at next payroll run</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {recordChanges.allowed && (
          <Button onClick={() => setAddOpen(true)} size="sm" data-testid="button-add-deduction">
            <Plus className="h-4 w-4 mr-1" />
            Add Deduction
          </Button>
        )}
        <Select value={filterWorker} onValueChange={setFilterWorker}>
          <SelectTrigger className="w-48" data-testid="select-filter-deduction-worker">
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
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-36" data-testid="select-filter-deduction-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="applied">Applied</SelectItem>
          </SelectContent>
        </Select>
        <RowsExportMenu
          title="Worker Deductions"
          rows={filtered}
          columns={[
            { header: "Worker", value: (d) => d.workerName },
            { header: "Date", value: (d) => formatDate(d.deductionDate) },
            { header: "Reason", value: (d) => d.reason },
            { header: "Amount (USD)", value: (d) => parseFloat(d.amount || "0"), type: "number" },
            { header: "Status", value: (d) => (d.applied ? "Applied" : "Pending") },
          ]}
          resource="factory.payroll"
          className="ml-auto"
          data-testid="button-export-deductions"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      No deductions found
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((d) => (
                    <TableRow key={d.id} data-testid={`row-deduction-${d.id}`}>
                      <TableCell className="font-medium" data-testid={`text-deduction-worker-${d.id}`}>
                        {d.workerName || "\u2014"}
                      </TableCell>
                      <TableCell data-testid={`text-deduction-date-${d.id}`}>{formatDate(d.deductionDate)}</TableCell>
                      <TableCell
                        className="text-muted-foreground max-w-[200px] truncate"
                        data-testid={`text-deduction-reason-${d.id}`}
                      >
                        {d.reason || "\u2014"}
                      </TableCell>
                      <TableCell
                        className="text-right font-mono text-destructive"
                        data-testid={`text-deduction-amount-${d.id}`}
                      >
                        {fmt(d.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={d.applied ? "secondary" : "outline"} className="text-xs">
                          {d.applied ? "Applied" : "Pending"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {recordChanges.allowed && !d.applied && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteTarget(d)}
                            data-testid={`button-delete-deduction-${d.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent data-testid="dialog-add-deduction">
          <DialogHeader>
            <DialogTitle>Add Worker Deduction</DialogTitle>
            <DialogDescription>
              This deduction will be applied when payroll is next generated for this worker.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Worker</Label>
              <Select value={form.workerId} onValueChange={(v) => setForm((f) => ({ ...f, workerId: v }))}>
                <SelectTrigger data-testid="select-deduction-worker">
                  <SelectValue placeholder="Select worker" />
                </SelectTrigger>
                <SelectContent>
                  {(workers as FactoryWorker[])
                    .filter((w) => w.active)
                    .map((w) => (
                      <SelectItem key={w.id} value={String(w.id)}>
                        {w.fullName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  data-testid="input-deduction-amount"
                />
              </div>
              <div className="space-y-1">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={form.deductionDate}
                  onChange={(e) => setForm((f) => ({ ...f, deductionDate: e.target.value }))}
                  data-testid="input-deduction-date"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Reason (optional)</Label>
              <Input
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="e.g. Uniform, equipment damage…"
                data-testid="input-deduction-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!form.workerId || !form.amount || !form.deductionDate || createMutation.isPending}
              data-testid="button-submit-deduction"
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Save Deduction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent data-testid="dialog-confirm-delete-deduction">
          <DialogHeader>
            <DialogTitle>Delete Deduction</DialogTitle>
            <DialogDescription>
              Delete the {fmt(deleteTarget?.amount)} deduction for {deleteTarget?.workerName}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteTarget && deleteMutation.mutate({ workerId: deleteTarget.workerId, id: deleteTarget.id })
              }
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-deduction"
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
