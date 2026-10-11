/**
 * Deleting a PO-linked voucher removes its container's CHARGE-<container>-*
 * vouchers. The match used LIKE, so a "_" in the container number acted as
 * a wildcard and also deleted a different container's charge vouchers
 * (DVC_1 matched CHARGE-DVCX1-1). The prefix is now compared literally and
 * within the container's company, and the container items total is reduced
 * as a decimal.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { deleteVoucher } from "../server/storage/accounting/voucher-writes";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "delvchg";
const CONTAINER = "DVC_1";

let ctx: TestContext;
let containerId: number;
let poVoucherId: number;
const voucherIds: Record<string, number> = {};

async function insertVoucher(companyId: number, number: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-09-01', '1.00') RETURNING id`,
    [companyId, number]
  );
  return result.rows[0].id;
}

// A deleted voucher is retired (soft-deleted, wave 16 A), so "exists" means live.
async function exists(id: number) {
  const result = await pool.query(`SELECT 1 FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return result.rowCount === 1;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX.toUpperCase()}S`, `${TEST_PREFIX} supplier`, `${TEST_PREFIX}@example.test`]
  );
  const supplierId = supplier.rows[0].id;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, items_total, grand_total)
     VALUES ($1, $2, $3, 'OTW', '2026-09-01', '0.30', '0.30') RETURNING id`,
    [ctx.companyId, CONTAINER, supplierId]
  );
  containerId = container.rows[0].id;

  poVoucherId = await insertVoucher(ctx.companyId, `${TEST_PREFIX}-PO`);
  await pool.query(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, voucher_id, items_total)
     VALUES ($1, $2, $3, $4, $5, '0.10'), ($1, $6, $3, $4, NULL, '0.20')`,
    [ctx.companyId, `${TEST_PREFIX}-PO1`, containerId, supplierId, poVoucherId, `${TEST_PREFIX}-PO2`]
  );

  voucherIds.own = await insertVoucher(ctx.companyId, `CHARGE-${CONTAINER}-1`);
  voucherIds.wildcard = await insertVoucher(ctx.companyId, `CHARGE-DVCX1-1`);
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM purchase_orders WHERE container_id = $1`, [containerId]);
  await pool.query(`DELETE FROM containers WHERE id = $1`, [containerId]);
  await pool.query(`DELETE FROM vouchers WHERE id = ANY($1::int[])`, [Object.values(voucherIds)]);
  await pool.query(`DELETE FROM suppliers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("deleteVoucher container charge cleanup", () => {
  it("deletes only this container's charge vouchers", async () => {
    await deleteVoucher(poVoucherId);

    expect(await exists(poVoucherId)).toBe(false);
    expect(await exists(voucherIds.own)).toBe(false);
    expect(await exists(voucherIds.wildcard)).toBe(true);

    const container = await pool.query<{ items_total: string; grand_total: string }>(
      `SELECT items_total, grand_total FROM containers WHERE id = $1`,
      [containerId]
    );
    expect(container.rows[0]).toEqual({ items_total: "0.20", grand_total: "0.20" });
  });
});
