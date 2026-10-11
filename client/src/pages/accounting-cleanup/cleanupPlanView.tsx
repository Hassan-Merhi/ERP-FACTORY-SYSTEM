/**
 * Plain-figure rendering of the Owner tools' plans and results (Accounting
 * clean-up page). The plans are the server's own JSON: figures are shown as
 * returned (exact decimal strings), never recomputed here.
 */
import { Link } from "wouter";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type PlanRecord = Record<string, unknown>;

/** Labels of the fields the plans share; any other field is shown with its name spaced out. */
export const FIELD_LABELS: Record<string, string> = {
  total: "Total",
  totals: "Totals",
  lines: "Lines",
  vouchers: "Vouchers",
  rows: "Rows",
  items: "Items",
  bales: "Bales",
  mixes: "Mixes",
  count: "Count",
  value: "Value",
  amount: "Amount",
  debit: "Debit",
  credit: "Credit",
  net: "Net",
  gain: "Gain",
  loss: "Loss",
  cost: "Cost",
  blockers: "Blockers",
  skipped: "Skipped",
  blocked: "Blocked",
  excluded: "Excluded",
  warnings: "Warnings",
  withoutRate: "Without a rate",
  unvalued: "Unvalued",
  reviewFlags: "Review flags",
  alreadyApplied: "Already applied",
  applied: "Applied",
  voucherDate: "Voucher date",
  voucherNumber: "Voucher number",
  journalDate: "Journal date",
  effectiveFrom: "Effective from",
  cutOverDate: "Cut-over date",
  suggestedCutOverDate: "Suggested cut-over date",
  monthEnd: "Month end",
  reversalDate: "Reversal date",
  date: "Date",
  closedThrough: "Closed through",
  currency: "Currency",
  storedValue: "Stored value",
  liveImportCycleDifference: "Live import-cycle difference",
  legacyLines: "Legacy lines",
  repairableLines: "Repairable lines",
  repairableVouchers: "Repairable vouchers",
  skippedLines: "Skipped lines",
  datedRateLines: "Lines at a dated factory rate",
  skippedByReason: "Skipped by reason",
  usdChangeByTarget: "USD change by target",
  candidates: "Vouchers to change",
  correctable: "Correctable",
  orphanedLocations: "Missing locations",
  orphanedRows: "Rows at missing locations",
  orphanedValue: "Value at missing locations",
  anomalousRows: "Anomalous rows",
  anomalousValue: "Anomalous value",
  anomalies: "Anomalies",
  wipChange: "WIP change",
  finishedChange: "Finished goods change",
  noMixBales: "Bales without a mix",
  withCandidate: "With a candidate mix",
  candidateCost: "Candidate cost",
  creates: "Allocations to create",
  createdAmount: "Amount allocated",
  releases: "Allocations to release",
  parties: "Parties",
  kinds: "Party kinds",
  supplierPartner: "Supplier partner",
  perpetual: "Perpetual posting",
  postingReady: "Posting ready",
  openingBalanceEquity: "Opening balance equity",
  movedToRetainedEarnings: "Moved to retained earnings",
  linesBeforeCutOver: "Lines before the cut-over",
  deferredClosing: "Deferred rent balance",
  classChanges: "Account class changes",
  sources: "Source accounts",
  destination: "Destination",
  toPost: "Invoices to post",
  purchaseDebits: "Purchase debits",
  noteInventoryLegs: "Note inventory legs",
  payrollPeriods: "Payroll periods",
  closedPeriodVoucherIds: "Vouchers in a closed period",
  alreadyReversed: "Already reversed",
  status: "Status",
  reason: "Reason",
  message: "Message",
  code: "Code",
  ready: "Ready",
  resolved: "Resolved",
  restored: "Restored",
  writtenOff: "Written off",
  anomaliesWrittenOff: "Anomalies written off",
  posted: "Posted",
  corrected: "Corrected",
  results: "Results",
  enabled: "Enabled",
  inserted: "Saved",
  identical: "Same as recorded",
};

const HIDDEN_KEYS = new Set(["planHash", "companyId", "realizedFx"]);
const MAX_ROWS = 50;

export function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function cellText(value: unknown): string {
  if (isScalar(value)) return scalarText(value);
  if (Array.isArray(value)) return value.every(isScalar) ? value.map(scalarText).join(", ") : `${value.length}`;
  return Object.entries(value as PlanRecord)
    .filter(([, inner]) => isScalar(inner))
    .map(([key, inner]) => `${key}: ${scalarText(inner)}`)
    .join(" · ");
}

