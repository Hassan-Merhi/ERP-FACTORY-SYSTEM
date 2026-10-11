/**
 * Phase 28 — factory accounting complete (accounting audit 2026-10):
 *
 *   F1   factory revenue and receivables post from the factory receivable
 *        cut-over whatever the inventory switch; the history is an opening
 *        receivable (Owner preview/apply), no back-post;
 *   F4   no-mix bales: assign to a costed mix (default), write off, or accept
 *        with a sign-off; F5 HMD16 zero-cost bales are not unvalued; F6
 *        imported bales are re-costed (blocker until then);
 *   F8   raw-material ADD/REMOVE adjustments and over-used rows are valued;
 *   F9   the daily factory journal records a dated valuation (reconciled as
 *        of a past day) and posts a missed day when nothing changed since;
 *   F10/F11  reviewed back-fill of legacy V3 loads, commissions, container
 *        import journals and no-target freight lines;
 *   F12  legacy payroll mark-paid on the session company, never twice; bulk
 *        generate rebuilds the period accrual from every payroll;
 *   I8   ERP bale-mirror values written off; a factory invoice takes its bales
 *        out of the mirror (re-sync idempotent, reversed when un-invoiced).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { syncFactoryInvoiceTx } from "../server/services/accounting/perpetualInventory/factoryInvoice";
import { factoryCutoverBlockers } from "../server/services/accounting/perpetualInventory/factoryCutoverBlockers";
import {
  catchUpFactoryStockJournalsTx,
  syncFactoryStockJournalTx,
} from "../server/services/accounting/perpetualInventory/factoryStockJournal";
import { factoryStockValuation } from "../server/services/accounting/perpetualInventory/factoryValuation";
import { reconcilePerpetualInventory } from "../server/services/accounting/perpetualInventory/reconciliation";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { planBaleRecostTx } from "../server/services/factory/baleRecost";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import {
  applyFactoryOpeningReceivable,
  isFactoryRevenuePostingActive,
  planFactoryOpeningReceivable,
} from "../server/services/factory/factoryOpeningReceivable";
import {
  applyLegacyFactoryPostings,
  planLegacyFactoryPostings,
} from "../server/services/factory/factoryLegacyPostings";
import { applyNoMixBaleResolution, planNoMixBaleResolution } from "../server/services/factory/noMixBaleResolution";
import { applyBaleMirrorWriteOff, planBaleMirrorWriteOff } from "../server/services/inventory/baleMirrorWriteOff";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p28fac";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);
const actor = { userId: "p28-owner", username: "p28 owner" };

let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId: number;
let sequence = 0;
const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("phase28-test", work);
const scoped = <T>(work: () => Promise<T>) => runInCompanyPostingScope(ctx.companyId, work);
const query = (text: string, values: unknown[] = []) => asMaintenance(() => pool.query(text, values));
const one = async (text: string, values: unknown[] = []) => (await query(text, values)).rows[0];

async function setCutover(effectiveFrom: string | null) {
  await query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  if (effectiveFrom) {
    await query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [ctx.companyId, effectiveFrom]
    );
  }
}

/** Live lines of vouchers matching `pattern`: [number, code or party, debit, credit]. */
async function journal(pattern: string) {
  const { rows } = await query(
    `SELECT v.voucher_number, COALESCE(la.code, 'FS-' || ve.factory_supplier_id::text, 'SUP-' || ve.supplier_id::text) AS code,
            ROUND(ve.debit_amount, 2)::text AS d, ROUND(ve.credit_amount, 2)::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL
      ORDER BY v.id, ve.id`,
    [ctx.companyId, pattern]
  );
  return rows.map((row) => [row.voucher_number, row.code, row.d, row.c]);
}

