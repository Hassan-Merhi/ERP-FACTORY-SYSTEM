import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  Amount,
  DateField,
  DifferenceNotice,
  FutureDatedNotice,
  ReportState,
  ReportToolbar,
  reportUrl,
  useReport,
  type FutureDated,
} from "./reportShared";

interface Columns {
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

interface TrialBalanceRow extends Columns {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  comparative: Columns | null;
}

export interface PeriodTrialBalanceResponse {
  from: string;
  to: string;
  toDefaulted: boolean;
  comparison: "none" | "priorPeriod" | "priorYear";
  comparativePeriod: { from: string; to: string } | null;
  rows: TrialBalanceRow[];
  totals: Columns;
  comparativeTotals: Columns | null;
  unexplainedDifference: string;
  balanced: boolean;
  futureDated: FutureDated;
}

type Comparison = PeriodTrialBalanceResponse["comparison"];

export default function TrialBalanceReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compare, setCompare] = useState<Comparison>("none");
  const params = { from, to, compare: compare === "none" ? null : compare };
  const { data, isLoading, error } = useReport<PeriodTrialBalanceResponse>(
    reportUrl("/api/reports/trial-balance", params)
  );
  const hasCompare = Boolean(data?.comparativePeriod);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-trial-balance">
      <ReportToolbar exportPath={reportUrl("/api/reports/export/trial-balance", params)}>
        <DateField id="tb-from" label="From" value={from} onChange={setFrom} />
        <DateField id="tb-to" label="To" value={to} onChange={setTo} />
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="tb-compare">Comparative</Label>
          <Select value={compare} onValueChange={(value) => setCompare(value as Comparison)}>
            <SelectTrigger id="tb-compare" className="w-full sm:w-44" data-testid="select-tb-compare">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No comparative</SelectItem>
              <SelectItem value="priorPeriod">Prior period</SelectItem>
              <SelectItem value="priorYear">Same period last year</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </ReportToolbar>

      <ReportState isLoading={isLoading} error={error}>
        {data ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="text-tb-period">
              {`Period ${data.from} to ${data.to}`}
              {data.comparativePeriod
                ? ` · ${`Comparative ${data.comparativePeriod.from} to ${data.comparativePeriod.to}`}`
                : ""}
            </p>
            <FutureDatedNotice futureDated={data.futureDated} />
            <DifferenceNotice difference={data.unexplainedDifference} label="Unexplained difference" />
            <Card className="min-w-0">
              <CardContent className="min-w-0 p-0">
                <Table mobileLayout="cards" scrollLabel="Trial balance" minimumWidth="56rem">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-end">Opening Dr</TableHead>
                      <TableHead className="text-end">Opening Cr</TableHead>
                      <TableHead className="text-end">Period Dr</TableHead>
                      <TableHead className="text-end">Period Cr</TableHead>
                      <TableHead className="text-end">Closing Dr</TableHead>
                      <TableHead className="text-end">Closing Cr</TableHead>
                      {hasCompare ? <TableHead className="text-end">Comparative Dr</TableHead> : null}
                      {hasCompare ? <TableHead className="text-end">Comparative Cr</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <TableRow
                        key={`${row.kind}:${row.id ?? "-"}`}
                        data-testid={`row-tb-${row.kind}-${row.id ?? "none"}`}
                      >
                        <TableCell className="whitespace-nowrap">{row.code ?? ""}</TableCell>
                        <TableCell className="min-w-0 wrap-break-word">{row.name}</TableCell>
                        <TableCell className="text-end">
                          <Amount value={row.openingDebit} />
                        </TableCell>
                        <TableCell className="text-end">
                          <Amount value={row.openingCredit} />
                        </TableCell>
                        <TableCell className="text-end">
                          <Amount value={row.periodDebit} />
                        </TableCell>
                        <TableCell className="text-end">
                          <Amount value={row.periodCredit} />
                        </TableCell>
                        <TableCell className="text-end">
                          <Amount value={row.closingDebit} />
                        </TableCell>
                        <TableCell className="text-end">
                          <Amount value={row.closingCredit} />
                        </TableCell>
                        {hasCompare ? (
                          <TableCell className="text-end">
                            <Amount value={row.comparative?.closingDebit ?? null} />
                          </TableCell>
                        ) : null}
                        {hasCompare ? (
                          <TableCell className="text-end">
                            <Amount value={row.comparative?.closingCredit ?? null} />
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                    <TableRow className={cn("font-semibold")} data-testid="row-tb-total">
                      <TableCell />
                      <TableCell>Total</TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.openingDebit} />
                      </TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.openingCredit} />
                      </TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.periodDebit} />
                      </TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.periodCredit} />
                      </TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.closingDebit} />
                      </TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.closingCredit} />
                      </TableCell>
                      {hasCompare ? (
                        <TableCell className="text-end">
                          <Amount value={data.comparativeTotals?.closingDebit ?? null} />
                        </TableCell>
                      ) : null}
                      {hasCompare ? (
                        <TableCell className="text-end">
                          <Amount value={data.comparativeTotals?.closingCredit ?? null} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
