/**
 * The ERP bale mirror (accounting audit phase 28, I8).
 *
 * Pressing and stock entry add each factory bale to an ERP location under a
 * BALE stock item coded with its product (the "mirror"), so the ERP stock
 * screens see the bales. The factory values its bales itself (finished
 * goods), so since wave 11 the mirror receives at rate 0 and every ERP
 * valuation leaves the mirror items out (factoryBaleMirrorStockItemIds).
 * Two gaps remained:
 *
 *  1. Mirror rows written before wave 11 still carry a value (the old receipt
 *     rate). The reviewed write-off sets those values to zero:
 *       GET  plan  (Admin/Owner): every mirror row with a non-zero value on a
 *            non-deleted location (row, item, location, quantity, value),
 *            totals and a plan hash;
 *       POST apply (Owner, confirm + plan hash): one transaction, the rows
 *            locked, the plan recomputed (409 PLAN_CHANGED), each value and
 *            average rate set to 0 (the quantity is kept: it is the physical
 *            count of bales), one audit row with every row before and after.
 *     No journal: the mirror is in no ledger valuation (neither the opening
 *     inventory journal nor the reconciliation count it), so the write-off
 *     changes the sub-ledger memo only.
 *
 *  2. A factory invoice never reduced the mirror, so the ERP screens kept the
 *     sold bales. syncFactoryInvoiceMirrorTx (called by syncFactoryInvoiceTx
 *     on every path that changes an invoice) takes each invoiced bale out of
 *     the mirror at its location (one unit, relieved at the row's average —
 *     0 once written off) and records it in factory_invoice_mirror_reductions;
 *     a re-sync is idempotent, a bale removed from the invoice (or an
 *     un-finalized or deleted invoice) is put back with the value it took.
 *     Only invoices that post (dated on or after the company's factory
 *     receivable or inventory cut-over) are reduced: the bales of older
 *     invoices are written off through the plan above or left as they are.
 */
import crypto from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { adjustInventory } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "./databaseStockMovementAdapter";
import { postStockMovementTx } from "./stockMovementIntegrityService";
import { writeAuditEvent } from "../audit";
import { factoryBaleMirrorStockItemIds } from "../accounting/perpetualInventory/factoryValuation";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/** Canonical evidence of one mirror unit leaving (issue) or coming back (receipt) for an invoice. */
async function mirrorMovementTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    stockItemId: number;
    locationId: number;
    kind: "issue" | "receipt";
    unitCost: string;
    reductionId: number;
    orderId: number;
    baleId: number;
  }
): Promise<void> {
  await postStockMovementTx(
    tx,
    {
      companyId: params.companyId,
      stockItemId: params.stockItemId,
      kind: params.kind,
      quantity: "1",
      unitCost: params.unitCost,
      ...(params.kind === "issue" ? { fromLocationId: params.locationId } : { toLocationId: params.locationId }),
      occurredAt: new Date().toISOString(),
      source: {
        sourceType: "factory-invoice-mirror",
        sourceId: `${params.orderId}:${params.baleId}`,
        idempotencyKey: `factory-invoice-mirror:${params.reductionId}:${params.kind}`,
      },
      allowNegativeStock: true,
    },
    canonicalStockMovementAdapter
  );
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

export const BALE_MIRROR_WRITE_OFF_MESSAGES = {
  PLAN_CHANGED: "The bale-mirror write-off changed since it was reviewed. Preview it again and confirm the new plan.",
  NOTHING_TO_APPLY: "No bale-mirror row carries a value.",
} as const;

export class BaleMirrorWriteOffRefusal extends HttpError {
  constructor(readonly code: keyof typeof BALE_MIRROR_WRITE_OFF_MESSAGES) {
    super(409, BALE_MIRROR_WRITE_OFF_MESSAGES[code]);
    this.name = "BaleMirrorWriteOffRefusal";
  }
  get body() {
    return { code: this.code, message: this.message };
  }
}

export interface BaleMirrorRow {
  inventoryId: number;
  stockItemId: number;
  locationId: number;
  quantity: string;
  averageRate: string;
  value: string;
}

export interface BaleMirrorWriteOffPlan {
  companyId: number;
  rows: BaleMirrorRow[];
  totals: { rows: number; value: string; items: number };
  planHash: string;
}

async function mirrorValueRowsTx(executor: DatabaseOrTransaction, companyId: number, lock: boolean) {
  const mirror = [...(await factoryBaleMirrorStockItemIds(executor, companyId))];
  if (mirror.length === 0) return [];
  const ids = `{${mirror.join(",")}}`;
  return rows<{
    id: number;
    stock_item_id: number;
    location_id: number;
    quantity: string;
    rate: string;
    value: string;
  }>(
    executor,
    sql`
      SELECT i.id, i.stock_item_id, i.location_id, i.quantity::text AS quantity,
             COALESCE(i.average_rate, 0)::text AS rate, COALESCE(i.total_value, 0)::text AS value
        FROM inventory i
        JOIN locations l ON l.id = i.location_id AND l.deleted_at IS NULL
       WHERE i.company_id = ${companyId} AND i.stock_item_id = ANY(${ids}::int[])
         AND (COALESCE(i.total_value, 0) <> 0 OR COALESCE(i.average_rate, 0) <> 0)
       ORDER BY i.id
       ${lock ? sql`FOR UPDATE OF i` : sql``}
    `
  );
}

export async function planBaleMirrorWriteOffTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  lock = false
): Promise<BaleMirrorWriteOffPlan> {
  const found = await mirrorValueRowsTx(executor, companyId, lock);
  const planRows: BaleMirrorRow[] = found.map((row) => ({
    inventoryId: Number(row.id),
    stockItemId: Number(row.stock_item_id),
    locationId: Number(row.location_id),
    quantity: toMoney(row.quantity).toFixed(3),
    averageRate: toMoney(row.rate).toFixed(6),
    value: toMoney(row.value).toFixed(2),
  }));
  const total = planRows.reduce((sum, row) => sum.plus(row.value), new MoneyDecimal(0));
  const totals = {
    rows: planRows.length,
    value: total.toFixed(2),
    items: new Set(planRows.map((row) => row.stockItemId)).size,
  };
  const planHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ companyId, rows: planRows }))
    .digest("hex");
  return { companyId, rows: planRows, totals, planHash };
}

