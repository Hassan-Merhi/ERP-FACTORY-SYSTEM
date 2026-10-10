/**
 * Behavioural coverage for the factory container delete write routes.
 *
 * These were guard-only. Deleting a container is the widest cascade in the
 * factory tree: the container is soft-deleted, but its daybook entries and its
 * accounting vouchers — goods import, commission, freight and other charges —
 * are hard-deleted along with every voucher entry behind them.
 *
 * The bulk endpoint is different on purpose: it soft-deletes only, leaving the
 * vouchers so the containers can be restored from Settings -> Deleted Items.
 * Both behaviours are pinned, because the two endpoints look alike and are not.
 *
 * That asymmetry is the property worth pinning. The container row survives so
 * history still resolves, while the money it posted has to leave the ledger
 * completely. A voucher left behind would keep charging the supplier for a
 * container that no longer exists, and it would be untraceable: the container
 * it belongs to no longer appears in any list.
 *
 * The vouchers are found by number prefix — `FACTORY-IMPORT-<id>-`,
 * `FACTORY-COMM-<id>-` and so on — which is fragile in a specific way: a
 * container whose id is a prefix of another's (1 and 12) must not take its
 * neighbour's vouchers with it. That case is asserted directly, because the
 * `ilike` pattern is the only thing standing between the two.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "cntdel";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let seq = 0;

async function createContainer(): Promise<number> {
  seq += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code)
     VALUES ($1, $2, $3, '1000', '2.00', 'USD') RETURNING id`,
    [ctx.companyId, supplierId, `${TEST_PREFIX}-CONT-${seq}`]
  );
  return result.rows[0].id;
}

/** An import voucher named the way the delete's prefix match expects. */
async function createContainerVoucher(containerId: number, kind = "IMPORT"): Promise<number> {
  seq += 1;
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description,
                           total_amount, currency, source_module)
     VALUES ($1, $2, 'Purchase', '2026-05-01', $3, '2000.00', 'USD', 'FACTORY') RETURNING id`,
    [ctx.companyId, `FACTORY-${kind}-${containerId}-${seq}`, `${TEST_PREFIX} container voucher`]
  );
  await pool.query(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, '2000.00', '0', 'dr'), ($1, $3, '0', '2000.00', 'cr')`,
    [voucher.rows[0].id, ctx.cashAccountId, ctx.salesAccountId]
  );
  return voucher.rows[0].id;
}

