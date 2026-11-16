// Extracted from ./ProfessionalFinancialStatements.tsx to keep that module under the source-size cap.
import { exportErpReportCsv } from "@/erp-core";

interface Line {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  category: string;
  amountUsd: string;
  openingSideAssumed: boolean;
  currentSourceIsMutable: boolean;
}

interface Section {
  lines: Line[];
  totalUsd: string;
}

interface Single {
  fromDate: string;
  asOfDate: string;
  currency: string;
  financialPosition: {
    assets: Section;
    liabilities: Section;
    equity: Section;
    unclassified: Section;
    unclosedEarningsUsd: string;
    totalEquityIncludingEarningsUsd: string;
    reportedBalanceSheetDifferenceUsd: string;
    assetsMinusLiabilitiesAndEquityUsd: string;
    balanced: boolean;
  };
  profitAndLoss: {
    revenue: Section;
    otherIncome: Section;
    costOfSales: Section;
    operatingExpenses: Section;
    grossProfitUsd: string;
    operatingResultUsd: string;
    periodNetResultUsd: string;
  };
  changesInEquity: {
    openingTotalEquityUsd: string;
    periodResultUsd: string;
    otherBookedEquityMovementsUsd: string;
    closingTotalEquityUsd: string;
    differenceUsd: string;
    otherMovementsRequireReview: boolean;
  };
  cashFlow: {
    operatingUsd: string;
    investingUsd: string;
    financingUsd: string;
    unclassifiedUsd: string;
    recognizedCashMovementUsd: string;
    actualCashMovementUsd: string;
    cashFlowClassificationDifferenceUsd: string;
    openingCashUsd: string;
    closingCashUsd: string;
    sourceVoucherCount: number;
    sampleTruncated: boolean;
    sourceSample: Array<{
      voucherId: number;
      voucherNumber: string;
      bookedOn: string;
      changeUsd: string;
      classification: string;
    }>;
  };
  controls: {
    trialBalanceDifferenceUsd: string;
    trialBalanceBalanced: boolean;
    assumedOpeningSides: number;
    unknownAccounts: number;
    unknownAbsAmountUsd: string;
    recognizedCashAndSourceAgree: boolean;
    certified: false;
    blockers: string[];
    warnings: string[];
  };
}

export interface Package {
  companyId: number;
  fromDate: string;
  asOfDate: string;
  currency: "USD";
  current: Single;
  comparison: Single | null;
  comparisonPeriod: { fromDate: string; asOfDate: string } | null;
  reportStatus: "PROVISIONAL_NOT_CERTIFIED";
  historicalFx: {
    ready: boolean;
    legacyCompatibilityMode: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    unresolvedLedgerOpeningCount: number;
    unresolvedBankOpeningCount: number;
    unresolvedCustomerOpeningCount: number;
    unresolvedSupplierOpeningCount: number;
    certified: false;
    caveat: string;
  };
  comparisonHistoricalFx: Package["historicalFx"] | null;
  disclosure: Record<string, string>;
}

export async function get(url: string): Promise<Package> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Unable to retrieve financial statements");
  return body as Package;
}

