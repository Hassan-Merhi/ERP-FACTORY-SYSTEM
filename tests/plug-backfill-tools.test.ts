/**
 * Phase 20 (code) — the Owner tools for two production clean-ups:
 *   A2: clearing the legacy import-cycle plug (system_settings
 *       equity_adjustment_<company>), preview / apply by plan hash, audited;
 *   B2: reversing main's 2bf7351 boot backfill INVENTORY lines by reviewed
 *       reversing journals (supplier-partner companies; others only with an
 *       explicit request and a reason), balanced, dated on the business date,
 *       closed period refused, audited, idempotent;
 * and the stock adjustment sync treating the backfill lines as the voucher's
 * inventory side (removed on a re-sync) unless they were reversed.
 */
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { syncStockAdjustmentInventoryTx } from "../server/services/accounting/perpetualInventory/stockAdjustments";
import { ensureSystemAccounts } from "../server/services/accounting/systemAccounts";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ph20plug";
const PLUG = "/api/accounting/legacy-equity-plug";
const MIRROR = "/api/accounting/stock-adjustment-inventory-mirror-reversal";
const BACKFILL = "Inventory side (backfill) - ";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let plugKey: string;
let accounts: Map<string, number>;
let sequence = 0;

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $3 WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
    role,
  ]);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}

async function setCompanyType(type: string) {
  await pool.query(`UPDATE companies SET company_type = $2 WHERE id = $1`, [ctx.companyId, type]);
}

/**
 * A stock adjustment voucher as main's backfill left it: its adjustment lines
 * and, for each, the INVENTORY mirror with the sides swapped.
 */
async function backfilledVoucher(type: string, lines: { debit: string; credit: string }[]): Promise<number> {
  sequence += 1;
  return withFixtureTransaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, $3, $4, '2026-03-10', 0, 'USD') RETURNING id`,
      [ctx.companyId, ctx.locationId, `${TEST_PREFIX}-${type}-${sequence}`, type]
    );
    const voucherId = rows[0].id;
    const adjustment = await client.query<{ id: number }>(
      `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type, notes)
       VALUES ($1, $2, $3, 'legacy') RETURNING id`,
      [voucherId, ctx.locationId, type]
    );
    await client.query(
      `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount)
       VALUES ($1, $2, 1, 1, 1)`,
      [adjustment.rows[0].id, ctx.stockItemIds[0]]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount, narration,
                                      transaction_currency, transaction_debit_amount, transaction_credit_amount)
         VALUES ($1, $2, $3, $4, $5, 'legacy line', 'USD', $4, $5),
                ($1, $2, $6, $5, $4, $7, 'USD', $5, $4)`,
        [
          voucherId,
          ctx.companyId,
          accounts.get("STOCK_ADJUSTMENT"),
          line.debit,
          line.credit,
          accounts.get("INVENTORY"),
          `${BACKFILL}legacy line`,
        ]
      );
    }
    return voucherId;
  });
}

const linesOf = async (voucherId: number) =>
  (
    await pool.query(
      `SELECT la.code, ve.debit_amount::numeric::text AS debit, ve.credit_amount::numeric::text AS credit, ve.narration
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [voucherId]
    )
  ).rows;

const reversalVouchers = async () =>
  (
    await pool.query(
      `SELECT id, voucher_number, voucher_date::text AS voucher_date, voucher_type FROM vouchers
        WHERE company_id = $1 AND voucher_number LIKE 'STOCKADJ-BACKFILL-REV-%' AND deleted_at IS NULL ORDER BY id`,
      [ctx.companyId]
    )
  ).rows;

async function inventoryNet(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::text AS net
       FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL AND la.code = 'INVENTORY'`,
    [ctx.companyId]
  );
  return Number(rows[0].net);
}

