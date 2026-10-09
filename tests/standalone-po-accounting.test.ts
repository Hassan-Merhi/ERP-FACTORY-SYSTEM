import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";

import { db, pool } from "../server/db";
import { storage } from "../server/storage";
import { resolveParentCompanyId } from "../server/routes/helpers/supplierBalanceHelpers";
import * as schema from "../shared/schema";
import { companyScopedSuppliers } from "../shared/schema/supplierCompanyScope";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "standpo";

let ctx: TestContext;
let originalParentCompanyId: number | null;
let legacyParentCompanyId: number;
let supplierId: number;
let containerId: number;
let poId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  originalParentCompanyId = await storage.getParentCompanyId();

  const [legacyParent] = await db
    .insert(schema.companies)
    .values({
      code: `${TEST_PREFIX.toUpperCase()}P`,
      name: `${TEST_PREFIX} Legacy Parent`,
      companyType: "erp",
      baseCurrency: "USD",
      active: true,
    })
    .returning();
  legacyParentCompanyId = legacyParent.id;

  // Reproduce the production condition: a historical/global parent is set,
  // but the active ERP company is explicitly unlinked in companies.parent_company_id.
  await storage.setParentCompanyId(legacyParentCompanyId);
  await db
    .update(schema.companies)
    .set({ parentCompanyId: null, companyType: "erp" })
    .where(eq(schema.companies.id, ctx.companyId));

  const [supplier] = await db
    .insert(companyScopedSuppliers)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX.toUpperCase()}-SUP`,
      legalName: `${TEST_PREFIX} Supplier`,
      email: `${TEST_PREFIX}@example.test`,
      openingBalance: "0",
      active: true,
    })
    .returning();
  supplierId = supplier.id;

  const [container] = await db
    .insert(schema.containers)
    .values({
      companyId: ctx.companyId,
      containerNumber: `${TEST_PREFIX.toUpperCase()}-CONT`,
      supplierId,
      status: "OTW",
      importDate: "2026-09-02",
      itemsTotal: "125.00",
      chargesTotal: "0",
      grandTotal: "125.00",
    })
    .returning();
  containerId = container.id;
}, 60000);

afterAll(async () => {
  if (poId) {
    const [po] = await db
      .select({ voucherId: schema.purchaseOrders.voucherId })
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, poId));
    await db.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, poId));
    await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    if (po?.voucherId) {
      await pool.query("DELETE FROM accounting_posting_requests WHERE voucher_id = $1", [po.voucherId]);
      await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, po.voucherId));
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, po.voucherId));
    }
  }
  if (containerId) await db.delete(schema.containers).where(eq(schema.containers.id, containerId));
  if (supplierId) await db.delete(companyScopedSuppliers).where(eq(companyScopedSuppliers.id, supplierId));

  await storage.setParentCompanyId(originalParentCompanyId);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("standalone purchase-order accounting", () => {
  it("keeps supplier parent resolution inside an explicitly unlinked company", async () => {
    await expect(resolveParentCompanyId(ctx.companyId)).resolves.toBe(ctx.companyId);
  });

  it("posts Purchases and Supplier inside the unlinked company and does not touch the global parent", async () => {
    const po = await storage.createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber: `${TEST_PREFIX.toUpperCase()}-PO-1`,
        containerId,
        supplierId,
        currency: "USD",
        itemsTotal: "125.00",
        freight: "0",
        surcharge: "0",
        fumigation: "0",
        documentCharges: "0",
        discount: "0",
        otherCharges: "0",
        status: "Open",
      },
      "2026-09-02"
    );
    poId = po.id;

    const [storedPo] = await db
      .select({ voucherId: schema.purchaseOrders.voucherId })
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, po.id));
    const voucherId = storedPo?.voucherId;
    expect(voucherId).toBeTruthy();
    if (!voucherId) throw new Error("Standalone PO did not create a purchase voucher");

    const [purchaseVoucher] = await db
      .select({ companyId: schema.vouchers.companyId })
      .from(schema.vouchers)
      .where(eq(schema.vouchers.id, voucherId));
    expect(purchaseVoucher.companyId).toBe(ctx.companyId);

    const entries = await db
      .select({
        supplierId: schema.voucherEntries.supplierId,
        ledgerAccountId: schema.voucherEntries.ledgerAccountId,
        debitAmount: schema.voucherEntries.debitAmount,
        creditAmount: schema.voucherEntries.creditAmount,
      })
      .from(schema.voucherEntries)
      .where(eq(schema.voucherEntries.voucherId, voucherId));

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          supplierId,
          debitAmount: "0.00",
          creditAmount: "125.00",
        }),
        expect.objectContaining({
          debitAmount: "125.00",
          creditAmount: "0.00",
        }),
      ])
    );

    const parentInterco = await db
      .select({ id: schema.vouchers.id })
      .from(schema.vouchers)
      .where(
        and(
          eq(schema.vouchers.companyId, legacyParentCompanyId),
          like(schema.vouchers.voucherNumber, `INTERCO-PARENT-${TEST_PREFIX.toUpperCase()}-PO-1-%`)
        )
      );
    expect(parentInterco).toHaveLength(0);

    const parentCredit = await db
      .select({ id: schema.ledgerAccounts.id })
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.companyId, ctx.companyId),
          like(schema.ledgerAccounts.name, `%Legacy Parent Credit%`)
        )
      );
    expect(parentCredit).toHaveLength(0);
  });

  it("posts the PO voucher at the cents the PO row stores", async () => {
    // purchase_orders.items_total is numeric(20, 2), so "1.005" is stored as 1.01;
    // the voucher used to be built from parseFloat("1.005").toFixed(2), which is "1.00".
    const po = await storage.createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber: `${TEST_PREFIX.toUpperCase()}-PO-2`,
        containerId,
        supplierId,
        currency: "USD",
        itemsTotal: "1.005",
        freight: "0",
        surcharge: "0",
        fumigation: "0",
        documentCharges: "0",
        discount: "0",
        otherCharges: "0",
        status: "Open",
      },
      "2026-09-02"
    );
    const [stored] = await db
      .select({ itemsTotal: schema.purchaseOrders.itemsTotal, voucherId: schema.purchaseOrders.voucherId })
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, po.id));
    const voucherId = stored.voucherId!;
    try {
      expect(stored.itemsTotal).toBe("1.01");
      const [voucher] = await db
        .select({ totalAmount: schema.vouchers.totalAmount })
        .from(schema.vouchers)
        .where(eq(schema.vouchers.id, voucherId));
      expect(voucher.totalAmount).toBe("1.01");
      const entries = await db
        .select({ debitAmount: schema.voucherEntries.debitAmount, creditAmount: schema.voucherEntries.creditAmount })
        .from(schema.voucherEntries)
        .where(eq(schema.voucherEntries.voucherId, voucherId));
      expect(entries).toEqual(
        expect.arrayContaining([
          { debitAmount: "1.01", creditAmount: "0.00" },
          { debitAmount: "0.00", creditAmount: "1.01" },
        ])
      );
    } finally {
      await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.id));
      if (voucherId) {
        await pool.query("DELETE FROM accounting_posting_requests WHERE voucher_id = $1", [voucherId]);
        await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, voucherId));
        await db.delete(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
      }
    }
  });
});
