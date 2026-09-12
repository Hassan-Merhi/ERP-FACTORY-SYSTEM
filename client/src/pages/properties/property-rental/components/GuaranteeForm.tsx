import type { ClientErrorLike } from "@/lib/clientError";
/**
 * GuaranteeForm — extracted sub-component.
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import type { CashAccount, Contract, Payment } from "../types";
import { fmtMoneyCurrency } from "../utils";
import { useApiBase } from "../shared";
import { AccountSearchSelect } from "./AccountSearchSelect";

export // ──────────────────────────────────────────────────────────
// TAB 3: GUARANTEE TO STATEMENT
// ──────────────────────────────────────────────────────────
function GuaranteeForm({
  contract,
  cashAccounts,
  testIdPrefix,
  unitId,
  payments,
}: {
  contract: Contract;
  cashAccounts: CashAccount[];
  testIdPrefix: string;
  unitId: number;
  payments: Payment[];
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const tenantPays = apiBase.includes("/erp/") || apiBase.includes("/factory/");

  // Computed balances
  const totalGuarantee = parseFloat(contract.guaranteeAmount || "0");
  const usedAmount = parseFloat(contract.guaranteePostedAmount || "0");
  // remainingGuarantee: used by "Post to Statement" / "Move to Cash" sections only
  const remainingGuarantee = Math.max(0, totalGuarantee - usedAmount);
  const monthlyRent = parseFloat(contract.rentalAmount || "0");

  // Detect if any guarantee-applied payments exist (shows the undo section)
  const guaranteeAppliedPayments = payments.filter((p) => (p.notes ?? "").includes("[Guarantee applied]"));
  const hasGuaranteeApplied = guaranteeAppliedPayments.length > 0;
  const guaranteeAppliedTotal = guaranteeAppliedPayments.reduce((s, p) => s + parseFloat(String(p.amount || "0")), 0);

  // remainingForRent: independent of "Post to Statement" — tracks how much of the
  // guarantee has actually been applied as rent via payment records.
  const remainingForRent = Math.max(0, totalGuarantee - guaranteeAppliedTotal);

  // ── Post to Statement state ──
  const [postAmount, setPostAmount] = useState(contract.guaranteeAmount);
  const [postAccountId, setPostAccountId] = useState<string>("");
  const [postDate, setPostDate] = useState(new Date().toISOString().slice(0, 10));
  const [postNotes, setPostNotes] = useState("");

  // ── Move to Cash state ──
  const [moveAmount, setMoveAmount] = useState(remainingGuarantee.toFixed(2));
  const [moveAccountId, setMoveAccountId] = useState<string>("");
  const [moveDate, setMoveDate] = useState(new Date().toISOString().slice(0, 10));
  const [moveNotes, setMoveNotes] = useState("");

  // ── Apply as Rent state ── default to 1 month's rent (or remaining if less)
  const defaultRentChunk = Math.min(monthlyRent, remainingForRent).toFixed(2);
  const [rentAmount, setRentAmount] = useState(defaultRentChunk);
  const [rentDate, setRentDate] = useState(new Date().toISOString().slice(0, 10));
  const [rentNotes, setRentNotes] = useState("");
  const [undoConfirm, setUndoConfirm] = useState(false);

  const rentAmountNum = parseFloat(rentAmount || "0");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    queryClient.invalidateQueries({ queryKey: [apiBase + "/units", unitId, "detail"] });
  };

  const resetGuarantee = useMutation({
    mutationFn: () => apiRequest("DELETE", `${apiBase}/contracts/${contract.id}/guarantee-to-statement`, {}),
    onSuccess: () => {
      toast({ title: "Guarantee status reset" });
      invalidate();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const post = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${apiBase}/contracts/${contract.id}/guarantee-to-statement`, {
        amount: postAmount,
        cashAccountId: postAccountId ? parseInt(postAccountId) : null,
        paymentDate: postDate,
        notes: postNotes,
      }),
    onSuccess: () => {
      toast({ title: "Guarantee posted to statement" });
      invalidate();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const moveToCash = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${apiBase}/contracts/${contract.id}/guarantee-to-cash`, {
        amount: moveAmount,
        cashAccountId: parseInt(moveAccountId),
        paymentDate: moveDate,
        notes: moveNotes,
      }),
    onSuccess: () => {
      toast({ title: "Guarantee moved to cash successfully" });
      invalidate();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const applyToRent = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${apiBase}/contracts/${contract.id}/guarantee-to-rent`, {
        amount: rentAmount,
        paymentDate: rentDate,
        notes: rentNotes,
      }),
    onSuccess: () => {
      toast({ title: "Guarantee applied to rent", description: "Rent ledger updated. No cash moved." });
      invalidate();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const undoGuaranteeAsRent = useMutation({
    mutationFn: () => apiRequest("POST", `${apiBase}/contracts/${contract.id}/undo-guarantee-as-rent`, {}),
    onSuccess: async (res) => {
      const data = (await res.json()) as { reversed?: number };
      setUndoConfirm(false);
      toast({
        title: "Guarantee reversed",
        description: `${data.reversed} payment(s) removed. Rent months restored to unpaid.`,
      });
      invalidate();
    },
    onError: (e: ClientErrorLike) => {
      setUndoConfirm(false);
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4 pt-3">
      {/* Info bar */}
      <div className="bg-muted/40 rounded-md p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="text-muted-foreground">Total guarantee:</span>
          <span className="font-bold">{fmtMoneyCurrency(contract.guaranteeAmount, contract.currency)}</span>
          <Badge variant={contract.guaranteePostedToStatement ? "default" : "destructive"} className="text-xs">
            {contract.guaranteePostedToStatement ? "Active" : "Not Posted"}
          </Badge>
          {contract.guaranteePostedToStatement && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto text-xs"
              disabled={resetGuarantee.isPending}
              onClick={() => resetGuarantee.mutate()}
              data-testid={`button-${testIdPrefix}-guarantee-reset`}
            >
              {resetGuarantee.isPending ? "Resetting…" : "Reset Status"}
            </Button>
          )}
        </div>
        {usedAmount > 0 && (
          <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/40 text-xs">
            <div>
              <p className="text-muted-foreground">Total</p>
              <p className="font-semibold tabular-nums">{fmtMoneyCurrency(totalGuarantee, contract.currency)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">{hasGuaranteeApplied ? "Applied as rent" : "Used / Posted"}</p>
              <p className="font-semibold tabular-nums text-orange-600 dark:text-orange-400">
                {fmtMoneyCurrency(usedAmount, contract.currency)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Remaining</p>
              <p
                className={`font-semibold tabular-nums ${remainingGuarantee <= 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}`}
              >
                {fmtMoneyCurrency(remainingGuarantee, contract.currency)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 1: Post to Statement ── */}
      <div className="border rounded-md p-3 space-y-3">
        <p className="text-sm font-semibold">{tenantPays ? "Post Guarantee Paid" : "Post Guarantee to Statement"}</p>
        <p className="text-xs text-muted-foreground">
          {tenantPays ? (
            <>
              Records guarantee paid out: Dr Security Deposits Paid / Cr Cash.{" "}
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Select an account to create an accounting entry — without an account only the status badge is updated.
              </span>
            </>
          ) : (
            <>
              Records guarantee received: Dr Cash / Cr Tenant Deposits.{" "}
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Select an account to create an accounting entry — without an account only the status badge is updated.
              </span>
            </>
          )}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Amount ($)</Label>
            <Input
              type="number"
              step="0.01"
              value={postAmount}
              onChange={(e) => setPostAmount(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-post`}
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={postDate}
              onChange={(e) => setPostDate(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-date`}
            />
          </div>
          <div className="col-span-2">
            <Label>{tenantPays ? "Cash account (paid from)" : "Account (where deposit is held)"}</Label>
            <AccountSearchSelect
              accounts={cashAccounts}
              value={postAccountId}
              onChange={setPostAccountId}
              placeholder="Select account…"
              testId={`select-${testIdPrefix}-guarantee-cash`}
            />
          </div>
          <div className="col-span-2">
            <Label>Notes</Label>
            <Textarea
              rows={2}
              value={postNotes}
              onChange={(e) => setPostNotes(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-notes`}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => post.mutate()}
            disabled={!postAmount || post.isPending}
            data-testid={`button-${testIdPrefix}-post-guarantee`}
          >
            {post.isPending ? "Posting…" : "Post to Statement"}
          </Button>
        </div>
      </div>

      {/* ── Section 2: Move to Cash ── */}
      <div className="border rounded-md p-3 space-y-3">
        <p className="text-sm font-semibold">{tenantPays ? "Recover Guarantee" : "Move Guarantee to Cash"}</p>
        <p className="text-xs text-muted-foreground">
          {tenantPays
            ? "Recovers guarantee returned by landlord: Dr Cash / Cr Security Deposits Paid"
            : "Releases guarantee from Tenant Deposits: Dr Tenant Deposits / Cr Cash Account"}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Amount ($)</Label>
            <Input
              type="number"
              step="0.01"
              value={moveAmount}
              onChange={(e) => setMoveAmount(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-move-amount`}
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={moveDate}
              onChange={(e) => setMoveDate(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-move-date`}
            />
          </div>
          <div className="col-span-2">
            <Label>{tenantPays ? "Cash account (received into)" : "Target Cash Account"}</Label>
            <AccountSearchSelect
              accounts={cashAccounts}
              value={moveAccountId}
              onChange={setMoveAccountId}
              placeholder="Select cash account…"
              testId={`select-${testIdPrefix}-guarantee-move-cash`}
            />
          </div>
          <div className="col-span-2">
            <Label>Notes</Label>
            <Textarea
              rows={2}
              value={moveNotes}
              onChange={(e) => setMoveNotes(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-move-notes`}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => moveToCash.mutate()}
            disabled={!moveAmount || !moveAccountId || moveToCash.isPending}
            data-testid={`button-${testIdPrefix}-guarantee-move-cash`}
          >
            {moveToCash.isPending
              ? tenantPays
                ? "Recovering…"
                : "Moving…"
              : tenantPays
                ? "Recover to Cash"
                : "Move to Cash"}
          </Button>
        </div>
      </div>

      {/* ── Section 3: Apply as Rent ── */}
      <div className="border rounded-md p-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-semibold">Apply Guarantee as Rent</p>
          {remainingForRent > 0 && (
            <span className="text-xs text-muted-foreground">
              Remaining to apply:{" "}
              <span className="font-semibold text-green-600 dark:text-green-400">
                {fmtMoneyCurrency(remainingForRent, contract.currency)}
              </span>
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {tenantPays
            ? "Covers rent from the deposit — no cash moves. Dr Rent Expense / Cr Security Deposits Paid. Rent ledger marked paid."
            : "Covers rent from the deposit — no cash moves. Dr Tenant Deposits / Cr Rent Income. Rent ledger marked paid."}
        </p>
        {remainingForRent <= 0 && (
          <p className="text-xs font-medium text-destructive">
            Guarantee fully applied as rent — nothing left to apply.
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>Amount</Label>
              {remainingForRent > 0 && (
                <button
                  type="button"
                  className="text-xs text-primary underline"
                  onClick={() => setRentAmount(remainingForRent.toFixed(2))}
                  data-testid={`button-${testIdPrefix}-guarantee-rent-max`}
                >
                  Use all remaining
                </button>
              )}
            </div>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              max={remainingForRent}
              value={rentAmount}
              onChange={(e) => setRentAmount(e.target.value)}
              data-testid={`input-${testIdPrefix}-guarantee-rent-amount`}
            />
            {rentAmountNum > remainingForRent && remainingForRent > 0 && (
              <p className="text-xs text-destructive mt-1">
                Exceeds remaining balance of {fmtMoneyCurrency(remainingForRent, contract.currency)}
              </p>
            )}
          </div>
          <div>
            <Label>Apply from date</Label>
            <Input
              type="date"
              value={rentDate}
              onChange={(e) => setRentDate(e.target.value)}
              className="mt-1"
              data-testid={`input-${testIdPrefix}-guarantee-rent-date`}
            />
          </div>
          <div className="col-span-2">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              value={rentNotes}
              onChange={(e) => setRentNotes(e.target.value)}
              placeholder="e.g. Applied to cover arrears on departure"
              data-testid={`input-${testIdPrefix}-guarantee-rent-notes`}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => applyToRent.mutate()}
            disabled={
              !rentAmount ||
              !rentDate ||
              applyToRent.isPending ||
              remainingForRent <= 0 ||
              rentAmountNum > remainingForRent
            }
            data-testid={`button-${testIdPrefix}-guarantee-apply-rent`}
          >
            {applyToRent.isPending ? "Applying…" : "Apply as Rent"}
          </Button>
        </div>
      </div>

      {/* ── Section 4: Undo Guarantee Applied as Rent (only if it was done) ── */}
      {hasGuaranteeApplied && (
        <div className="border border-destructive/40 rounded-md p-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-destructive">Undo: Guarantee Applied as Rent</p>
            <Badge variant="destructive" className="text-xs">
              {guaranteeAppliedPayments.length} payment{guaranteeAppliedPayments.length !== 1 ? "s" : ""} — $
              {guaranteeAppliedTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            The guarantee was applied toward rent on {guaranteeAppliedPayments.length} month
            {guaranteeAppliedPayments.length !== 1 ? "s" : ""}. Clicking below will reverse all those payments, restore
            those months to unpaid, and reverse the accounting voucher entries. The guarantee deposit itself remains
            intact.
          </p>
          {!undoConfirm ? (
            <div className="flex justify-end">
              <Button
                variant="destructive"
                onClick={() => setUndoConfirm(true)}
                data-testid={`button-${testIdPrefix}-undo-guarantee-rent`}
              >
                Undo Guarantee as Rent
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 flex-wrap bg-destructive/10 rounded-md p-2">
              <p className="text-xs font-medium text-destructive">
                This will reverse {guaranteeAppliedPayments.length} payment(s) totalling $
                {guaranteeAppliedTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}. Are you sure?
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUndoConfirm(false)}
                  disabled={undoGuaranteeAsRent.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => undoGuaranteeAsRent.mutate()}
                  disabled={undoGuaranteeAsRent.isPending}
                  data-testid={`button-${testIdPrefix}-undo-guarantee-rent-confirm`}
                >
                  {undoGuaranteeAsRent.isPending ? "Reversing…" : "Yes, Reverse"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// TAB 4: END CONTRACT
// ──────────────────────────────────────────────────────────