async function closeToday(): Promise<void> {
  const today = getCompanyBusinessDate(null);
  const closing = await withFixtureTransaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, source_module)
       VALUES ($1, $2, 'Journal', $3, 1, 'USD', 'ERP') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-CLOSE-${sequence++}`, today]
    );
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, 1, 0), ($1, $3, 0, 1)`,
      [rows[0].id, ctx.cashAccountId, ctx.salesAccountId]
    );
    return rows[0].id;
  });
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, $2, $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [ctx.companyId, today, ctx.userId, closing, ctx.cashAccountId]
  );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  plugKey = `equity_adjustment_${ctx.companyId}`;
  await pool.query(`DELETE FROM system_settings WHERE key = $1`, [plugKey]);
  const statuses = await ensureSystemAccounts(db, ctx.companyId, ["STOCK_ADJUSTMENT", "INVENTORY"]);
  accounts = new Map(statuses.map((status) => [status.code, "accountId" in status ? status.accountId : 0]));
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await setRole("Owner");
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM system_settings WHERE key = $1`, [plugKey]);
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [id]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await setCompanyType("erp");
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("A2: legacy equity plug clear (Owner preview/apply)", () => {
  it("has nothing to clear when no value is stored", async () => {
    const plan = await agent.get(`${PLUG}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ stored: null, storedValue: "0.00", blockers: ["NOTHING_TO_CLEAR"] });
    const apply = await agent.post(`${PLUG}/apply`).send({ confirm: true, planHash: plan.body.planHash });
    expect(apply.status).toBe(400);
    expect(apply.body.code).toBe("NOTHING_TO_CLEAR");
  });

  it("previews the stored value and the live difference, refuses stale hashes, an Admin apply and a changed value", async () => {
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ($1, '-1234.56')`, [plugKey]);
    const plan = await agent.get(`${PLUG}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ settingKey: plugKey, storedValue: "-1234.56", blockers: [] });
    expect(plan.body.liveImportCycleDifference).toMatch(/^-?\d+\.\d{2}$/);
    expect(plan.body.planHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await agent.post(`${PLUG}/apply`).send({ planHash: plan.body.planHash })).status).toBe(400);
    expect((await agent.post(`${PLUG}/apply`).send({ confirm: true })).status).toBe(400);
    const stale = await agent.post(`${PLUG}/apply`).send({ confirm: true, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");

    await setRole("Admin");
    try {
      expect((await agent.get(`${PLUG}/plan`)).status).toBe(200);
      expect((await agent.post(`${PLUG}/apply`).send({ confirm: true, planHash: plan.body.planHash })).status).toBe(
        403
      );
    } finally {
      await setRole("Owner");
    }

    await pool.query(`UPDATE system_settings SET value = '-1234.57' WHERE key = $1`, [plugKey]);
    const changed = await agent.post(`${PLUG}/apply`).send({ confirm: true, planHash: plan.body.planHash });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("PLAN_CHANGED");
    const { rows } = await pool.query(`SELECT value FROM system_settings WHERE key = $1`, [plugKey]);
    expect(rows[0].value).toBe("-1234.57");
  });

  it("clears the reviewed value once and audits before and after in the same transaction", async () => {
    const plan = await agent.get(`${PLUG}/plan`);
    const applied = await agent.post(`${PLUG}/apply`).send({ confirm: true, planHash: plan.body.planHash });
    expect(applied.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM system_settings WHERE key = $1`, [plugKey])).rowCount).toBe(0);

    const { rows: audits } = await pool.query(
      `SELECT action, table_name, changes FROM audit_log
        WHERE company_id = $1 AND record_identifier = 'legacy-equity-plug-clear'`,
      [ctx.companyId]
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "delete", table_name: "system_settings" });
    expect(audits[0].changes).toMatchObject({
      [plugKey]: { old: "-1234.57", new: null },
      storedValue: { old: "-1234.57", new: "0.00" },
      liveImportCycleDifference: { old: plan.body.liveImportCycleDifference },
    });

    const again = await agent.get(`${PLUG}/plan`);
    expect(again.body.blockers).toEqual(["NOTHING_TO_CLEAR"]);
    expect((await agent.post(`${PLUG}/apply`).send({ confirm: true, planHash: again.body.planHash })).status).toBe(400);
  });
});

describe("B2: stock adjustment backfill reversal (Owner preview/apply)", () => {
  let consumption: number;
  let mixed: number;

  beforeAll(async () => {
    consumption = await backfilledVoucher("Consumption", [{ debit: "100.00", credit: "0" }]);
    mixed = await backfilledVoucher("Mixed", [
      { debit: "40.00", credit: "0" },
      { debit: "0", credit: "25.50" },
    ]);
  });

  it("refuses a company that is not a supplier partner unless requested with a reason", async () => {
    await setCompanyType("erp");
    const plan = await agent.get(`${MIRROR}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.body.blockers).toContain("NOT_SUPPLIER_PARTNER");
    expect(plan.body.vouchers).toHaveLength(2);
    const refused = await agent.post(`${MIRROR}/apply`).send({ confirm: true, planHash: plan.body.planHash });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("NOT_SUPPLIER_PARTNER");

    const noReason = await agent.get(`${MIRROR}/plan`).query({ allowNonSupplierPartner: "true" });
    expect(noReason.body.blockers).toEqual(["REASON_REQUIRED"]);
    const withReason = await agent
      .get(`${MIRROR}/plan`)
      .query({ allowNonSupplierPartner: "true", reason: "Reviewed: company runs no stock" });
    expect(withReason.body.blockers).toEqual([]);
    expect(withReason.body.override).toEqual({
      allowNonSupplierPartner: true,
      reason: "Reviewed: company runs no stock",
    });
    expect(withReason.body.planHash).not.toBe(plan.body.planHash);
    expect((await agent.get(`${MIRROR}/plan`).query({ offset: "CASH" })).status).toBe(400);
    expect(await reversalVouchers()).toEqual([]);
  });

  it("previews the reversing journals for a supplier partner; refuses stale hashes, an Admin apply and a closed date", async () => {
    await setCompanyType("supplier_partner");
    const plan = await agent.get(`${MIRROR}/plan`);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({
      supplierPartner: true,
      blockers: [],
      offsetAccount: { code: "OPENING_BALANCE_EQUITY" },
      total: { vouchers: 2, lines: 3, inventoryDebit: "140.00", inventoryCredit: "25.50" },
    });
    const consumptionPlan = plan.body.vouchers.find((v: { voucherId: number }) => v.voucherId === consumption);
    expect(consumptionPlan.journal).toEqual([
      expect.objectContaining({ account: "INVENTORY", debit: "100.00", credit: "0.00" }),
      expect.objectContaining({ account: "OPENING_BALANCE_EQUITY", debit: "0.00", credit: "100.00" }),
    ]);

    const stale = await agent.post(`${MIRROR}/apply`).send({ confirm: true, planHash: "f".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");

    await setRole("Admin");
    try {
      expect((await agent.get(`${MIRROR}/plan`)).status).toBe(200);
      const forbidden = await agent.post(`${MIRROR}/apply`).send({ confirm: true, planHash: plan.body.planHash });
      expect(forbidden.status).toBe(403);
    } finally {
      await setRole("Owner");
    }

    await closeToday();
    try {
      const closed = await agent.get(`${MIRROR}/plan`);
      expect(closed.body.blockers).toContain("PERIOD_CLOSED");
      const refused = await agent.post(`${MIRROR}/apply`).send({ confirm: true, planHash: closed.body.planHash });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("PERIOD_CLOSED");
    } finally {
      await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
    }
    expect(await reversalVouchers()).toEqual([]);
  });

  it("posts one balanced reversing journal per voucher, leaves the originals alone, audits, and is idempotent", async () => {
    const before = { consumption: await linesOf(consumption), mixed: await linesOf(mixed) };
    const inventoryBefore = await inventoryNet();
    const plan = await agent.get(`${MIRROR}/plan`);
    const applied = await agent.post(`${MIRROR}/apply`).send({ confirm: true, planHash: plan.body.planHash });
    expect(applied.status).toBe(200);
    expect(applied.body.reversals).toHaveLength(2);

    const posted = await reversalVouchers();
    expect(posted.map((v) => v.voucher_number).sort()).toEqual(
      [`STOCKADJ-BACKFILL-REV-${consumption}`, `STOCKADJ-BACKFILL-REV-${mixed}`].sort()
    );
    for (const voucher of posted) {
      expect(voucher.voucher_date).toBe(plan.body.voucherDate);
      expect(voucher.voucher_type).toBe("Journal");
      const lines = await linesOf(voucher.id);
      const debit = lines.reduce((sum, line) => sum + Math.round(Number(line.debit) * 100), 0);
      const credit = lines.reduce((sum, line) => sum + Math.round(Number(line.credit) * 100), 0);
      expect(debit).toBe(credit);
    }
    // The backfill lines are cancelled on INVENTORY; the originals are untouched.
    expect(Math.round(inventoryBefore * 100)).toBe(-11450);
    expect(await linesOf(consumption)).toEqual(before.consumption);
    expect(await linesOf(mixed)).toEqual(before.mixed);
    expect(Math.round((await inventoryNet()) * 100)).toBe(0);

    const { rows: audits } = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND record_identifier = 'stock-adjustment-backfill-reversal'`,
      [ctx.companyId]
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].changes.reversalJournals.new).toHaveLength(2);
    expect(audits[0].changes.backfillLines.old[0].reversed).toBe(false);

    const again = await agent.get(`${MIRROR}/plan`);
    expect(again.body.vouchers).toEqual([]);
    expect(again.body.alreadyReversed).toHaveLength(2);
    expect(again.body.blockers).toEqual(["NOTHING_TO_APPLY"]);
    const reapply = await agent.post(`${MIRROR}/apply`).send({ confirm: true, planHash: again.body.planHash });
    expect(reapply.status).toBe(400);
    expect(await reversalVouchers()).toHaveLength(2);
  });

  it("the sync keeps the backfill lines of a reversed voucher", async () => {
    const before = await linesOf(consumption);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_company_id', ${String(ctx.companyId)}, true)`);
      await syncStockAdjustmentInventoryTx(tx, ctx.companyId, consumption);
    });
    expect(await linesOf(consumption)).toEqual(before);
  });
});

describe("the stock adjustment sync recognises the backfill narration", () => {
  it("removes the backfill lines of a voucher not reversed on a re-sync (periodic: no inventory line)", async () => {
    await setCompanyType("erp");
    const voucherId = await backfilledVoucher("Consumption", [{ debit: "12.34", credit: "0" }]);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_company_id', ${String(ctx.companyId)}, true)`);
      await syncStockAdjustmentInventoryTx(tx, ctx.companyId, voucherId);
    });
    const lines = await linesOf(voucherId);
    expect(lines).toEqual([expect.objectContaining({ code: "STOCK_ADJUSTMENT", debit: "12.34" })]);
  });
});