async function invoice(values: { total: string; date: string; status?: string }) {
  sequence += 1;
  const row = await one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total, finalized_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date + time '12:00') RETURNING id`,
    [
      ctx.companyId,
      customerId,
      values.date,
      values.status ?? "FINALIZED",
      `${PREFIX}-INV-${sequence}`,
      values.total,
      values.date,
    ]
  );
  return Number(row.id);
}

async function bale(values: {
  article: string;
  cost: string;
  mix?: number | null;
  product?: number | null;
  importBatch?: number | null;
  weight?: string;
  status?: string;
}) {
  sequence += 1;
  const reference = `${PREFIX}-B-${sequence}`;
  const row = await one(
    `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name, weight_kg,
                                cost_per_kg, total_cost, status, erp_location_id, mix_batch_id, product_id,
                                import_batch_id, stock_entry_date)
     VALUES ($1, $2::text, $2::text, $3::text, $3::text, $4, '1', $5, $6, $7, $8, $9, $10, CURRENT_DATE) RETURNING id`,
    [
      ctx.companyId,
      reference,
      values.article,
      values.weight ?? "25.000",
      values.cost,
      values.status ?? "IN_STOCK",
      ctx.locationId,
      values.mix ?? null,
      values.product ?? null,
      values.importBatch ?? null,
    ]
  );
  return Number(row.id);
}

async function mix(costPerKg: string, weight = "100.000") {
  sequence += 1;
  const row = await one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, used_kg, cost_per_kg, total_cost, status, batch_date)
     VALUES ($1, $2, $3, $3, $4, 0, 'CLOSED', CURRENT_DATE - 1) RETURNING id`,
    [ctx.companyId, `${PREFIX}-MIX-${sequence}`, weight, costPerKg]
  );
  return Number(row.id);
}

