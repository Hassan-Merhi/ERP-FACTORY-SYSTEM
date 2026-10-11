import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Amount, DateField, ReportState, ReportToolbar, reportUrl, useReport } from "./reportShared";

interface LedgerLine {
  entryId: number;
  voucherNumber: string;
  voucherType: string;
  bookedOn: string;
  narration: string | null;
  debit: string;
  credit: string;
  balance: string;
}

interface LedgerAccount {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  opening: string;
  periodDebit: string;
  periodCredit: string;
  closing: string;
  lines: LedgerLine[];
}

/** GET /api/accounting/general-ledger (phase 23, G18). */
export interface GeneralLedgerResponse {
  from: string;
  to: string;
  accounts: LedgerAccount[];
  totals: { opening: string; periodDebit: string; periodCredit: string; closing: string };
  truncated: boolean;
}

function monthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function GeneralLedgerReport() {
  // The endpoint requires both dates; the page starts on the current month.
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const ready = Boolean(from && to && from <= to);
  const { data, isLoading, error } = useReport<GeneralLedgerResponse>(
    reportUrl("/api/accounting/general-ledger", { from, to }),
    ready
  );

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-general-ledger">
      <ReportToolbar>
        <DateField id="gl-from" label="From" value={from} onChange={setFrom} />
        <DateField id="gl-to" label="To" value={to} onChange={setTo} />
      </ReportToolbar>
      {!ready ? <p className="text-sm text-muted-foreground">Choose a start date on or before the end date</p> : null}
      <ReportState isLoading={ready && isLoading} error={error}>
        {data ? (
          <>
            {data.truncated ? (
              <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="notice-gl-truncated">
                The period has more lines than the report lists; choose a shorter period
              </p>
            ) : null}
            {data.accounts.map((account) => (
              <Card key={`${account.kind}:${account.id ?? account.name}`} className="min-w-0">
                <CardHeader className="pb-2">
                  <CardTitle className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 text-base">
                    <span className="min-w-0 wrap-break-word">
                      {account.code ? `${account.code} · ` : ""}
                      {account.name}
                    </span>
                    <span className="text-sm font-normal text-muted-foreground">
                      <Amount value={account.opening} /> → <Amount value={account.closing} />
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="min-w-0 p-0 sm:p-6 sm:pt-0">
                  <Table mobileLayout="cards" scrollLabel={account.name}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Voucher</TableHead>
                        <TableHead>Narration</TableHead>
                        <TableHead className="text-end">Debit</TableHead>
                        <TableHead className="text-end">Credit</TableHead>
                        <TableHead className="text-end">Balance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {account.lines.map((line) => (
                        <TableRow key={line.entryId}>
                          <TableCell className="whitespace-nowrap">{line.bookedOn}</TableCell>
                          <TableCell className="whitespace-nowrap">{line.voucherNumber}</TableCell>
                          <TableCell className="min-w-0 wrap-break-word">{line.narration ?? ""}</TableCell>
                          <TableCell className="text-end">
                            <Amount value={line.debit} />
                          </TableCell>
                          <TableCell className="text-end">
                            <Amount value={line.credit} />
                          </TableCell>
                          <TableCell className="text-end">
                            <Amount value={line.balance} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
