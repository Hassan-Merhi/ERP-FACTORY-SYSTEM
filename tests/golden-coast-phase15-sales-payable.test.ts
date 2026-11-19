import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { closeTestServer } from "./setup";
import {
  GOLDEN_COAST_PHASE5_SALE_DATE,
  clearLots,
  goldenCoastPhase5SaleUrl,
  seedCutoverLot,
  setupGoldenCoastPhase5Fixture,
  teardownGoldenCoastPhase5Fixture,
  type GoldenCoastPhase5Fixture,
} from "./helpers/goldenCoastPhase5Fixture";

const TEST_PREFIX = "gcphase15payable";
const PHASE15_SOURCE_TYPE = "golden-coast-phase15-sales-payable";
let fixture: GoldenCoastPhase5Fixture;

async function roleAccountId(companyId: number, subType: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM ledger_accounts
     WHERE company_id = $1 AND sub_type = $2 AND active = true AND deleted_at IS NULL
     ORDER BY id`,
    [companyId, subType]
  );
  if (rows.length !== 1) throw new Error(`Expected one active ${subType} account, found ${rows.length}`);
  return Number(rows[0].id);
}

async function netDebit(accountId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) AS balance
     FROM voucher_entries ve
     JOIN vouchers v ON v.id = ve.voucher_id
     WHERE ve.ledger_account_id = $1 AND v.deleted_at IS NULL`,
    [accountId]
  );
  return Number(rows[0].balance);
}

