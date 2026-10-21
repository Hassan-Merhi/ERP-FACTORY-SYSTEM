/**
 * Unified Accounting Phase 6 — ERP stock-to-ledger audit.
 *
 * This report is a read-only accounting bridge between established ERP stock
 * documents and the existing perpetual-inventory linked journals. It never
 * posts, repairs, backfills or revalues inventory. The per-company cutover
 * switch stays untouched. Before activation, missing journals are expected.
 *
 * Sale COGS is derived from the cost ACTUALLY relieved by adjustInventory;
 * there is no reliable reconstruction from current product sale prices.
 * A missing sale journal is therefore a review item, not a guessed write-off.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { assertTransactionCompanyScope } from "../../security/transactionCompanyScope";
import { companyBusinessDate } from "../companyBusinessDate";
import { PERPETUAL_INVENTORY_POSTING_READY, getInventoryCutover } from "./cutover";
import { companyStockValuation, companyStockValuationAsOf } from "../../inventory/stockValuation";
import { ledgerBalancesByCode, isSupplierPartnerCompany } from "./linkedJournal";
import { fxDay } from "../monetaryFxRates";

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
interface SourceRow extends Record<string, unknown> {
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
const number = (x: unknown) => new Decimal(String(x ?? "0"));
const fixed = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const limit = 251;
const cutoff = (day: string, cutover: { effectiveFrom: string } | null) => !!cutover && day >= cutover.effectiveFrom;
function documentStatus(row: SourceRow, kind: ErpInventorySource, active: boolean): ErpInventoryAuditRow {
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
export async function erpInventoryAccountingAuditTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    asOfDate?: string;
  }
): Promise<ErpInventoryAccountingAudit> {
  if (!Number.isSafeInteger(input.companyId) || input.companyId <= 0)
    throw new Error("INVENTORY_AUDIT_INVALID_COMPANY");
  await assertTransactionCompanyScope(tx, input.companyId);
  const date = fxDay(input.asOfDate ?? (await companyBusinessDate(input.companyId, tx)));
  const cutover = await getInventoryCutover(tx, input.companyId);
  const partner = await isSupplierPartnerCompany(tx, input.companyId);
  const active = (d: string) => !partner && cutoff(d, cutover);
  const companyId = input.companyId;

  // Every source has a company predicate on its owning document and a cap.
  // The journal join also includes company, live/posted, and its exact stable
  // number. Old retired generations cannot masquerade as active postings.
  const sales = resultRows<SourceRow>(
    await tx.execute(sql`
    SELECT v.id,v.voucher_number AS doc,
      COALESCE(v.effective_date,v.voucher_date)::text AS dated,
      NULL::text AS expected,('COGS-'||v.id)::text AS journal_number,
      j.id AS journal_id,COALESCE(j.effective_date,j.voucher_date)::text AS journal_date,
      (SELECT SUM(CASE WHEN la.code='INVENTORY' THEN e.credit_amount-e.debit_amount ELSE 0 END)::text
         FROM voucher_entries e LEFT JOIN ledger_accounts la ON la.id=e.ledger_account_id
         WHERE e.voucher_id=j.id AND la.company_id=${companyId}) AS posted,
      (SELECT COUNT(*)::int FROM sales_items si WHERE si.voucher_id=v.id) AS lines
    FROM vouchers v
    LEFT JOIN vouchers j ON j.company_id=v.company_id
      AND j.voucher_number='COGS-'||v.id AND j.deleted_at IS NULL AND j.optional=false
    WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
      AND v.voucher_type IN ('Sales','Receipt')
      AND COALESCE(v.effective_date,v.voucher_date)<=${date}::date
      AND EXISTS(SELECT 1 FROM sales_items si WHERE si.voucher_id=v.id)
    ORDER BY COALESCE(v.effective_date,v.voucher_date) DESC,v.id DESC LIMIT ${limit}
  `)
  );
  const orders = resultRows<SourceRow>(
    await tx.execute(sql`
    SELECT po.id,po.po_number AS doc,
      COALESCE(v.effective_date,v.voucher_date)::text AS dated,
      (SELECT COALESCE(SUM(e.debit_amount),0)::text FROM voucher_entries e
         JOIN ledger_accounts la ON la.id=e.ledger_account_id
         WHERE e.voucher_id=v.id AND la.company_id=${companyId} AND la.code='PURCHASES') AS expected,
      ('GIT-PO-'||po.id)::text AS journal_number,
      j.id AS journal_id,COALESCE(j.effective_date,j.voucher_date)::text AS journal_date,
      (SELECT SUM(CASE WHEN la.code='GOODS_IN_TRANSIT' THEN e.debit_amount-e.credit_amount ELSE 0 END)::text
         FROM voucher_entries e JOIN ledger_accounts la ON la.id=e.ledger_account_id
         WHERE e.voucher_id=j.id AND la.company_id=${companyId}) AS posted,
      NULL::integer AS lines
    FROM purchase_orders po
    JOIN vouchers v ON v.id=po.voucher_id AND v.company_id=po.company_id
      AND v.deleted_at IS NULL AND v.optional=false
    LEFT JOIN vouchers j ON j.company_id=po.company_id
      AND j.voucher_number='GIT-PO-'||po.id AND j.deleted_at IS NULL AND j.optional=false
    WHERE po.company_id=${companyId}
      AND COALESCE(v.effective_date,v.voucher_date)<=${date}::date
    ORDER BY COALESCE(v.effective_date,v.voucher_date) DESC,po.id DESC LIMIT ${limit}
  `)
  );
  const offloads = resultRows<SourceRow>(
    await tx.execute(sql`
    SELECT co.id,c.container_number AS doc,
      COALESCE(
        CASE WHEN co.id=(SELECT MAX(z.id) FROM container_offloads z
                WHERE z.container_id=c.id AND z.optional=false)
             THEN c.offload_date ELSE NULL END,
        co.offloaded_at::date)::text AS dated,
      (SELECT COALESCE(SUM(COALESCE(ci.value_moved,ci.total_value)),0)::text
        FROM container_offload_items ci WHERE ci.offload_id=co.id) AS expected,
      ('STOCK-IN-'||c.id||'-'||co.id)::text AS journal_number,
      j.id AS journal_id,COALESCE(j.effective_date,j.voucher_date)::text AS journal_date,
      (SELECT SUM(CASE WHEN la.code='INVENTORY' THEN e.debit_amount-e.credit_amount ELSE 0 END)::text
        FROM voucher_entries e JOIN ledger_accounts la ON la.id=e.ledger_account_id
        WHERE e.voucher_id=j.id AND la.company_id=${companyId}) AS posted,
      NULL::integer AS lines
    FROM container_offloads co
    JOIN containers c ON c.id=co.container_id AND c.company_id=${companyId}
    LEFT JOIN vouchers j ON j.company_id=c.company_id
      AND j.voucher_number='STOCK-IN-'||c.id||'-'||co.id
      AND j.deleted_at IS NULL AND j.optional=false
    WHERE co.optional=false
      AND COALESCE(c.offload_date,co.offloaded_at::date)<=${date}::date
    ORDER BY co.offloaded_at DESC,co.id DESC LIMIT ${limit}
  `)
  );
  const movements = resultRows<SourceRow>(
    await tx.execute(sql`
    SELECT m.source_number AS id,m.source_number AS doc,
      MAX(m.movement_date)::text AS dated,SUM(m.value_delta)::text AS expected,
      m.source_number AS journal_number,
      j.id AS journal_id,COALESCE(j.effective_date,j.voucher_date)::text AS journal_date,
      (SELECT SUM(CASE WHEN la.code='INVENTORY' THEN e.debit_amount-e.credit_amount ELSE 0 END)::text
        FROM voucher_entries e JOIN ledger_accounts la ON la.id=e.ledger_account_id
        WHERE e.voucher_id=j.id AND la.company_id=${companyId}) AS posted,
      COUNT(*)::int AS lines
    FROM inventory_value_movements m
    LEFT JOIN vouchers j ON j.company_id=m.company_id AND j.voucher_number=m.source_number
      AND j.deleted_at IS NULL AND j.optional=false
    WHERE m.company_id=${companyId} AND m.movement_date<=${date}::date
    GROUP BY m.source_number,j.id,j.effective_date,j.voucher_date
    ORDER BY MAX(m.movement_date) DESC,m.source_number DESC LIMIT ${limit}
  `)
  );
  // Credit/debit notes put the Inventory contra directly on their OWN voucher,
  // rather than a separate linked COGS or receipt voucher. Compare the exact
  // movement captured in credit_note_items.value_moved to the original posted
  // Inventory line; never value the return using today's average or sales price.
  const notes = resultRows<SourceRow>(
    await tx.execute(sql`
    SELECT v.id,v.voucher_number AS doc,
      COALESCE(v.effective_date,v.voucher_date)::text AS dated,
      (CASE WHEN v.voucher_type='Credit Note' THEN 1 ELSE -1 END*
        COALESCE((SELECT SUM(COALESCE(n.value_moved,n.quantity*n.inventory_cost))
           FROM credit_note_items n WHERE n.voucher_id=v.id),0))::text AS expected,
      v.voucher_number AS journal_number,v.id AS journal_id,
      COALESCE(v.effective_date,v.voucher_date)::text AS journal_date,
      (SELECT COALESCE(SUM(ve.debit_amount-ve.credit_amount),0)::text
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id=ve.ledger_account_id
         WHERE ve.voucher_id=v.id AND la.company_id=${companyId}
           AND la.code='INVENTORY') AS posted,
      (SELECT COUNT(*)::int FROM credit_note_items n WHERE n.voucher_id=v.id) AS lines
    FROM vouchers v
    WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
      AND v.voucher_type IN ('Credit Note','Debit Note')
      AND COALESCE(v.effective_date,v.voucher_date)<=${date}::date
    ORDER BY COALESCE(v.effective_date,v.voucher_date) DESC,v.id DESC LIMIT ${limit}
  `)
  );
  // Transfers conserve cost across locations: no new company-wide Inventory
  // or COGS journal is expected. Any shortage-settlement value is already
  // represented by a separately audited INV-MOVE journal.
  const transfers = resultRows<SourceRow>(
    await tx.execute(sql`
    SELECT st.id,v.voucher_number AS doc,
      COALESCE(v.effective_date,v.voucher_date)::text AS dated,
      '0'::text AS expected,v.voucher_number AS journal_number,
      NULL::integer AS journal_id,NULL::text AS journal_date,
      NULL::text AS posted,
      CASE WHEN st.inventory_applied THEN 1 ELSE 0 END AS lines
    FROM stock_transfer_vouchers st JOIN vouchers v ON v.id=st.voucher_id
    WHERE v.company_id=${companyId} AND v.deleted_at IS NULL AND v.optional=false
      AND COALESCE(v.effective_date,v.voucher_date)<=${date}::date
    ORDER BY COALESCE(v.effective_date,v.voucher_date) DESC,st.id DESC LIMIT ${limit}
  `)
  );
  const all = [
    ...sales.map((row) => documentStatus(row, "sale", active(row.dated))),
    ...orders.map((row) => documentStatus(row, "purchase_order", active(row.dated))),
    ...offloads.filter((row) => row.dated !== null).map((row) => documentStatus(row, "offload", active(row.dated))),
    ...movements.map((row) => documentStatus(row, "inventory_movement", active(row.dated))),
    ...notes.map((row) => documentStatus(row, "credit_debit_note", true)),
    ...transfers.map((row) => ({
      kind: "transfer" as const,
      sourceId: String(row.id),
      documentNumber: row.doc,
      documentDate: row.dated,
      linkedJournalNumber: "No separate COGS journal required",
      linkedJournalId: null,
      linkedJournalDate: null,
      expectedStockMovement: "0.00",
      postedStockMovement: null,
      status: (Number(row.lines) === 1 ? "posted" : "review") as ErpInventoryAuditStatus,
      note:
        Number(row.lines) === 1
          ? "Internal location transfer preserves company-wide cost. Shortage variance, if any, is traced as INV-MOVE."
          : "This stock transfer does not show inventory applied; review its operational lifecycle.",
    })),
  ];
  const totals = {
    sources: all.length,
    posted: all.filter((r) => r.status === "posted").length,
    missing: all.filter((r) => r.status === "missing").length,
    mismatched: all.filter((r) => ["cost_mismatch", "date_mismatch"].includes(r.status)).length,
    periodic: all.filter((r) => r.status === "expected_periodic").length,
    review: all.filter((r) => r.status === "review").length,
    truncated: [sales, orders, offloads, movements, notes, transfers].some((rows) => rows.length === limit),
  };
  const now = await companyBusinessDate(companyId, tx);
  const value = partner
    ? null
    : date >= now
      ? await companyStockValuation(tx, companyId)
      : await companyStockValuationAsOf(tx, companyId, date);
  const ledger = await ledgerBalancesByCode(tx, companyId, ["INVENTORY"], date);
  const book = ledger.get("INVENTORY") ?? new Decimal(0);
  const sub = value ? number(value.subLedgerTotal) : null;
  const mode = partner ? "SUPPLIER_PARTNER" : cutover ? "PERPETUAL" : "PERIODIC";
  return {
    companyId,
    asOfDate: date,
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
    cutover: cutover ? { effectiveFrom: cutover.effectiveFrom, openingVoucherId: cutover.openingVoucherId } : null,
    accountingMode: mode,
    valuation: {
      subLedgerAtCost: sub === null ? null : fixed(sub),
      ledgerInventory: mode === "PERPETUAL" ? fixed(book) : null,
      difference: mode === "PERPETUAL" && sub !== null ? fixed(book.minus(sub)) : null,
      basis:
        mode === "PERPETUAL"
          ? "Inventory GL (debit positive) vs ERP stock total_value at cost, excluding Factory bale mirrors"
          : "Periodic or Supplier Partner ledger: stock is not expected in the perpetual Inventory control account",
      historicalReliable: date >= now,
    },
    summary: totals,
    journals: all,
    policy: {
      sourceOfCost: "ERP inventory.total_value and recorded adjustInventory value deltas; never sale price",
      cutoverActivation: "Per-company cutover remains disabled until its existing readiness gate certifies all paths",
      historicalAdjustment: "No historical journals or inventory balances are backfilled",
      transfers: "Internal location transfers move stock value between locations, not new consolidated COGS",
      returns:
        "Credit/debit notes reconcile inventory movement at the original note voucher, with their recorded value_moved; sale COGS reversals retain their source lifecycle",
      landedCosts: "PO Goods in Transit and offload charge allocations retain their original booked source amounts",
    },
  };
}
