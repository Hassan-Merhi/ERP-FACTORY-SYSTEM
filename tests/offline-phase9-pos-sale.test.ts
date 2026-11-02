/**
 * Phase 9 offline POS cash sales (pos.sale.v1) on the full application schema:
 * the factory LAN capture (LAN invoice series, immutable outbox, owner-policy
 * refusals) and the cloud replay through the normal sale service, idempotent
 * on the sale's clientSaleId, with below-zero stock held for review.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { createPosSale } from "../server/services/pos/createSaleService";
import { ensurePhase9PosOutboxSchema } from "../server/edge/phase9PosOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { phase9PosSaleApplyHandler, type Phase9PosSaleEvent } from "../server/edge/phase9PosSaleApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9pos";
const SITE = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
let ctx: TestContext;
let customerAccountId: number;

const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };

function sale(body: Record<string, unknown>) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), () =>
    createPosSale(
      {
        currentCompanyId: ctx.companyId,
        userId: ctx.userId,
        username: `${PREFIX}_testuser`,
        userRole: "Admin",
        canSellNegativeStock: false,
        sessionCashAccountId: null,
        voucherDateFallback: "2026-10-31",
        body: {
          locationId: ctx.locationId,
          cashAccountId: ctx.cashAccountId,
          items: [{ stockItemId: ctx.stockItemIds[0], quantity: 2, rate: 12.5 }],
          voucherDate: "2026-10-31",
          ...body,
        } as never,
      },
      { isSpCompany: false }
    )
  );
}

function posEvent(sequence: number, overrides: Partial<Phase9PosSaleEvent["payload"]> = {}): Phase9PosSaleEvent {
  const requestId = overrides.requestId ?? randomUUID();
  const payload = {
    kind: "pos.sale.v1",
    requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    localVoucherId: 900000 + sequence,
    lanInvoiceNumber: `LAN-7C1D-${String(sequence).padStart(6, "0")}`,
    locationId: ctx.locationId,
    paymentAccountType: "cash" as const,
    paymentAccountId: ctx.cashAccountId,
    currency: "USD",
    exchangeRate: null as string | null,
    voucherDate: "2026-10-31",
    notes: null,
    items: [{ stockItemId: ctx.stockItemIds[1], quantity: "3.000", rate: "10.00", originalCurrencyRate: null }],
    ...overrides,
  };
  const event = {
    sequence: String(sequence),
    operationId: requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: payload.localVoucherId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("pos", event);
  return event as Phase9PosSaleEvent;
}

async function replay(event: Phase9PosSaleEvent, overrideConflicts: string[] = []) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), async () => {
    const client = await pool.connect();
    try {
      await phase9PosSaleApplyHandler.authorize(client, event);
      const result = await phase9PosSaleApplyHandler.apply(client, event, { overrideConflicts });
      expect(await phase9PosSaleApplyHandler.verify(client, event, result)).toBe(true);
      return result;
    } finally {
      client.release();
    }
  });
}

async function conflictCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Phase9EventConflict) return error.message;
    throw error;
  }
  throw new Error("expected a Phase 9 conflict");
}

async function stock(stockItemId: number): Promise<number> {
  const result = await pool.query(
    "SELECT quantity::numeric AS q FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
    [ctx.companyId, ctx.locationId, stockItemId]
  );
  return Number(result.rows[0]?.q ?? 0);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const customer = await pool.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Offline Customer', 'Asset', '0', 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}_CUST`]
  );
  customerAccountId = Number(customer.rows[0].id);
  edge.config = LAN;
  await ensurePhase9PosOutboxSchema(pool);
  edge.config = CLOUD;
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query("ALTER TABLE factory_edge_pos_outbox DISABLE TRIGGER factory_edge_pos_outbox_no_mutation");
  await pool.query("DELETE FROM factory_edge_pos_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_pos_outbox ENABLE TRIGGER factory_edge_pos_outbox_no_mutation");
  await pool.query("DELETE FROM factory_edge_pos_counter WHERE site_id = $1", [SITE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 offline POS sale capture on the factory LAN server (POST /api/pos/sales)", () => {
  it("numbers offline sales in the LAN series and records them in the same transaction", async () => {
    edge.config = LAN;
    try {
      const clientSaleId = randomUUID();
      const result = await sale({ clientSaleId });
      expect(result.status).toBe(200);
      const body = result.body as { voucher: { id: number; voucherNumber: string } };
      expect(body.voucher.voucherNumber).toMatch(/^LAN-7C1D-\d{6}$/);
      const outbox = await pool.query(
        "SELECT local_voucher_id, lan_invoice_number, payload FROM factory_edge_pos_outbox WHERE operation_id = $1",
        [clientSaleId]
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]).toMatchObject({
        local_voucher_id: body.voucher.id,
        lan_invoice_number: body.voucher.voucherNumber,
      });
      expect(outbox.rows[0].payload).toMatchObject({
        kind: "pos.sale.v1",
        paymentAccountType: "cash",
        paymentAccountId: ctx.cashAccountId,
        items: [{ stockItemId: ctx.stockItemIds[0], quantity: "2.000", rate: "12.50", originalCurrencyRate: null }],
      });
      // The same till retry is the same sale: no second LAN invoice.
      const retry = await sale({ clientSaleId });
      expect((retry.body as { _idempotent?: boolean })._idempotent).toBe(true);
      const count = await pool.query("SELECT count(*)::int AS n FROM factory_edge_pos_outbox WHERE site_id = $1", [
        SITE,
      ]);
      expect(count.rows[0].n).toBe(1);
    } finally {
      edge.config = CLOUD;
    }
  });

  it("refuses id-less sales and non-USD sales without an entered rate before writing anything", async () => {
    edge.config = LAN;
    try {
      const before = await stock(ctx.stockItemIds[0]);
      expect((await sale({})).body).toMatchObject({ code: "EDGE_POS_CLIENT_SALE_ID_REQUIRED" });
      expect((await sale({ clientSaleId: randomUUID(), currency: "XOF" })).body).toMatchObject({
        code: "EDGE_POS_OFFLINE_RATE_REQUIRED",
      });
      expect(await stock(ctx.stockItemIds[0])).toBe(before);
    } finally {
      edge.config = CLOUD;
    }
  });

  it("records credit sales and foreign-currency sales at the cashier's entered rate", async () => {
    edge.config = LAN;
    try {
      const credit = await sale({
        clientSaleId: randomUUID(),
        isCreditSale: true,
        paymentAccountId: customerAccountId,
      });
      expect(credit.status, JSON.stringify(credit.body)).toBe(200);
      const foreign = await sale({ clientSaleId: randomUUID(), currency: "XOF", exchangeRate: "600" });
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(200);
      const rows = await pool.query(
        "SELECT payload FROM factory_edge_pos_outbox WHERE local_voucher_id = ANY($1::int[]) ORDER BY sequence",
        [
          [
            (credit.body as { voucher: { id: number } }).voucher.id,
            (foreign.body as { voucher: { id: number } }).voucher.id,
          ],
        ]
      );
      expect(rows.rows.map((r) => [r.payload.paymentAccountType, r.payload.currency, r.payload.exchangeRate])).toEqual([
        ["credit", "USD", null],
        ["cash", "XOF", "600"],
      ]);
    } finally {
      edge.config = CLOUD;
    }
  });
});

describe("Phase 9 offline POS sale cloud replay", () => {
  it("replays the sale through the sale service at its offline price, exactly once", async () => {
    const before = await stock(ctx.stockItemIds[1]);
    const event = posEvent(1, { notes: "Gate sale" });
    const applied = await replay(event);
    expect(applied).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-10-31" });
    const voucher = await pool.query(
      "SELECT voucher_number, description, total_amount::text AS total FROM vouchers WHERE id = $1",
      [applied.cloudRef]
    );
    expect(voucher.rows[0].voucher_number).not.toMatch(/^LAN-/);
    expect(voucher.rows[0].description).toBe("Gate sale · Offline sale LAN-7C1D-000001 (offline price)");
    expect(Number(voucher.rows[0].total)).toBe(30);
    expect(await stock(ctx.stockItemIds[1])).toBe(before - 3);
    // Lost acknowledgement: the retry finds the committed sale.
    expect(await replay(event)).toEqual({ ...applied, outcome: "already-present" });
    expect(await stock(ctx.stockItemIds[1])).toBe(before - 3);
  });

  it("holds a sale that would take cloud stock below zero until it is approved", async () => {
    const event = posEvent(2, {
      items: [{ stockItemId: ctx.stockItemIds[2], quantity: "150.000", rate: "1.00", originalCurrencyRate: null }],
    });
    expect(await conflictCode(replay(event))).toBe("PHASE9_POS_STOCK_WOULD_GO_NEGATIVE");
    expect(await stock(ctx.stockItemIds[2])).toBe(100);
    await replay(event, ["PHASE9_POS_STOCK_WOULD_GO_NEGATIVE"]);
    expect(await stock(ctx.stockItemIds[2])).toBe(-50);
  });

  it("refuses a till account that is missing or not a cash account, and a diverged replay", async () => {
    expect(await conflictCode(replay(posEvent(3, { paymentAccountId: ctx.salesAccountId })))).toBe(
      "PHASE9_POS_PAYMENT_ACCOUNT_MISSING"
    );
    const requestId = randomUUID();
    await replay(posEvent(4, { requestId }));
    const diverged = posEvent(5, {
      requestId,
      items: [{ stockItemId: ctx.stockItemIds[1], quantity: "4.000", rate: "10.00", originalCurrencyRate: null }],
    });
    expect(await conflictCode(replay(diverged))).toBe("PHASE9_POS_REQUEST_ID_DIVERGED");
  });

  it("replays a credit sale to the customer and a foreign sale at the LAN rate, never a re-derived one", async () => {
    const credit = await replay(posEvent(6, { paymentAccountType: "credit", paymentAccountId: customerAccountId }));
    const foreign = await replay(posEvent(7, { currency: "XOF", exchangeRate: "600" }));
    const vouchers = await pool.query(
      "SELECT id, is_credit_sale, currency, exchange_rate::numeric AS rate FROM vouchers WHERE id = ANY($1::int[]) ORDER BY id",
      [[credit.cloudRef, foreign.cloudRef]]
    );
    expect(vouchers.rows.map((r) => [r.is_credit_sale, r.currency, r.rate === null ? null : Number(r.rate)])).toEqual([
      [true, "USD", null],
      [false, "XOF", 600],
    ]);
  });
});