async function resetFactory() {
  for (const table of [
    "factory_bale_cost_resolutions",
    "factory_invoice_mirror_reductions",
    "factory_stock_valuation_snapshots",
    "factory_stock_value_events",
    "factory_raw_material_adjustments",
    "factory_container_receipts",
    "factory_raw_stock",
    "factory_bales",
    "factory_mix_batches",
  ]) {
    await query(`DELETE FROM ${table} WHERE company_id = $1`, [ctx.companyId]);
  }
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureFactoryCostBasisSchema(pool);
  await query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  const row = await one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`, [
    ctx.companyId,
    `${PREFIX}-CUST`,
    `${PREFIX} Customer`,
  ]);
  customerId = Number(row.id);
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await setCutover(null);
  await query(`DELETE FROM factory_ar_cutovers WHERE company_id = $1`, [id]);
  await resetFactory();
  await query(
    `DELETE FROM factory_v3_load_bales WHERE load_id IN (SELECT id FROM factory_v3_loads WHERE company_id = $1)`,
    [id]
  );
  await query(`DELETE FROM factory_v3_loads WHERE company_id = $1`, [id]);
  await query(`DELETE FROM customer_balances WHERE company_id = $1`, [id]);
  for (const table of ["customer_order_bales", "customer_order_lines", "customer_order_charges"]) {
    await query(`DELETE FROM ${table} WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`, [id]);
  }
  await query(`DELETE FROM customer_orders WHERE company_id = $1`, [id]);
  for (const table of ["factory_payrolls", "factory_workers", "factory_daybook_entries", "factory_containers"]) {
    await query(`DELETE FROM ${table} WHERE company_id = $1`, [id]).catch(() => undefined);
  }
  await query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [id]).catch(() => undefined);
  await query(`DELETE FROM factory_bale_products WHERE company_id = $1`, [id]).catch(() => undefined);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("F1 — factory receivables independent of the inventory switch", () => {
  it("posts nothing before a cut-over, then opens the history as one receivable and posts later invoices", async () => {
    await setCutover(null);
    const old1 = await invoice({ total: "300.00", date: day(-20) });
    const old2 = await invoice({ total: "200.00", date: day(-10) });
    await scoped(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, ctx.companyId, old1)));
    expect(await journal(`INV-GL-${ctx.companyId}-%`)).toEqual([]);
    expect(await scoped(() => isFactoryRevenuePostingActive(db, ctx.companyId, today))).toBe(false);

    const plan = await scoped(() => planFactoryOpeningReceivable(ctx.companyId, day(-5)));
    expect(plan.lines.map((line) => [line.orderId, line.amount, line.currency])).toEqual([
      [old1, "300.00", "USD"],
      [old2, "200.00", "USD"],
    ]);
    expect(plan.totals).toEqual([{ currency: "USD", amount: "500.00", invoices: 2 }]);
    expect(plan.blockers).toEqual([]);
    expect(plan.journalDate).toBe(day(-6));

    const future = await scoped(() => planFactoryOpeningReceivable(ctx.companyId, day(5)));
    expect(future.blockers).toContain("CUTOVER_IN_FUTURE");

    await expect(
      scoped(() =>
        applyFactoryOpeningReceivable(ctx.companyId, { effectiveFrom: day(-5), planHash: "0".repeat(64), actor })
      )
    ).rejects.toMatchObject({ statusCode: 409, code: "PLAN_CHANGED" });

    // An invoice dated on or after the cut-over is posted by the apply itself.
    const recent = await invoice({ total: "75.00", date: day(-2) });
    const fresh = await scoped(() => planFactoryOpeningReceivable(ctx.companyId, day(-5)));
    expect(fresh.toPost.map((entry) => entry.orderId)).toEqual([recent]);
    const applied = await scoped(() =>
      applyFactoryOpeningReceivable(ctx.companyId, { effectiveFrom: day(-5), planHash: fresh.planHash, actor })
    );
    expect(applied.voucherIds).toHaveLength(1);
    const opening = await journal(`INV-OPEN-AR-${ctx.companyId}-USD`);
    expect(opening.map(([, code, d, c]) => [code, d, c])).toEqual([
      [`CUST-${customerId}`, "300.00", "0.00"],
      [`CUST-${customerId}`, "200.00", "0.00"],
      ["OPENING_BALANCE_EQUITY", "0.00", "500.00"],
    ]);
    const openingVoucher = await one(`SELECT voucher_date::text AS d FROM vouchers WHERE id = $1`, [
      applied.voucherIds[0],
    ]);
    expect(openingVoucher.d).toBe(day(-6));
    // Receivable and revenue only: no inventory cut-over, so no cost of sales.
    expect((await journal(`INV-GL-${ctx.companyId}-${recent}`)).map(([, code, d, c]) => [code, d, c])).toEqual([
      [`CUST-${customerId}`, "75.00", "0.00"],
      ["FACTORY_BALE_SALES_INCOME", "0.00", "75.00"],
    ]);
    const lines = await one(
      `SELECT COUNT(*)::int AS n FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.voucher_number = $1 AND ve.customer_id = $2`,
      [`INV-OPEN-AR-${ctx.companyId}-USD`, customerId]
    );
    expect(lines.n).toBe(2);

    // A new invoice after the apply posts on its own.
    const later = await invoice({ total: "40.00", date: today });
    await scoped(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, ctx.companyId, later)));
    expect(await journal(`INV-GL-${ctx.companyId}-${later}`)).toHaveLength(2);

    await expect(
      scoped(() =>
        applyFactoryOpeningReceivable(ctx.companyId, { effectiveFrom: day(-5), planHash: fresh.planHash, actor })
      )
    ).rejects.toMatchObject({ code: "ALREADY_APPLIED" });
    const audit = await one(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND table_name = 'factory_ar_cutovers' ORDER BY id DESC LIMIT 1`,
      [ctx.companyId]
    );
    expect(audit.changes.openingReceivable.new.totals).toEqual([{ currency: "USD", amount: "500.00", invoices: 2 }]);
  }, 60_000);

  it("keeps the Owner apply route Owner-only", async () => {
    const plan = await agent.get(`/api/accounting/factory-opening-receivable/plan?effectiveFrom=${today}`);
    expect(plan.status).toBe(200);
    const apply = await agent
      .post("/api/accounting/factory-opening-receivable/apply")
      .send({ confirm: true, planHash: plan.body.planHash, effectiveFrom: today });
    expect(apply.status).toBe(403);
  });
});

