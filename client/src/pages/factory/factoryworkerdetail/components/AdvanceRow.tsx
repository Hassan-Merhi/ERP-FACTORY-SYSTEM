/**
 * AdvanceRow — extracted sub-component.
 *
 * Extracted from FactoryWorkerDetail.tsx during the Phase 4 god-file split.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AdvanceRowProps, CashAccount } from "../types";

export function AdvanceRow({ adv, isLoan, isExpanded, onToggleExpand, onRepay, formatDate, fmt }: AdvanceRowProps) {
  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    enabled: isLoan && isExpanded,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  interface AdvanceRepaymentRow {
    id: number;
    amount: string | null;
    repaymentDate: string;
    cashAccountId?: number | null;
    notes?: string | null;
  }

  const { data: repayments } = useQuery<AdvanceRepaymentRow[]>({
    queryKey: ["/api/factory/advances", adv.id, "repayments"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/advances/${adv.id}/repayments`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isLoan && isExpanded,
  });

  const cashAccountMap = new Map((cashAccounts || []).map((a) => [a.id, a.name]));

  const repaymentsWithRunningBalance = (repayments || [])
    .slice()
    .sort((a, b) => new Date(a.repaymentDate).getTime() - new Date(b.repaymentDate).getTime())
    .reduce<Array<AdvanceRepaymentRow & { balanceAfter: number }>>((acc, r) => {
      const prevBal = acc.length > 0 ? acc[acc.length - 1].balanceAfter : parseFloat(adv.amount || "0");
      const balAfter = prevBal - parseFloat(r.amount || "0");
      acc.push({ ...r, balanceAfter: Math.max(0, balAfter) });
      return acc;
    }, [])
    .reverse();

  return (
    <>
      <TableRow data-testid={`row-worker-advance-${adv.id}`}>
        <TableCell className="px-2">
          {isLoan && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onToggleExpand}
              data-testid={`button-expand-advance-${adv.id}`}
            >
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          )}
        </TableCell>
        <TableCell>{formatDate(adv.advanceDate)}</TableCell>
        <TableCell className="text-right font-mono">{fmt(adv.amount)}</TableCell>
        <TableCell className="text-right font-mono">{fmt(adv.remainingBalance)}</TableCell>
        <TableCell>
          <Badge
            variant="outline"
            className={
              isLoan
                ? "border-blue-400 text-blue-700 dark:text-blue-400"
                : "border-slate-400 text-slate-700 dark:text-slate-400"
            }
            data-testid={`badge-advance-type-${adv.id}`}
          >
            {isLoan ? "Loan" : "Salary Ded."}
          </Badge>
        </TableCell>
        <TableCell>
          <Badge
            variant="outline"
            className={
              adv.fullyPaid
                ? "border-green-500 text-green-700 dark:text-green-400"
                : "border-amber-400 text-amber-700 dark:text-amber-400"
            }
          >
            {adv.fullyPaid ? "Paid" : "Outstanding"}
          </Badge>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{adv.notes || "\u2014"}</TableCell>
        <TableCell>
          {isLoan && !adv.fullyPaid && (
            <Button size="sm" variant="outline" onClick={onRepay} data-testid={`button-repay-advance-${adv.id}`}>
              <RotateCcw className="h-3 w-3 mr-1" /> Repay
            </Button>
          )}
        </TableCell>
      </TableRow>
      {isLoan && isExpanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/30 p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">Repayment History</div>
            {repaymentsWithRunningBalance.length === 0 ? (
              <p className="text-xs text-muted-foreground">No repayments recorded yet</p>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs text-right">Amount</TableHead>
                    <TableHead className="text-xs">Cash Account</TableHead>
                    <TableHead className="text-xs text-right">Balance After</TableHead>
                    <TableHead className="text-xs">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repaymentsWithRunningBalance.map((r) => (
                    <TableRow key={r.id} data-testid={`row-repayment-${r.id}`}>
                      <TableCell className="text-xs">{formatDate(r.repaymentDate)}</TableCell>
                      <TableCell className="text-xs text-right font-mono">{fmt(r.amount)}</TableCell>
                      <TableCell className="text-xs">
                        {r.cashAccountId ? cashAccountMap.get(r.cashAccountId) || `#${r.cashAccountId}` : "\u2014"}
                      </TableCell>
                      <TableCell className="text-xs text-right font-mono">{fmt(r.balanceAfter)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.notes || "\u2014"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
