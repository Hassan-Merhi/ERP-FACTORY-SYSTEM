// Extracted from ./ErpInventoryAccounting.tsx

export type Kind = "sale" | "purchase_order" | "offload" | "inventory_movement" | "credit_debit_note" | "transfer";

export type Status = "posted" | "cost_mismatch" | "date_mismatch" | "missing" | "expected_periodic" | "review";

interface Row {
  kind: Kind;
  sourceId: string;
  documentNumber: string;
  documentDate: string;
  linkedJournalNumber: string;
  linkedJournalId: number | null;
  linkedJournalDate: string | null;
  expectedStockMovement: string | null;
  postedStockMovement: string | null;
  status: Status;
  note: string;
}

export interface Audit {
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
  journals: Row[];
  policy: {
    sourceOfCost: string;
    cutoverActivation: string;
    historicalAdjustment: string;
    transfers: string;
    returns: string;
    landedCosts: string;
  };
}

export interface Readiness {
  ready: boolean;
  postingReady: boolean;
  blockers: Array<{ code: string; count: number; message: string }>;
  effectiveFrom: string;
  cutover: { effectiveFrom: string } | null;
  openingPlan: { lines: number; total: string; unvalued: number } | null;
  reconciliation: { reconciled: boolean; differences: number } | null;
}

export async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.message || "Unable to retrieve the inventory audit");
  return v as T;
}

export function sourceLabel(k: Kind) {
  return (
    {
      sale: "Sales / COGS",
      purchase_order: "Purchase / GIT",
      offload: "Offload / stock-in",
      inventory_movement: "Inventory adjustment",
      credit_debit_note: "Credit / debit note",
      transfer: "Stock transfer",
    } as const
  )[k];
}