describe("F4/F5/F6 — bales with no costed mix, garbage bales, imported bales", () => {
  it("assigns by default to a costed mix of the product, accepts with a sign-off, and clears the blocker", async () => {
    await resetFactory();
    const product = await one(
      `INSERT INTO factory_bale_products (company_id, code, name, production_price) VALUES ($1, $2::text, $2::text, '40') RETURNING id`,
      [ctx.companyId, `${PREFIX}-PROD`]
    );
    const mixId = await mix("1.6000000");
    await bale({ article: `${PREFIX}-ART`, cost: "40.00", mix: mixId, product: Number(product.id), status: "SOLD" });
    const assigned = await bale({
      article: `${PREFIX}-ART`,
      cost: "40.00",
      product: Number(product.id),
      weight: "20.000",
    });
    const lonely = await bale({ article: `${PREFIX}-OTHER`, cost: "55.00" });
    const garbage = await bale({ article: "HMD16-P28", cost: "0" });

    // F5: a garbage bale costs nothing by rule and is not unvalued.
    const valuation = await asMaintenance(() => factoryStockValuation(db, ctx.companyId));
    expect(valuation.unvalued.filter((row) => row.id === garbage)).toEqual([]);
    // The re-cost leaves the no-mix bales to this tool (it priced them at the catalogue price).
    const recost = await asMaintenance(() => db.transaction((tx) => planBaleRecostTx(tx, ctx.companyId)));
    expect(recost.noMixBales).toBe(2);
    expect(recost.bales.map((line) => line.id)).not.toContain(assigned);

    const blockers = await asMaintenance(() => factoryCutoverBlockers(db, ctx.companyId));
    expect(blockers.noMixBales.baleIds).toEqual([assigned, lonely]);

    const plan = await scoped(() => planNoMixBaleResolution(ctx.companyId));
    const line = plan.bales.find((entry) => entry.baleId === assigned)!;
    expect(line.candidate).toMatchObject({ mixBatchId: mixId, newTotalCost: "32.0000000" });
    expect(line.defaultAction).toBe("assign");
    expect(plan.bales.find((entry) => entry.baleId === lonely)!.defaultAction).toBeNull();

    await expect(
      scoped(() => applyNoMixBaleResolution(ctx.companyId, { planHash: plan.planHash, actor }))
    ).rejects.toMatchObject({ code: "ACTION_REQUIRED", baleIds: [lonely] });
    await expect(
      scoped(() => applyNoMixBaleResolution(ctx.companyId, { planHash: plan.planHash, unmatched: "accept", actor }))
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const result = await scoped(() =>
      applyNoMixBaleResolution(ctx.companyId, {
        planHash: plan.planHash,
        unmatched: "accept",
        reason: "Owner accepts the counted cost",
        actor,
      })
    );
    expect(result.applied.map((entry) => [entry.baleId, entry.action])).toEqual([
      [assigned, "assign"],
      [lonely, "accept"],
    ]);
    const after = await one(`SELECT mix_batch_id, total_cost::text AS cost FROM factory_bales WHERE id = $1`, [
      assigned,
    ]);
    expect(after).toEqual({ mix_batch_id: mixId, cost: "32.0000000" });
    expect((await asMaintenance(() => factoryCutoverBlockers(db, ctx.companyId))).noMixBales.count).toBe(0);
    const resolutions = await query(
      `SELECT bale_id, action FROM factory_bale_cost_resolutions WHERE company_id = $1 ORDER BY bale_id`,
      [ctx.companyId]
    );
    expect(resolutions.rows).toEqual([
      { bale_id: assigned, action: "ASSIGN" },
      { bale_id: lonely, action: "ACCEPT" },
    ]);
    // An accepted bale whose cost changes again is listed again.
    await query(`UPDATE factory_bales SET total_cost = 56 WHERE id = $1`, [lonely]);
    expect((await asMaintenance(() => factoryCutoverBlockers(db, ctx.companyId))).noMixBales.baleIds).toEqual([lonely]);
  }, 60_000);

  it("blocks an imported bale until the re-cost values it from its mix (F6)", async () => {
    await resetFactory();
    const mixId = await mix("2.0000000");
    const imported = await bale({ article: `${PREFIX}-IMP`, cost: "99.00", mix: mixId, importBatch: 1 });
    const blockers = await asMaintenance(() => factoryCutoverBlockers(db, ctx.companyId));
    expect(blockers.importedNotRecosted).toMatchObject({ count: 1, baleIds: [imported] });
    await query(`UPDATE factory_bales SET total_cost = 50 WHERE id = $1`, [imported]);
    expect((await asMaintenance(() => factoryCutoverBlockers(db, ctx.companyId))).importedNotRecosted.count).toBe(0);
  });
});

describe("F8 — raw-material adjustments and over-use are valued", () => {
  it("adds an ADD at its cost, takes a REMOVE at the supplier rate and values an over-used row", async () => {
    await resetFactory();
    const supplier = await one(
      `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, 1.5) RETURNING id`,
      [ctx.companyId, `${PREFIX} supplier`]
    );
    const container = await one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status, currency_code)
       VALUES ($1, $2, $3, 'OFFLOADED', 'USD') RETURNING id`,
      [ctx.companyId, `${PREFIX}-C-F8`, supplier.id]
    );
    await query(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
       VALUES ($1, $2, 100, 120, 1, 1)`,
      [ctx.companyId, container.id]
    );
    await query(
      `INSERT INTO factory_raw_material_adjustments (company_id, date, type, kg, cost_per_kg, currency_code, supplier_id)
       VALUES ($1, $2, 'ADD', 50, 2, 'USD', $3), ($1, $2, 'REMOVE', 10, 0, 'USD', $3)`,
      [ctx.companyId, today, supplier.id]
    );
    const valuation = await asMaintenance(() => factoryStockValuation(db, ctx.companyId));
    // over-use −20 × 1 = −20; ADD 50 × 2 = 100; REMOVE 10 × 1.5 = −15.
    expect(valuation.raw.toFixed(2)).toBe("65.00");
    expect(valuation.unvalued).toEqual([]);
  });
});

