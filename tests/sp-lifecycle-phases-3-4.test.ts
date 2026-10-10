import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "splife34";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let payableAccountId: number;
let bankAccountId: number;

async function login() {
  const response = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(response.status).toBe(200);
  const companyResponse = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(companyResponse.status).toBe(200);
}

async function createSpAccount(code: string, name: string, accountType: string, subType: string) {
  const [account] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code,
      name,
      accountType,
      subType,
      openingBalance: "0",
      openingBalanceSide: accountType === "Asset" ? "Dr" : "Cr",
    })
    .returning();
  return account;
}

async function inventoryQuantity(stockItemId: number): Promise<number> {
  const [row] = await db
    .select({ quantity: schema.inventory.quantity })
    .from(schema.inventory)
    .where(
      and(
        eq(schema.inventory.companyId, ctx.companyId),
        eq(schema.inventory.locationId, ctx.locationId),
        eq(schema.inventory.stockItemId, stockItemId)
      )
    );
  return Number(row?.quantity ?? 0);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);

  const payable = await createSpAccount("SP-PAY-L34", "SP Lifecycle Payable", "Liability", "sp_payable");
  payableAccountId = payable.id;
  await createSpAccount("SP-OTW-L34", "SP Lifecycle Goods OTW", "Asset", "sp_goods_otw");
  await createSpAccount("SP-OTWCLR-L34", "SP Lifecycle OTW Clearing", "Liability", "sp_otw_clearing");

  const [bank] = await db
    .insert(schema.bankAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_BANK`,
      name: "SP Lifecycle Bank",
      bankName: "SP Lifecycle Bank",
      accountNumber: "3400000001",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  bankAccountId = bank.id;

  agent = request.agent(ctx.app);
  await login();
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM sp_sale_lines WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_sales WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_offload_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_offloads WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_prepaid_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_container_lines WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM sp_containers WHERE company_id = $1`, [ctx.companyId]);
  // Lines on these bank accounts go first: voucher_entries.bank_account_id is a
  // RESTRICT foreign key. Every line of their vouchers goes with them, in one
  // statement, so no voucher is left one-sided for the voucher balance guard.
  await db
    .delete(schema.voucherEntries)
    .where(
      sql`${schema.voucherEntries.voucherId} IN (SELECT voucher_id FROM voucher_entries WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = ${ctx.companyId}))`
    );
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, ctx.companyId));
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("Supplier Partner Phase 3 — full sale reversal", () => {
  it("restores FIFO lot and ERP inventory while posting an exact compensating voucher", async () => {
    const stockItemId = ctx.stockItemIds[0];
    const inventoryBeforeSale = await inventoryQuantity(stockItemId);

    const [lot] = await db
      .insert(schema.spStockMovements)
      .values({
        companyId: ctx.companyId,
        sourceType: "opening",
        articleCode: `${TEST_PREFIX}-SALE-ITEM`,
        description: "Lifecycle test item",
        stockItemId,
        locationId: ctx.locationId,
        qtyIn: "2",
        qtyRemaining: "2",
        baseUnitCostUsd: "40",
        landedUnitCostUsd: "10",
        finalUnitCostUsd: "50",
      })
      .returning();

    const saleResponse = await agent.post("/api/sp/sales").send({
      saleDate: "2026-08-03",
      customerName: "Lifecycle Test Customer",
      bankAccountId,
      saleLines: [{ stockItemId, qtySold: 1, salePricePerUnit: 80 }],
    });

    expect(saleResponse.status).toBe(200);
    const sale = saleResponse.body;
    expect(sale.status).toBe("posted");
    expect(await inventoryQuantity(stockItemId)).toBeCloseTo(inventoryBeforeSale - 1, 3);

    const [lotAfterSale] = await db
      .select()
      .from(schema.spStockMovements)
      .where(eq(schema.spStockMovements.id, lot.id));
    expect(Number(lotAfterSale.qtyRemaining)).toBeCloseTo(1, 4);

    const originalEntries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, sale.voucherId));
    expect(originalEntries).toHaveLength(2);

    const reverseResponse = await agent.post(`/api/sp/sales/${sale.id}/reverse`).send({
      reason: "Customer sale was entered twice",
      confirmation: "REVERSE SP SALE",
      idempotencyKey: `reverse-sale-${sale.id}`,
      reversalDate: "2026-08-03",
    });

    expect(reverseResponse.status).toBe(200);
    expect(reverseResponse.body.sale.status).toBe("reversed");
    expect(reverseResponse.body.restoredLineCount).toBe(1);
    expect(reverseResponse.body.reversalVoucherId).toBeTruthy();

    const [lotAfterReversal] = await db
      .select()
      .from(schema.spStockMovements)
      .where(eq(schema.spStockMovements.id, lot.id));
    expect(Number(lotAfterReversal.qtyRemaining)).toBeCloseTo(2, 4);
    expect(await inventoryQuantity(stockItemId)).toBeCloseTo(inventoryBeforeSale, 3);

    const reversalEntries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, reverseResponse.body.reversalVoucherId));
    expect(reversalEntries).toHaveLength(2);

    const reversalBank = reversalEntries.find((entry) => entry.bankAccountId === bankAccountId);
    const reversalPayable = reversalEntries.find((entry) => entry.ledgerAccountId === payableAccountId);
    expect(Number(reversalBank?.creditAmount)).toBeCloseTo(80, 2);
    expect(Number(reversalBank?.debitAmount)).toBeCloseTo(0, 2);
    expect(Number(reversalPayable?.debitAmount)).toBeCloseTo(80, 2);
    expect(Number(reversalPayable?.creditAmount)).toBeCloseTo(0, 2);

    const totalDebit = reversalEntries.reduce((sum, entry) => sum + Number(entry.debitAmount ?? 0), 0);
    const totalCredit = reversalEntries.reduce((sum, entry) => sum + Number(entry.creditAmount ?? 0), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);

    const duplicateResponse = await agent.post(`/api/sp/sales/${sale.id}/reverse`).send({
      reason: "Attempt to reverse the same sale again",
      confirmation: "REVERSE SP SALE",
      idempotencyKey: `reverse-sale-duplicate-${sale.id}`,
    });
    expect(duplicateResponse.status).toBe(409);
    expect(duplicateResponse.body.code).toBe("SP_SALE_NOT_REVERSIBLE");
  });
});

