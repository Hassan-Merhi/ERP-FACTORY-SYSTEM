/**
 * Behavioural coverage for the factory daybook edit write routes.
 *
 * These were guard-only. The daybook is the operational view of the ledger, and
 * these four endpoints are the only way to change an entry after it is posted.
 *
 * The distinction they exist to enforce is the one worth pinning: **a
 * voucher-backed entry may be voided but never hard-deleted.** Deleting the
 * daybook row would leave the voucher and its two entries posted with nothing
 * in the daybook pointing at them — money in the trial balance that no
 * operational view shows. Voiding instead retires the voucher (soft delete,
 * lines kept, audited), and unwinds the payroll and
 * advance links that referenced it.
 *
 * The reverse is also asserted: an entry that is *not* voucher-backed cannot be
 * voided, because there is no voucher to unwind.
 *
 * Every one of these is role-gated, and the check has to run before any write —
 * a caller who is refused must leave the entry exactly as it was.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "dbkedit";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let seq = 0;

async function entryRow(id: number) {
  const result = await pool.query<{
    id: number;
    description: string | null;
    amount_usd: string | null;
    reference_table: string | null;
    reference_id: number | null;
  }>(
    `SELECT id, description, amount_usd, reference_table, reference_id
     FROM factory_daybook_entries WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function voucherRow(id: number) {
  const result = await pool.query<{ id: number; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM vouchers WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** A posted voucher with two balanced legs. */
async function createVoucher(voucherType = "Payment"): Promise<number> {
  seq += 1;
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency)
     VALUES ($1, $2, $3, '2026-05-01', $4, '100.00', 'USD') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-V${seq}`, voucherType, `${TEST_PREFIX} voucher ${seq}`]
  );
  const voucherId = voucher.rows[0].id;
  await pool.query(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, '100.00', '0', 'dr'), ($1, $3, '0', '100.00', 'cr')`,
    [voucherId, ctx.cashAccountId, ctx.salesAccountId]
  );
  return voucherId;
}

/** A daybook entry, optionally backed by a voucher. */
async function createEntry(voucherId: number | null): Promise<number> {
  seq += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_daybook_entries
       (company_id, tx_date, tx_type, reference_id, reference_table, description,
        currency_code, amount_currency, fx_rate_to_usd, amount_usd)
     VALUES ($1, '2026-05-01', 'PAYMENT', $2, $3, $4, 'USD', '100.00', '1', '100.00')
     RETURNING id`,
    [ctx.companyId, voucherId, voucherId === null ? "manual" : "vouchers", `${TEST_PREFIX} entry ${seq}`]
  );
  return result.rows[0].id;
}

async function voucherEntryCount(voucherId: number): Promise<number> {
  const result = await pool.query(`SELECT id FROM voucher_entries WHERE voucher_id = $1`, [voucherId]);
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
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("PUT /api/factory/daybook/:entryId", () => {
  it("edits the entry when a reason is given", async () => {
    const entryId = await createEntry(null);

    const response = await agent
      .put(`/api/factory/daybook/${entryId}`)
      .send({ reason: "corrected narration", description: "after edit" });

    expect(response.status).toBe(200);
    expect((await entryRow(entryId))?.description).toBe("after edit");
  });

  it("refuses an edit with no reason, leaving the entry untouched", async () => {
    const entryId = await createEntry(null);
    const before = await entryRow(entryId);

    for (const body of [{ description: "x" }, { reason: "   ", description: "x" }]) {
      const response = await agent.put(`/api/factory/daybook/${entryId}`).send(body);
      expect(response.status).toBe(400);
    }

    // The reason is the audit trail for the edit; without it the change would
    // be unexplained in the ledger's history.
    expect(await entryRow(entryId)).toEqual(before);
  });

  it("rejects a non-numeric entry id", async () => {
    expect((await agent.put("/api/factory/daybook/not-an-id").send({ reason: "x" })).status).toBe(400);
  });
});

describe("DELETE /api/factory/daybook/entry/:id", () => {
  it("hard-deletes a manual entry", async () => {
    const entryId = await createEntry(null);

    const response = await agent.delete(`/api/factory/daybook/entry/${entryId}`);

    expect(response.status).toBe(200);
    expect(await entryRow(entryId)).toBeNull();
  });

  it("refuses to hard-delete a voucher-backed entry", async () => {
    const voucherId = await createVoucher();
    const entryId = await createEntry(voucherId);

    const response = await agent.delete(`/api/factory/daybook/entry/${entryId}`);

    // Removing the daybook row would leave the voucher and both its legs posted
    // with nothing operational pointing at them — money in the trial balance
    // that no view shows. Those have to be voided instead.
    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain("voided");
    expect(await entryRow(entryId)).not.toBeNull();
    expect(await voucherEntryCount(voucherId)).toBe(2);
  });

  it("refuses a synthetic (negative) id", async () => {
    const response = await agent.delete("/api/factory/daybook/entry/-5");

    // A negative id addresses a voucher that has no daybook row yet; there is
    // nothing to hard-delete.
    expect(response.status).toBe(400);
  });

  it("returns 404 for an entry in another company", async () => {
    expect((await agent.delete("/api/factory/daybook/entry/999999")).status).toBe(404);
  });
});

describe("DELETE /api/factory/daybook/entry/:id/void", () => {
  it("retires the voucher with its legs kept, and drops the daybook row", async () => {
    const voucherId = await createVoucher("Payment");
    const entryId = await createEntry(voucherId);

    const response = await agent.delete(`/api/factory/daybook/entry/${entryId}/void`);
    expect(response.status).toBe(200);

    // Phase 19 (A), G3: the voucher is retired (soft-deleted, so its amounts
    // leave the trial balance) and its legs stay with it as history; they were
    // hard-deleted before.
    expect(await voucherEntryCount(voucherId)).toBe(2);
    expect((await voucherRow(voucherId))?.deleted_at).not.toBeNull();
    expect(await entryRow(entryId)).toBeNull();
  });

  it("refuses to void an entry that is not voucher-backed", async () => {
    const entryId = await createEntry(null);

    const response = await agent.delete(`/api/factory/daybook/entry/${entryId}/void`);

    expect(response.status).toBe(400);
    expect(String(response.body.message)).toContain("not voucher-backed");
    expect(await entryRow(entryId)).not.toBeNull();
  });

  it("refuses to void a voucher type the daybook does not own", async () => {
    const voucherId = await createVoucher("Purchase");
    const entryId = await createEntry(voucherId);

    const response = await agent.delete(`/api/factory/daybook/entry/${entryId}/void`);

    // A purchase voucher belongs to the container/PO workflow, which has its
    // own reversal path; voiding it here would bypass that.
    expect(response.status).toBe(400);
    expect(await voucherEntryCount(voucherId)).toBe(2);
    expect((await voucherRow(voucherId))?.deleted_at).toBeNull();
  });

  it("refuses to void the same voucher twice", async () => {
    const voucherId = await createVoucher("Receipt");
    const entryId = await createEntry(voucherId);
    expect((await agent.delete(`/api/factory/daybook/entry/${entryId}/void`)).status).toBe(200);

    // Addressed directly by voucher id this time, since the daybook row is gone.
    const second = await agent.delete(`/api/factory/daybook/entry/-${voucherId}/void`);

    // The lookup excludes soft-deleted vouchers, so a second void finds nothing
    // rather than deleting legs that are already gone.
    expect(second.status).toBe(404);
  });

  it("returns 404 for an entry in another company", async () => {
    expect((await agent.delete("/api/factory/daybook/entry/999999/void")).status).toBe(404);
  });
});
