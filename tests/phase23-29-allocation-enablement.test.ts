/**
 * Phases 23–29 integration review: the hourly FIFO allocation (phase 25) and
 * the realized FX it triggers (phase 24) do nothing for a company until its
 * Owner has run the reviewed first allocation; realized FX of a settlement
 * dated before that is posted only through the reviewed history tool.
 *
 *   - the scheduled run writes nothing for a company that is not enabled;
 *   - the first run: Admin 403, no confirmation 400, a stale plan hash 409, the
 *     preview's hash 200 — it writes the enablement, allocates history and
 *     posts no realized FX;
 *   - the history tool lists that allocation's FX, refuses a stale hash, posts
 *     it once (audited) and is then empty;
 *   - after the enablement, a settlement dated on or after it allocated by the
 *     scheduled run posts its realized FX automatically.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { runOpenItemAllocationForAllCompanies } from "../server/services/accounting/allocations/allocationRun";
import { ensureOpenItemSchema } from "../server/services/accounting/allocations/ensureOpenItemSchema";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { postErpVoucherTx } from "../server/services/accounting/erpVoucherPosting";
import { registerRealizedFxListener } from "../server/services/accounting/fx/realizedFx";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p2329en";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let customerId = 0;
let historyInvoiceId = 0;

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function postEur(key: string, date: string, rate: string, side: "invoice" | "receipt") {
  const posted = await runInCompanyPostingScope(ctx.companyId, () =>
    db.transaction((tx) =>
      postErpVoucherTx(tx, {
        companyId: ctx.companyId,
        voucherType: side === "invoice" ? "Sales" : "Receipt",
        voucherDate: date,
        currency: "EUR",
        exchangeRate: rate,
        lines: [
          {
            ...(side === "invoice" ? { customerId } : { ledgerAccountId: ctx.cashAccountId }),
            debit: "1",
            transaction: { currency: "EUR", amount: "100", rate },
          },
          {
            ...(side === "invoice" ? { ledgerAccountId: ctx.salesAccountId } : { customerId }),
            credit: "1",
            transaction: { currency: "EUR", amount: "100", rate },
          },
        ],
        source: { type: `${PREFIX}-${side}`, id: key },
      })
    )
  );
  return posted.voucher.id;
}

async function liveAllocations() {
  return (
    await pool.query(
      `SELECT id, invoice_voucher_id, payment_voucher_id, amount::text AS amount
         FROM party_open_item_allocations
        WHERE company_id = $1 AND party_kind = 'customer' AND party_id = $2 AND released_at IS NULL
        ORDER BY id`,
      [ctx.companyId, customerId]
    )
  ).rows;
}

async function realizedFxRequests() {
  return (
    await pool.query(
      `SELECT r.source_id, r.voucher_id FROM accounting_posting_requests r
         JOIN vouchers v ON v.id = r.voucher_id AND v.deleted_at IS NULL
        WHERE r.company_id = $1 AND r.source_type = 'fx-realized-allocation'
        ORDER BY r.voucher_id`,
      [ctx.companyId]
    )
  ).rows;
}

const scheduledRun = () =>
  runWithDatabaseMaintenanceScope("scheduler:openItemAllocation", () => runOpenItemAllocationForAllCompanies());

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureOpenItemSchema(pool);
  registerRealizedFxListener();
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-C1`, `${PREFIX} customer`]
  );
  customerId = customer.rows[0].id;
  // History: EUR 100 invoiced at 0.8 EUR per USD (USD 125), received at 1.0 (USD 100).
  historyInvoiceId = await postEur("hist-inv", "2026-04-02", "0.8", "invoice");
  await postEur("hist-rec", "2026-04-20", "1", "receipt");
}, 120_000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("automatic allocation gated on the Owner's first run", () => {
  it("the scheduled run writes nothing for a company that is not enabled", async () => {
    await scheduledRun();
    expect(await liveAllocations()).toEqual([]);
    expect(await realizedFxRequests()).toEqual([]);
    const marker = await pool.query(`SELECT 1 FROM open_item_allocation_enablements WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    expect(marker.rows).toHaveLength(0);
  });

  it("the first run is the Owner's, with the preview's hash; it allocates history and posts no realized FX", async () => {
    const asAdmin = await agent.post("/api/open-items/allocate").send({});
    expect(asAdmin.status).toBe(403);
    expect(asAdmin.body.code).toBe("OPEN_ITEM_ALLOCATION_OWNER_FIRST_RUN");
    await setRole("Owner");
    const preview = await agent.get("/api/open-items/allocate/preview");
    expect(preview.status).toBe(200);
    expect(preview.body.enabled).toBeNull();
    expect(preview.body.kinds.find((kind: { kind: string }) => kind.kind === "customer")).toMatchObject({
      creates: 1,
      createdAmount: "100.00",
    });
    expect((await agent.post("/api/open-items/allocate").send({ planHash: preview.body.planHash })).status).toBe(400);
    const stale = await agent.post("/api/open-items/allocate").send({ confirm: true, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("OPEN_ITEM_ALLOCATION_PLAN_CHANGED");
    expect(await liveAllocations()).toEqual([]);

    const first = await agent.post("/api/open-items/allocate").send({ confirm: true, planHash: preview.body.planHash });
    expect(first.status).toBe(200);
    expect(first.body.enabled).toMatchObject({
      enabledOn: await companyBusinessDate(ctx.companyId),
      planHash: preview.body.planHash,
    });
    const rows = await liveAllocations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoice_voucher_id: historyInvoiceId, amount: "100.00" });
    // Historical settlement: no realized FX journal, automatically or otherwise.
    expect(await realizedFxRequests()).toEqual([]);
    const again = await agent.get("/api/open-items/allocate/preview");
    expect(again.body.enabled).toMatchObject({ planHash: preview.body.planHash });
  });

  it("posts the history's realized FX only through the reviewed history tool", async () => {
    const plan = await agent.get("/api/accounting/realized-fx/history/plan");
    expect(plan.status).toBe(200);
    const [allocation] = await liveAllocations();
    expect(plan.body.items).toEqual([
      expect.objectContaining({ allocationId: allocation.id, difference: "-25.00", currency: "EUR" }),
    ]);
    const stale = await agent
      .post("/api/accounting/realized-fx/history/apply")
      .send({ confirm: true, planHash: "f".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("REALIZED_FX_HISTORY_PLAN_CHANGED");
    expect(await realizedFxRequests()).toEqual([]);

    const applied = await agent
      .post("/api/accounting/realized-fx/history/apply")
      .send({ confirm: true, planHash: plan.body.planHash });
    expect(applied.status).toBe(200);
    expect(applied.body.posted).toHaveLength(1);
    expect(await realizedFxRequests()).toEqual([
      { source_id: String(allocation.id), voucher_id: applied.body.posted[0].voucherId },
    ]);
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND record_identifier LIKE 'fx-realized-history:%'`,
      [ctx.companyId]
    );
    expect(audit.rows).toHaveLength(1);
    const empty = await agent.get("/api/accounting/realized-fx/history/plan");
    expect(empty.body.items).toEqual([]);
    const nothing = await agent
      .post("/api/accounting/realized-fx/history/apply")
      .send({ confirm: true, planHash: empty.body.planHash });
    expect(nothing.status).toBe(400);
    await setRole("Admin");
  });

  it("after the enablement, the scheduled run allocates new settlements and posts their realized FX", async () => {
    const today = await companyBusinessDate(ctx.companyId);
    const invoiceId = await postEur("new-inv", today, "0.8", "invoice");
    await postEur("new-rec", today, "1", "receipt");
    await scheduledRun();
    const rows = (await liveAllocations()).filter((row) => row.invoice_voucher_id === invoiceId);
    expect(rows).toHaveLength(1);
    const requests = await realizedFxRequests();
    // (The test harness clears posting identities between test cases, so only this one is listed.)
    expect(requests.map((row) => row.source_id)).toEqual([String(rows[0].id)]);
  });
});
