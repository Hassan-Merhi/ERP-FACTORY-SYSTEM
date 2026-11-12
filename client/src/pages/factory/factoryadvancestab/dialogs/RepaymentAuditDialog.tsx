/**
 * RepaymentAuditDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useAdvancesModel } from "../advances/useAdvancesModel";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
import { Fragment } from "react";
import { Loader2, SearchCheck, CheckCircle2, AlertCircle } from "lucide-react";
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
import { fmt } from "../utils";

import type { AuditAdvance } from "../types";
export function RepaymentAuditDialog({
  auditCashBalance,
  auditData,
  auditLoading,
  cashAccounts,
  formatDate,
  refetchAudit,
  repayAuditForm,
  repayAuditMutation,
  repayAuditOpen,
  setRepayAuditForm,
  setRepayAuditOpen,
}: {
  auditCashBalance: AdvancesModel["auditCashBalance"];
  auditData: AdvancesModel["auditData"];
  auditLoading: AdvancesModel["auditLoading"];
  cashAccounts: AdvancesModel["cashAccounts"];
  formatDate: AdvancesModel["formatDate"];
  refetchAudit: AdvancesModel["refetchAudit"];
  repayAuditForm: AdvancesModel["repayAuditForm"];
  repayAuditMutation: AdvancesModel["repayAuditMutation"];
  repayAuditOpen: AdvancesModel["repayAuditOpen"];
  setRepayAuditForm: AdvancesModel["setRepayAuditForm"];
  setRepayAuditOpen: AdvancesModel["setRepayAuditOpen"];
}) {
  const recordChanges = useExistingRecordChangeAccess();
  return (
    <Dialog
      open={repayAuditOpen}
      onOpenChange={(open) => {
        setRepayAuditOpen(open);
        if (!open) setRepayAuditForm({ cashAccountId: "", repaymentDate: "" });
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Repayment Audit — Salary Deduction Advances</DialogTitle>
          <DialogDescription>
            Scans every Salary Deduction advance and finds ones where the cash account is missing an entry — either the
            voucher was deleted (Case A) or the advance was marked paid without any repayment record (Case B).
          </DialogDescription>
        </DialogHeader>

        {auditLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Scanning advances…
          </div>
        ) : !auditData ? null : (
          (() => {
            const { summary, advances: auditAdvances } = auditData;
            const missingTotal = auditAdvances.reduce((sum, advance) => {
              if (advance.caseType === "missing_voucher") {
                return (
                  sum +
                  advance.missingVoucherRepayments.reduce(
                    (repaymentSum, repayment) => repaymentSum + parseFloat(repayment.amount || "0"),
                    0
                  )
                );
              }
              return sum + parseFloat(advance.amount || "0");
            }, 0);

            const grouped: Record<string, AuditAdvance[]> = {};
            for (const a of auditAdvances) {
              const k = a.workerName || `Worker #${a.workerId}`;
              if (!grouped[k]) grouped[k] = [];
              grouped[k].push(a);
            }

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total Advances</p>
                    <p className="font-bold">{summary.total}</p>
                  </div>
                  <div className="rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Already OK</p>
                    <p className="font-bold text-green-700 dark:text-green-400">{summary.ok}</p>
                  </div>
                  <div className="rounded-md bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Missing Voucher</p>
                    <p className="font-bold text-amber-700 dark:text-amber-400">{summary.missingVoucher}</p>
                  </div>
                  <div className="rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">No Record</p>
                    <p className="font-bold text-red-700 dark:text-red-400">{summary.noRepayment}</p>
                  </div>
                </div>

                {auditAdvances.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                    <CheckCircle2 className="h-8 w-8 text-green-500" />
                    <p className="text-sm font-medium">All repayments are fully accounted for</p>
                    <p className="text-xs">Every paid advance has matching voucher entries on the cash account.</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>
                          Default Cash Account <span className="text-destructive">*</span>
                        </Label>
                        <Select
                          value={repayAuditForm.cashAccountId}
                          onValueChange={(v) => setRepayAuditForm((p) => ({ ...p, cashAccountId: v }))}
                        >
                          <SelectTrigger data-testid="select-audit-cash-account">
                            <SelectValue placeholder="Select cash account" />
                          </SelectTrigger>
                          <SelectContent>
                            {(cashAccounts || []).map((a) => (
                              <SelectItem key={a.id} value={String(a.id)}>
                                {a.name} ({a.code})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>
                          Default Repayment Date <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          type="date"
                          value={repayAuditForm.repaymentDate}
                          onChange={(e) => setRepayAuditForm((p) => ({ ...p, repaymentDate: e.target.value }))}
                          data-testid="input-audit-date"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground -mt-2">
                      Used for entries that have no existing date/account on record (No Record cases). Case A entries
                      use their original repayment data.
                    </p>

                    {repayAuditForm.cashAccountId && (
                      <div className="rounded-md border overflow-hidden text-sm">
                        <div className="px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground border-b">
                          Posting Impact — Journal: DR Factory Workers Salary Payable / CR Factory Worker Advances
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 divide-x">
                          <div className="px-4 py-3 text-center">
                            <p className="text-xs text-muted-foreground mb-1">Cash Account Balance</p>
                            <p className="font-mono font-bold">
                              {auditCashBalance ? fmt(parseFloat(auditCashBalance.balance)) : "…"}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">No change</p>
                          </div>
                          <div className="px-4 py-3 text-center">
                            <p className="text-xs text-muted-foreground mb-1">Factory Worker Advances</p>
                            <p className="font-mono font-bold text-green-700 dark:text-green-400">
                              −{fmt(missingTotal)}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">Decreases (CR)</p>
                          </div>
                          <div className="px-4 py-3 text-center">
                            <p className="text-xs text-muted-foreground mb-1">Workers Salary Payable</p>
                            <p className="font-mono font-bold text-amber-700 dark:text-amber-400">
                              −{fmt(missingTotal)}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">Decreases (DR)</p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="border rounded-md overflow-hidden">
                      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/20">
                        <span>Worker / Advance Date</span>
                        <span className="text-right">Amount</span>
                        <span className="text-right">Missing</span>
                        <span>Case</span>
                        <span>Status</span>
                      </div>
                      <div className="divide-y max-h-64 overflow-y-auto">
                        {Object.entries(grouped).map(([workerName, wAdvances]) => (
                          <Fragment key={workerName}>
                            <div className="px-4 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground">
                              {workerName}
                            </div>
                            {wAdvances.map((a) => {
                              const missingAmt =
                                a.caseType === "missing_voucher"
                                  ? a.missingVoucherRepayments.reduce(
                                      (sum, repayment) => sum + parseFloat(repayment.amount || "0"),
                                      0
                                    )
                                  : parseFloat(a.amount || "0");
                              return (
                                <div
                                  key={a.id}
                                  className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-4 py-2 text-sm items-center"
                                  data-testid={`row-audit-${a.id}`}
                                >
                                  <span className="text-xs text-muted-foreground pl-2">
                                    {formatDate(a.advanceDate)}
                                  </span>
                                  <span className="font-mono text-right text-xs">{fmt(a.amount)}</span>
                                  <span className="font-mono text-right font-medium">{fmt(missingAmt)}</span>
                                  <Badge variant="outline" className="text-xs">
                                    {a.caseType === "missing_voucher" ? "Case A" : "Case B"}
                                  </Badge>
                                  <AlertCircle className="h-4 w-4 text-amber-500" />
                                </div>
                              );
                            })}
                          </Fragment>
                        ))}
                      </div>
                      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 px-4 py-2 text-sm font-bold bg-muted/20 border-t">
                        <span>Total Missing</span>
                        <span></span>
                        <span className="font-mono text-right">{fmt(missingTotal)}</span>
                        <span></span>
                        <span></span>
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>
                        <span className="font-medium">Case A</span> — repayment record exists but voucher was deleted.
                        Will re-create the DR Cash / CR Advances voucher.
                      </p>
                      <p>
                        <span className="font-medium">Case B</span> — advance marked paid with no repayment record. Will
                        create both the repayment record and the voucher.
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })()
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => refetchAudit()}
            disabled={auditLoading}
            data-testid="button-audit-refresh"
          >
            {auditLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchCheck className="h-4 w-4" />}
          </Button>
          <Button variant="outline" onClick={() => setRepayAuditOpen(false)} data-testid="button-audit-cancel">
            Cancel
          </Button>
          {recordChanges.allowed && (
            <Button
              onClick={() => repayAuditMutation.mutate(repayAuditForm)}
              disabled={
                !auditData ||
                auditData.advances.length === 0 ||
                !repayAuditForm.cashAccountId ||
                !repayAuditForm.repaymentDate ||
                repayAuditMutation.isPending
              }
              data-testid="button-audit-confirm"
            >
              {repayAuditMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting…
                </>
              ) : (
                `Post Missing Entries — ${fmt(
                  auditData?.advances.reduce(
                    (sum, advance) =>
                      sum +
                      (advance.caseType === "missing_voucher"
                        ? advance.missingVoucherRepayments.reduce(
                            (repaymentSum, repayment) => repaymentSum + parseFloat(repayment.amount || "0"),
                            0
                          )
                        : parseFloat(advance.amount || "0")),
                    0
                  ) ?? 0
                )}`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