async function phase15MarkerCount(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM accounting_posting_requests
     WHERE company_id = $1 AND source_type = $2`,
    [fixture.ctx.companyId, PHASE15_SOURCE_TYPE]
  );
  return Number(rows[0].count);
}

function saleBody(clientRequestId: string, qty: string, unitPriceUsd: string) {
  return {
    locationId: fixture.ctx.locationId,
    saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
    customerName: "Golden Coast Phase 15 Customer",
    clientRequestId,
    lines: [{ stockItemId: fixture.goldenCoastStockItemId, qty, unitPriceUsd }],
  };
}

beforeAll(async () => {
  fixture = await setupGoldenCoastPhase5Fixture(TEST_PREFIX);
}, 90_000);

afterAll(async () => {
  await teardownGoldenCoastPhase5Fixture(fixture);
  closeTestServer();
}, 60_000);

describe("Golden Coast Phase 15 — canonical GC Sales Cash payable", () => {
  it("keeps GC Sales Cash credit-normal across consecutive HADI-routed sales and replays exactly", async () => {
    await pool.query(
      `UPDATE locations SET supplier_partner_payable_deduction_per_qty = '0'
       WHERE id = $1 AND company_id = $2`,
      [fixture.ctx.locationId, fixture.ctx.companyId]
    );
    await clearLots(fixture.ctx.companyId);
    await seedCutoverLot({
      prefix: TEST_PREFIX,
      companyId: fixture.ctx.companyId,
      locationId: fixture.ctx.locationId,
      stockItemId: fixture.goldenCoastStockItemId,
      qty: "200",
      unitCost: "22",
    });

    const freshStartEquity = await roleAccountId(fixture.ctx.companyId, "gc_partner_capital");
    const hassanEquity = await roleAccountId(fixture.ctx.companyId, "gc_owner_capital");
    const before = {
      payable: await netDebit(fixture.saleSideAccountId),
      fresh: await netDebit(freshStartEquity),
      hassan: await netDebit(hassanEquity),
      gcHadi: await netDebit(fixture.goldenCoastHadiIntercompanyAccountId),
      hadiCash: await netDebit(fixture.hadiCashAccountId),
      hadiGc: await netDebit(fixture.hadiGoldenCoastIntercompanyAccountId),
      sales: await netDebit(fixture.salesAccountId),
      cogs: await netDebit(fixture.cogsAccountId),
      stock: await netDebit(fixture.stockInHandAccountId),
      markers: await phase15MarkerCount(),
    };

    const first = await fixture.agent
      .post(goldenCoastPhase5SaleUrl(fixture))
      .send(saleBody("phase15-first", "10", "60"));
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);

    // This second sale is the key regression: an existing credit payable from
    // the first sale must not block automatic HADI routing for the next sale.
    const secondBody = saleBody("phase15-second", "5", "60");
    const second = await fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send(secondBody);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(false);

    // Gross sales = 600 + 300 = 900. FIFO COGS = 15 * 22 = 330.
    expect((await netDebit(fixture.saleSideAccountId)) - before.payable).toBeCloseTo(-900, 2);
    expect((await netDebit(freshStartEquity)) - before.fresh).toBeCloseTo(900, 2);
    expect((await netDebit(hassanEquity)) - before.hassan).toBeCloseTo(0, 2);
    expect((await netDebit(fixture.goldenCoastHadiIntercompanyAccountId)) - before.gcHadi).toBeCloseTo(900, 2);
    expect((await netDebit(fixture.hadiCashAccountId)) - before.hadiCash).toBeCloseTo(900, 2);
    expect((await netDebit(fixture.hadiGoldenCoastIntercompanyAccountId)) - before.hadiGc).toBeCloseTo(-900, 2);
    expect((await netDebit(fixture.salesAccountId)) - before.sales).toBeCloseTo(-900, 2);
    expect((await netDebit(fixture.cogsAccountId)) - before.cogs).toBeCloseTo(330, 2);
    expect((await netDebit(fixture.stockInHandAccountId)) - before.stock).toBeCloseTo(-330, 2);
    expect((await phase15MarkerCount()) - before.markers).toBe(2);

    const beforeReplay = {
      payable: await netDebit(fixture.saleSideAccountId),
      fresh: await netDebit(freshStartEquity),
      gcHadi: await netDebit(fixture.goldenCoastHadiIntercompanyAccountId),
      hadiCash: await netDebit(fixture.hadiCashAccountId),
      markers: await phase15MarkerCount(),
    };
    const replay = await fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send(secondBody);
    // Every state-changing /api/sp/ request is claimed by the Phase 5-to-6
    // voucher-path boundary, which is a durable HTTP-level idempotency layer:
    // a repeat with the same clientRequestId and fingerprint replays the
    // ORIGINAL response (status and body, marked `replayed: true`) and never
    // reaches the route. So the guarantee to assert is that the replay is the
    // first response flagged as a replay and that the ledger did not move.
    expect(replay.status).toBe(second.status);
    expect(replay.body).toEqual({ ...second.body, replayed: true });
    expect(await netDebit(fixture.saleSideAccountId)).toBeCloseTo(beforeReplay.payable, 2);
    expect(await netDebit(freshStartEquity)).toBeCloseTo(beforeReplay.fresh, 2);
    expect(await netDebit(fixture.goldenCoastHadiIntercompanyAccountId)).toBeCloseTo(beforeReplay.gcHadi, 2);
    expect(await netDebit(fixture.hadiCashAccountId)).toBeCloseTo(beforeReplay.hadiCash, 2);
    expect(await phase15MarkerCount()).toBe(beforeReplay.markers);
  });

  it("reduces the Fresh Start payable by the existing special-location Hassan Savings deduction", async () => {
    await pool.query(
      `UPDATE locations SET supplier_partner_payable_deduction_per_qty = '2.5000'
       WHERE id = $1 AND company_id = $2`,
      [fixture.ctx.locationId, fixture.ctx.companyId]
    );
    await clearLots(fixture.ctx.companyId);
    await seedCutoverLot({
      prefix: `${TEST_PREFIX}-deduct`,
      companyId: fixture.ctx.companyId,
      locationId: fixture.ctx.locationId,
      stockItemId: fixture.goldenCoastStockItemId,
      qty: "100",
      unitCost: "22",
    });

    const freshStartEquity = await roleAccountId(fixture.ctx.companyId, "gc_partner_capital");
    const hassanSavings = await roleAccountId(fixture.ctx.companyId, "gc_hassan_savings");
    const before = {
      payable: await netDebit(fixture.saleSideAccountId),
      fresh: await netDebit(freshStartEquity),
      savings: await netDebit(hassanSavings),
      gcHadi: await netDebit(fixture.goldenCoastHadiIntercompanyAccountId),
    };

    const response = await fixture.agent
      .post(goldenCoastPhase5SaleUrl(fixture))
      .send(saleBody("phase15-deduction", "4", "100"));
    expect(response.status).toBe(200);

    // Gross claim is 400. The existing Phase 6 deduction is 4 * 2.50 = 10,
    // leaving a 390 credit payable to Fresh Start while HADI still holds all
    // 400 of the physical sale proceeds.
    expect((await netDebit(freshStartEquity)) - before.fresh).toBeCloseTo(400, 2);
    expect((await netDebit(fixture.saleSideAccountId)) - before.payable).toBeCloseTo(-390, 2);
    expect((await netDebit(hassanSavings)) - before.savings).toBeCloseTo(-10, 2);
    expect((await netDebit(fixture.goldenCoastHadiIntercompanyAccountId)) - before.gcHadi).toBeCloseTo(400, 2);
  });
});
