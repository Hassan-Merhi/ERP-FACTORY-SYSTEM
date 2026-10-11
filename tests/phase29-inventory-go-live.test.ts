/**
 * Phase 29 (code) — perpetual inventory go-live (accounting audit 2026-10):
 *
 *   I3  a sale's COGS journal is dated on the sale's effective date and moves
 *       with it;
 *   I4  under perpetual inventory a landed charge with no paying account is
 *       journalled as an accrued charge (STOCK-IN then capitalises it);
 *   I5  a stock merge leaves dated evidence for the as-of replay; the
 *       reconciliation refuses a date before the cut-over (phase 28 test);
 *   I6  a Retail supplier invoice clears received-not-invoiced receipts with a
 *       price variance; GRNI aging;
 *   I7  the Retail inventory opening needs a sign-off and shows its composition;
 *   the cut-over apply takes its lock before its snapshot (a document committed
 *   while it waited is seen and refuses it);
 *   the opening raw-stock recalculation is audited, Decimal and cut-over aware;
 *   the closed-period edit refusal offers the Reverse action in the UI; the
 *   net position, net profit and bank readers sum the ledger columns.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import {
  OpeningJournalRefusal,
  applyOpeningInventoryJournal,
} from "../server/services/accounting/perpetualInventory/openingJournal";
import { postSaleCogsTx, redateSaleCogsTx } from "../server/services/accounting/perpetualInventory/saleCogs";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { postChargeVouchers } from "../server/services/containers/offload-lifecycle/charge-vouchers";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { recalcOpeningRawStockUsageTx } from "../server/services/factory/openingRawStockRecalc";
import { recordStockMergeEvidenceTx } from "../server/services/inventory/stockMergeEvidence";
import { applyRetailInventoryOpening } from "../server/services/retail/retailInventoryJournal";
import { postRetailSupplierInvoice, retailGrniAging } from "../server/services/retail/retailSupplierInvoices";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p29gol";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);
const actor = { userId: "p29-owner", username: "p29 owner" };

let ctx: TestContext;
let agent: request.SuperAgentTest;
const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("phase29-test", work);
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

async function accountByCode(code: string, type: string): Promise<number> {
  const found = await one(`SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = $2 AND deleted_at IS NULL`, [
    ctx.companyId,
    code,
  ]);
  if (found) return Number(found.id);
  const row = await one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2::text, $2::text, $3, 0, 'Dr') RETURNING id`,
    [ctx.companyId, code, type]
  );
  return Number(row.id);
}

/** A balanced fixture voucher (number, type, date, lines [account, debit, credit]). */
async function voucher(
  number: string,
  type: string,
  date: string,
  lines: Array<[number, string, string]>,
  effectiveDate: string | null = null
): Promise<number> {
  return withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const { rows } = await client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        ctx.companyId,
        number,
        type,
        date,
        effectiveDate,
        lines.reduce((sum, [, d]) => sum.plus(d), new Decimal(0)).toFixed(2),
      ]
    );
    for (const [ledger, d, c] of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, ledger, d, c]
      );
    }
    return Number(rows[0].id);
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureFactoryCostBasisSchema(pool);
  // The factory routes need a factory company.
  await query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await setCutover(null);
  for (const table of [
    "retail_supplier_invoice_receipts",
    "retail_supplier_invoices",
    "inventory_value_movements",
    "factory_raw_stock",
    "factory_mix_batch_sources",
    "factory_mix_batches",
    "factory_containers",
    "factory_suppliers",
  ]) {
    if (table === "factory_mix_batch_sources") {
      await query(
        `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
        [id]
      );
      continue;
    }
    await query(`DELETE FROM ${table} WHERE company_id = $1`, [id]).catch(() => undefined);
  }
  await query(`DELETE FROM containers WHERE company_id = $1`, [id]).catch(() => undefined);
  await query(`DELETE FROM suppliers WHERE company_id = $1`, [id]).catch(() => undefined);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("I3 — COGS on the sale's effective date", () => {
  it("dates the COGS journal on the effective date and moves it with a re-date", async () => {
    await setCutover(day(-60));
    const cash = ctx.cashAccountId;
    const sales = ctx.salesAccountId;
    const sale = await voucher(
      `${PREFIX}-SALE-1`,
      "Sales",
      day(-1),
      [
        [cash, "50.00", "0.00"],
        [sales, "0.00", "50.00"],
      ],
      day(-3)
    );
    await scoped(() =>
      db.transaction((tx) =>
        postSaleCogsTx(tx, {
          companyId: ctx.companyId,
          saleVoucherId: sale,
          saleVoucherNumber: `${PREFIX}-SALE-1`,
          voucherDate: day(-1),
          relieved: new Decimal("20.00"),
        })
      )
    );
    const cogsDate = async () =>
      (
        await one(
          `SELECT voucher_date::text AS d FROM vouchers WHERE company_id = $1 AND voucher_number = $2 AND deleted_at IS NULL`,
          [ctx.companyId, `COGS-${sale}`]
        )
      ).d;
    expect(await cogsDate()).toBe(day(-3));
    await query(`UPDATE vouchers SET effective_date = $2 WHERE id = $1`, [sale, day(-2)]);
    await scoped(() =>
      db.transaction((tx) =>
        redateSaleCogsTx(tx, {
          companyId: ctx.companyId,
          saleVoucherId: sale,
          voucherType: "Sales",
          oldDate: day(-1),
          newDate: day(-1),
          oldEffectiveDate: day(-3),
          newEffectiveDate: day(-2),
        })
      )
    );
    expect(await cogsDate()).toBe(day(-2));
    await setCutover(null);
  }, 60_000);
});

describe("I4 — landed charges with no paying account are accrued under perpetual inventory", () => {
  it("journals duties and office charges entered with no account, only once the cut-over applies", async () => {
    const supplier = await one(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::text, $2::text, 'p29@example.com') RETURNING id`,
      [ctx.companyId, `${PREFIX}-SUP`]
    );
    const container = await one(
      `INSERT INTO containers (company_id, container_number, supplier_id, import_date) VALUES ($1, $2, $3, $4) RETURNING *`,
      [ctx.companyId, `${PREFIX}-CONT`, supplier.id, day(-5)]
    );
    const input = {
      companyId: ctx.companyId,
      containerId: Number(container.id),
      mode: "create" as never,
      locationId: ctx.locationId,
      offloadDate: today,
      duties: "30.00",
      officeCharges: "12.00",
      transferCharges: "0",
      transportFees: "0",
    };
    const asContainer = { ...container, containerNumber: container.container_number } as never;
    await setCutover(null);
    await scoped(() => db.transaction((tx) => postChargeVouchers(tx, asContainer, ctx.companyId, input)));
    const before = await one(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2 AND deleted_at IS NULL`,
      [ctx.companyId, `%-${PREFIX}-CONT-%`]
    );
    expect(before.n).toBe(0);
    await setCutover(day(-30));
    await scoped(() => db.transaction((tx) => postChargeVouchers(tx, asContainer, ctx.companyId, input)));
    const { rows } = await query(
      `SELECT v.voucher_number, la.code, ROUND(ve.debit_amount, 2)::text AS d, ROUND(ve.credit_amount, 2)::text AS c
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL ORDER BY v.id, ve.id`,
      [ctx.companyId, `%-${PREFIX}-CONT-%`]
    );
    expect(rows.map((row) => [row.voucher_number.split("-")[0], row.code, row.d, row.c])).toEqual([
      ["DUTY", "DUTIES", "30.00", "0.00"],
      ["DUTY", "DUTIES_PAYABLE", "0.00", "30.00"],
      ["OFFICE", "OFFICE_CHARGES", "12.00", "0.00"],
      ["OFFICE", "OFFICE_CHARGES_PAYABLE", "0.00", "12.00"],
    ]);
    await setCutover(null);
  }, 60_000);
});

describe("I5 — stock merge evidence", () => {
  it("records a dated line out of the duplicate and into the kept item, with no journal", async () => {
    const [kept, duplicate] = ctx.stockItemIds;
    await scoped(() =>
      db.transaction((tx) =>
        recordStockMergeEvidenceTx(tx, {
          companyId: ctx.companyId,
          keptId: kept,
          duplicateId: duplicate,
          rows: [{ locationId: ctx.locationId, quantity: "4.000", totalValue: "18.40" }],
          actor,
        })
      )
    );
    const { rows } = await query(
      `SELECT stock_item_id, quantity_delta::text AS q, value_delta::text AS v, movement_date::text AS d
         FROM inventory_value_movements WHERE company_id = $1 AND source_type = 'stock-merge' ORDER BY id`,
      [ctx.companyId]
    );
    expect(rows).toEqual([
      { stock_item_id: duplicate, q: "-4.000", v: "-18.40", d: today },
      { stock_item_id: kept, q: "4.000", v: "18.40", d: today },
    ]);
    const journal = await one(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'INV-MOVE-%stock-merge%'`,
      [ctx.companyId]
    );
    expect(journal.n).toBe(0);
  });
});