describe("F9 — dated factory valuation, catch-up", () => {
  it("records the valuation per day, reconciles a past day against it and posts a missed unchanged day", async () => {
    await resetFactory();
    await setCutover(day(-10));
    await bale({ article: `${PREFIX}-F9`, cost: "30.00", mix: await mix("1.2000000") });
    await query(`UPDATE factory_bales SET updated_at = now() - interval '5 days' WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    await query(`UPDATE factory_mix_batches SET updated_at = now() - interval '5 days' WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    // The last journal ran four days ago; nothing changed since.
    const first = await scoped(() => db.transaction((tx) => syncFactoryStockJournalTx(tx, ctx.companyId, day(-4))));
    expect(first.voucherId).not.toBeNull();
    const snapshot = await one(
      `SELECT finished::text AS finished, basis FROM factory_stock_valuation_snapshots WHERE company_id = $1 AND valuation_date = $2`,
      [ctx.companyId, day(-4)]
    );
    expect(snapshot).toEqual({ finished: "30.00", basis: "journal" });

    const caught = await scoped(() => db.transaction((tx) => catchUpFactoryStockJournalsTx(tx, ctx.companyId, today)));
    expect(caught.notRecoverable).toEqual([]);
    expect(caught.posted.map((entry) => entry.date)).toEqual([day(-3)]);
    expect(caught.unchangedDays).toEqual([day(-2), day(-1)]);

    // A change today: today's valuation differs, yesterday's snapshot still reconciles yesterday.
    await bale({ article: `${PREFIX}-F9`, cost: "10.00", mix: await mix("1.0000000") });
    const past = await asMaintenance(() => reconcilePerpetualInventory(db, ctx.companyId, day(-1)));
    const finished = past.lines.find((line) => line.accountCode === "FACTORY_FINISHED_GOODS")!;
    expect(finished).toMatchObject({ ledger: "30.00", subLedger: "30.00", asOfBasis: "as-of" });

    // A missed day after which the factory changed is not recoverable.
    await query(`DELETE FROM factory_stock_valuation_snapshots WHERE company_id = $1 AND valuation_date > $2`, [
      ctx.companyId,
      day(-4),
    ]);
    await query(
      `UPDATE vouchers SET deleted_at = now(), voucher_number = voucher_number || '~DEL' || id::text
        WHERE company_id = $1 AND voucher_number LIKE $2 AND voucher_date > $3`,
      [ctx.companyId, `GL-FACTORY-STOCK-${ctx.companyId}-%`, day(-4)]
    );
    const lost = await scoped(() => db.transaction((tx) => catchUpFactoryStockJournalsTx(tx, ctx.companyId, today)));
    expect(lost.notRecoverable).toEqual([day(-3), day(-2), day(-1)]);
    expect(lost.posted).toEqual([]);

    await expect(asMaintenance(() => reconcilePerpetualInventory(db, ctx.companyId, day(-11)))).rejects.toMatchObject({
      statusCode: 400,
      code: "RECONCILIATION_BEFORE_CUTOVER",
    });
    await setCutover(null);
  }, 60_000);
});

describe("F10/F11 — legacy factory postings back-filled through the engine", () => {
  it("plans and posts the commission, the import journal and the no-target freight line", async () => {
    await resetFactory();
    const supplier = await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      ctx.companyId,
      `${PREFIX} legacy supplier`,
    ]);
    const container = await one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status, currency_code, total_kg,
                                       rate_per_kg, commission_amount, commission_currency_code, arrival_date)
       VALUES ($1, $2, $3, 'OFFLOADED', 'USD', 1000, 0.5, 120, 'USD', $4) RETURNING id`,
      [ctx.companyId, `${PREFIX}-C-LEG`, supplier.id, day(-30)]
    );
    await query(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status, currency_code, total_kg, rate_per_kg)
       VALUES ($1, $2, $3, 'PENDING', 'USD', 10, 1)`,
      [ctx.companyId, `${PREFIX}-C-PEND`, supplier.id]
    );
    const cash = ctx.cashAccountId;
    const freight = await withFixtureTransaction(async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      await client.query("SET LOCAL app.ledger_integrity_bypass = 'on'");
      const { rows } = await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
         VALUES ($1, $2, 'Payment', $3, 80, 'USD') RETURNING id`,
        [ctx.companyId, `FACTORY-FREIGHT-${container.id}-1700000000000`, day(-29)]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
         VALUES ($1, NULL, 80, 0, 'Freight'), ($1, $2, 0, 80, 'Freight paid')`,
        [rows[0].id, cash]
      );
      return Number(rows[0].id);
    });

    const plan = await scoped(() => planLegacyFactoryPostings(ctx.companyId));
    const mine = plan.items.filter((item) => item.id === Number(container.id) || item.id === freight);
    expect(mine.map((item) => [item.family, item.amount, item.postingDate])).toEqual([
      ["commissions", "120.00", day(-30)],
      ["imports", "500.00", day(-30)],
      ["noTargetLines", "80.00", day(-29)],
    ]);
    expect(plan.excluded.map((item) => item.reason)).toContain("pending: posted when the container is confirmed");

    await expect(
      scoped(() => applyLegacyFactoryPostings(ctx.companyId, { planHash: "0".repeat(64), actor }))
    ).rejects.toMatchObject({ code: "PLAN_CHANGED" });
    const result = await scoped(() => applyLegacyFactoryPostings(ctx.companyId, { planHash: plan.planHash, actor }));
    expect(result.posted.every((entry) => entry.voucherId !== null || entry.family === "v3Loads")).toBe(true);
    expect((await journal(`FACTORY-COMM-${container.id}`)).map(([, code, d, c]) => [code, d, c])).toEqual([
      ["FACTORY_IMPORT_COST", "120.00", "0.00"],
      [`FS-${supplier.id}`, "0.00", "120.00"],
    ]);
    expect((await journal(`FACTORY-IMPORT-${container.id}-%`)).map(([, code, d, c]) => [code, d, c])).toEqual([
      ["FACTORY_IMPORT_COST", "500.00", "0.00"],
      [`FS-${supplier.id}`, "0.00", "500.00"],
    ]);
    const retired = await one(`SELECT deleted_at IS NOT NULL AS retired FROM vouchers WHERE id = $1`, [freight]);
    expect(retired.retired).toBe(true);
    const reposted = await journal(`FACTORY-FREIGHT-${container.id}-R${freight}`);
    expect(reposted.map(([, code, d, c]) => [code, d, c])).toEqual([
      ["FACTORY_FREIGHT_EXPENSE", "80.00", "0.00"],
      [expect.any(String), "0.00", "80.00"],
    ]);
    const again = await scoped(() => planLegacyFactoryPostings(ctx.companyId));
    expect(again.items.filter((item) => item.id === Number(container.id) || item.id === freight)).toEqual([]);
  }, 60_000);
});

