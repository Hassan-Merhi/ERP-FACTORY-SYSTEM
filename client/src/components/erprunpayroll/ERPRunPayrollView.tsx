import {
  Users,
  Search,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Loader2,
  PlayCircle,
  Banknote,
  FileSpreadsheet,
  Printer,
  CheckCircle2,
  History,
  ArrowLeft,
  Trash2,
  ClipboardList,
  RotateCcw,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
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
import type { useERPRunPayrollModel } from "./useERPRunPayrollModel";

interface ERPRunPayrollViewProps {
  model: ReturnType<typeof useERPRunPayrollModel>;
}

export function ERPRunPayrollView({ model }: ERPRunPayrollViewProps) {
  const {
    activeTab,
    setActiveTab,
    searchQuery,
    setSearchQuery,
    expandedGroups,
    selectedWorkers,
    step,
    setStep,
    previewItems,
    previewDate,
    setPreviewDate,
    previewNotes,
    setPreviewNotes,
    payDialogRun,
    setPayDialogRun,
    payAccountId,
    setPayAccountId,
    deleteRunId,
    setDeleteRunId,
    undoRunId,
    setUndoRunId,
    migrateConfirmOpen,
    setMigrateConfirmOpen,
    migrateResult,
    setMigrateResult,
    payrollRuns,
    runsLoading,
    cashAccounts,
    workers,
    workerGroups,
    ungroupedWorkers,
    advanceBalanceByEmployee,
    filtered,
    workerById,
    toggleGroup,
    toggleWorker,
    toggleGroupSelection,
    enterPreview,
    updateDeduction,
    saveDraftMutation,
    payRunMutation,
    deleteRunMutation,
    undoRunMutation,
    migrateGroupExpensesMutation,
    printRun,
    exportRunExcel,
    isLoading,
    totalSelectedBase,
    previewTotalNet,
    previewTotalBase,
    formatAmount,
  } = model;

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
        <TabsList>
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

        <TabsContent value="run" className="mt-4">
          {step === 1 ? (
            <>
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="relative flex-1 min-w-52">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name, code, department..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                    data-testid="input-search-workers"
                  />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm whitespace-nowrap">Payroll Date</Label>
                    <Input
                      type="date"
                      value={previewDate}
                      onChange={(e) => setPreviewDate(e.target.value)}
                      className="w-40"
                      data-testid="input-payroll-date"
                    />
                  </div>
                  {selectedWorkers.size > 0 && (
                    <span className="text-sm text-muted-foreground">
                      {selectedWorkers.size} selected — {formatAmount(totalSelectedBase)}
                    </span>
                  )}
                  <Button
                    onClick={enterPreview}
                    disabled={selectedWorkers.size === 0}
                    data-testid="button-preview-payroll"
                  >
                    <ClipboardList className="h-4 w-4 mr-2" />
                    Preview Payroll ({selectedWorkers.size})
                  </Button>
                </div>
              </div>

              {!hasResults ? (
                <div className="text-center py-20 text-muted-foreground">
                  <Users className="mx-auto h-10 w-10 mb-3 opacity-40" />
                  <p className="font-medium">
                    {searchQuery ? "No workers match your search" : "No active workers found"}
                  </p>
                </div>
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
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)} data-testid="button-back-to-select">
                    <ArrowLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                  <h3 className="font-semibold text-sm">
                    Payroll Preview — {previewItems.length} worker{previewItems.length !== 1 ? "s" : ""}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => saveDraftMutation.mutate()}
                    disabled={saveDraftMutation.isPending || previewTotalNet <= 0}
                    data-testid="button-save-draft"
                  >
                    {saveDraftMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Save as Draft
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Payroll Date</Label>
                  <Input
                    type="date"
                    value={previewDate}
                    onChange={(e) => setPreviewDate(e.target.value)}
                    data-testid="input-preview-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Notes (optional)</Label>
                  <Input
                    placeholder="e.g. March 2026 payroll"
                    value={previewNotes}
                    onChange={(e) => setPreviewNotes(e.target.value)}
                    data-testid="input-preview-notes"
                  />
                </div>
              </div>

              <div className="border rounded-md overflow-x-auto">
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Worker</TableHead>
                      <TableHead className="text-muted-foreground text-xs font-medium">Group</TableHead>
                      <TableHead className="text-right">Base Salary</TableHead>
                      <TableHead className="text-right w-40">Advance Deduction</TableHead>
                      <TableHead className="text-right">Deductions</TableHead>
                      <TableHead className="text-right">Net Pay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewItems.map((it, idx) => {
                      const advBal = advanceBalanceByEmployee[it.employeeId] || 0;
                      return (
                        <TableRow key={idx} data-testid={`row-preview-${it.employeeId}`}>
                          <TableCell className="font-medium text-sm">{it.employeeName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{it.groupName}</TableCell>
                          <TableCell className="text-right text-sm">{formatAmount(it.baseSalary)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-col items-end gap-1">
                              <Input
                                type="number"
                                min="0"
                                max={String(it.baseSalary)}
                                step="0.01"
                                placeholder="0.00"
                                className="h-8 text-sm w-28 text-right"
                                value={it.deduction === 0 ? "" : it.deduction}
                                onChange={(e) => updateDeduction(idx, e.target.value)}
                                data-testid={`input-deduction-${it.employeeId}`}
                              />
                              {advBal > 0 &&
                                (() => {
                                  const remaining = advBal - it.deduction;
                                  return remaining > 0.005 ? (
                                    <span className="text-xs text-amber-600 dark:text-amber-400">
                                      Remaining: {formatAmount(remaining)}
                                    </span>
                                  ) : (
                                    <span className="text-xs text-green-600 dark:text-green-400">Fully deducted</span>
                                  );
                                })()}
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {it.pendingDeductions > 0 ? (
                              <span className="text-orange-600 dark:text-orange-400 font-mono">
                                -{formatAmount(it.pendingDeductions)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell
                            className="text-right font-semibold text-sm"
                            data-testid={`text-net-${it.employeeId}`}
                          >
                            {formatAmount(it.netPay)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="flex justify-end gap-6 text-sm text-muted-foreground px-1">
                <span>
                  Total Base: <span className="font-semibold text-foreground">{formatAmount(previewTotalBase)}</span>
                </span>
                <span>
                  Net Payable: <span className="font-semibold text-foreground">{formatAmount(previewTotalNet)}</span>
                </span>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── TAB 2: Payroll History ──────────────────────────────────────── */}
        <TabsContent value="history" className="mt-4">
          {runsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-md" />
              ))}
            </div>
          ) : payrollRuns.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">
              <History className="mx-auto h-10 w-10 mb-3 opacity-40" />
              <p className="font-medium">No payroll runs yet</p>
              <p className="text-sm mt-1">Select workers and run a payroll to get started.</p>
            </div>
          ) : (
            <>
              <div className="flex justify-end mb-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setMigrateConfirmOpen(true)}
                  disabled={migrateGroupExpensesMutation.isPending}
                  data-testid="button-migrate-group-expenses"
                >
                  {migrateGroupExpensesMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-2" />
                  )}
                  Fix Old Expense Accounts
                </Button>
              </div>
              <div className="border rounded-md overflow-x-auto">
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="text-right">Workers</TableHead>
                      <TableHead className="text-right">Total Base</TableHead>
                      <TableHead className="text-right">Net Payable</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payrollRuns.map((run) => (
                      <TableRow key={run.id} data-testid={`row-run-${run.id}`}>
                        <TableCell className="font-medium text-sm">{run.date}</TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-48 truncate">
                          {run.notes || "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm">{run.itemCount}</TableCell>
                        <TableCell className="text-right text-sm">{formatAmount(parseFloat(run.totalBase))}</TableCell>
                        <TableCell className="text-right font-semibold text-sm">
                          {formatAmount(parseFloat(run.totalNet))}
                        </TableCell>
                        <TableCell>
                          {run.status === "PAID" ? (
                            <Badge
                              variant="secondary"
                              className="bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 no-default-active-elevate"
                            >
                              Paid
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 no-default-active-elevate"
                            >
                              Draft
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => printRun(run)}
                              title="Print / PDF"
                              data-testid={`button-print-run-${run.id}`}
                            >
                              <Printer className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => exportRunExcel(run)}
                              title="Export Excel"
                              data-testid={`button-excel-run-${run.id}`}
                            >
                              <FileSpreadsheet className="h-4 w-4" />
                            </Button>
                            {run.status === "DRAFT" && (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    setPayDialogRun(run);
                                    setPayAccountId("");
                                  }}
                                  data-testid={`button-pay-run-${run.id}`}
                                >
                                  <DollarSign className="h-3.5 w-3.5 mr-1" />
                                  Pay
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setDeleteRunId(run.id)}
                                  className="text-destructive"
                                  title="Delete draft"
                                  data-testid={`button-delete-run-${run.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            {run.status === "PAID" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setUndoRunId(run.id)}
                                className="text-destructive"
                                title="Undo payroll — reverses ledger entries and advance deductions"
                                data-testid={`button-undo-run-${run.id}`}
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Pay Dialog ─────────────────────────────────────────────────────── */}
      <Dialog
        open={!!payDialogRun}
        onOpenChange={(open) => {
          if (!open) setPayDialogRun(null);
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-pay-run">
          <DialogHeader>
            <DialogTitle>Pay Payroll Draft</DialogTitle>
            <DialogDescription>
              This will create ledger entries and mark the payroll as paid. Net total:{" "}
              <strong>{payDialogRun ? formatAmount(parseFloat(payDialogRun.totalNet)) : ""}</strong>
            </DialogDescription>
          </DialogHeader>

          {payDialogRun && (
            <div className="space-y-4 py-2">
              <div className="rounded-md bg-muted/40 px-4 py-3 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Date</span>
                  <span className="font-medium">{payDialogRun.date}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Workers</span>
                  <span className="font-medium">{payDialogRun.itemCount}</span>
                </div>
                {payDialogRun.notes && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Notes</span>
                    <span className="font-medium">{payDialogRun.notes}</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Payment Account (Cash)</Label>
                <Select value={payAccountId} onValueChange={setPayAccountId}>
                  <SelectTrigger data-testid="select-pay-account">
                    <SelectValue placeholder="Select cash account" />
                  </SelectTrigger>
                  <SelectContent>
                    {cashAccounts.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No cash accounts found
                      </SelectItem>
                    ) : (
                      cashAccounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              {/* Worker breakdown */}
              <div className="border rounded-md overflow-hidden max-h-56 overflow-y-auto">
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Worker</TableHead>
                      <TableHead className="text-right text-xs">Base</TableHead>
                      <TableHead className="text-right text-xs">Deduction</TableHead>
                      <TableHead className="text-right text-xs">Net Pay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(payDialogRun.items || []).map((it, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="text-sm py-2">{it.employeeName}</TableCell>
                        <TableCell className="text-right text-sm py-2">
                          {formatAmount(parseFloat(it.baseSalary))}
                        </TableCell>
                        <TableCell className="text-right text-sm py-2 text-amber-600 dark:text-amber-400">
                          {parseFloat(it.deduction) > 0 ? `-${formatAmount(parseFloat(it.deduction))}` : "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm py-2 font-semibold">
                          {formatAmount(parseFloat(it.netPay))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPayDialogRun(null)} data-testid="button-cancel-pay">
              Cancel
            </Button>
            <Button
              onClick={() => payDialogRun && payRunMutation.mutate({ runId: payDialogRun.id, accountId: payAccountId })}
              disabled={payRunMutation.isPending || !payAccountId}
              data-testid="button-confirm-pay"
            >
              {payRunMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <DollarSign className="h-4 w-4 mr-2" />
                  Confirm Payment
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* ── Migrate Confirmation ─────────────────────────────────────────────── */}
      <AlertDialog
        open={migrateConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setMigrateConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fix Old Expense Accounts?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This one-time fix will scan all historical payroll records and reclassify any that used old-style
                  expense accounts:
                </p>
                <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
                  <li>
                    <strong>Worker payroll runs</strong> — split "Salary Expense" into "Salary Expense - {"{Group}"}"
                  </li>
                  <li>
                    <strong>Employee salary deposits</strong> — move "Payroll Deposit Expense" → "Salary Expense -{" "}
                    {"{Group}"}"
                  </li>
                  <li>
                    <strong>Employee bonuses</strong> — move "Salary Expense" (wrong) → "Bonus Expense - {"{Group}"}"
                  </li>
                </ul>
                <p className="text-muted-foreground">
                  Totals stay the same — only the expense account breakdown changes. Safe to run more than once.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => migrateGroupExpensesMutation.mutate()}
              data-testid="button-confirm-migrate"
            >
              {migrateGroupExpensesMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Fix Now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Migrate Result ───────────────────────────────────────────────────── */}
      <AlertDialog
        open={!!migrateResult}
        onOpenChange={(open) => {
          if (!open) setMigrateResult(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {migrateResult &&
              (migrateResult.migrated > 0 || migrateResult.depositsMigrated > 0 || migrateResult.bonusesMigrated > 0)
                ? "Records Updated"
                : "Check Complete"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {migrateResult && (
                  <>
                    {/* Worker payroll runs */}
                    <div>
                      <p className="font-medium mb-1">Worker Payroll Runs</p>
                      {migrateResult.total === 0 && (
                        <p className="text-muted-foreground">No paid payroll runs found.</p>
                      )}
                      {migrateResult.migrated > 0 && (
                        <p className="text-green-700 dark:text-green-400">
                          <strong>{migrateResult.migrated}</strong> run{migrateResult.migrated !== 1 ? "s" : ""} updated
                          to per-group expense accounts.
                        </p>
                      )}
                      {migrateResult.alreadyCorrect > 0 && (
                        <p className="text-muted-foreground">
                          <strong>{migrateResult.alreadyCorrect}</strong> already correct — no changes.
                        </p>
                      )}
                      {migrateResult.noGroups > 0 && (
                        <p className="text-muted-foreground">
                          <strong>{migrateResult.noGroups}</strong> kept as "Salary Expense" (workers have no group).
                        </p>
                      )}
                      {migrateResult.noVoucher > 0 && (
                        <p className="text-muted-foreground">
                          <strong>{migrateResult.noVoucher}</strong> skipped — no voucher found.
                        </p>
                      )}
                    </div>

                    {/* Employee deposits */}
                    <div>
                      <p className="font-medium mb-1">Employee Salary Deposits</p>
                      {migrateResult.depositsMigrated > 0 ? (
                        <p className="text-green-700 dark:text-green-400">
                          <strong>{migrateResult.depositsMigrated}</strong> deposit
                          {migrateResult.depositsMigrated !== 1 ? "s" : ""} moved to correct expense accounts.
                        </p>
                      ) : (
                        <p className="text-muted-foreground">
                          {migrateResult.depositsAlreadyCorrect > 0
                            ? `${migrateResult.depositsAlreadyCorrect} already correct.`
                            : "None found."}
                        </p>
                      )}
                    </div>

                    {/* Bonuses */}
                    <div>
                      <p className="font-medium mb-1">Employee Bonuses</p>
                      {migrateResult.bonusesMigrated > 0 ? (
                        <p className="text-green-700 dark:text-green-400">
                          <strong>{migrateResult.bonusesMigrated}</strong> bonus
                          {migrateResult.bonusesMigrated !== 1 ? "es" : ""} corrected — moved to per-group "Bonus
                          Expense" accounts.
                        </p>
                      ) : (
                        <p className="text-muted-foreground">
                          {migrateResult.bonusesAlreadyCorrect > 0
                            ? `${migrateResult.bonusesAlreadyCorrect} already correct.`
                            : "None found."}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setMigrateResult(null)} data-testid="button-close-migrate-result">
              Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
