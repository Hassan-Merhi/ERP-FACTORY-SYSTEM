import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "poimpsppar";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let childCompanyId = 0;
let supplierId = 0;
let childStockItemId = 0;
let childName = "";

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  childName = `${TEST_PREFIX}_SupplierPartner`;
  const child = await pool.query(
    `INSERT INTO companies (code, name, company_type, base_currency, parent_company_id, active)
     VALUES ($1, $2, 'supplier_partner', 'USD', $3, true)
     RETURNING id`,
    [`PISP${Date.now().toString().slice(-6)}`, childName, ctx.companyId]
  );
  childCompanyId = Number(child.rows[0].id);

  await pool.query(
    `INSERT INTO user_company_roles (user_id, company_id, role)
     VALUES ($1, $2, 'Admin')`,
    [ctx.userId, childCompanyId]
  );
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT user_id, $2, permission, granted_by
     FROM user_security_permissions
     WHERE user_id = $1 AND company_id = $3`,
    [ctx.userId, childCompanyId, ctx.companyId]
  );

  const group = await pool.query(
    `INSERT INTO stock_groups (company_id, name, code)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [childCompanyId, `${TEST_PREFIX}_Group`, `PISPG${Date.now().toString().slice(-5)}`]
  );
  const item = await pool.query(
    `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active)
     VALUES ($1, $2, $3, 'PCS', $4, true)
     RETURNING id`,
    [childCompanyId, `${TEST_PREFIX}-ITEM`, `${TEST_PREFIX} Item`, group.rows[0].id]
  );
  childStockItemId = Number(item.rows[0].id);

  await pool.query(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active)
     VALUES
       ($1, $2, $3, 'Asset', 'sp_goods_otw', '0', 'Dr', true),
       ($1, $4, $5, 'Liability', 'sp_otw_clearing', '0', 'Cr', true)`,
    [
      childCompanyId,
      `PISPOTW${Date.now().toString().slice(-5)}`,
      `${TEST_PREFIX} Goods OTW`,
      `PISPCLR${Date.now().toString().slice(-5)}`,
      `${TEST_PREFIX} OTW Clearing`,
    ]
  );

  const supplier = await pool.query(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP-${Date.now()}`, `${TEST_PREFIX} Parent Supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = Number(supplier.rows[0].id);

  const switched = await agent.post("/api/auth/set-company").send({ companyId: childCompanyId });
  expect(switched.status).toBe(200);
});

afterAll(async () => {
  if (childCompanyId) {
    await pool.query(
      `DELETE FROM import_logs
       WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
      [childCompanyId]
    );
    await pool.query(
      `DELETE FROM container_charges
       WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)`,
      [childCompanyId]
    );
    await pool.query(
      `DELETE FROM po_line_items
       WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`,
      [childCompanyId]
    );
    await pool.query("DELETE FROM purchase_orders WHERE company_id = $1", [childCompanyId]);
    await pool.query("DELETE FROM containers WHERE company_id = $1", [childCompanyId]);

    await pool.query("DELETE FROM accounting_posting_requests WHERE company_id IN ($1, $2)", [
      ctx.companyId,
      childCompanyId,
    ]);
    await pool.query(
      `DELETE FROM voucher_entries
       WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id IN ($1, $2))`,
      [ctx.companyId, childCompanyId]
    );
    await pool.query("DELETE FROM vouchers WHERE company_id IN ($1, $2)", [ctx.companyId, childCompanyId]);
  }
  if (supplierId) {
    await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
  }

  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
});

describe("PO import linked Supplier Partner parent accounting", () => {
  it("keeps local SP OTW accounting and credits the supplier in the explicit parent company", async () => {
    const nonce = Date.now();
    const poNumber = `${TEST_PREFIX}-PO-${nonce}`;
    const containerNumber = `${TEST_PREFIX}-CONT-${nonce}`;
    const fileHash = `${TEST_PREFIX}-HASH-${nonce}`;

    const imported = await agent.post("/api/po-import/import").send({
      fileHash,
      fileName: `${TEST_PREFIX}.xlsx`,
      containerNumber,
      supplierId,
      importDate: "2030-01-15",
      freightPaidBy: "supplier",
      preview: [
        {
          containerNumber,
          itemsTotal: 100,
          chargesTotal: 0,
          grandTotal: 100,
          itemsCount: 1,
          charges: {
            freight: 0,
            surcharge: 0,
            fumigation: 0,
            documentCharges: 0,
            discount: 0,
            otherCharges: 0,
          },
          items: [
            {
              poNumber,
              stockItemId: childStockItemId,
              barcode: `${TEST_PREFIX}-ITEM`,
              itemName: `${TEST_PREFIX} Item`,
              quantity: 10,
              rate: 10,
              lineTotal: 100,
              currency: "USD",
            },
          ],
        },
      ],
    });

    expect(imported.status).toBe(200);
    expect(imported.body.success).toBe(true);

    const localVoucher = await pool.query(
      `SELECT id
       FROM vouchers
       WHERE company_id = $1 AND voucher_type = 'Purchase' AND description LIKE $2
       ORDER BY id DESC
       LIMIT 1`,
      [childCompanyId, `${containerNumber}%`]
    );
    expect(localVoucher.rows).toHaveLength(1);

    const localEntries = await pool.query(
      `SELECT la.sub_type AS "subType", ve.debit_amount AS "debitAmount",
              ve.credit_amount AS "creditAmount", ve.supplier_id AS "supplierId"
       FROM voucher_entries ve
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE ve.voucher_id = $1`,
      [localVoucher.rows[0].id]
    );
    expect(localEntries.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subType: "sp_goods_otw", debitAmount: "100.00" }),
        // Phases 23–29 integration (G17): the supplier is the parent's, so the
        // child's clearing line no longer names it (the parent carries it below).
        expect.objectContaining({
          subType: "sp_otw_clearing",
          creditAmount: "100.00",
          supplierId: null,
        }),
      ])
    );

    const parentVoucher = await pool.query(
      `SELECT id
       FROM vouchers
       WHERE company_id = $1 AND voucher_type = 'Journal' AND description LIKE $2
       ORDER BY id DESC
       LIMIT 1`,
      [ctx.companyId, `${containerNumber}%`]
    );
    expect(parentVoucher.rows).toHaveLength(1);

    const parentEntries = await pool.query(
      `SELECT la.name AS "accountName", ve.debit_amount AS "debitAmount",
              ve.credit_amount AS "creditAmount", ve.supplier_id AS "supplierId"
       FROM voucher_entries ve
       LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE ve.voucher_id = $1`,
      [parentVoucher.rows[0].id]
    );
    expect(parentEntries.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountName: `${childName} Credit`, debitAmount: "100.00" }),
        expect.objectContaining({ supplierId, creditAmount: "100.00" }),
      ])
    );

    const parentSupplierBalance = await pool.query(
      `SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0)::text AS balance
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = $1 AND ve.supplier_id = $2`,
      [ctx.companyId, supplierId]
    );
    expect(Number(parentSupplierBalance.rows[0].balance)).toBe(100);
  });
});