describe("I8 — ERP bale mirror", () => {
  it("writes mirror values off and takes invoiced bales out of the mirror, reversibly", async () => {
    await resetFactory();
    const product = await one(
      `INSERT INTO factory_bale_products (company_id, code, name) VALUES ($1, $2::text, $2::text) RETURNING id`,
      [ctx.companyId, `${PREFIX}-MIRROR`]
    );
    const item = await one(
      `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2::text, $2::text, 'BALE', true) RETURNING id`,
      [ctx.companyId, `${PREFIX}-MIRROR`]
    );
    await query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, 3, 10, 30)`,
      [ctx.companyId, ctx.locationId, item.id]
    );
    const plan = await scoped(() => planBaleMirrorWriteOff(ctx.companyId));
    expect(plan.totals).toMatchObject({ rows: 1, value: "30.00" });
    await scoped(() => applyBaleMirrorWriteOff(ctx.companyId, { planHash: plan.planHash, actor }));
    const row = await one(
      `SELECT quantity::text AS q, total_value::text AS v FROM inventory WHERE company_id = $1 AND stock_item_id = $2`,
      [ctx.companyId, item.id]
    );
    expect(row).toEqual({ q: "3.000", v: "0.00" });

    const baleId = await bale({ article: `${PREFIX}-MIRROR`, cost: "5", product: Number(product.id), status: "SOLD" });
    const order = await invoice({ total: "12.00", date: today });
    await query(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, price_used, weight)
       SELECT $1, id, reference_number, $3, 12, weight_kg FROM factory_bales WHERE id = $2`,
      [order, baleId, ctx.locationId]
    );
    await scoped(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, ctx.companyId, order)));
    await scoped(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, ctx.companyId, order)));
    const quantity = async () =>
      (
        await one(`SELECT quantity::text AS q FROM inventory WHERE company_id = $1 AND stock_item_id = $2`, [
          ctx.companyId,
          item.id,
        ])
      ).q;
    expect(await quantity()).toBe("2.000");
    await query(`UPDATE customer_orders SET status = 'DRAFT' WHERE id = $1`, [order]);
    await scoped(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, ctx.companyId, order)));
    expect(await quantity()).toBe("3.000");
  }, 60_000);
});

