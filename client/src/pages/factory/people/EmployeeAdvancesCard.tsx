/**
 * Advances tab of the employee detail page: the employee's advances from the
 * existing list endpoint (filtered by employee), laid out like the worker
 * statement's "Advances Given" table. Recording and repaying stay on the
 * Employees hub Advances tab.
 */
import { useQuery } from "@tanstack/react-query";
import { Banknote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

interface EmployeeAdvanceRow {
  id: number;
  advanceDate: string;
  amount: string;
  remainingBalance: string;
  fullyPaid: boolean;
  notes: string | null;
}

type RawAdvanceRow = Record<string, unknown>;

/** The advances endpoint returns raw rows (snake_case); accept either spelling. */
export function toEmployeeAdvanceRow(row: RawAdvanceRow): EmployeeAdvanceRow {
  return {
    id: Number(row.id),
    advanceDate: String(row.advanceDate ?? row.advance_date ?? ""),
    amount: String(row.amount ?? "0"),
    remainingBalance: String(row.remainingBalance ?? row.remaining_balance ?? "0"),
    fullyPaid: Boolean(row.fullyPaid ?? row.fully_paid),
    notes: (row.notes as string | null | undefined) ?? null,
  };
}

export function EmployeeAdvancesCard({
  employeeId,
  formatDate,
  formatAmount,
}: {
  employeeId: number;
  formatDate: (value: string) => string;
  formatAmount: (value: string) => string;
}) {
  const { selectedCompany } = useCompany();
  const {
    data: advances,
    isLoading,
    isError,
    refetch,
  } = useQuery<EmployeeAdvanceRow[]>({
    queryKey: companyQueryKey("/api/factory/employee-advances", selectedCompany?.id, "employee", employeeId),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/employee-advances?employeeId=${employeeId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load advances");
      const rows = (await res.json()) as RawAdvanceRow[];
      return rows.map(toEmployeeAdvanceRow);
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Banknote className="h-4 w-4" />
          Advances Given
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <LoadingState className="border-0" />
        ) : isError ? (
          <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="border-0" />
        ) : !advances?.length ? (
          <EmptyState title="No advances given" className="border-0" />
        ) : (
          <Table mobileLayout="cards">
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {advances.map((adv) => (
                <TableRow key={adv.id} data-testid={`row-employee-advance-${adv.id}`}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDate(adv.advanceDate)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {formatAmount(adv.amount)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {formatAmount(adv.remainingBalance)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={adv.fullyPaid ? "outline" : "default"} className="text-xs">
                      {adv.fullyPaid ? "Repaid" : "Outstanding"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{adv.notes || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
