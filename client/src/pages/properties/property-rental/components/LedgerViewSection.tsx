// Extracted from ./LedgerView.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";
import { fmtMoneyCurrency, MONTH_NAMES } from "../utils";
import { useLedgerViewState } from "./useLedgerViewState";

export function LedgerViewSection({
  apiBase,
  balance,
  contract,
  isAdmin,
  ledger,
  ledgerCards,
  readOnly,
  reverseAccrual,
  totalExpected,
  totalPaid,
}: Pick<
  ReturnType<typeof useLedgerViewState>,
  | "apiBase"
  | "balance"
  | "contract"
  | "isAdmin"
  | "ledger"
  | "ledgerCards"
  | "readOnly"
  | "reverseAccrual"
  | "totalExpected"
  | "totalPaid"
>) {
  return (
    <div className="border rounded-md overflow-hidden">
      <table className="w-full text-sm" {...ledgerCards.tableProps}>
        <thead className="bg-muted/50 text-xs uppercase">
          <tr>
            <th className="text-left px-3 py-2">Month</th>
            <th className="text-right px-3 py-2">Expected</th>
            <th className="text-right px-3 py-2">Paid</th>
            <th className="text-right px-3 py-2">Outstanding</th>
            <th className="text-left px-3 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {ledger.map((r) => {
            // FIX #7: prefer backend-calculated fields, fall back to frontend estimation.
            // Use allPostedPaid (no date filter) for the PAID column so future-dated posted
            // payments are not hidden by the asOf cutoff.
            const isDue = r.isDue !== undefined ? r.isDue : true;
            const paid =
              r.allPostedPaid ?? (r.effectivePaidAmount !== undefined ? r.effectivePaidAmount : Number(r.paidAmount));
            const expected = r.expectedAsOf !== undefined ? r.expectedAsOf : isDue ? Number(r.expectedAmount) : 0;
            const outstanding = Math.max(0, expected - paid);
            const credit = Math.max(0, paid - expected);
            const statusLabel = r.status;
            const showAsCreditRow = !isDue && paid > 0.005;
            return (
              <tr key={r.id} className="border-t" data-testid={`row-ledger-${r.year}-${r.month}`}>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span>
                      {MONTH_NAMES[r.month]} {r.year}
                    </span>
                    {!isDue && (
                      <span className="text-[11px] text-muted-foreground italic">{statusLabel ?? "not due"}</span>
                    )}
                    {isDue && credit > 0.005 && (
                      <span className="text-[11px] text-green-600 dark:text-green-400 font-medium">+credit</span>
                    )}
                    {statusLabel === "SCHEDULED" && (
                      <Badge variant="outline" className="text-[11px] border-amber-500 text-amber-600">
                        Scheduled
                      </Badge>
                    )}
                    {r.accrualVoucherId && (
                      <>
                        <Badge
                          variant="secondary"
                          className="text-[11px]"
                          data-testid={`badge-accrued-${r.year}-${r.month}`}
                        >
                          Accrued
                        </Badge>
                        {isAdmin && !readOnly && apiBase.includes("/erp/") && paid < 0.005 && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Reverse this accrual (posts Dr Accrued Rent Payable / Cr Rent Expense)"
                            onClick={(e) => {
                              e.stopPropagation();
                              reverseAccrual.mutate(r.id);
                            }}
                            disabled={reverseAccrual.isPending && reverseAccrual.variables === r.id}
                            data-testid={`button-reverse-accrual-${r.year}-${r.month}`}
                          >
                            <RotateCcw className="h-3 w-3" />
                          </Button>
                        )}
                      </>
                    )}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {isDue ? fmtMoneyCurrency(expected, contract.currency) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoneyCurrency(paid, contract.currency)}</td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums font-semibold ${outstanding > 0.005 ? "text-red-600 dark:text-red-400" : credit > 0.005 || showAsCreditRow ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                >
                  {credit > 0.005 || showAsCreditRow
                    ? `${fmtMoneyCurrency(showAsCreditRow ? paid : credit, contract.currency)} CR`
                    : fmtMoneyCurrency(outstanding, contract.currency)}
                </td>
                <td
                  className="px-3 py-1.5 text-xs text-muted-foreground"
                  data-mobile-cell={r.notes ? undefined : "hidden"}
                >
                  {r.notes || ""}
                </td>
              </tr>
            );
          })}
          <tr className="border-t-2 bg-muted/30 font-semibold">
            <td className="px-3 py-2">
              TOTALS <span className="font-normal text-[11px] text-muted-foreground">(as of today)</span>
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyCurrency(totalExpected, contract.currency)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyCurrency(totalPaid, contract.currency)}</td>
            <td
              className={`px-3 py-2 text-right tabular-nums ${balance > 0 ? "text-red-600 dark:text-red-400" : balance < 0 ? "text-green-600 dark:text-green-400" : ""}`}
            >
              {balance < 0
                ? `${fmtMoneyCurrency(Math.abs(balance), contract.currency)} CR`
                : fmtMoneyCurrency(balance, contract.currency)}
            </td>
            <td data-mobile-cell="hidden"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