describe("F12 — legacy payroll paths", () => {
  it("refuses a body naming another company and a second payment of a paid payroll", async () => {
    const worker = await one(
      `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, $2, true) RETURNING id`,
      [ctx.companyId, `${PREFIX} worker`]
    );
    const payroll = await one(
      `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, base_salary, net_salary, status)
       VALUES ($1, $2, $3, $4, 100, 100, 'APPROVED') RETURNING id`,
      [ctx.companyId, worker.id, day(-30), day(-1)]
    );
    const other = await agent
      .patch(`/api/factory/payrolls/${payroll.id}/mark-paid`)
      .send({ companyId: ctx.companyId + 100000, cashAccountId: ctx.cashAccountId, paymentDate: today });
    // The company boundary middleware refuses it first; the route refuses it too.
    expect(other.status).toBe(403);
    expect(["CROSS_COMPANY_ACCESS_DENIED", "PAYROLL_COMPANY_MISMATCH"]).toContain(other.body.code);
    const paid = await agent
      .patch(`/api/factory/payrolls/${payroll.id}/mark-paid`)
      .send({ cashAccountId: ctx.cashAccountId, paymentDate: today });
    expect(paid.status).toBe(200);
    expect(await journal(`PAYMENT-PAY-${payroll.id}-PAID`)).toHaveLength(2);
    const twice = await agent
      .patch(`/api/factory/payrolls/${payroll.id}/mark-paid`)
      .set("X-Idempotency-Key", `${PREFIX}-second`)
      .send({ cashAccountId: ctx.cashAccountId, paymentDate: day(-1) });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("PAYROLL_ALREADY_PAID");
    const vouchers = await one(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
      [ctx.companyId, `PAYMENT-PAY-${payroll.id}-%`]
    );
    expect(vouchers.n).toBe(1);
  }, 60_000);

  it("keeps every batch of a period in its accrual when a second batch is generated", async () => {
    const start = "2026-03-01";
    const end = "2026-03-31";
    const workers = [];
    for (const name of ["A", "B"]) {
      workers.push(
        (
          await one(
            `INSERT INTO factory_workers (company_id, full_name, active, base_salary, salary_type)
             VALUES ($1, $2, true, 300, 'monthly') RETURNING id`,
            [ctx.companyId, `${PREFIX} gen ${name}`]
          ).catch(() =>
            one(`INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, $2, true) RETURNING id`, [
              ctx.companyId,
              `${PREFIX} gen ${name}`,
            ])
          )
        ).id
      );
    }
    for (const workerId of workers) {
      const response = await agent
        .post("/api/factory/payrolls/generate-bulk")
        .send({ workerIds: [workerId], periodStart: start, periodEnd: end, bonusPerWorker: "10" });
      expect(response.status).toBe(200);
    }
    const accrual = await one(
      `SELECT COUNT(*)::int AS lines, SUM(ve.credit_amount)::text AS credit
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.company_id = $1 AND v.voucher_number = $2 AND v.deleted_at IS NULL AND ve.credit_amount > 0`,
      [ctx.companyId, `PAYROLL-GEN-${ctx.companyId}-${start}-${end}`]
    );
    const net = await one(
      `SELECT COALESCE(SUM(net_salary + advances), 0)::numeric(20,2)::text AS total FROM factory_payrolls
        WHERE company_id = $1 AND period_start = $2 AND period_end = $3`,
      [ctx.companyId, start, end]
    );
    expect(accrual.credit).toBe(net.total);
    const live = await one(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number = $2 AND deleted_at IS NULL`,
      [ctx.companyId, `PAYROLL-GEN-${ctx.companyId}-${start}-${end}`]
    );
    expect(live.n).toBe(1);
  }, 60_000);
});
