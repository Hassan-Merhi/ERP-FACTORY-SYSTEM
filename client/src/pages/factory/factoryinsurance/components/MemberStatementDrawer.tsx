/**
 * MemberStatementDrawer — extracted sub-component.
 *
 * Extracted from FactoryInsurance.tsx during the Phase 4 god-file split.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { InsuranceMember, LedgerEntry } from "../types";
import { formatUsd } from "@/lib/moneyDisplay";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";

export // ─── Member Statement Drawer ──────────────────────────────────────────────────
function MemberStatementDrawer({ member, onClose }: { member: InsuranceMember; onClose: () => void }) {
  const { formatDisplayDate } = useDateFormat();

  const {
    data: entries = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<LedgerEntry[]>({
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
          <RowsExportMenu
            title="Insurance Statement"
            filters={[{ label: "Member", value: member.name }]}
            rows={entries}
            columns={[
              { header: "Date", value: (e) => formatDisplayDate(e.voucherDate) },
              { header: "Voucher", value: (e) => e.voucherNumber },
              { header: "Description", value: (e) => e.narration || e.description },
              {
                header: "Credit (USD)",
                value: (e) => (parseFloat(e.creditAmount || "0") > 0 ? parseFloat(e.creditAmount!) : null),
                type: "number",
              },
              {
                header: "Debit (USD)",
                value: (e) => (parseFloat(e.debitAmount || "0") > 0 ? parseFloat(e.debitAmount!) : null),
                type: "number",
              },
            ]}
            resource="factory.accounting"
            className="self-start"
            data-testid="button-export-insurance-statement"
          />
        </SheetHeader>

        <div className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <LoadingState className="py-12" />
          ) : isError && entries.length === 0 ? (
            <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-12" />
          ) : entries.length === 0 ? (
            <EmptyState icon={FileText} title="No entries posted yet for this member." className="py-12" />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Total Credited</p>
                    <p className="text-lg font-bold">{formatUsd(totalCredit, 2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Total Debited</p>
                    <p className="text-lg font-bold">{formatUsd(totalDebit, 2)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xs text-muted-foreground">Net Balance</p>
                    <p className="text-lg font-bold">{formatUsd(totalCredit - totalDebit, 2)}</p>
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
                        {parseFloat(e.creditAmount || "0") > 0 ? formatUsd(parseFloat(e.creditAmount!), 2) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {parseFloat(e.debitAmount || "0") > 0 ? formatUsd(parseFloat(e.debitAmount!), 2) : "—"}
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
