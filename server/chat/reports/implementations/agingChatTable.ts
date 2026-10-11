/**
 * Chat aging shards on the aging service (accounting audit phase 25, AR-12):
 * the customer and supplier aging answers are the AR/AP aging report
 * (services/reports/agingReport.ts) — the engine's parties, open items by due
 * date through the allocation table, book amounts, the company's business
 * date — not a query of their own over ledger accounts in floats.
 */
import type { DataQueryResult } from "../types";
import { getAgingReport, type AgingKind } from "../../../services/reports/agingReport";
import { toMoney } from "../../../lib/money";

const BUCKET_HEADERS = ["Not due", "1-30 days", "31-60 days", "61-90 days", "90+ days", "Opening", "Unapplied"];

export async function agingChatResult(input: {
  companyId: number;
  kind: Extract<AgingKind, "customer" | "supplier">;
  rowLimit: number;
  fmt: (n: number) => string;
}): Promise<DataQueryResult> {
  const report = await getAgingReport(input.companyId, input.kind, null);
  const show = (value: string) => input.fmt(toMoney(value).toNumber());
  const cells = (buckets: (typeof report.totals)["buckets"]) => [
    show(buckets.notDue),
    show(buckets.days1to30),
    show(buckets.days31to60),
    show(buckets.days61to90),
    show(buckets.over90),
    show(buckets.opening),
    show(buckets.unappliedCredit),
  ];
  const rows = report.parties
    .slice(0, input.rowLimit)
    .map((party) => [party.name, show(party.balance), ...cells(party.buckets)]);
  rows.push(["TOTAL", show(report.totals.balance), ...cells(report.totals.buckets)]);
  const customer = input.kind === "customer";
  return {
    queryType: customer ? "customer_aging" : "supplier_aging",
    title: customer ? "Customer Receivables Aging" : "Supplier Payables Aging",
    subtitle: `As of ${report.referenceDate} — by due date`,
    table: {
      headers: [customer ? "Customer" : "Supplier", customer ? "Total" : "Total Owed", ...BUCKET_HEADERS],
      rows,
    },
    noData: rows.length <= 1,
  };
}
