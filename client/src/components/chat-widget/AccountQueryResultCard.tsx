// Extracted from ./AccountVoucherCards.tsx
import { useLocation } from "wouter";
import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountQueryResult } from "./chatWidgetTypes";

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
                          <span className="text-[11px] text-muted-foreground bg-muted rounded-sm px-1 py-0.5">
                            {tx.voucherType}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {tx.description || tx.narration || "—"}
                        </p>
                        <span className="text-[11px] text-muted-foreground">{tx.voucherDate}</span>
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
                        <span className="text-[11px] text-muted-foreground bg-muted rounded-sm px-1 py-0.5">
                          {m.voucherType}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{m.description || "—"}</p>
                      <span className="text-[11px] text-muted-foreground">{m.voucherDate}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-muted-foreground">Balance after</p>
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