describe("Supplier Partner Phase 4 — open-container cancellation", () => {
  it("reverses Goods OTW, detaches unused prepaid charges and locks the cancelled container", async () => {
    const createResponse = await agent.post("/api/sp/containers").send({
      supplierName: "Lifecycle Supplier",
      invoiceNumber: "LIFE-INV-34",
      containerNumber: "LIFE-CONT-34",
      invoiceDate: "2026-08-03",
      invoiceTotalUsd: 1200,
      lines: [],
    });

    expect(createResponse.status).toBe(200);
    const containerId = createResponse.body.id;

    const [containerBefore] = await db
      .select()
      .from(schema.spContainers)
      .where(and(eq(schema.spContainers.id, containerId), eq(schema.spContainers.companyId, ctx.companyId)));
    expect(containerBefore.status).toBe("open");
    expect(containerBefore.goodsOtwVoucherId).toBeTruthy();

    const [prepaid] = await db
      .insert(schema.spPrepaidCharges)
      .values({
        companyId: ctx.companyId,
        containerId,
        prepaidDate: "2026-08-03",
        chargeType: "freight",
        amountPaidUsd: "150",
        amountUsedUsd: "0",
        notes: "Unused lifecycle prepaid",
      })
      .returning();

    const originalEntries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, Number(containerBefore.goodsOtwVoucherId)));
    expect(originalEntries).toHaveLength(2);

    const cancellationResponse = await agent.post(`/api/sp/containers/${containerId}/cancel`).send({
      reason: "Supplier cancelled the shipment before dispatch",
      confirmation: "CANCEL SP CONTAINER",
      idempotencyKey: `cancel-container-${containerId}`,
      cancellationDate: "2026-08-03",
    });

    expect(cancellationResponse.status).toBe(200);
    expect(cancellationResponse.body.container.status).toBe("cancelled");
    expect(cancellationResponse.body.cancellationVoucherId).toBeTruthy();
    expect(cancellationResponse.body.detachedPrepaidChargeCount).toBe(1);

    const [detachedPrepaid] = await db
      .select()
      .from(schema.spPrepaidCharges)
      .where(eq(schema.spPrepaidCharges.id, prepaid.id));
    expect(detachedPrepaid.containerId).toBeNull();
    expect(Number(detachedPrepaid.amountPaidUsd)).toBeCloseTo(150, 2);

    const cancellationEntries = await db
      .select()
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, cancellationResponse.body.cancellationVoucherId));
    expect(cancellationEntries).toHaveLength(originalEntries.length);

    const originalDebit = originalEntries.reduce((sum, entry) => sum + Number(entry.debitAmount ?? 0), 0);
    const originalCredit = originalEntries.reduce((sum, entry) => sum + Number(entry.creditAmount ?? 0), 0);
    const cancellationDebit = cancellationEntries.reduce((sum, entry) => sum + Number(entry.debitAmount ?? 0), 0);
    const cancellationCredit = cancellationEntries.reduce((sum, entry) => sum + Number(entry.creditAmount ?? 0), 0);
    expect(originalDebit).toBeCloseTo(cancellationCredit, 2);
    expect(originalCredit).toBeCloseTo(cancellationDebit, 2);

    const editResponse = await agent.patch(`/api/sp/containers/${containerId}`).send({
      supplierName: "Changed after cancellation",
    });
    expect(editResponse.status).toBe(409);
    expect(editResponse.body.code).toBe("SP_CONTAINER_NOT_EDITABLE");

    const duplicateResponse = await agent.post(`/api/sp/containers/${containerId}/cancel`).send({
      reason: "Attempt to cancel the same container again",
      confirmation: "CANCEL SP CONTAINER",
      idempotencyKey: `cancel-container-duplicate-${containerId}`,
    });
    expect(duplicateResponse.status).toBe(409);
    expect(duplicateResponse.body.code).toBe("SP_CONTAINER_NOT_CANCELLABLE");
  });
});
