import type { ClientErrorLike } from "@/lib/clientError";
/**
 * EndContractForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { CashAccount, Contract } from "../types";
import { fmtMoneyCurrency } from "../utils";
import { useApiBase } from "../shared";
import { AccountSearchSelect } from "./AccountSearchSelect";

export // ──────────────────────────────────────────────────────────
// TAB 4: END CONTRACT
// ──────────────────────────────────────────────────────────
function EndContractForm({
  contract,
  cashAccounts,
  testIdPrefix,
  onClose,
  unitId,
}: {
  contract: Contract;
  cashAccounts: CashAccount[];
  testIdPrefix: string;
  onClose: () => void;
  unitId: number;
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const tenantPays = apiBase.includes("/erp/") || apiBase.includes("/factory/");

  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [confirm, setConfirm] = useState(false);

  // Guarantee refund
  const totalGuarantee = parseFloat(contract.guaranteeAmount || "0");
  const usedAmount = parseFloat(contract.guaranteePostedAmount || "0");
  const remainingGuarantee = Math.max(0, totalGuarantee - usedAmount);
  const hasRemainingGuarantee = remainingGuarantee > 0.005;

  const [refundGuarantee, setRefundGuarantee] = useState(false);
  const [refundAmount, setRefundAmount] = useState(remainingGuarantee.toFixed(2));
  const [refundAccountId, setRefundAccountId] = useState("");
  const [refundNotes, setRefundNotes] = useState("");

  const end = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${apiBase}/contracts/${contract.id}/end`, {
        endDate,
        notes,
        refundGuarantee: refundGuarantee && hasRemainingGuarantee,
        refundAmount: refundGuarantee ? refundAmount : undefined,
        refundCashAccountId: refundGuarantee && refundAccountId ? parseInt(refundAccountId) : null,
        refundNotes: refundGuarantee ? refundNotes : undefined,
      }),
    onSuccess: () => {
      toast({
        title: "Contract ended",
        description: refundGuarantee
          ? `Unit vacated. Guarantee refund of ${fmtMoneyCurrency(refundAmount, contract.currency)} posted.`
          : "Unit is now vacant.",
      });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units", unitId, "detail"] });
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3 pt-3">
      <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-md p-3 text-sm">
        <p className="font-semibold text-red-700 dark:text-red-400">Warning — Ending the contract will:</p>
        <ul className="list-disc pl-5 mt-1 text-red-600 dark:text-red-400 text-xs">
          <li>Mark the unit as vacant</li>
          <li>Stop monthly auto-generation</li>
          <li>Remove future unpaid ledger rows beyond the end date</li>
          {refundGuarantee && refundAccountId && (
            <li className="text-orange-600 dark:text-orange-400">
              Post guarantee refund of {fmtMoneyCurrency(refundAmount, contract.currency)}
            </li>
          )}
        </ul>
      </div>

      <div>
        <Label>End Date *</Label>
        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          data-testid={`input-${testIdPrefix}-end-date`}
        />
      </div>
      <div>
        <Label>Notes</Label>
        <Textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          data-testid={`input-${testIdPrefix}-end-notes`}
        />
      </div>

      {/* Guarantee refund section — only shown if there's something to refund */}
      {hasRemainingGuarantee && (
        <div className="border rounded-md p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm font-semibold">Refund Guarantee on Departure</p>
              <p className="text-xs text-muted-foreground">
                Remaining:{" "}
                <span className="font-semibold text-green-600 dark:text-green-400">
                  {fmtMoneyCurrency(remainingGuarantee, contract.currency)}
                </span>
                {usedAmount > 0 && (
                  <span className="ml-2 text-muted-foreground">
                    ({fmtMoneyCurrency(usedAmount, contract.currency)} already applied as rent)
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`refund-guar-${contract.id}`}
                checked={refundGuarantee}
                onChange={(e) => setRefundGuarantee(e.target.checked)}
                data-testid={`check-${testIdPrefix}-refund-guarantee`}
              />
              <Label htmlFor={`refund-guar-${contract.id}`} className="cursor-pointer text-sm">
                Refund {fmtMoneyCurrency(remainingGuarantee, contract.currency)} now
              </Label>
            </div>
          </div>

          {refundGuarantee && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-border/40">
              <div>
                <Label>Refund amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  data-testid={`input-${testIdPrefix}-refund-amount`}
                />
              </div>
              <div className="sm:col-span-2">
                <Label>{tenantPays ? "Cash account (received back into)" : "Cash account (paid out from)"}</Label>
                <AccountSearchSelect
                  accounts={cashAccounts}
                  value={refundAccountId}
                  onChange={setRefundAccountId}
                  placeholder="Select account…"
                  testId={`select-${testIdPrefix}-refund-account`}
                />
                {refundGuarantee && !refundAccountId && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    No account selected — refund will be recorded without an accounting entry.
                  </p>
                )}
              </div>
              <div className="sm:col-span-2">
                <Label>Notes (optional)</Label>
                <Textarea
                  rows={2}
                  value={refundNotes}
                  onChange={(e) => setRefundNotes(e.target.value)}
                  placeholder="e.g. Returned by bank transfer"
                  data-testid={`input-${testIdPrefix}-refund-notes`}
                />
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground">
                  {tenantPays
                    ? "Posts: Dr Cash / Cr Security Deposits Paid — clears the asset and brings cash in."
                    : "Posts: Dr Tenant Deposits / Cr Cash — reduces the liability and pays out cash."}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`conf-${contract.id}`}
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
          data-testid={`check-${testIdPrefix}-confirm-end`}
        />
        <Label htmlFor={`conf-${contract.id}`} className="cursor-pointer">
          I confirm I want to end this contract
        </Label>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          onClick={() => end.mutate()}
          disabled={!confirm || end.isPending}
          data-testid={`button-${testIdPrefix}-end-contract`}
        >
          {end.isPending
            ? "Ending…"
            : refundGuarantee
              ? "End Contract & Refund Guarantee"
              : "End Contract & Vacate Unit"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// TAB: EDIT CONTRACT INFO
// ──────────────────────────────────────────────────────────
