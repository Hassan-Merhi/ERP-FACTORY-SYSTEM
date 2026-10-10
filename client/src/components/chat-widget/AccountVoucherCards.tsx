import { useState } from "react";
import { useLocation } from "wouter";
import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountQueryResult, VoucherDraft } from "./chatWidgetTypes";

// ── Account Query Result Card ────────────────────────────────────────
export function AccountQueryResultCard({ result, onDismiss }: { result: AccountQueryResult; onDismiss: () => void }) {
  const [, setLocation] = useLocation();
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtAmt = (s: string | undefined) =>
    s ? parseFloat(s).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";

  const headerColor = "border-teal-500/30 bg-teal-500/5";
  const headerBg = "bg-teal-500/10";
  const textColor = "text-teal-700 dark:text-teal-400";

  const goToAccount = () => setLocation(`/accounts?accountId=${result.accountId}`);

  return (
    <div className={`mt-2 rounded-md border ${headerColor} overflow-hidden`} data-testid="account-query-result-card">
      <div className={`px-3 py-2 ${headerBg} flex items-center justify-between gap-2`}>
        <div className="flex items-center gap-2">
          <FileText className={`h-4 w-4 ${textColor} shrink-0`} />
          <span className={`text-sm font-semibold ${textColor}`}>
            {result.queryType === "balance" && `Balance: ${result.accountName}`}
            {result.queryType === "transactions" && `Transactions: ${result.accountName}`}
            {result.queryType === "balance_history" && `Balance History: ${result.accountName}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={goToAccount}
            data-testid="button-open-account"
          >
            Open
          </Button>
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {result.queryType === "balance" && (
        <div className="px-3 py-3">
          <p className="text-xs text-muted-foreground mb-1">Current Balance</p>
          <p
            className={`text-2xl font-bold ${(result.balance ?? 0) >= 0 ? "text-foreground" : "text-red-500 dark:text-red-400"}`}
          >
            {(result.balance ?? 0) < 0 ? "-" : ""}
            {fmt(Math.abs(result.balance ?? 0))}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {(result.balance ?? 0) >= 0 ? "Debit balance (Dr)" : "Credit balance (Cr)"}
          </p>
        </div>
      )}

      {result.queryType === "transactions" && (
        <div>
          {!result.transactions || result.transactions.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">No matching transactions found.</p>
          ) : (
            <div className="divide-y">
              {result.transactions.map((tx, i) => {
                const dr = parseFloat(tx.debitAmount || "0");
                const cr = parseFloat(tx.creditAmount || "0");
                const isDebit = dr > 0;
                const amt = isDebit ? dr : cr;
                return (
                  <div key={`${tx.voucherId}-${i}`} className="px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold">{tx.voucherNumber}</span>
                          <span className="text-[10px] text-muted-foreground bg-muted rounded-sm px-1 py-0.5">
                            {tx.voucherType}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {tx.description || tx.narration || "—"}
                        </p>
                        <span className="text-[10px] text-muted-foreground">{tx.voucherDate}</span>
                      </div>
                      <div className="text-right shrink-0">
                        <p
                          className={`text-xs font-semibold ${isDebit ? "text-red-500 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                        >
                          {isDebit ? "Dr" : "Cr"} {fmtAmt(String(amt))}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {result.queryType === "balance_history" && (
        <div>
          {!result.matches || result.matches.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              No point found where the balance was close to {fmt(result.targetBalance ?? 0)}.
            </p>
          ) : (
            <>
              <p className="px-3 pt-2 text-xs text-muted-foreground">
                Transactions where balance was ~{fmt(result.targetBalance ?? 0)}:
              </p>
              <div className="divide-y">
                {result.matches.map((m, i) => (
                  <div key={`${m.voucherId}-${i}`} className="px-3 py-2 flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-semibold">{m.voucherNumber}</span>
                        <span className="text-[10px] text-muted-foreground bg-muted rounded-sm px-1 py-0.5">
                          {m.voucherType}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{m.description || "—"}</p>
                      <span className="text-[10px] text-muted-foreground">{m.voucherDate}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-muted-foreground">Balance after</p>
                      <p className="text-xs font-semibold">{fmt(m.balanceAfter)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

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
            className={`grid ${hasBalanceBefore ? "grid-cols-[1fr_60px_60px_60px]" : "grid-cols-[1fr_60px_60px]"} gap-2 text-[10px] font-semibold text-muted-foreground uppercase`}
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
          <p className="text-[10px] text-destructive text-right">Voucher must be balanced (Debit = Credit)</p>
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
