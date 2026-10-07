/**
 * Opening inventory journal for the perpetual-inventory cut-over (wave 8).
 *
 * Under the periodic method the stock on hand was never in the ledger: its cost
 * went to expense when it was bought. At the cut-over that stock is
 * capitalised once, dated the eve of the cut-over:
 *
 *   Dr Inventory                     ERP stock (sub-ledger value as of the eve)
 *   Dr Factory Raw Material Stock    remaining kg × landed USD cost per kg
 *   Dr Factory Work in Progress      open mix-batch kg × mix cost per kg,
 *                                    plus bales awaiting pressing
 *   Dr Factory Finished Goods        bales held, at their recorded cost
 *      Cr Opening Balance Equity     the total
 *
 * The plan is read-only. Rows that carry no cost are listed, never valued at a
 * guess. Applying requires an Owner, PERPETUAL_INVENTORY_POSTING_READY, and a
 * cut-over date that is today or earlier (the factory figures are current
 * values; the ERP figure is computed as of the eve). It posts the journal and
 * records the cut-over in one transaction, once per company.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { computeStockInHand } from "../../../routes/stats/netProfitStockSection";
import { ensureSystemAccounts } from "../systemAccounts";
import { DEFAULT_PERPETUAL_INVENTORY_FROM, PERPETUAL_INVENTORY_POSTING_READY, getInventoryCutover } from "./cutover";

export interface OpeningJournalLine {
  accountCode: string;
  amount: string;
  basis: string;
}

export interface UnvaluedRow {
  source: "factory_raw_stock" | "factory_mix_batches" | "factory_bales";
  id: number;
  reason: string;
}

export interface OpeningInventoryPlan {
  companyId: number;
  effectiveFrom: string;
  /** The journal's date: the eve of the cut-over. */
  journalDate: string;
  lines: OpeningJournalLine[];
  total: string;
  unvalued: UnvaluedRow[];
  /** Bales already marked sold on orders that are not finalized: shipped but not yet invoiced. */
  soldNotInvoiced: { bales: number; cost: string };
  /** Supplier-partner company: ERP stock is carried in sp_stock and not capitalised here. */
  supplierPartner: boolean;
  alreadyApplied: boolean;
  postingReady: boolean;
}

