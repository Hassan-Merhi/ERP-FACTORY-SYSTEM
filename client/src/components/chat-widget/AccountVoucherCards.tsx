import { useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoucherDraft } from "./chatWidgetTypes";
export { AccountQueryResultCard } from "./AccountQueryResultCard";

// ── Voucher Confirmation Card ────────────────────────────────────────
export function VoucherConfirmCard({
  draft,
  onConfirm,
  onDismiss,
  isSubmitting,
}: {
  draft: VoucherDraft;
  onConfirm: (edited: VoucherDraft) => void;
  onDismiss: () => void;
  isSubmitting: boolean;
}) {
  const [editDate, setEditDate] = useState(draft.date);
  const [editDesc, setEditDesc] = useState(draft.description);
  const [editEntries, setEditEntries] = useState(() =>
    draft.entries.map((e) => ({
      ...e,
      debitStr: e.debit > 0 ? String(e.debit) : "",
      creditStr: e.credit > 0 ? String(e.credit) : "",
    }))
  );

  const parsedEntries = editEntries.map((e) => ({
    ...e,
    debit: parseFloat(e.debitStr) || 0,
    credit: parseFloat(e.creditStr) || 0,
  }));
  const totalDebit = parsedEntries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = parsedEntries.reduce((s, e) => s + e.credit, 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

  const handleConfirmClick = () => {
    const edited: VoucherDraft = {
      ...draft,
      date: editDate,
      description: editDesc,
      entries: parsedEntries.map((e) => ({
        accountId: e.accountId,
        accountName: e.accountName,
        debit: e.debit,
        credit: e.credit,
        balanceBefore: e.balanceBefore,
      })),
    };
    onConfirm(edited);
  };

  const setEntryField = (i: number, field: "debitStr" | "creditStr", val: string) => {
    setEditEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, [field]: val } : e)));
  };

  const hasBalanceBefore = draft.entries.some((e) => e.balanceBefore !== undefined);

  return (
    <div
      className="mt-2 rounded-md border border-primary/30 bg-primary/5 overflow-hidden"
      data-testid="voucher-confirm-card"
    >
      <div className="px-3 py-2 bg-primary/10 flex items-center gap-2">
        <FileText className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-semibold text-primary">Create {draft.type} Voucher?</span>
      </div>
      <div className="px-3 py-2 space-y-1.5 text-xs">
        <div className="flex justify-between gap-2 text-muted-foreground items-center">
          <span className="shrink-0">Date</span>
          <input
            type="date"
            value={editDate}
            onChange={(e) => setEditDate(e.target.value)}
            className="text-xs font-medium text-foreground bg-background border rounded-sm px-1.5 py-0.5"
            data-testid="input-voucher-date"
          />
        </div>
        <div className="flex justify-between gap-2 text-muted-foreground items-center">
          <span className="shrink-0">Description</span>
          <input
            type="text"
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            className="flex-1 text-xs font-medium text-foreground bg-background border rounded-sm px-1.5 py-0.5 min-w-0"
            data-testid="input-voucher-desc"
          />
        </div>

        <div className="border-t pt-1.5 mt-0.5 space-y-1.5">
          <div
            className={`grid ${hasBalanceBefore ? "grid-cols-[1fr_60px_60px_60px]" : "grid-cols-[1fr_60px_60px]"} gap-2 text-[11px] font-semibold text-muted-foreground uppercase`}
          >
            <span>Account</span>
            {hasBalanceBefore && <span className="text-right">Balance</span>}
            <span className="text-right">Debit</span>
            <span className="text-right">Credit</span>
          </div>
          {editEntries.map((e, i) => (
            <div
              key={i}
              className={`grid ${hasBalanceBefore ? "grid-cols-[1fr_60px_60px_60px]" : "grid-cols-[1fr_60px_60px]"} gap-2 items-center`}
            >
              <span className="truncate" title={e.accountName}>
                {e.accountName}
              </span>
              {hasBalanceBefore && (
                <span className="text-right text-muted-foreground">
                  {e.balanceBefore !== undefined
                    ? e.balanceBefore.toLocaleString(undefined, { maximumFractionDigits: 0 })
                    : "—"}
                </span>
              )}
              <input
                type="number"
                value={e.debitStr}
                onChange={(ev) => setEntryField(i, "debitStr", ev.target.value)}
                className="w-full text-right text-xs bg-background border rounded-sm px-1 py-0.5"
                placeholder="0"
                data-testid={`input-debit-${i}`}
              />
              <input
                type="number"
                value={e.creditStr}
                onChange={(ev) => setEntryField(i, "creditStr", ev.target.value)}
                className="w-full text-right text-xs bg-background border rounded-sm px-1 py-0.5"
                placeholder="0"
                data-testid={`input-credit-${i}`}
              />
            </div>
          ))}
          <div
            className={`grid ${hasBalanceBefore ? "grid-cols-[1fr_60px_60px_60px]" : "grid-cols-[1fr_60px_60px]"} gap-2 pt-1 border-t font-semibold`}
          >
            <span>Total</span>
            {hasBalanceBefore && <span></span>}
            <span className={`text-right ${balanced ? "text-foreground" : "text-destructive"}`}>
              {totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={`text-right ${balanced ? "text-foreground" : "text-destructive"}`}>
              {totalCredit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
        {!balanced && (
          <p className="text-[11px] text-destructive text-right">Voucher must be balanced (Debit = Credit)</p>
        )}
      </div>
      <div className="px-3 py-2 border-t flex gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={onDismiss}
          disabled={isSubmitting}
          data-testid="button-dismiss-voucher"
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          onClick={handleConfirmClick}
          disabled={!balanced || isSubmitting}
          data-testid="button-confirm-voucher"
        >
          Confirm & Create
        </Button>
      </div>
    </div>
  );
}
