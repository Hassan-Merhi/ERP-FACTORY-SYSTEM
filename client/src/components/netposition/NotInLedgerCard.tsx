import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * "Not yet in the ledger" section of the net position reports (accounting
 * audit wave 10): operational amounts the ledger does not carry yet (unposted
 * factory invoices, POS credit sales, unjournalled container amounts,
 * unfinalized orders, advance and payroll tables over the ledger). Shown for
 * information; never included in What We Have / What We Owe.
 */
export interface NotInLedgerLine {
  label: string;
  code: string;
  value: number;
  count: number;
}

export interface NotInLedgerSectionData {
  label: string;
  total: number;
  lines: NotInLedgerLine[];
}

export function NotInLedgerCard({
  section,
  formatAmount,
}: {
  section: NotInLedgerSectionData | null | undefined;
  formatAmount: (value: number) => string;
}) {
  if (!section || section.lines.length === 0) return null;
  return (
    <Card data-testid="card-not-in-ledger" className="border-dashed">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Not yet in the ledger</CardTitle>
        <p className="text-xs text-muted-foreground">
          Operational amounts shown for information. They are not included in What We Have or What We Owe.
        </p>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {section.lines.map((line) => (
          <div
            key={line.code}
            className="flex items-center justify-between gap-4 text-sm"
            data-testid={`row-not-in-ledger-${line.code}`}
          >
            <span className="min-w-0 text-foreground/80">{line.label}</span>
            <span className="shrink-0 font-mono">{formatAmount(line.value)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 border-t pt-2 text-sm font-semibold">
          <span>Total not yet in the ledger</span>
          <span className="font-mono">{formatAmount(section.total)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
