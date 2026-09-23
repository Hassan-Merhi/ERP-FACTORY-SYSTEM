/**
 * Phase 19 backend coverage — intercompany lifecycle and shared charges.
 *
 * Covers:
 * - Golden Coast child -> HADI parent mirrored cash/intercompany journals.
 * - exact-request replay, edit/rebuild, and linked cancellation.
 * - HADI/HMD-style reciprocal balance equality.
 * - Supplier Partner offload freight plus parent-agent/shared-charge journals.
 * - a standalone/non-parent Supplier Partner remaining entirely local.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { postSupplierPartnerJournals } from "../server/services/containers/offload-lifecycle/sp-journals";
import type { ContainerOffloadLifecycleInput } from "../server/services/containers/offload-lifecycle/types";
import { closeTestServer } from "./setup";
import {
  setupGoldenCoastNormalPosFixture,
  teardownGoldenCoastNormalPosFixture,
  voucherEntriesFor,
  type GoldenCoastNormalPosFixture,
} from "./helpers/goldenCoastPhase5Fixture";

const PREFIX = `p19ic-${Date.now().toString(36)}`;
const SALE_DATE = "2026-09-15";
const SETTLEMENT_SOURCE_TYPE = "golden-coast-pos-settlement";

let fixture: GoldenCoastNormalPosFixture;
let childOtwId = 0;
let childOtwClearingId = 0;
let childCostClearingId = 0;
let childPrepaidExpensesId = 0;
let parentAgentAccountId = 0;
let plainOtwId = 0;
let plainOtwClearingId = 0;
let plainStockId = 0;
let plainCostClearingId = 0;

async function insertLedger(input: {
  companyId: number;
  code: string;
  name: string;
  accountType: string;
  subType: string;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active, is_hidden)
     VALUES ($1, $2, $3, $4, $5, '0', 'Dr', true, false)
     RETURNING id`,
    [input.companyId, input.code, input.name, input.accountType, input.subType]
  );
  return result.rows[0].id;
}

async function accountBalance(accountId: number): Promise<number> {
  const result = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0)::text AS balance
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
      WHERE ve.ledger_account_id = $1
        AND v.deleted_at IS NULL`,
    [accountId]
  );
  return Number(result.rows[0].balance);
}

async function settlementVoucherIds(clientSaleId: string): Promise<number[]> {
  const result = await pool.query<{ voucher_id: number }>(
    `SELECT voucher_id
       FROM accounting_posting_requests
      WHERE source_type = $1 AND source_id LIKE $2
      ORDER BY voucher_id`,
    [SETTLEMENT_SOURCE_TYPE, `${clientSaleId}:%`]
  );
  return result.rows.map((row) => Number(row.voucher_id));
}

async function settlementMarkers(clientSaleId: string): Promise<
  Array<{
    voucherId: number;
    companyId: number;
    sourceId: string;
  }>
> {
  const result = await pool.query<{ voucher_id: number; company_id: number; source_id: string }>(
    `SELECT voucher_id, company_id, source_id
       FROM accounting_posting_requests
      WHERE source_type = $1 AND source_id LIKE $2
      ORDER BY company_id, voucher_id`,
    [SETTLEMENT_SOURCE_TYPE, `${clientSaleId}:%`]
  );
  return result.rows.map((row) => ({
    voucherId: Number(row.voucher_id),
    companyId: Number(row.company_id),
    sourceId: String(row.source_id),
  }));
}

async function expectBalanced(voucherIds: number[]) {
  expect(voucherIds.length).toBeGreaterThan(0);
  for (const voucherId of voucherIds) {
    const rows = await voucherEntriesFor(voucherId);
    const debit = rows.reduce((sum, row) => sum + Number(row.debitAmount), 0);
    const credit = rows.reduce((sum, row) => sum + Number(row.creditAmount), 0);
    expect(debit).toBeCloseTo(credit, 2);
  }
}

function saleBody(clientSaleId: string, quantity = "4", rate = "125") {
  return {
    locationId: fixture.ctx.locationId,
    voucherDate: SALE_DATE,
    paymentAccountType: "ledger",
    paymentAccountId: fixture.ctx.cashAccountId,
    clientSaleId,
    targetCompanyId: fixture.hadiCompanyId,
    items: [{ stockItemId: fixture.goldenCoastStockItemId, quantity, rate }],
  };
}

beforeAll(async () => {
  fixture = await setupGoldenCoastNormalPosFixture(PREFIX);

  childOtwId = await insertLedger({
    companyId: fixture.ctx.companyId,
    code: `P19-OTW-${fixture.ctx.companyId}`,
    name: "Phase 19 Goods OTW",
    accountType: "Asset",
    subType: "sp_goods_otw",
  });
  childOtwClearingId = await insertLedger({
    companyId: fixture.ctx.companyId,
    code: `P19-OTWC-${fixture.ctx.companyId}`,
    name: "Phase 19 OTW Clearing",
    accountType: "Liability",
    subType: "sp_otw_clearing",
  });
  childCostClearingId = await insertLedger({
    companyId: fixture.ctx.companyId,
    code: `P19-COST-${fixture.ctx.companyId}`,
    name: "Phase 19 Cost Clearing",
    accountType: "Liability",
    subType: "sp_cost_clearing",
  });
  childPrepaidExpensesId = await insertLedger({
    companyId: fixture.ctx.companyId,
    code: `P19-PREEXP-${fixture.ctx.companyId}`,
    name: "Phase 19 Prepaid Expenses",
    accountType: "Asset",
    subType: "sp_prepaid_expenses",
  });
  parentAgentAccountId = await insertLedger({
    companyId: fixture.hadiCompanyId,
    code: `P19-AGENT-${fixture.hadiCompanyId}`,
    name: "Phase 19 Parent Freight Agent",
    accountType: "Loans",
    subType: "p19_parent_agent",
  });

  plainOtwId = await insertLedger({
    companyId: fixture.plainCompanyId,
    code: `P19-POTW-${fixture.plainCompanyId}`,
    name: "Phase 19 Plain Goods OTW",
    accountType: "Asset",
    subType: "sp_goods_otw",
  });
  plainOtwClearingId = await insertLedger({
    companyId: fixture.plainCompanyId,
    code: `P19-POTWC-${fixture.plainCompanyId}`,
    name: "Phase 19 Plain OTW Clearing",
    accountType: "Liability",
    subType: "sp_otw_clearing",
  });
  plainStockId = await insertLedger({
    companyId: fixture.plainCompanyId,
    code: `P19-PSTOCK-${fixture.plainCompanyId}`,
    name: "Phase 19 Plain Stock",
    accountType: "Asset",
    subType: "sp_stock",
  });
  plainCostClearingId = await insertLedger({
    companyId: fixture.plainCompanyId,
    code: `P19-PCOST-${fixture.plainCompanyId}`,
    name: "Phase 19 Plain Cost Clearing",
    accountType: "Liability",
    subType: "sp_cost_clearing",
  });
}, 120_000);

afterAll(async () => {
  if (fixture) await teardownGoldenCoastNormalPosFixture(fixture);
  closeTestServer();
}, 120_000);

describe("Phase 19 intercompany flows", () => {
  it("posts equal-and-opposite parent/child settlement with balanced mirrored journals", async () => {
    const beforeParentCash = await accountBalance(fixture.hadiCashAccountId);
    const beforeChildIntercompany = await accountBalance(fixture.goldenCoastIntercompanyAccountId);
    const beforeParentIntercompany = await accountBalance(fixture.hadiIntercompanyAccountId);

    const response = await fixture.agent.post("/api/pos/sales").send(saleBody("p19-parent-flow", "4", "125"));
    expect(response.status, response.text).toBe(200);
    expect(Number(response.body.voucher.id)).toBeGreaterThan(0);

    const settlementIds = await settlementVoucherIds("p19-parent-flow");
    expect(settlementIds).toHaveLength(2);
    await expectBalanced(settlementIds);

    const childDelta = (await accountBalance(fixture.goldenCoastIntercompanyAccountId)) - beforeChildIntercompany;
    const parentDelta = (await accountBalance(fixture.hadiIntercompanyAccountId)) - beforeParentIntercompany;
    const parentCashDelta = (await accountBalance(fixture.hadiCashAccountId)) - beforeParentCash;

    expect(childDelta).toBeCloseTo(500, 2);
    expect(parentDelta).toBeCloseTo(-500, 2);
    expect(parentCashDelta).toBeCloseTo(500, 2);
    // HADI/HMD-style control: the reciprocal intercompany movements are equal
    // in absolute amount and opposite in sign after every successful posting.
    expect(Math.abs(childDelta)).toBeCloseTo(Math.abs(parentDelta), 2);
    expect(childDelta + parentDelta).toBeCloseTo(0, 2);
  });

  it("replays the same parent settlement without duplicate journals", async () => {
    const body = saleBody("p19-retry", "2", "175");
    const first = await fixture.agent.post("/api/pos/sales").send(body);
    expect(first.status, first.text).toBe(200);
    const beforeIds = await settlementVoucherIds("p19-retry");
    expect(beforeIds).toHaveLength(2);

    const retry = await fixture.agent.post("/api/pos/sales").send(body);
    expect(retry.status, retry.text).toBe(200);
    expect(retry.body.voucher.id).toBe(first.body.voucher.id);
    expect(await settlementVoucherIds("p19-retry")).toEqual(beforeIds);
    await expectBalanced(beforeIds);
  });

  // Settlement journals represent the sale's current state: an edit retires
  // the previous pair and posts one pair for the edited amount (ccabbc7),
  // rather than reversing and rebuilding.
  it("replaces the mirrored settlement with one pair for the edited sale", async () => {
    const beforeChildIntercompany = await accountBalance(fixture.goldenCoastIntercompanyAccountId);
    const beforeParentIntercompany = await accountBalance(fixture.hadiIntercompanyAccountId);
    const created = await fixture.agent.post("/api/pos/sales").send(saleBody("p19-edit", "4", "100"));
    expect(created.status, created.text).toBe(200);
    const voucherId = Number(created.body.voucher.id);

    const edited = await fixture.agent.patch(`/api/vouchers/${voucherId}/sales`).send({
      locationId: fixture.ctx.locationId,
      paymentAccountType: "cash",
      paymentAccountId: fixture.ctx.cashAccountId,
      targetCompanyId: fixture.hadiCompanyId,
      items: [{ stockItemId: fixture.goldenCoastStockItemId, quantity: "3", sellingPrice: "150" }],
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body.grandTotal).toBe("450.00");

    const childDelta = (await accountBalance(fixture.goldenCoastIntercompanyAccountId)) - beforeChildIntercompany;
    const parentDelta = (await accountBalance(fixture.hadiIntercompanyAccountId)) - beforeParentIntercompany;
    expect(childDelta).toBeCloseTo(450, 2);
    expect(parentDelta).toBeCloseTo(-450, 2);
    expect(childDelta + parentDelta).toBeCloseTo(0, 2);

    const markers = await settlementMarkers("p19-edit");
    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => marker.sourceId.includes(":edit1:"))).toBe(true);
    expect(new Set(markers.map((marker) => marker.companyId))).toEqual(
      new Set([fixture.ctx.companyId, fixture.hadiCompanyId])
    );
    await expectBalanced(markers.map((marker) => marker.voucherId));
  });

  it("retires the pre-edit settlement pair instead of reversing it", async () => {
    const clientSaleId = "p19-retire";
    const created = await fixture.agent.post("/api/pos/sales").send(saleBody(clientSaleId, "4", "100"));
    expect(created.status, created.text).toBe(200);
    const voucherId = Number(created.body.voucher.id);
    const originalIds = await settlementVoucherIds(clientSaleId);
    expect(originalIds).toHaveLength(2);

    const edited = await fixture.agent.patch(`/api/vouchers/${voucherId}/sales`).send({
      locationId: fixture.ctx.locationId,
      paymentAccountType: "cash",
      paymentAccountId: fixture.ctx.cashAccountId,
      targetCompanyId: fixture.hadiCompanyId,
      items: [{ stockItemId: fixture.goldenCoastStockItemId, quantity: "3", sellingPrice: "150" }],
    });
    expect(edited.status, edited.text).toBe(200);

    const retired = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM vouchers WHERE id = ANY($1::int[])`,
      [originalIds]
    );
    expect(retired.rows).toHaveLength(2);
    expect(retired.rows.every((row) => row.deleted_at !== null)).toBe(true);

    const markers = await settlementMarkers(clientSaleId);
    expect(markers.map((marker) => marker.voucherId).some((id) => originalIds.includes(id))).toBe(false);
    expect(markers.some((marker) => marker.sourceId.includes(":reversal:"))).toBe(false);
  });

  it("deletes the rebuilt settlement journal together with its counterpart", async () => {
    const clientSaleId = "p19-delete-rebuilt";
    const beforeChildIntercompany = await accountBalance(fixture.goldenCoastIntercompanyAccountId);
    const beforeParentIntercompany = await accountBalance(fixture.hadiIntercompanyAccountId);

    const created = await fixture.agent.post("/api/pos/sales").send(saleBody(clientSaleId, "4", "100"));
    expect(created.status, created.text).toBe(200);
    const voucherId = Number(created.body.voucher.id);

    const edited = await fixture.agent.patch(`/api/vouchers/${voucherId}/sales`).send({
      locationId: fixture.ctx.locationId,
      paymentAccountType: "cash",
      paymentAccountId: fixture.ctx.cashAccountId,
      targetCompanyId: fixture.hadiCompanyId,
      items: [{ stockItemId: fixture.goldenCoastStockItemId, quantity: "3", sellingPrice: "150" }],
    });
    expect(edited.status, edited.text).toBe(200);

    const markers = await settlementMarkers(clientSaleId);
    const childCash = markers.find(
      (marker) => marker.companyId === fixture.ctx.companyId && marker.sourceId.endsWith(":edit1:gc_cash_transfer")
    );
    expect(childCash, JSON.stringify(markers)).toBeDefined();

    const deleted = await fixture.agent.delete(`/api/vouchers/${childCash!.voucherId}`);
    expect(deleted.status, deleted.text).toBe(200);
    expect(deleted.body.message).toMatch(/intercompany cash transfer deleted/i);
    expect(await settlementMarkers(clientSaleId)).toHaveLength(0);

    // With the settlement gone, the intercompany accounts are back where they started.
    expect(await accountBalance(fixture.goldenCoastIntercompanyAccountId)).toBeCloseTo(beforeChildIntercompany, 2);
    expect(await accountBalance(fixture.hadiIntercompanyAccountId)).toBeCloseTo(beforeParentIntercompany, 2);
  });

  it("cancels the source sale and all linked cross-company settlement evidence atomically", async () => {
    const beforeChildIntercompany = await accountBalance(fixture.goldenCoastIntercompanyAccountId);
    const beforeParentIntercompany = await accountBalance(fixture.hadiIntercompanyAccountId);
    const beforeParentCash = await accountBalance(fixture.hadiCashAccountId);

    const created = await fixture.agent.post("/api/pos/sales").send(saleBody("p19-cancel", "2", "120"));
    expect(created.status, created.text).toBe(200);
    const voucherId = Number(created.body.voucher.id);
    expect(await settlementVoucherIds("p19-cancel")).toHaveLength(2);

    const deleted = await fixture.agent.delete(`/api/vouchers/${voucherId}`);
    expect(deleted.status, deleted.text).toBe(200);
    expect(deleted.body.message).toMatch(/linked intercompany cash transfer deleted/i);
    expect(await settlementVoucherIds("p19-cancel")).toHaveLength(0);

    expect(await accountBalance(fixture.goldenCoastIntercompanyAccountId)).toBeCloseTo(beforeChildIntercompany, 2);
    expect(await accountBalance(fixture.hadiIntercompanyAccountId)).toBeCloseTo(beforeParentIntercompany, 2);
    expect(await accountBalance(fixture.hadiCashAccountId)).toBeCloseTo(beforeParentCash, 2);

    const softDeleted = await pool.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM vouchers WHERE id = $1`, [
      voucherId,
    ]);
    expect(softDeleted.rows[0].deleted_at).not.toBeNull();
  });

  it("posts supplier freight and parent-agent shared charges against the configured parent company", async () => {
    const containerId = 9_190_001;
    const minimalContainer = {
      id: containerId,
      companyId: fixture.ctx.companyId,
      grandTotal: "1000.00",
    } as unknown as typeof schema.containers.$inferSelect;
    const purchaseOrders = [
      {
        supplierId: null,
        itemsTotal: "900.00",
        freight: "100.00",
        otherCharges: "0",
        surcharge: "0",
        fumigation: "0",
        documentCharges: "0",
        discount: "0",
      },
    ] as unknown as Array<typeof schema.purchaseOrders.$inferSelect>;
    const input: ContainerOffloadLifecycleInput = {
      companyId: fixture.ctx.companyId,
      containerId,
      mode: "create-or-replace",
      locationId: fixture.ctx.locationId,
      offloadDate: SALE_DATE,
      duties: "0",
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
      agentChargeLines: [
        {
          amountUsd: 150,
          parentAgentAccountId,
          description: "Shared freight handled by parent",
        },
      ],
    };

    await db.transaction((tx) => postSupplierPartnerJournals(tx, minimalContainer, purchaseOrders, input));

    const vouchers = await pool.query<{
      id: number;
      company_id: number;
      voucher_number: string;
      debit: string;
      credit: string;
    }>(
      `SELECT v.id, v.company_id, v.voucher_number,
              COALESCE(SUM(ve.debit_amount::numeric), 0)::text AS debit,
              COALESCE(SUM(ve.credit_amount::numeric), 0)::text AS credit
         FROM vouchers v
         JOIN voucher_entries ve ON ve.voucher_id = v.id
        WHERE v.voucher_number LIKE $1
           OR v.voucher_number LIKE $2
           OR v.voucher_number LIKE $3
           OR v.voucher_number LIKE $4
        GROUP BY v.id, v.company_id, v.voucher_number
        ORDER BY v.id`,
      [
        `SP-OTW-REV-ERP-${containerId}-%`,
        `SP-STOCK-ERP-${containerId}-%`,
        `SP-AGENT-SETTLE-${containerId}-%`,
        `SP-AGENT-ERP-${containerId}-%`,
      ]
    );
    expect(vouchers.rows).toHaveLength(4);
    for (const voucher of vouchers.rows) {
      expect(Number(voucher.debit)).toBeCloseTo(Number(voucher.credit), 2);
    }

    const reversal = vouchers.rows.find((row) => row.voucher_number.startsWith("SP-OTW-REV-ERP-"));
    const stock = vouchers.rows.find((row) => row.voucher_number.startsWith("SP-STOCK-ERP-"));
    const parent = vouchers.rows.find((row) => row.voucher_number.startsWith("SP-AGENT-ERP-"));
    expect(Number(reversal?.debit)).toBeCloseTo(1000, 2); // 900 goods + 100 freight
    expect(Number(stock?.debit)).toBeCloseTo(1000, 2);
    expect(parent?.company_id).toBe(fixture.hadiCompanyId);

    const childSharedDelta = await accountBalance(fixture.goldenCoastIntercompanyAccountId);
    const parentSharedDelta = await accountBalance(fixture.hadiIntercompanyAccountId);
    const childEntry = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text AS debit,
              COALESCE(SUM(ve.credit_amount::numeric), 0)::text AS credit
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.voucher_number LIKE $1 AND ve.ledger_account_id = $2`,
      [`SP-AGENT-SETTLE-${containerId}-%`, fixture.goldenCoastIntercompanyAccountId]
    );
    const parentEntry = await pool.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text AS debit,
              COALESCE(SUM(ve.credit_amount::numeric), 0)::text AS credit
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.voucher_number LIKE $1 AND ve.ledger_account_id = $2`,
      [`SP-AGENT-ERP-${containerId}-%`, fixture.hadiIntercompanyAccountId]
    );
    expect(Number(childEntry.rows[0].debit)).toBeCloseTo(150, 2);
    expect(Number(parentEntry.rows[0].debit)).toBeCloseTo(150, 2);
    expect(Math.abs(Number(childEntry.rows[0].debit) - Number(parentEntry.rows[0].debit))).toBeCloseTo(0, 2);
    expect(Number.isFinite(childSharedDelta)).toBe(true);
    expect(Number.isFinite(parentSharedDelta)).toBe(true);

    // Prove the service resolved accounts by configured company, not historical
    // company id 1 or by account name alone.
    const parentVoucher = vouchers.rows.find((row) => row.voucher_number.startsWith("SP-AGENT-ERP-"));
    expect(parentVoucher?.company_id).toBe(fixture.hadiCompanyId);
    expect(childOtwId).toBeGreaterThan(0);
    expect(childOtwClearingId).toBeGreaterThan(0);
    expect(childCostClearingId).toBeGreaterThan(0);
    expect(childPrepaidExpensesId).toBeGreaterThan(0);
  });

  it("keeps a non-parent Supplier Partner offload journal local when no parent charge exists", async () => {
    const containerId = 9_190_002;
    const minimalContainer = {
      id: containerId,
      companyId: fixture.plainCompanyId,
      grandTotal: "300.00",
    } as unknown as typeof schema.containers.$inferSelect;
    const input: ContainerOffloadLifecycleInput = {
      companyId: fixture.plainCompanyId,
      containerId,
      mode: "create-or-replace",
      locationId: fixture.plainLocationId,
      offloadDate: SALE_DATE,
      duties: "0",
      officeCharges: "0",
      transferCharges: "0",
      transportFees: "0",
      agentChargeLines: [],
    };

    await db.transaction((tx) => postSupplierPartnerJournals(tx, minimalContainer, [], input));

    const rows = await pool.query<{ company_id: number; count: number }>(
      `SELECT company_id, COUNT(*)::int AS count
         FROM vouchers
        WHERE voucher_number LIKE $1 OR voucher_number LIKE $2
        GROUP BY company_id`,
      [`SP-OTW-REV-ERP-${containerId}-%`, `SP-STOCK-ERP-${containerId}-%`]
    );
    expect(rows.rows).toEqual([{ company_id: fixture.plainCompanyId, count: 2 }]);
    expect(plainOtwId).toBeGreaterThan(0);
    expect(plainOtwClearingId).toBeGreaterThan(0);
    expect(plainStockId).toBeGreaterThan(0);
    expect(plainCostClearingId).toBeGreaterThan(0);
  });
});
