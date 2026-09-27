/**
 * MemberStatementDrawer — extracted sub-component.
 *
 * Extracted from FactoryInsurance.tsx during the Phase 4 god-file split.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield, Loader2, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { InsuranceMember, LedgerEntry } from "../types";

export // ─── Member Statement Drawer ──────────────────────────────────────────────────
function MemberStatementDrawer({ member, onClose }: { member: InsuranceMember; onClose: () => void }) {
  const { formatDisplayDate } = useDateFormat();

  const { data: entries = [], isLoading } = useQuery<LedgerEntry[]>({
    queryKey: ["/api/insurance/members", member.id, "entries"],
    queryFn: async () => {
      const res = await fetch(`/api/insurance/members/${member.id}/entries`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const runningBalance = useMemo(() => {
    let bal = 0;
    return entries.map((e) => {
      const dr = parseFloat(e.debitAmount || "0");
      const cr = parseFloat(e.creditAmount || "0");
      bal = bal + dr - cr;
      return { ...e, balance: bal };
    });
  }, [entries]);

  const totalCredit = entries.reduce((s, e) => s + parseFloat(e.creditAmount || "0"), 0);
  const totalDebit = entries.reduce((s, e) => s + parseFloat(e.debitAmount || "0"), 0);

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            {member.name} — Insurance Statement
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            {member.nationality && <span>{member.nationality} · </span>}
            {member.positionWorking && <span>{member.positionWorking} · </span>}
            <span>Started {formatDisplayDate(member.startDate)}</span>
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FileText className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm">No entries posted yet for this member.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Total Credited</p>
                    <p className="text-lg font-bold">${totalCredit.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Total Debited</p>
                    <p className="text-lg font-bold">${totalDebit.toFixed(2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Net Balance</p>
                    <p className="text-lg font-bold">${(totalCredit - totalDebit).toFixed(2)}</p>
                  </CardContent>
                </Card>
              </div>

              <Table mobileLayout="cards">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Voucher</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runningBalance.map((e) => (
                    <TableRow key={e.id} data-testid={`row-entry-${e.id}`}>
                      <TableCell className="whitespace-nowrap">{formatDisplayDate(e.voucherDate)}</TableCell>
                      <TableCell className="font-mono text-xs">{e.voucherNumber}</TableCell>
                      <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                        {e.narration || e.description || "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {parseFloat(e.creditAmount || "0") > 0 ? `$${parseFloat(e.creditAmount!).toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {parseFloat(e.debitAmount || "0") > 0 ? `$${parseFloat(e.debitAmount!).toFixed(2)}` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