function Figures({ entries, testId }: { entries: Array<[string, unknown]>; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3" data-testid={testId}>
      {entries.map(([key, value]) => (
        <div key={key} className="flex min-w-0 justify-between gap-2 border-b border-dashed py-1">
          <dt className="text-muted-foreground">{fieldLabel(key)}</dt>
          <dd className="text-end font-mono tabular-nums wrap-break-word" data-business-value>
            {scalarText(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RowsTable({ rows, label, testId }: { rows: unknown[]; label: string; testId: string }) {
  const objects = rows.filter((row): row is PlanRecord => !!row && typeof row === "object" && !Array.isArray(row));
  if (objects.length === 0) {
    return (
      <p className="text-sm font-mono wrap-break-word" data-testid={testId} data-business-value>
        {rows.map(scalarText).join(", ")}
      </p>
    );
  }
  const columns = Array.from(new Set(objects.slice(0, MAX_ROWS).flatMap((row) => Object.keys(row)))).slice(0, 10);
  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      <Table maxHeight="20rem" scrollLabel={label}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} className="whitespace-nowrap">
                {fieldLabel(column)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {objects.slice(0, MAX_ROWS).map((row, index) => (
            <TableRow key={index}>
              {columns.map((column) => (
                <TableCell key={column} className="max-w-64 font-mono text-xs wrap-break-word">
                  {cellText(row[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {objects.length > MAX_ROWS && (
        <p className="p-2 text-xs text-muted-foreground">{`First ${MAX_ROWS} of ${objects.length} rows`}</p>
      )}
    </div>
  );
}

/** Every figure of a plan: scalars and small objects as figures, lists as tables. */
export function PlanFigures({ plan, testId, omit = [] }: { plan: PlanRecord; testId: string; omit?: string[] }) {
  const hidden = new Set([...HIDDEN_KEYS, ...omit]);
  const entries = Object.entries(plan).filter(([key]) => !hidden.has(key));
  const scalars = entries.filter(([, value]) => isScalar(value));
  const objects: Array<[string, PlanRecord]> = [];
  const lists: Array<[string, unknown[]]> = [];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) lists.push([key, value]);
    else if (value !== null && typeof value === "object") objects.push([key, value as PlanRecord]);
  }
  return (
    <div className="space-y-3" data-testid={testId}>
      <Figures entries={scalars} testId={`${testId}-figures`} />
      {objects.map(([key, value]) => (
        <div key={key} className="space-y-1">
          <p className="text-sm font-medium">{fieldLabel(key)}</p>
          <Figures
            entries={Object.entries(value).map(([inner, innerValue]) => [
              inner,
              isScalar(innerValue) ? innerValue : cellText(innerValue),
            ])}
            testId={`${testId}-${key}`}
          />
        </div>
      ))}
      {lists.map(([key, value]) => (
        <div key={key} className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {fieldLabel(key)}
            <Badge variant="outline">{value.length}</Badge>
          </p>
          {value.length > 0 && <RowsTable rows={value} label={fieldLabel(key)} testId={`${testId}-${key}`} />}
        </div>
      ))}
    </div>
  );
}

export interface VoucherReference {
  id: number;
  number: string | null;
}

const VOUCHER_ID_KEYS = /^(voucherId|reversalVoucherId|replacementVoucherId|counterpartVoucherId|openingVoucherId)$/;

/** The vouchers an apply result names (the re-derived plan it echoes is left out). */
export function collectVouchers(result: unknown): VoucherReference[] {
  const found = new Map<number, string | null>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = value as PlanRecord;
    for (const [key, inner] of Object.entries(record)) {
      if (key === "plan") continue;
      if (VOUCHER_ID_KEYS.test(key) && Number.isInteger(inner) && (inner as number) > 0) {
        const number =
          key === "reversalVoucherId"
            ? record.reversalVoucherNumber
            : key === "voucherId"
              ? record.voucherNumber
              : null;
        found.set(inner as number, typeof number === "string" ? number : (found.get(inner as number) ?? null));
      } else if (key === "voucherIds" && Array.isArray(inner)) {
        for (const id of inner) if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, null);
      } else visit(inner, depth + 1);
    }
  };
  visit(result, 0);
  return Array.from(found, ([id, number]) => ({ id, number }));
}

export function VoucherLinks({
  vouchers,
  modePrefix,
  testId,
}: {
  vouchers: VoucherReference[];
  modePrefix: string;
  testId: string;
}) {
  if (vouchers.length === 0) return null;
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-sm font-medium">{`Vouchers posted: ${vouchers.length}`}</p>
      <ul className="flex flex-wrap gap-2 text-sm">
        {vouchers.slice(0, 100).map((voucher) => (
          <li key={voucher.id}>
            <Link
              href={`${modePrefix}/voucher-detail/${voucher.id}`}
              className="text-primary underline-offset-2 hover:underline"
              data-voucher-number
            >
              {voucher.number ?? `#${voucher.id}`}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