export class OpeningJournalRefusal extends Error {
  constructor(
    readonly code: "POSTING_NOT_READY" | "ALREADY_APPLIED" | "CUTOVER_IN_FUTURE" | "INVALID_DATE",
    message: string
  ) {
    super(message);
    this.name = "OpeningJournalRefusal";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as unknown as T[];
}

/** Read-only: the opening inventory journal for one company. */
export async function planOpeningInventoryJournal(
  companyId: number,
  effectiveFrom: string = DEFAULT_PERPETUAL_INVENTORY_FROM
): Promise<OpeningInventoryPlan> {
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const journalDate = dayBefore(effectiveFrom);
  const unvalued: UnvaluedRow[] = [];

  // Supplier-partner companies carry their stock in their own sp_stock
  // accounts already; their ERP stock is not capitalised a second time.
  const company = await rows<{ company_type: string | null }>(
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  const supplierPartner = company[0]?.company_type === "supplier_partner";
  const erpStock = supplierPartner
    ? new MoneyDecimal(0)
    : toMoney(await computeStockInHand(companyId, journalDate)).toDecimalPlaces(2);

  const raw = await rows<{ id: number; remaining: string; cost: string | null }>(sql`
    SELECT id, (received_kg - used_kg)::text AS remaining, cost_per_kg_usd::text AS cost
      FROM factory_raw_stock
     WHERE company_id = ${companyId} AND received_kg - used_kg > 0
  `);
  let rawValue: Decimal = new MoneyDecimal(0);
  for (const row of raw) {
    if (row.cost === null) {
      unvalued.push({ source: "factory_raw_stock", id: row.id, reason: "no USD cost per kg" });
      continue;
    }
    rawValue = rawValue.plus(toMoney(row.remaining).times(toMoney(row.cost)));
  }

  const mixes = await rows<{ id: number; remaining: string; cost: string }>(sql`
    SELECT id, (total_weight_kg - used_kg)::text AS remaining, cost_per_kg::text AS cost
      FROM factory_mix_batches
     WHERE company_id = ${companyId} AND deleted_at IS NULL AND status <> 'CLOSED'
       AND total_weight_kg - used_kg > 0
  `);
  let wipValue: Decimal = new MoneyDecimal(0);
  for (const row of mixes) wipValue = wipValue.plus(toMoney(row.remaining).times(toMoney(row.cost)));

  const bales = await rows<{ status: string; count: number; cost: string; zero_cost: number[] }>(sql`
    SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_cost), 0)::text AS cost,
           COALESCE(array_agg(id) FILTER (WHERE COALESCE(total_cost, 0) = 0), '{}') AS zero_cost
      FROM factory_bales
     WHERE company_id = ${companyId} AND deleted_at IS NULL
       AND status IN ('PENDING_PRESSING', 'IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
     GROUP BY status
  `);
  let finishedValue: Decimal = new MoneyDecimal(0);
  for (const row of bales) {
    if (row.status === "PENDING_PRESSING") wipValue = wipValue.plus(toMoney(row.cost));
    else finishedValue = finishedValue.plus(toMoney(row.cost));
    for (const id of row.zero_cost) unvalued.push({ source: "factory_bales", id, reason: "no recorded cost" });
  }

  const sold = await rows<{ count: number; cost: string }>(sql`
    SELECT COUNT(DISTINCT b.id)::int AS count, COALESCE(SUM(b.total_cost), 0)::text AS cost
      FROM factory_bales b
      JOIN customer_order_bales cob ON cob.bale_id = b.id
      JOIN customer_orders co ON co.id = cob.order_id
     WHERE b.company_id = ${companyId} AND b.deleted_at IS NULL AND b.status = 'SOLD'
       AND co.status NOT IN ('FINALIZED', 'CANCELLED')
  `);

  const candidates: OpeningJournalLine[] = [
    { accountCode: "INVENTORY", amount: erpStock.toFixed(2), basis: `ERP stock in hand as of ${journalDate}` },
    {
      accountCode: "FACTORY_RAW_MATERIAL_STOCK",
      amount: rawValue.toDecimalPlaces(2).toFixed(2),
      basis: "remaining kg × landed USD cost per kg",
    },
    {
      accountCode: "FACTORY_WIP",
      amount: wipValue.toDecimalPlaces(2).toFixed(2),
      basis: "open mix-batch kg × mix cost per kg, and bales awaiting pressing",
    },
    {
      accountCode: "FACTORY_FINISHED_GOODS",
      amount: finishedValue.toDecimalPlaces(2).toFixed(2),
      basis: "bales held, at their recorded cost",
    },
  ];
  const lines = candidates.filter((line) => !toMoney(line.amount).isZero());
  const total = lines.reduce((sum, line) => sum.plus(line.amount), new MoneyDecimal(0));

  return {
    companyId,
    effectiveFrom,
    journalDate,
    lines,
    total: total.toFixed(2),
    unvalued,
    soldNotInvoiced: { bales: sold[0]?.count ?? 0, cost: toMoney(sold[0]?.cost ?? 0).toFixed(2) },
    supplierPartner,
    alreadyApplied: (await getInventoryCutover(db, companyId)) !== null,
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
  };
}

/**
 * Posts the opening journal and records the cut-over, in one transaction.
 * `postingReady` exists for tests; the route always passes the real flag.
 */
export async function applyOpeningInventoryJournal(
  companyId: number,
  effectiveFrom: string,
  appliedBy: string,
  options: { postingReady?: boolean; today?: string } = {}
): Promise<{ plan: OpeningInventoryPlan; voucherId: number | null }> {
  if (!(options.postingReady ?? PERPETUAL_INVENTORY_POSTING_READY)) {
    throw new OpeningJournalRefusal(
      "POSTING_NOT_READY",
      "Perpetual inventory posting is not complete yet; the cut-over cannot be applied"
    );
  }
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (effectiveFrom > today) {
    throw new OpeningJournalRefusal("CUTOVER_IN_FUTURE", "The cut-over can be applied on or after its date");
  }

  const plan = await planOpeningInventoryJournal(companyId, effectiveFrom);
  if (plan.alreadyApplied) {
    throw new OpeningJournalRefusal("ALREADY_APPLIED", "The cut-over is already applied for this company");
  }

  const voucherId = await db.transaction(async (tx) => {
    // Serializes concurrent applies for the company; the primary key refuses a second row.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gl_inventory_cutover'), ${companyId})`);
    if (await getInventoryCutover(tx, companyId)) {
      throw new OpeningJournalRefusal("ALREADY_APPLIED", "The cut-over is already applied for this company");
    }
    let id: number | null = null;
    if (plan.lines.length > 0) {
      const codes = [...plan.lines.map((line) => line.accountCode), "OPENING_BALANCE_EQUITY"];
      const statuses = await ensureSystemAccounts(tx, companyId, codes);
      const accountId = new Map<string, number>();
      for (const status of statuses) {
        if (status.state === "missing" || status.state === "deleted") {
          throw new Error("A required system account is not available");
        }
        accountId.set(status.code, status.accountId);
      }
      const voucher = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
        INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, exchange_rate)
        VALUES (${companyId}, ${`GL-INVENTORY-OPENING-${companyId}`}, 'Journal', ${plan.journalDate},
                ${`Opening inventory at the perpetual-inventory cut-over (${effectiveFrom})`}, ${plan.total}, 'USD', 1)
        RETURNING id
      `);
      id = (voucher.rows[0] as { id: number }).id;
      for (const line of plan.lines) {
        await tx.execute(sql`
          INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
          VALUES (${id}, ${accountId.get(line.accountCode)!}, ${line.amount}, 0, ${line.basis})
        `);
      }
      await tx.execute(sql`
        INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
        VALUES (${id}, ${accountId.get("OPENING_BALANCE_EQUITY")!}, 0, ${plan.total},
                'Stock on hand capitalised at the perpetual-inventory cut-over')
      `);
    }
    await tx.execute(sql`
      INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_voucher_id, opening_plan, applied_by)
      VALUES (${companyId}, ${effectiveFrom}, ${id}, ${JSON.stringify(plan)}::jsonb, ${appliedBy})
    `);
    return id;
  });
  return { plan, voucherId };
}
