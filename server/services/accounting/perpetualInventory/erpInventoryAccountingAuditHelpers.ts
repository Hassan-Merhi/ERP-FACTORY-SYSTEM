// Extracted from ./erpInventoryAccountingAudit.ts
import Decimal from "decimal.js";

export type ErpInventorySource =
  "sale" | "purchase_order" | "offload" | "inventory_movement" | "credit_debit_note" | "transfer";

export type ErpInventoryAuditStatus =
  "posted" | "cost_mismatch" | "date_mismatch" | "missing" | "expected_periodic" | "review";

export interface ErpInventoryAuditRow {
  kind: ErpInventorySource;
  sourceId: string;
  documentNumber: string;
  documentDate: string;
  linkedJournalNumber: string;
  linkedJournalId: number | null;
  linkedJournalDate: string | null;
  expectedStockMovement: string | null;
  postedStockMovement: string | null;
  status: ErpInventoryAuditStatus;
  note: string;
}

export interface ErpInventoryAccountingAudit {
  companyId: number;
  asOfDate: string;
  postingReady: boolean;
  cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
  accountingMode: "PERIODIC" | "PERPETUAL" | "SUPPLIER_PARTNER";
  valuation: {
    subLedgerAtCost: string | null;
    ledgerInventory: string | null;
    difference: string | null;
    basis: string;
    historicalReliable: boolean;
  };
  summary: {
    sources: number;
    posted: number;
    missing: number;
    mismatched: number;
    periodic: number;
    review: number;
    truncated: boolean;
  };
  journals: ErpInventoryAuditRow[];
  policy: {
    sourceOfCost: string;
    cutoverActivation: string;
    historicalAdjustment: string;
    transfers: string;
    returns: string;
    landedCosts: string;
  };
}

export interface SourceRow extends Record<string, unknown> {
  id: number | string;
  doc: string;
  dated: string;
  expected: string | null;
  journal_number: string;
  journal_id: number | null;
  journal_date: string | null;
  posted: string | null;
  lines: number | null;
}

export const number = (x: unknown) => new Decimal(String(x ?? "0"));

export const fixed = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function documentStatus(row: SourceRow, kind: ErpInventorySource, active: boolean): ErpInventoryAuditRow {
  const expected = row.expected === null ? null : number(row.expected);
  const posted = row.posted === null ? null : number(row.posted);
  let status: ErpInventoryAuditStatus;
  let note: string;
  if (!active) {
    status = "expected_periodic";
    note = "Periodic inventory: no linked perpetual journal required before cutover";
    if (row.journal_id !== null) {
      status = "review";
      note = "Unexpected live linked journal on a pre-cutover document";
    }
  } else if (row.journal_id === null) {
    if (kind === "sale" && Number(row.lines ?? 0) > 0) {
      status = "review";
      note = "Sale has stock items but no linked COGS journal; check whether the recorded relieved value was zero";
    } else if (expected === null || expected.isZero()) {
      status = "review";
      note = "No measurable cost from stored source; inspect source before assuming a journal is required";
    } else {
      status = "missing";
      note = "Expected linked journal is missing";
    }
  } else if (row.journal_date !== row.dated) {
    status = "date_mismatch";
    note = "Linked journal date differs from source accounting date";
  } else if (
    expected !== null &&
    posted !== null &&
    expected.toDecimalPlaces(2).minus(posted.toDecimalPlaces(2)).abs().gt("0.01")
  ) {
    status = "cost_mismatch";
    note = "Posted inventory/GIT value differs from the source's recorded value";
  } else if (expected !== null && !expected.isZero() && posted === null) {
    status = "review";
    note = "Linked journal is present but no matching inventory/GIT control line was identified";
  } else {
    status = "posted";
    note = "Linked posting exists; balance of entire inventory still requires ledger reconciliation";
  }
  return {
    kind,
    sourceId: String(row.id),
    documentNumber: String(row.doc),
    documentDate: String(row.dated),
    linkedJournalNumber: String(row.journal_number),
    linkedJournalId: row.journal_id === null ? null : Number(row.journal_id),
    linkedJournalDate: row.journal_date,
    expectedStockMovement: expected === null ? null : fixed(expected),
    postedStockMovement: posted === null ? null : fixed(posted),
    status,
    note,
  };
}