export function planBaleMirrorWriteOff(companyId: number): Promise<BaleMirrorWriteOffPlan> {
  return planBaleMirrorWriteOffTx(db, companyId);
}

export async function applyBaleMirrorWriteOff(
  companyId: number,
  params: { planHash: string; actor: { userId: string; username: string } }
): Promise<BaleMirrorWriteOffPlan> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bale_mirror_write_off'), ${companyId})`);
    const plan = await planBaleMirrorWriteOffTx(tx, companyId, true);
    if (plan.planHash !== params.planHash) throw new BaleMirrorWriteOffRefusal("PLAN_CHANGED");
    if (plan.rows.length === 0) throw new BaleMirrorWriteOffRefusal("NOTHING_TO_APPLY");
    const ids = `{${plan.rows.map((row) => row.inventoryId).join(",")}}`;
    await tx.execute(sql`
      UPDATE inventory SET total_value = 0, average_rate = 0, last_updated = now()
       WHERE company_id = ${companyId} AND id = ANY(${ids}::int[])
    `);
    await writeAuditEvent(
      {
        userId: params.actor.userId,
        username: params.actor.username,
        companyId,
        action: "update",
        tableName: "inventory",
        recordId: companyId,
        recordIdentifier: "bale-mirror-write-off",
        changes: {
          baleMirrorValues: {
            old: plan.rows.map((row) => ({ id: row.inventoryId, rate: row.averageRate, value: row.value })),
            new: plan.rows.map((row) => ({ id: row.inventoryId, rate: "0", value: "0.00" })),
          },
          totals: { old: null, new: { ...plan.totals, planHash: plan.planHash } },
        },
      },
      tx
    );
    return plan;
  });
}

interface InvoicedBale {
  bale_id: number;
  location_id: number | null;
  item_code: string | null;
}

/**
 * Takes the invoiced bales of an order out of the ERP mirror, or puts back
 * those no longer invoiced (see the module comment). `invoiced` is whether the
 * order is a finalized invoice that posts.
 */
