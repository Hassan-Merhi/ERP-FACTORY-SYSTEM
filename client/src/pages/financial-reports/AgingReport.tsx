import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Amount, DateField, DifferenceNotice, ReportState, ReportToolbar, reportUrl, useReport } from "./reportShared";

type AgingKind = "customer" | "supplier" | "factorySupplier" | "employee";

const KIND_LABELS: Record<AgingKind, string> = {
  customer: "Customers",
  supplier: "Suppliers",
  factorySupplier: "Factory suppliers",
  employee: "Employees",
};

/** Bucket keys the aging service may return, in display order, with their labels. */
const BUCKET_LABELS: Array<[string, string]> = [
  ["future", "Future"],
  ["notDue", "Not yet due"],
  ["current", "0-30 days"],
  ["days1to30", "1-30 past due"],
  ["days31to60", "31-60 days"],
  ["days61to90", "61-90 days"],
  ["over90", "Over 90 days"],
  ["opening", "Opening"],
  ["unappliedCredit", "Unapplied credit"],
];

interface AgingParty {
  id: number | null;
  code: string | null;
  name: string;
  balance: string;
  buckets: Record<string, string>;
}

export interface AgingResponse {
  kind: AgingKind;
  referenceDate: string;
  parties: AgingParty[];
  totals: { balance: string; buckets: Record<string, string> };
  controlTieOut?: { engineTotal: string; agingTotal: string; difference: string; tied: boolean };
}

export default function AgingReport() {
  const [kind, setKind] = useState<AgingKind>("customer");
  const [asOf, setAsOf] = useState("");
  const params = { kind, asOf };
  const { data, isLoading, error } = useReport<AgingResponse>(reportUrl("/api/reports/aging", params));
  const buckets = BUCKET_LABELS.filter(([key]) => data && key in data.totals.buckets);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-aging">
      <ReportToolbar exportPath={reportUrl("/api/reports/export/aging", params)}>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="aging-kind">Parties</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as AgingKind)}>
            <SelectTrigger id="aging-kind" className="w-full sm:w-48" data-testid="select-aging-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as AgingKind[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {KIND_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DateField id="aging-as-of" label="As of" value={asOf} onChange={setAsOf} />
      </ReportToolbar>
      <ReportState isLoading={isLoading} error={error}>
        {data ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="text-aging-reference">
              {`Reference date ${data.referenceDate}`}
            </p>
            {data.controlTieOut ? (
              <DifferenceNotice
                difference={data.controlTieOut.difference}
                label="Difference with the control account"
              />
            ) : null}
            <Card className="min-w-0">
              <CardContent className="min-w-0 p-0">
                <Table mobileLayout="cards" scrollLabel="Aging" minimumWidth="48rem">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Party</TableHead>
                      <TableHead className="text-end">Balance</TableHead>
                      {buckets.map(([key, label]) => (
                        <TableHead key={key} className="text-end">
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.parties.map((party) => (
                      <TableRow key={`${party.id ?? party.name}`} data-testid={`row-aging-${party.id ?? "none"}`}>
                        <TableCell className="whitespace-nowrap">{party.code ?? ""}</TableCell>
                        <TableCell className="min-w-0 wrap-break-word">{party.name}</TableCell>
                        <TableCell className="text-end">
                          <Amount value={party.balance} />
                        </TableCell>
                        {buckets.map(([key]) => (
                          <TableCell key={key} className="text-end">
                            <Amount value={party.buckets[key]} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold" data-testid="row-aging-total">
                      <TableCell />
                      <TableCell>Total</TableCell>
                      <TableCell className="text-end">
                        <Amount value={data.totals.balance} />
                      </TableCell>
                      {buckets.map(([key]) => (
                        <TableCell key={key} className="text-end">
                          <Amount value={data.totals.buckets[key]} />
                        </TableCell>
                      ))}
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
