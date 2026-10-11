/**
 * Perpetual-inventory cut-over, foundation (2026-10 accounting audit, wave 8.0).
 *
 * The opening inventory journal capitalises the stock on hand against Opening
 * Balance Equity: factory raw material at landed USD cost, open mix batches and
 * bales awaiting pressing as work in progress, bales held as finished goods.
 * Rows without a cost are listed, not guessed. Applying is refused until every
 * posting path is converted, refused for a future date and refused twice; once
 * applied, the gate is on from the cut-over date only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import {
  ensureInventoryCutoverSchema,
  isPerpetualInventoryActive,
} from "../server/services/accounting/perpetualInventory/cutover";
import {
  applyOpeningInventoryJournal,
  planOpeningInventoryJournal,
} from "../server/services/accounting/perpetualInventory/openingJournal";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";

const PREFIX = `pic${Date.now().toString(36)}`;
let companyId: number;
const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("perpetual-cutover-test", work);

async function maintenance(work: (q: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await work((text, values) => client.query(text, values) as never);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  expect(await ensureInventoryCutoverSchema(pool)).toBe(true);
  await maintenance(async (q) => {
    companyId = (
      await q(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [PREFIX.toUpperCase()])
    ).rows[0].id;
    const container = async (n: string) =>
      (
        await q(`INSERT INTO factory_containers (company_id, container_number) VALUES ($1, $2) RETURNING id`, [
          companyId,
          `${PREFIX}-${n}`,
        ])
      ).rows[0].id;
    // 600 kg left at 0.85 USD/kg = 510.00; a second lot with no USD cost is listed, not valued.
    await q(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
       VALUES ($1, $2, 1000, 400, 0.8, 0.85), ($1, $3, 50, 0, 1, NULL)`,
      [companyId, await container("A"), await container("B")]
    );
    // Open mix batch: 120 kg left at 0.9 = 108.00; a closed one is ignored.
    await q(
      `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, used_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, 500, 380, 0.9, 450, 'ACTIVE'), ($1, $3, 100, 0, 0.9, 90, 'CLOSED')`,
      [companyId, `${PREFIX}-M1`, `${PREFIX}-M2`]
    );
    const bale = (code: string, status: string, cost: string) =>
      q(
        `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status)
         VALUES ($1, $2, $2, 50, 0, $3, $4)`,
        [companyId, `${PREFIX}-${code}`, cost, status]
      );
    await bale("B1", "IN_STOCK", "40");
    await bale("B2", "RESERVED_FOR_ORDER", "45.5");
    await bale("B3", "PENDING_PRESSING", "30");
    await bale("B4", "SOLD", "99");
    await bale("B5", "IN_STOCK", "0");

    // The ledger already holds 25.00 of finished goods as of the eve: a 5.00
    // opening balance and a 20.00 posting. A posting after the eve is ignored.
    const account = async (code: string, opening: string) =>
      (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
           VALUES ($1, $2::varchar, $2::text, 'Asset', $3, 'Dr') RETURNING id`,
          [companyId, code, opening]
        )
      ).rows[0].id;
    const finished = await account("FACTORY_FINISHED_GOODS", "5");
    const cash = await account(`${PREFIX.toUpperCase()}_CASH`, "0");
    const posting = async (n: string, date: string, amount: string) => {
      const voucherId = (
        await q(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', $3, $4) RETURNING id`,
          [companyId, `${PREFIX}-${n}`, date, amount]
        )
      ).rows[0].id;
      await q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)`,
        [voucherId, finished, cash, amount]
      );
    };
    await posting("J1", "2026-10-15", "20");
    await posting("J2", "2026-11-05", "7");
  });
}, 60000);

afterAll(async () => {
  await maintenance(async (q) => {
    await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await q(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM vouchers WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM ledger_accounts WHERE company_id = $1`, [companyId]);
    for (const table of ["factory_bales", "factory_mix_batches", "factory_raw_stock", "factory_containers"]) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`, [companyId]);
    }
    // Account creation and the apply route write audit rows for the company.
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [companyId]);
    await q(`DELETE FROM companies WHERE id = $1`, [companyId]);
  });
}, 60000);

describe("opening inventory journal", () => {
  it("values factory stock from its own costing and lists what has no cost", async () => {
    const plan = await asMaintenance(() => planOpeningInventoryJournal(companyId, "2026-11-01"));
    expect(plan.journalDate).toBe("2026-10-31");
    // Each line posts its value less what the ledger already holds on the account.
    expect(plan.lines.map((line) => [line.accountCode, line.target, line.ledgerBalance, line.amount])).toEqual([
      ["FACTORY_RAW_MATERIAL_STOCK", "510.00", "0.00", "510.00"],
      ["FACTORY_WIP", "138.00", "0.00", "138.00"],
      ["FACTORY_FINISHED_GOODS", "85.50", "25.00", "60.50"],
    ]);
    expect(plan.total).toBe("708.50");
    expect(plan.unvalued.map((row) => [row.source, row.reason])).toEqual([
      ["factory_raw_stock", "no USD cost per kg"],
      ["factory_bales", "no recorded cost"],
    ]);
    expect(plan.postingReady).toBe(false);
  });

  it("is refused while the posting paths are not converted, and for a future date", async () => {
    await expect(asMaintenance(() => applyOpeningInventoryJournal(companyId, "2026-11-01", "test"))).rejects.toThrow(
      /not complete/
    );
    await expect(
      asMaintenance(() =>
        applyOpeningInventoryJournal(companyId, "2026-11-01", "test", { postingReady: true, today: "2026-10-20" })
      )
    ).rejects.toThrow(/on or after its date/);
  });

  it("is refused while a document is posted on or after the cut-over date", async () => {
    await expect(
      asMaintenance(() =>
        applyOpeningInventoryJournal(companyId, "2026-11-01", "test", { postingReady: true, today: "2026-11-01" })
      )
    ).rejects.toThrow(/already posted on or after the cut-over date/);
    // J2 (dated 2026-11-05) goes; the cut-over can then be applied.
    await asMaintenance(() =>
      pool.query(`UPDATE vouchers SET deleted_at = now() WHERE company_id = $1 AND voucher_number = $2`, [
        companyId,
        `${PREFIX}-J2`,
      ])
    );
  });

  it("posts a balanced journal once and turns the gate on from the cut-over date", async () => {
    // Wave 17 B (decision 6): refused while factory rows carry no cost and stock
    // bales with no mix are costed at the catalogue price.
    await expect(
      asMaintenance(() =>
        applyOpeningInventoryJournal(companyId, "2026-11-01", "test", { postingReady: true, today: "2026-11-01" })
      )
    ).rejects.toMatchObject({ code: "FACTORY_READINESS_BLOCKERS" });
    // Resolved: the unvalued raw row and bale go, the costed bales come from the open mix.
    await maintenance(async (q) => {
      await q(`DELETE FROM factory_raw_stock WHERE company_id = $1 AND cost_per_kg_usd IS NULL`, [companyId]);
      await q(`DELETE FROM factory_bales WHERE company_id = $1 AND total_cost = 0`, [companyId]);
      await q(
        `UPDATE factory_bales SET mix_batch_id = (SELECT id FROM factory_mix_batches WHERE batch_code = $2)
          WHERE company_id = $1`,
        [companyId, `${PREFIX}-M1`]
      );
    });
    const result = await asMaintenance(() =>
      applyOpeningInventoryJournal(companyId, "2026-11-01", "test", { postingReady: true, today: "2026-11-01" })
    );
    const lines = await asMaintenance(() =>
      pool.query(
        `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c, v.voucher_date::text AS date
           FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE v.id = $1 ORDER BY ve.id`,
        [result.voucherId]
      )
    );
    expect(lines.rows).toEqual([
      { code: "FACTORY_RAW_MATERIAL_STOCK", d: "510.00", c: "0.00", date: "2026-10-31" },
      { code: "FACTORY_WIP", d: "138.00", c: "0.00", date: "2026-10-31" },
      { code: "FACTORY_FINISHED_GOODS", d: "60.50", c: "0.00", date: "2026-10-31" },
      { code: "OPENING_BALANCE_EQUITY", d: "0.00", c: "708.50", date: "2026-10-31" },
    ]);

    expect(await asMaintenance(() => isPerpetualInventoryActive(db, companyId, "2026-10-31"))).toBe(false);
    expect(await asMaintenance(() => isPerpetualInventoryActive(db, companyId, "2026-11-01"))).toBe(true);

    await expect(
      asMaintenance(() =>
        applyOpeningInventoryJournal(companyId, "2026-11-01", "test", { postingReady: true, today: "2026-11-02" })
      )
    ).rejects.toThrow(/already applied/);
  });
});
