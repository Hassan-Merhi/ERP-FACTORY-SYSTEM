/**
 * Purchase orders and the accounting they raise.
 *
 * A PO posts differently depending on who owes whom. A standalone company owes
 * its supplier directly. A subsidiary with an explicit parent does not: the
 * parent settles the supplier, so the subsidiary owes the parent and the parent
 * carries a receivable against the subsidiary — with the supplier credit on the
 * parent's side, and freight carved out of the intercompany balance when the
 * parent pays it directly. A supplier-partner company owns its supplier
 * relationships whatever its parent link says, so it must never take the
 * intercompany path; that is the distinction this file is most concerned with,
 * because getting it wrong hides a payable in the wrong tenant's ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import {
  getAllContainers,
  getActiveContainers,
  getContainerById,
  getContainerByIdForCompany,
  getContainerByNumber,
  getSoldContainers,
  getAllPurchaseOrders,
  getPurchaseOrderById,
  getPurchaseOrderByIdForCompany,
  getPurchaseOrdersByContainer,
  getPurchaseOrdersByContainerForCompany,
  getPurchaseOrdersBySupplier,
  updateContainer,
} from "../server/storage/containers-store/containers";
import {
  createPurchaseOrder,
  deletePurchaseOrder,
  updatePurchaseOrder,
} from "../server/storage/containers-store/purchase-orders";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "pointer";
let ctx: TestContext;
let parentCtx: TestContext;
let supplierId: number;
let containerId: number;
let sequence = 0;

type EntryRow = {
  ledger_account_id: number | null;
  supplier_id: number | null;
  debit_amount: string;
  credit_amount: string;
  code: string | null;
};

function nextPoNumber(): string {
  sequence += 1;
  return `${TEST_PREFIX}-PO-${sequence}`;
}

async function insertSupplier(companyId: number, code: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [companyId, code, `${TEST_PREFIX} Supplier ${code}`, `${code.toLowerCase()}@example.test`]
  );
  return result.rows[0].id;
}

async function insertContainer(companyId: number, supplier: number, number_: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', '2026-09-01') RETURNING id`,
    [companyId, number_, supplier]
  );
  return result.rows[0].id;
}

async function entriesForCompany(companyId: number, poNumber: string): Promise<EntryRow[]> {
  const result = await pool.query<EntryRow>(
    `SELECT ve.ledger_account_id, ve.supplier_id, ve.debit_amount, ve.credit_amount, la.code
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number LIKE $2
      ORDER BY ve.id`,
    [companyId, `%${poNumber}%`]
  );
  return result.rows;
}

function netOf(entries: EntryRow[]): number {
  return entries.reduce((sum, row) => sum + Number(row.debit_amount || 0) - Number(row.credit_amount || 0), 0);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  parentCtx = await seedTestData(`${TEST_PREFIX}par`);
  supplierId = await insertSupplier(ctx.companyId, `${TEST_PREFIX}S`);
  containerId = await insertContainer(ctx.companyId, supplierId, `${TEST_PREFIX}-CONT`);
}, 180_000);

afterAll(async () => {
  await cleanupTestData(`${TEST_PREFIX}par`);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

async function asStandalone(): Promise<void> {
  await pool.query(`UPDATE companies SET parent_company_id = NULL, company_type = 'erp' WHERE id = $1`, [
    ctx.companyId,
  ]);
}

async function asSubsidiaryOf(parentId: number, companyType = "erp"): Promise<void> {
  await pool.query(`UPDATE companies SET parent_company_id = $1, company_type = $2 WHERE id = $3`, [
    parentId,
    companyType,
    ctx.companyId,
  ]);
}

describe("standalone purchase order accounting", () => {
  it("debits purchases and credits the supplier in the company's own books", async () => {
    await asStandalone();
    const poNumber = nextPoNumber();

    const created = await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "100.00",
        freight: "20.00",
      },
      "2026-09-15"
    );

    expect(created.poNumber).toBe(poNumber);

    const entries = await entriesForCompany(ctx.companyId, poNumber);
    expect(entries.length).toBeGreaterThan(0);
    // Whatever accounts it chose, the voucher balances.
    expect(netOf(entries)).toBeCloseTo(0, 2);

    // The purchases account is created on demand if the company has none.
    const purchases = await pool.query(
      `SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'PURCHASES' AND deleted_at IS NULL`,
      [ctx.companyId]
    );
    expect(purchases.rowCount).toBe(1);

    const debit = entries.find((row) => row.code === "PURCHASES");
    expect(Number(debit?.debit_amount)).toBeCloseTo(120, 2);

    const supplierCredit = entries.find((row) => row.supplier_id === supplierId);
    expect(Number(supplierCredit?.credit_amount)).toBeCloseTo(120, 2);
  }, 180_000);

  it("nets the discount out of the charges it capitalises", async () => {
    await asStandalone();
    const poNumber = nextPoNumber();

    await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "200.00",
        freight: "30.00",
        surcharge: "10.00",
        fumigation: "5.00",
        documentCharges: "5.00",
        otherCharges: "10.00",
        discount: "60.00",
      },
      "2026-09-15"
    );

    // 200 + 30 + 10 + 5 + 5 + 10 - 60 = 200.
    const entries = await entriesForCompany(ctx.companyId, poNumber);
    const debit = entries.find((row) => row.code === "PURCHASES");
    expect(Number(debit?.debit_amount)).toBeCloseTo(200, 2);
    expect(netOf(entries)).toBeCloseTo(0, 2);
  }, 180_000);

  it("posts nothing for a purchase order that is already attached to a voucher", async () => {
    await asStandalone();
    const poNumber = nextPoNumber();

    const voucher = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date,
                             description, total_amount, currency)
       VALUES ($1, $2, $3, 'Purchase', '2026-09-15', 'existing', '100.00', 'USD') RETURNING id`,
      [ctx.companyId, ctx.locationId, `${TEST_PREFIX}-EXISTING-${sequence}`]
    );

    await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "100.00",
        voucherId: voucher.rows[0].id,
      },
      "2026-09-15"
    );

    expect(await entriesForCompany(ctx.companyId, poNumber)).toEqual([]);
  }, 180_000);

  it("posts nothing for a purchase order worth nothing", async () => {
    await asStandalone();
    const poNumber = nextPoNumber();

    await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "0",
      },
      "2026-09-15"
    );

    expect(await entriesForCompany(ctx.companyId, poNumber)).toEqual([]);
  }, 180_000);
});

describe("intercompany purchase order accounting", () => {
  it("makes the subsidiary owe the parent and the parent owe the supplier", async () => {
    await asSubsidiaryOf(parentCtx.companyId);
    const poNumber = nextPoNumber();

    await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "300.00",
      },
      "2026-09-15"
    );

    const subsidiaryEntries = await entriesForCompany(ctx.companyId, poNumber);
    expect(subsidiaryEntries.length).toBeGreaterThan(0);
    expect(netOf(subsidiaryEntries)).toBeCloseTo(0, 2);
    // The subsidiary's credit is to the parent, not to the supplier.
    expect(subsidiaryEntries.some((row) => row.supplier_id === supplierId)).toBe(false);
    const parentCredit = subsidiaryEntries.find((row) => row.code?.endsWith("_CREDIT"));
    expect(Number(parentCredit?.credit_amount)).toBeCloseTo(300, 2);

    const parentEntries = await entriesForCompany(parentCtx.companyId, poNumber);
    expect(parentEntries.length).toBeGreaterThan(0);
    expect(netOf(parentEntries)).toBeCloseTo(0, 2);
    // The parent carries the receivable and the supplier payable.
    const receivable = parentEntries.find((row) => Number(row.debit_amount) > 0);
    expect(Number(receivable?.debit_amount)).toBeCloseTo(300, 2);
    const supplierCredit = parentEntries.find((row) => row.supplier_id === supplierId);
    expect(Number(supplierCredit?.credit_amount)).toBeCloseTo(300, 2);
  }, 180_000);

  it("leaves freight the parent pays out of what the subsidiary owes", async () => {
    await asSubsidiaryOf(parentCtx.companyId);
    const poNumber = nextPoNumber();
    const freightAccount = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
       VALUES ($1, $2, $3, 'Expense', '0', 'Dr', true) RETURNING id`,
      [parentCtx.companyId, `${TEST_PREFIX}-FREIGHT-${sequence}`, `${TEST_PREFIX} Freight`]
    );

    await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "400.00",
        freight: "50.00",
        freightPaidBy: "parent",
        freightParentAccountId: freightAccount.rows[0].id,
      },
      "2026-09-15"
    );

    const parentEntries = await entriesForCompany(parentCtx.companyId, poNumber);
    expect(netOf(parentEntries)).toBeCloseTo(0, 2);

    // The supplier is credited for the goods only; the freight sits on the
    // parent's own freight account instead.
    const supplierCredit = parentEntries.find((row) => row.supplier_id === supplierId);
    expect(Number(supplierCredit?.credit_amount)).toBeCloseTo(400, 2);
    const freightCredit = parentEntries.find((row) => row.ledger_account_id === freightAccount.rows[0].id);
    expect(Number(freightCredit?.credit_amount)).toBeCloseTo(50, 2);

    // The subsidiary still owes the parent the whole 450.
    const subsidiaryEntries = await entriesForCompany(ctx.companyId, poNumber);
    const parentCredit = subsidiaryEntries.find((row) => row.code?.endsWith("_CREDIT"));
    expect(Number(parentCredit?.credit_amount)).toBeCloseTo(450, 2);
  }, 180_000);

  it("keeps a supplier-partner company's payable in its own books despite a parent link", async () => {
    await asSubsidiaryOf(parentCtx.companyId, "supplier_partner");
    const poNumber = nextPoNumber();

    await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "250.00",
      },
      "2026-09-15"
    );

    // The supplier credit stays here, and the parent posts nothing at all.
    const entries = await entriesForCompany(ctx.companyId, poNumber);
    expect(netOf(entries)).toBeCloseTo(0, 2);
    const supplierCredit = entries.find((row) => row.supplier_id === supplierId);
    expect(Number(supplierCredit?.credit_amount)).toBeCloseTo(250, 2);

    expect(await entriesForCompany(parentCtx.companyId, poNumber)).toEqual([]);

    await asStandalone();
  }, 180_000);
});

describe("purchase order and container reads", () => {
  it("updates and deletes a purchase order", async () => {
    await asStandalone();
    const poNumber = nextPoNumber();
    const created = await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "0",
      },
      "2026-09-15"
    );

    const updated = await updatePurchaseOrder(created.id, { status: "Closed" });
    expect(updated.status).toBe("Closed");

    await deletePurchaseOrder(created.id);
    expect(await getPurchaseOrderById(created.id)).toBeUndefined();
  }, 180_000);

  it("scopes every container and purchase order read to the company", async () => {
    await asStandalone();

    const all = await getAllContainers(ctx.companyId);
    expect(all.some((entry) => entry.id === containerId)).toBe(true);
    expect(await getAllContainers(parentCtx.companyId)).toEqual([]);

    expect((await getContainerById(containerId))?.id).toBe(containerId);
    expect((await getContainerByIdForCompany(containerId, ctx.companyId))?.id).toBe(containerId);
    expect(await getContainerByIdForCompany(containerId, parentCtx.companyId)).toBeUndefined();
    expect((await getContainerByNumber(`${TEST_PREFIX}-CONT`))?.id).toBe(containerId);
    expect(await getContainerByNumber(`${TEST_PREFIX}-NO-SUCH-CONT`)).toBeUndefined();

    // "Active" means not yet sold on: an offloaded container is still active,
    // a sold one drops out and shows up in the sold list instead.
    expect((await getActiveContainers(ctx.companyId)).some((entry) => entry.id === containerId)).toBe(true);
    await updateContainer(containerId, { status: "OFFLOADED" });
    expect((await getActiveContainers(ctx.companyId)).some((entry) => entry.id === containerId)).toBe(true);

    await updateContainer(containerId, { status: "SOLD" });
    expect((await getActiveContainers(ctx.companyId)).some((entry) => entry.id === containerId)).toBe(false);

    // The sold list joins the sale and its customer, so a container marked sold
    // with no sale recorded against it is not reported as sold.
    expect((await getSoldContainers(ctx.companyId)).some((entry) => entry.containerId === containerId)).toBe(false);

    const customer = await pool.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name, active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}CUST`, `${TEST_PREFIX} Customer`]
    );
    await pool.query(
      `INSERT INTO container_sales (company_id, container_id, customer_id, sale_date, container_cost,
                                    commission, total_amount, currency, payment_status, paid_amount)
       VALUES ($1, $2, $3, '2026-09-15', '100.00', '10.00', '110.00', 'USD', 'unpaid', '0')`,
      [ctx.companyId, containerId, customer.rows[0].id]
    );

    const sold = await getSoldContainers(ctx.companyId);
    const soldRow = sold.find((entry) => entry.containerId === containerId);
    expect(soldRow?.customerName).toBe(`${TEST_PREFIX} Customer`);
    expect(Number(soldRow?.totalAmount)).toBeCloseTo(110, 2);
    expect(await getSoldContainers(parentCtx.companyId)).toEqual([]);

    await pool.query(`DELETE FROM container_sales WHERE container_id = $1`, [containerId]);
    await updateContainer(containerId, { status: "OTW" });

    const poNumber = nextPoNumber();
    const po = await createPurchaseOrder(
      {
        companyId: ctx.companyId,
        poNumber,
        containerId,
        supplierId,
        currency: "USD",
        status: "Open",
        itemsTotal: "0",
      },
      "2026-09-15"
    );

    expect((await getAllPurchaseOrders(ctx.companyId)).some((entry) => entry.id === po.id)).toBe(true);
    expect((await getPurchaseOrderByIdForCompany(po.id, ctx.companyId))?.id).toBe(po.id);
    expect(await getPurchaseOrderByIdForCompany(po.id, parentCtx.companyId)).toBeUndefined();
    expect((await getPurchaseOrdersByContainer(containerId)).some((entry) => entry.id === po.id)).toBe(true);
    expect(await getPurchaseOrdersByContainerForCompany(containerId, parentCtx.companyId)).toEqual([]);
    expect((await getPurchaseOrdersBySupplier(supplierId, ctx.companyId)).length).toBeGreaterThan(0);

    await deletePurchaseOrder(po.id);
  }, 180_000);
});
