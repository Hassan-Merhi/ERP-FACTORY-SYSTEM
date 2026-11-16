/**
 * tests/golden-coast-pos-sale-safety.test.ts
 *
 * Golden Coast Phase 5 — replay safety, company isolation, atomicity, and the
 * guarantee that non-Golden-Coast Supplier Partner companies are unaffected.
 *
 * The FIFO consumption and journal values live in the companion suite. The
 * split keeps each file's privileged-mutation rate-limit budget comfortable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { pool, db } from "../server/db";
import * as schema from "../shared/schema";
import { closeTestServer } from "./setup";
import {
  GOLDEN_COAST_PHASE5_SALE_DATE,
  GOLDEN_COAST_PHASE5_SALE_URL,
  goldenCoastPhase5SaleUrl,
  clearLots,
  inventoryQuantity,
  lotRemaining,
  seedCutoverLot,
  selectCompany,
  setupGoldenCoastPhase5Fixture,
  teardownGoldenCoastPhase5Fixture,
  voucherEntriesFor,
  type GoldenCoastPhase5Fixture,
} from "./helpers/goldenCoastFixture";

const TEST_PREFIX = "gcphase5safe";

let fixture: GoldenCoastPhase5Fixture;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gc5-safe-${requestCounter}`;
}

function saleBody(overrides: Record<string, unknown> = {}) {
  return {
    locationId: fixture.ctx.locationId,
    saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
    customerName: "Golden Coast Customer",
    clientRequestId: nextRequestId(),
    lines: [{ stockItemId: fixture.goldenCoastStockItemId, qty: "30", unitPriceUsd: "60" }],
    ...overrides,
  };
}

function postSale(body: Record<string, unknown>) {
  return fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send(body);
}

function seedLot(input: { qty: string; unitCost: string }) {
  return seedCutoverLot({
    prefix: TEST_PREFIX,
    companyId: fixture.ctx.companyId,
    locationId: fixture.ctx.locationId,
    stockItemId: fixture.goldenCoastStockItemId,
    qty: input.qty,
    unitCost: input.unitCost,
  });
}

function goldenCoastInventory(): Promise<number> {
  return inventoryQuantity(fixture.ctx.companyId, fixture.ctx.locationId, fixture.goldenCoastStockItemId);
}

beforeAll(async () => {
  fixture = await setupGoldenCoastPhase5Fixture(TEST_PREFIX);
}, 90000);

afterAll(async () => {
  await teardownGoldenCoastPhase5Fixture(fixture);
  closeTestServer();
}, 60000);

describe("Golden Coast Phase 5 — replay safety", () => {
  it("replays a duplicate request without consuming stock or posting again", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "100", unitCost: "22" });

    const body = saleBody();
    const first = await postSale(body);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    const remainingAfterFirst = await lotRemaining(lotId);
    const inventoryAfterFirst = await goldenCoastInventory();

    // Identical resubmission. The repository-wide voucher-path request boundary
    // keys on clientRequestId and replays the stored response, so the sale must
    // not consume stock or post a second time.
    const replay = await postSale(body);
    expect(replay.status).toBe(200);
    expect(await lotRemaining(lotId)).toBeCloseTo(remainingAfterFirst, 4);
    expect(await goldenCoastInventory()).toBeCloseTo(inventoryAfterFirst, 4);

    // Same client request id behind a different transport identity: the request
    // reaches this route's own replay detection, which returns the already
    // posted pair instead of consuming stock again.
    const handlerReplay = await fixture.agent
      .post(goldenCoastPhase5SaleUrl(fixture))
      .set("X-Idempotency-Key", `${body.clientRequestId}-transport-retry`)
      .send(body);
    expect(handlerReplay.status).toBe(200);
    expect(handlerReplay.body.replayed).toBe(true);
    expect(handlerReplay.body.postings.map((posting: { voucher: { id: number } }) => posting.voucher.id)).toEqual(
      first.body.postings.map((posting: { voucher: { id: number } }) => posting.voucher.id)
    );
    // A replay re-reports the sale's own vouchers and adds the automatic HADI
    // collection pair, which posts on the replay too: the collection is what
    // moves the cash, and a Phase 6 sale that was recorded before automatic
    // routing existed must be able to acquire its missing HADI side without
    // consuming stock again.
    expect(handlerReplay.body.postings.map((posting: { role: string }) => posting.role)).toEqual([
      "revenue",
      "cogs",
      "hadi_collection_golden_coast",
      "hadi_collection_hadi",
      // Phase 15 posts the Fresh Start capital-to-payable bridge alongside the
      // collection, so every automatically routed sale carries a third leg.
      "hadi_collection_sales_payable",
    ]);
    expect(await lotRemaining(lotId)).toBeCloseTo(remainingAfterFirst, 4);
    expect(await goldenCoastInventory()).toBeCloseTo(inventoryAfterFirst, 4);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`,
      [fixture.ctx.companyId, `GC-POS-C${fixture.ctx.companyId}-${body.clientRequestId}%`]
    );
    expect(rows[0].c).toBe(2);
  });

  it("refuses a reused client request id with changed sale data behind a fresh transport key", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "100", unitCost: "22" });

    const body = saleBody();
    expect((await postSale(body)).status).toBe(200);
    const remainingAfterFirst = await lotRemaining(lotId);

    // A fresh X-Idempotency-Key gets past the outer transport-keyed boundary, so
    // this reaches the handler with the same clientRequestId but different data.
    // Without the persisted sale digest it would be answered with the original
    // sale's vouchers while silently dropping this one.
    const tampered = await fixture.agent
      .post(goldenCoastPhase5SaleUrl(fixture))
      .set("X-Idempotency-Key", `${body.clientRequestId}-different-data`)
      .send({ ...body, lines: [{ stockItemId: fixture.goldenCoastStockItemId, qty: "5", unitPriceUsd: "99" }] });

    expect(tampered.status).toBe(409);
    expect(tampered.body.code).toBe("GC_PHASE6_IDEMPOTENCY_CONFLICT");
    expect(await lotRemaining(lotId)).toBeCloseTo(remainingAfterFirst, 4);
  });

  it("rejects a reused client request id that carries different sale data", async () => {
    await clearLots(fixture.ctx.companyId);
    await seedLot({ qty: "100", unitCost: "22" });

    const body = saleBody();
    expect((await postSale(body)).status).toBe(200);

    const conflicting = await postSale({ ...body, customerName: "Someone Else" });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe("POSTING_IDEMPOTENCY_CONFLICT");
  });

  it("requires a client request id on every Golden Coast sale", async () => {
    const res = await fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send({
      locationId: fixture.ctx.locationId,
      saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
      customerName: "No Request Id",
      lines: [{ stockItemId: fixture.goldenCoastStockItemId, qty: "1", unitPriceUsd: "60" }],
    });
    expect(res.status).toBe(400);
    expect(["GC_PHASE5_SALE_INVALID", "GC_PHASE5_INPUT_INVALID", "ACCOUNTING_REQUEST_ID_REQUIRED"]).toContain(
      res.body.code
    );
    expect(res.body.message).toMatch(/clientRequestId|request identity/i);
  });
});

describe("Golden Coast Phase 5 — atomicity and isolation", () => {
  it("rolls inventory and FIFO consumption back when the accounting posting fails", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "100", unitCost: "22" });
    const inventoryBefore = await goldenCoastInventory();

    // Occupy the voucher number this sale would derive, so the posting fails
    // after FIFO consumption and inventory adjustment have already run.
    const body = saleBody();
    const collidingNumber = `GC-POS-C${fixture.ctx.companyId}-${body.clientRequestId}`;
    await db.insert(schema.vouchers).values({
      companyId: fixture.ctx.companyId,
      voucherType: "Journal",
      voucherNumber: collidingNumber,
      voucherDate: GOLDEN_COAST_PHASE5_SALE_DATE,
      description: "Voucher number collision fixture",
      totalAmount: "0",
      currency: "USD",
    });

    const res = await postSale(body);
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(await lotRemaining(lotId)).toBeCloseTo(100, 4);
    expect(await goldenCoastInventory()).toBeCloseTo(inventoryBefore, 4);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
      [fixture.ctx.companyId, `${collidingNumber}-COGS`]
    );
    expect(rows[0].c).toBe(0);
  });

  it("never consumes another company's FIFO lots and rejects a foreign location", async () => {
    await clearLots(fixture.ctx.companyId);
    await clearLots(fixture.plainCompanyId);
    const ownLotId = await seedLot({ qty: "100", unitCost: "22" });
    const foreignLotId = await seedCutoverLot({
      prefix: TEST_PREFIX,
      companyId: fixture.plainCompanyId,
      locationId: fixture.plainLocationId,
      stockItemId: fixture.plainStockItemId,
      qty: "100",
      unitCost: "5",
      createdAt: "2026-09-01 00:00:00",
    });

    const ok = await postSale(saleBody());
    expect(ok.status).toBe(200);
    expect(ok.body.cogsUsd).toBe("660.00");
    expect(await lotRemaining(foreignLotId)).toBeCloseTo(100, 4);
    expect(await lotRemaining(ownLotId)).toBeCloseTo(70, 4);

    const foreignLocation = await postSale(saleBody({ locationId: fixture.plainLocationId }));
    expect(foreignLocation.status).toBe(400);
    expect(foreignLocation.body.code).toBe("GC_PHASE6_LOCATION_INVALID");
  });

  it("touches Fresh Start capital only through the Phase 15 bridge, and Hassan's never", async () => {
    const capitalRows = await db
      .select({ id: schema.ledgerAccounts.id })
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.companyId, fixture.ctx.companyId),
          eq(schema.ledgerAccounts.subType, "gc_partner_capital")
        )
      );
    expect(capitalRows).toHaveLength(1);

    // Hassan's capital is still never touched by a sale: the Phase 15 bridge
    // reclassifies Fresh Start's claim on the goods it contributed, nothing else.
    const owner = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = $1
         AND ve.ledger_account_id IN (
           SELECT id FROM ledger_accounts
           WHERE company_id = $1 AND sub_type = 'gc_owner_capital')`,
      [fixture.ctx.companyId]
    );
    expect(owner.rows[0].c).toBe(0);

    // Fresh Start's capital moves only on Phase 15 bridge vouchers, and only
    // ever as a debit — a sale converts contributed capital into a payable, it
    // never credits capital back.
    const partner = await pool.query(
      `SELECT v.voucher_number, ve.debit_amount::numeric AS dr, ve.credit_amount::numeric AS cr
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = $1
         AND ve.ledger_account_id IN (
           SELECT id FROM ledger_accounts
           WHERE company_id = $1 AND sub_type = 'gc_partner_capital')`,
      [fixture.ctx.companyId]
    );
    expect(partner.rows.length).toBeGreaterThan(0);
    for (const row of partner.rows) {
      expect(String(row.voucher_number)).toMatch(/^GC-P15-C\d+-/);
      expect(Number(row.dr)).toBeGreaterThan(0);
      expect(Number(row.cr)).toBe(0);
    }
  });
});

describe("Golden Coast Phase 5 — non-Golden-Coast Supplier Partner companies", () => {
  it("refuses the Phase 5 sale path and leaves the legacy Supplier Partner sale working", async () => {
    await selectCompany(fixture, fixture.plainCompanyId);
    try {
      const blocked = await fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send({
        locationId: fixture.plainLocationId,
        saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
        customerName: "Plain Customer",
        clientRequestId: nextRequestId(),
        lines: [{ stockItemId: fixture.plainStockItemId, qty: "1", unitPriceUsd: "60" }],
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("GC_PHASE6_NOT_CONFIGURED");

      await clearLots(fixture.plainCompanyId);
      await seedCutoverLot({
        prefix: TEST_PREFIX,
        companyId: fixture.plainCompanyId,
        locationId: fixture.plainLocationId,
        stockItemId: fixture.plainStockItemId,
        qty: "10",
        unitCost: "5",
      });

      const legacy = await fixture.agent.post("/api/sp/sales").send({
        saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
        customerName: "Plain Customer",
        paymentAccountType: "cash",
        paymentAccountId: fixture.plainCashAccountId,
        saleLines: [{ stockItemId: fixture.plainStockItemId, qtySold: 1, salePricePerUnit: 100 }],
      });
      expect(legacy.status).toBe(200);

      // Unchanged legacy shape: Dr Cash / Cr Supplier Cash Payable only.
      const legacyEntries = await voucherEntriesFor(legacy.body.voucherId);
      expect(legacyEntries).toHaveLength(2);
      expect(
        legacyEntries.find((entry) => entry.ledgerAccountId === fixture.plainPayableAccountId)?.creditAmount
      ).toBeTruthy();
    } finally {
      await selectCompany(fixture, fixture.ctx.companyId);
    }
  });
});