describe("I6 — Retail supplier invoices clear received-not-invoiced", () => {
  it("lists open receipts by age, clears them with a price variance, once", async () => {
    const grni = await accountByCode("RETAIL-GRNI", "Liability");
    const inventory = await accountByCode("RETAIL-INVENTORY", "Asset");
    await accountByCode("RETAIL-INVENTORY-ADJUSTMENT", "Expense");
    const receipt1 = await voucher(`${PREFIX}-RCV-1`, "Journal", day(-40), [
      [inventory, "100.00", "0.00"],
      [grni, "0.00", "100.00"],
    ]);
    const receipt2 = await voucher(`${PREFIX}-RCV-2`, "Journal", day(-5), [
      [inventory, "20.00", "0.00"],
      [grni, "0.00", "20.00"],
    ]);
    const supplier = await one(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::text, $2::text, 'p29r@example.com') RETURNING id`,
      [ctx.companyId, `${PREFIX}-RSUP`]
    );
    const aging = await scoped(() => retailGrniAging(ctx.companyId));
    expect(aging.openTotal).toBe("120.00");
    expect(aging.buckets.find((bucket) => bucket.bucket === "31-60")).toMatchObject({ receipts: 1, amount: "100.00" });
    expect(aging.difference).toBe("0.00");

    const posted = await scoped(() =>
      postRetailSupplierInvoice(ctx.companyId, {
        supplierId: Number(supplier.id),
        invoiceNumber: "SINV-1",
        invoiceDate: today,
        amount: "105.00",
        receiptVoucherIds: [receipt1],
        actor,
      })
    );
    expect(posted).toMatchObject({ grniCleared: "100.00", variance: "5.00" });
    const { rows } = await query(
      `SELECT COALESCE(la.code, 'SUP') AS code, ve.supplier_id, ROUND(ve.debit_amount, 2)::text AS d,
              ROUND(ve.credit_amount, 2)::text AS c
         FROM voucher_entries ve LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [posted.voucherId]
    );
    expect(rows.map((row) => [row.code, row.d, row.c])).toEqual([
      ["RETAIL-GRNI", "100.00", "0.00"],
      ["RETAIL-INVENTORY-ADJUSTMENT", "5.00", "0.00"],
      ["SUP", "0.00", "105.00"],
    ]);
    expect(rows[2].supplier_id).toBe(Number(supplier.id));
    const after = await scoped(() => retailGrniAging(ctx.companyId));
    expect(after.receipts.map((receipt) => receipt.voucherId)).toEqual([receipt2]);
    expect(after.difference).toBe("0.00");

    await expect(
      scoped(() =>
        postRetailSupplierInvoice(ctx.companyId, {
          supplierId: Number(supplier.id),
          invoiceNumber: "SINV-2",
          invoiceDate: today,
          amount: "100.00",
          receiptVoucherIds: [receipt1],
          actor,
        })
      )
    ).rejects.toMatchObject({ code: "RECEIPT_NOT_OPEN", receiptVoucherIds: [receipt1] });
    await expect(
      scoped(() =>
        postRetailSupplierInvoice(ctx.companyId, {
          supplierId: Number(supplier.id),
          invoiceNumber: "SINV-1",
          invoiceDate: today,
          amount: "20.00",
          receiptVoucherIds: [receipt2],
          actor,
        })
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_INVOICE" });
  }, 60_000);
});

describe("I7 — Retail inventory opening sign-off", () => {
  it("refuses the apply without a sign-off of at least 10 characters", async () => {
    await expect(
      applyRetailInventoryOpening(ctx.companyId, {
        openingDate: today,
        planHash: "0".repeat(64),
        actor: { userId: actor.userId },
        signOff: "ok",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "RETAIL_INVENTORY_OPENING_SIGN_OFF_REQUIRED" });
  });
});

describe("cut-over apply takes its lock before its snapshot", () => {
  it("sees a document committed while it waited for the lock, and refuses", async () => {
    await setCutover(null);
    await query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
    await query(`UPDATE vouchers SET voucher_date = $2 WHERE company_id = $1 AND voucher_date >= $2`, [
      ctx.companyId,
      day(-1),
    ]);
    const client = await pool.connect();
    let applied: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('gl_inventory_cutover'), $1)", [ctx.companyId]);
      const { rows } = await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', $3, 5) RETURNING id`,
        [ctx.companyId, `${PREFIX}-RACE`, today]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 5, 0), ($1, $3, 0, 5)`,
        [rows[0].id, ctx.cashAccountId, ctx.salesAccountId]
      );
      applied = asMaintenance(() =>
        applyOpeningInventoryJournal(ctx.companyId, today, "test", { postingReady: true, today })
      ).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const outcome = await applied;
    expect(outcome).toBeInstanceOf(OpeningJournalRefusal);
    expect((outcome as OpeningJournalRefusal).code).toBe("DOCUMENTS_ON_OR_AFTER_CUTOVER");
    const cutover = await one(`SELECT 1 AS found FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
    expect(cutover).toBeUndefined();
  }, 60_000);
});