export async function syncFactoryInvoiceMirrorTx(
  tx: DbTransaction,
  companyId: number,
  orderId: number,
  invoiced: boolean
): Promise<void> {
  const recorded = await rows<{
    id: number;
    bale_id: number;
    stock_item_id: number;
    location_id: number;
    value: string;
  }>(
    tx,
    sql`SELECT id, bale_id, stock_item_id, location_id, value::text AS value
          FROM factory_invoice_mirror_reductions WHERE company_id = ${companyId} AND order_id = ${orderId}
         ORDER BY id`
  );
  const wanted = invoiced
    ? await rows<InvoicedBale>(
        tx,
        sql`
          SELECT cob.bale_id, COALESCE(cob.location_id, b.erp_location_id) AS location_id,
                 COALESCE(NULLIF(p.article_code, ''), p.code) AS item_code
            FROM customer_order_bales cob
            JOIN factory_bales b ON b.id = cob.bale_id AND b.company_id = ${companyId}
            LEFT JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${companyId}
           WHERE cob.order_id = ${orderId}
           ORDER BY cob.bale_id
        `
      )
    : [];
  if (recorded.length === 0 && wanted.length === 0) return;
  const wantedIds = new Set(wanted.map((bale) => Number(bale.bale_id)));
  for (const row of recorded) {
    if (wantedIds.has(Number(row.bale_id))) continue;
    await adjustInventory(tx, row.location_id, row.stock_item_id, 1, companyId, 0, undefined, undefined, {
      incomingValue: toMoney(row.value).toFixed(2),
    });
    await mirrorMovementTx(tx, {
      companyId,
      stockItemId: Number(row.stock_item_id),
      locationId: Number(row.location_id),
      kind: "receipt",
      unitCost: toMoney(row.value).toFixed(2),
      reductionId: Number(row.id),
      orderId,
      baleId: Number(row.bale_id),
    });
    await tx.execute(sql`DELETE FROM factory_invoice_mirror_reductions WHERE id = ${row.id}`);
  }
  const done = new Set(recorded.map((row) => Number(row.bale_id)));
  const mirror = await factoryBaleMirrorStockItemIds(tx, companyId);
  const itemByCode = new Map<string, number | null>();
  for (const bale of wanted) {
    if (done.has(Number(bale.bale_id)) || !bale.location_id || !bale.item_code) continue;
    if (!itemByCode.has(bale.item_code)) {
      const [item] = await rows<{ id: number }>(
        tx,
        sql`SELECT id FROM stock_items WHERE company_id = ${companyId} AND code = ${bale.item_code}
             ORDER BY id LIMIT 1`
      );
      itemByCode.set(bale.item_code, item && mirror.has(Number(item.id)) ? Number(item.id) : null);
    }
    const stockItemId = itemByCode.get(bale.item_code);
    if (!stockItemId) continue;
    // Only a bale the mirror holds at that location is taken out.
    const [held] = await rows<{ quantity: string }>(
      tx,
      sql`SELECT quantity::text AS quantity FROM inventory
           WHERE company_id = ${companyId} AND location_id = ${bale.location_id} AND stock_item_id = ${stockItemId}`
    );
    if (!held || !toMoney(held.quantity).gt(0)) continue;
    const result = await adjustInventory(tx, Number(bale.location_id), stockItemId, -1, companyId);
    const relieved: Decimal = toMoney(result.valueDelta).negated();
    const [reduction] = await rows<{ id: number }>(
      tx,
      sql`
        INSERT INTO factory_invoice_mirror_reductions
          (company_id, order_id, bale_id, stock_item_id, location_id, quantity, value)
        VALUES (${companyId}, ${orderId}, ${bale.bale_id}, ${stockItemId}, ${bale.location_id}, 1, ${relieved.toFixed(2)})
        RETURNING id
      `
    );
    await mirrorMovementTx(tx, {
      companyId,
      stockItemId,
      locationId: Number(bale.location_id),
      kind: "issue",
      unitCost: relieved.toFixed(2),
      reductionId: Number(reduction.id),
      orderId,
      baleId: Number(bale.bale_id),
    });
  }
}