async function containerRow(id: number) {
  const result = await pool.query<{ id: number; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM factory_containers WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

// Wave 16 (A): a removed voucher is retired (soft-deleted with its lines), not hard-deleted.
async function voucherExists(id: number): Promise<boolean> {
  const result = await pool.query(`SELECT id FROM vouchers WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return (result.rowCount ?? 0) > 0;
}

async function voucherEntryCount(voucherId: number): Promise<number> {
  const result = await pool.query(
    `SELECT ve.id FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL WHERE ve.voucher_id = $1`,
    [voucherId]
  );
  return result.rowCount ?? 0;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} supplier`]
  );
  supplierId = supplier.rows[0].id;
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("DELETE /api/factory/containers/:id", () => {
  it("soft-deletes the container but hard-deletes its vouchers and entries", async () => {
    const containerId = await createContainer();
    const voucherId = await createContainerVoucher(containerId);
    expect(await voucherEntryCount(voucherId)).toBe(2);

    const response = await agent.delete(`/api/factory/containers/${containerId}`);
    expect(response.status).toBe(200);

    // The container survives so history still resolves through it...
    const row = await containerRow(containerId);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();

    // ...but the money it posted has to leave the ledger completely. A voucher
    // left behind would keep charging the supplier for a container that no
    // longer appears in any list.
    expect(await voucherExists(voucherId)).toBe(false);
    expect(await voucherEntryCount(voucherId)).toBe(0);
  });

  it("removes freight and commission vouchers too, not just the import", async () => {
    const containerId = await createContainer();
    const importVoucher = await createContainerVoucher(containerId, "IMPORT");
    const freightVoucher = await createContainerVoucher(containerId, "FREIGHT");
    const commissionVoucher = await createContainerVoucher(containerId, "COMM");
    const ocVoucher = await createContainerVoucher(containerId, "OC");

    expect((await agent.delete(`/api/factory/containers/${containerId}`)).status).toBe(200);

    for (const id of [importVoucher, freightVoucher, commissionVoucher, ocVoucher]) {
      expect(await voucherExists(id)).toBe(false);
    }
  });

  it("does not take a neighbouring container's vouchers whose id shares a prefix", async () => {
    // The delete finds vouchers by `FACTORY-IMPORT-<id>-%`. Without the trailing
    // dash, deleting container 1 would match container 12's vouchers too.
    const first = await createContainer();
    const second = await createContainer();
    const firstVoucher = await createContainerVoucher(first);
    const secondVoucher = await createContainerVoucher(second);

    expect((await agent.delete(`/api/factory/containers/${first}`)).status).toBe(200);

    expect(await voucherExists(firstVoucher)).toBe(false);
    expect(await voucherExists(secondVoucher)).toBe(true);
    expect(await voucherEntryCount(secondVoucher)).toBe(2);
    expect((await containerRow(second))?.deleted_at).toBeNull();
  });

  it("returns 404 when the container is already deleted", async () => {
    const containerId = await createContainer();
    expect((await agent.delete(`/api/factory/containers/${containerId}`)).status).toBe(200);

    const second = await agent.delete(`/api/factory/containers/${containerId}`);

    // The update excludes rows already tombstoned, so a repeat finds nothing
    // rather than re-running the voucher cascade.
    expect(second.status).toBe(404);
  });

  it("returns 404 for a container in another company", async () => {
    expect((await agent.delete("/api/factory/containers/999999")).status).toBe(404);
  });

  it("rejects a non-numeric id", async () => {
    expect((await agent.delete("/api/factory/containers/not-an-id")).status).toBe(400);
  });
});

describe("POST /api/factory/containers/bulk-delete", () => {
  it("soft-deletes every listed container while keeping their vouchers", async () => {
    const first = await createContainer();
    const second = await createContainer();
    const firstVoucher = await createContainerVoucher(first);
    const secondVoucher = await createContainerVoucher(second);

    const response = await agent.post("/api/factory/containers/bulk-delete").send({ ids: [first, second] });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(2);
    expect((await containerRow(first))?.deleted_at).not.toBeNull();
    expect((await containerRow(second))?.deleted_at).not.toBeNull();

    // Bulk delete deliberately does NOT cascade, unlike the single-container
    // DELETE above: it hides the containers so they can be restored from
    // Settings -> Deleted Items, and permanent removal is done from the admin
    // trash UI. Pinned explicitly because the two endpoints look alike and
    // behave differently, and because a long-dead cascade block used to sit in
    // this handler implying otherwise.
    expect(await voucherExists(firstVoucher)).toBe(true);
    expect(await voucherExists(secondVoucher)).toBe(true);
    expect(await voucherEntryCount(firstVoucher)).toBe(2);
  });

  it("rejects an empty or missing id list", async () => {
    expect((await agent.post("/api/factory/containers/bulk-delete").send({ ids: [] })).status).toBe(400);
    expect((await agent.post("/api/factory/containers/bulk-delete").send({})).status).toBe(400);
  });

  it("leaves another company's container alone", async () => {
    const mine = await createContainer();

    const response = await agent.post("/api/factory/containers/bulk-delete").send({ ids: [mine, 999999] });

    // The ids come straight from the request body, so the company predicate in
    // the WHERE clause is the only thing scoping the cascade.
    expect(response.status).toBe(200);
    expect((await containerRow(mine))?.deleted_at).not.toBeNull();
  });
});