export const number = (v: string) =>
  Number(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function exportedCsv(record: Package) {
  const rows: string[][] = [
    ["PROVISIONAL FINANCIAL STATEMENTS — NOT CERTIFIED"],
    ["Company", String(record.companyId)],
    ["From", record.fromDate],
    ["As of", record.asOfDate],
    ["Currency", "USD"],
    ["Statement", "Account", "Current USD", "Prior USD"],
  ];
  const current = record.current,
    prior = record.comparison;
  function detail(name: string, section: Section, prev?: Section) {
    const prevMap = new Map((prev?.lines ?? []).map((l) => [`${l.kind}:${l.id}`, l.amountUsd]));
    const included = new Set(section.lines.map((line) => `${line.kind}:${line.id}`));
    for (const line of section.lines) {
      rows.push([
        name,
        line.code ? line.code + " — " + line.name : line.name,
        line.amountUsd,
        prevMap.get(`${line.kind}:${line.id}`) ?? "",
      ]);
    }
    for (const line of prev?.lines ?? []) {
      if (included.has(`${line.kind}:${line.id}`)) continue;
      rows.push([name, line.code ? line.code + " — " + line.name : line.name, "0.00", line.amountUsd]);
    }
    rows.push([name, "TOTAL", section.totalUsd, prev?.totalUsd ?? ""]);
  }
  detail("Revenue", current.profitAndLoss.revenue, prior?.profitAndLoss.revenue);
  detail("Other income", current.profitAndLoss.otherIncome, prior?.profitAndLoss.otherIncome);
  detail("Cost of sales", current.profitAndLoss.costOfSales, prior?.profitAndLoss.costOfSales);
  detail("Operating expenses", current.profitAndLoss.operatingExpenses, prior?.profitAndLoss.operatingExpenses);
  rows.push([
    "Profit and loss",
    "NET RESULT",
    current.profitAndLoss.periodNetResultUsd,
    prior?.profitAndLoss.periodNetResultUsd ?? "",
  ]);
  detail("Assets", current.financialPosition.assets, prior?.financialPosition.assets);
  detail("Liabilities", current.financialPosition.liabilities, prior?.financialPosition.liabilities);
  detail("Equity", current.financialPosition.equity, prior?.financialPosition.equity);
  detail("Unclassified", current.financialPosition.unclassified, prior?.financialPosition.unclassified);
  rows.push([
    "Financial position",
    "Unclosed current earnings",
    current.financialPosition.unclosedEarningsUsd,
    prior?.financialPosition.unclosedEarningsUsd ?? "",
  ]);
  rows.push([
    "Financial position",
    "ASSETS MINUS LIABILITIES AND EQUITY",
    current.financialPosition.reportedBalanceSheetDifferenceUsd,
    prior?.financialPosition.reportedBalanceSheetDifferenceUsd ?? "",
  ]);
  rows.push([
    "Financial position",
    "RESIDUAL AFTER UNCLASSIFIED",
    current.financialPosition.assetsMinusLiabilitiesAndEquityUsd,
    prior?.financialPosition.assetsMinusLiabilitiesAndEquityUsd ?? "",
  ]);
  for (const key of [
    "openingTotalEquityUsd",
    "periodResultUsd",
    "otherBookedEquityMovementsUsd",
    "closingTotalEquityUsd",
    "differenceUsd",
  ] as const) {
    rows.push(["Changes in equity", key, current.changesInEquity[key], prior?.changesInEquity[key] ?? ""]);
  }
  for (const key of [
    "operatingUsd",
    "investingUsd",
    "financingUsd",
    "unclassifiedUsd",
    "actualCashMovementUsd",
    "cashFlowClassificationDifferenceUsd",
    "openingCashUsd",
    "closingCashUsd",
  ] as const) {
    rows.push(["Cash flow", key, current.cashFlow[key], prior?.cashFlow[key] ?? ""]);
  }
  rows.push(["", "DISCLAIMER", "All statements provisional; no ledger adjustment applied", ""]);
  exportErpReportCsv({
    headers: [],
    rows,
    fileName: `financial-statements-${record.companyId}-${record.asOfDate}.csv`,
  });
}

export function SectionTable({ title, current, previous }: { title: string; current: Section; previous?: Section }) {
  const previousMap = new Map((previous?.lines ?? []).map((l) => [`${l.kind}:${l.id}`, l.amountUsd]));
  const existing = new Set(current.lines.map((l) => `${l.kind}:${l.id}`));
  const lines = [
    ...current.lines,
    ...(previous?.lines ?? [])
      .filter((l) => !existing.has(`${l.kind}:${l.id}`))
      .map((l) => ({ ...l, amountUsd: "0.00" })),
  ];
  return (
    <div className="space-y-1">
      <h3 className="font-semibold text-base">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Account / party</th>
              <th className="p-2 text-right">Current USD</th>
              {previous && <th className="p-2 text-right">Comparison USD</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.kind + ":" + line.id + ":" + i} className="border-b">
                <td className="p-2">
                  {line.code ? line.code + " · " : ""}
                  {line.name}
                  {line.openingSideAssumed && (
                    <span className="text-xs text-muted-foreground"> (opening side assumed)</span>
                  )}
                </td>
                <td className="p-2 text-right tabular-nums">{number(line.amountUsd)}</td>
                {previous && (
                  <td className="p-2 text-right tabular-nums">
                    {previousMap.has(`${line.kind}:${line.id}`)
                      ? number(previousMap.get(`${line.kind}:${line.id}`) ?? "0")
                      : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold border-t">
              <td className="p-2">TOTAL {title.toUpperCase()}</td>
              <td className="p-2 text-right tabular-nums">{number(current.totalUsd)}</td>
              {previous && <td className="p-2 text-right tabular-nums">{number(previous.totalUsd)}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function Figure({ label, current, previous }: { label: string; current: string; previous?: string }) {
  return (
    <div className="flex justify-between items-center gap-2 border-b py-2 text-sm">
      <span>{label}</span>
      <div className="flex gap-4 items-center font-semibold tabular-nums">
        <span>{number(current)}</span>
        {previous !== undefined && <span className="text-muted-foreground">{number(previous)}</span>}
      </div>
    </div>
  );
}