describe("opening raw-stock recalculation", () => {
  it("allocates FIFO in Decimal, audits the changed rows and is refused after the cut-over", async () => {
    await setCutover(null);
    const supplier = await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      ctx.companyId,
      `${PREFIX} raw supplier`,
    ]);
    const container = await one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status) VALUES ($1, $2, $3, 'OPENING_BALANCE') RETURNING id`,
      [ctx.companyId, `${PREFIX}-OB-1`, supplier.id]
    );
    const rowA = await one(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, offloaded_at)
       VALUES ($1, $2, 10.1, 0, 1, now() - interval '2 days') RETURNING id`,
      [ctx.companyId, container.id]
    );
    const container2 = await one(
      `INSERT INTO factory_containers (company_id, container_number, supplier_id, status) VALUES ($1, $2, $3, 'OPENING_BALANCE') RETURNING id`,
      [ctx.companyId, `${PREFIX}-OB-2`, supplier.id]
    );
    const rowB = await one(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, offloaded_at)
       VALUES ($1, $2, 20, 0, 1, now() - interval '1 day') RETURNING id`,
      [ctx.companyId, container2.id]
    );
    const mix = await one(
      `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, cost_per_kg, total_cost)
       VALUES ($1, $2, 12.3, 1, 12.3) RETURNING id`,
      [ctx.companyId, `${PREFIX}-RMIX`]
    );
    await query(
      `INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, weight_kg, cost_per_kg, total_cost)
       VALUES ($1, $2, 12.3, 1, 12.3)`,
      [mix.id, supplier.id]
    );
    const stats = await scoped(() =>
      db.transaction((tx) => recalcOpeningRawStockUsageTx(tx, ctx.companyId, { actor }))
    );
    expect(stats).toMatchObject({ totalAllocatedKg: "12.300", unmatchedKg: "0.000", changedRows: 2 });
    const used = await query(
      `SELECT id, used_kg::text AS used FROM factory_raw_stock WHERE id = ANY($1::int[]) ORDER BY id`,
      [[rowA.id, rowB.id]]
    );
    expect(used.rows.map((row) => row.used)).toEqual(["10.100", "2.200"]);
    const audit = await one(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND record_identifier = 'opening-raw-stock-usage-recalc'
        ORDER BY id DESC LIMIT 1`,
      [ctx.companyId]
    );
    expect(audit.changes.usedKg.new).toEqual([
      { id: Number(rowA.id), usedKg: "10.100" },
      { id: Number(rowB.id), usedKg: "2.200" },
    ]);
    await setCutover(day(-5));
    const refused = await agent.post("/api/factory/raw-stock/recalc-opening").send({});
    expect([refused.status, refused.body.code]).toEqual([409, "FACTORY_OPENING_RECALC_AFTER_CUTOVER"]);
    await setCutover(null);
  }, 60_000);
});

describe("reverse instead of edit, and ledger-column readers", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  // The Reverse action on the closed-period refusal is covered by behaviour in
  // tests/ui/phase29-reverse-instead.test.ts (it was a source-text pin here).

  it("sums debit_amount / credit_amount, not base_*, in the net position, net profit and bank readers", () => {
    for (const file of [
      "server/helpers/calculateNetPositionAsOf.ts",
      "server/routes/stats/netProfitDataLoad.ts",
      "server/routes/bankAssetRoutes.ts",
    ]) {
      expect(read(file)).not.toMatch(/SUM\((CAST\()?COALESCE\(ve\.base_(debit|credit)_amount/);
    }
  });
});
