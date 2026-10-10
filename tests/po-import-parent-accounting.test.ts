import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "poimportacct";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let parentCompanyId: number;
let supplierId: number;
let childSupplierId: number;
let parentFreightAccountId: number;

type ImportOptions = {
  suffix: string;
  poNumber: string;
  itemTotal: number;
  freight: number;
  freightPaidBy: "supplier" | "parent";
  supplierId?: number;
};

function importPayload(options: ImportOptions) {
  const containerNumber = `${TEST_PREFIX}-CONT-${options.suffix}`;
  return {
    fileHash: `${TEST_PREFIX}-HASH-${options.suffix}`,
    fileName: `${TEST_PREFIX}-${options.suffix}.xlsx`,
    containerNumber,
    supplierId: options.supplierId ?? supplierId,
    importDate: "2026-09-01",
    freightPaidBy: options.freightPaidBy,
    freightParentAccountId: options.freightPaidBy === "parent" ? parentFreightAccountId : null,
    preview: [
      {
        containerNumber,
        items: [
          {
            barcode: `${TEST_PREFIX}-ITEM1`,
            itemName: "Test Item 1",
            poNumber: options.poNumber,
            quantity: 1,
            rate: options.itemTotal,
            lineTotal: options.itemTotal,
            currency: "USD",
          },
        ],
        charges: {
          freight: options.freight,
          surcharge: 0,
          fumigation: 0,
          documentCharges: 0,
          discount: 0,
          otherCharges: 0,
        },
        itemsTotal: options.itemTotal,
        chargesTotal: options.freight,
        grandTotal: options.itemTotal + options.freight,
        itemsCount: 1,
      },
    ],
  };
}

async function postingFor(poNumber: string, companyId = parentCompanyId) {
  const marker = await pool.query<{ voucher_id: number }>(
    `SELECT voucher_id
       FROM accounting_posting_requests
      WHERE company_id = $1
        AND source_type = 'po-import'
        AND source_id = $2`,
    [companyId, `${ctx.companyId}:${poNumber}:parent-intercompany`]
  );
  const voucherId = marker.rows[0]?.voucher_id;
  if (!voucherId) return null;

  const entries = await pool.query<{
    ledger_account_id: number | null;
    supplier_id: number | null;
    debit_amount: string;
    credit_amount: string;
  }>(
    `SELECT ledger_account_id, supplier_id, debit_amount, credit_amount
       FROM voucher_entries
      WHERE voucher_id = $1
      ORDER BY id`,
    [voucherId]
  );
  return { voucherId, entries: entries.rows };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const [parent] = await db
    .insert(schema.companies)
    .values({
      code: `${TEST_PREFIX.toUpperCase()}P`,
      name: `${TEST_PREFIX}_Parent`,
      companyType: "erp",
      active: true,
      baseCurrency: "USD",
    })
    .returning();
  parentCompanyId = parent.id;

  await db.insert(schema.userCompanyRoles).values({
    userId: ctx.userId,
    companyId: parentCompanyId,
    role: "Admin",
  });

  const [freightAccount] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: parentCompanyId,
      code: `${TEST_PREFIX.toUpperCase()}FR`,
      name: `${TEST_PREFIX} Parent Freight`,
      accountType: "Liability",
      subType: "Current Liability",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();
  parentFreightAccountId = freightAccount.id;

  await db.insert(schema.ledgerAccounts).values([
    {
      companyId: ctx.companyId,
      code: `${TEST_PREFIX.toUpperCase()}OTW`,
      name: `${TEST_PREFIX} Goods OTW`,
      accountType: "Asset",
      subType: "sp_goods_otw",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    },
    {
      companyId: ctx.companyId,
      code: `${TEST_PREFIX.toUpperCase()}CLR`,
      name: `${TEST_PREFIX} OTW Clearing`,
      accountType: "Liability",
      subType: "sp_otw_clearing",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    },
  ]);

  const [supplier] = await db
    .insert(schema.suppliers)
    .values({
      code: `${TEST_PREFIX.toUpperCase()}SUP`,
      legalName: `${TEST_PREFIX} Supplier`,
      email: `${TEST_PREFIX}@example.test`,
    })
    .returning();
  supplierId = supplier.id;
  await pool.query("UPDATE suppliers SET company_id = $1 WHERE id = $2", [parentCompanyId, supplierId]);

  const childSupplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (code, legal_name, email, company_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      `${TEST_PREFIX.toUpperCase()}CHILD`,
      `${TEST_PREFIX} Child Supplier`,
      `${TEST_PREFIX}-child@example.test`,
      ctx.companyId,
    ]
  );
  childSupplierId = childSupplier.rows[0].id;

  await db
    .update(schema.companies)
    .set({ companyType: "supplier_partner", parentCompanyId })
    .where(eq(schema.companies.id, ctx.companyId));
}, 60000);

afterAll(async () => {
  closeTestServer();

  // The supplier row is company-scoped (the supplier company-scope migration
  // backfills suppliers.company_id), so it blocks cleanupTestData's delete of
  // the fixture company and therefore has to go first. Everything that points
  // at the supplier has to go before it, in foreign-key order: purchase orders
  // (po_line_items cascades), then the containers the import created, then the
  // supplier-credit voucher entries raised in the parent company. Those entries
  // would be removed by cleanupTestData's voucher delete anyway, but that
  // happens per company and cannot be interleaved from here. Every line of a
  // voucher carrying the supplier goes in the same statement: deleting only the
  // supplier leg would leave the voucher one-sided, which the voucher balance
  // guard refuses at commit.
  for (const id of [supplierId, childSupplierId]) {
    if (!id) continue;
    await pool.query("DELETE FROM purchase_orders WHERE supplier_id = $1", [id]);
    await pool.query(
      "DELETE FROM import_logs WHERE container_id IN (SELECT id FROM containers WHERE supplier_id = $1)",
      [id]
    );
    await pool.query("DELETE FROM containers WHERE supplier_id = $1", [id]);
    await pool.query(
      "DELETE FROM voucher_entries WHERE voucher_id IN (SELECT voucher_id FROM voucher_entries WHERE supplier_id = $1)",
      [id]
    );
    await pool.query("DELETE FROM suppliers WHERE id = $1", [id]);
  }

  await cleanupTestData(TEST_PREFIX);
}, 30000);

describe("PO import parent accounting", () => {
  it("lists current and parent suppliers once and validates an inherited supplier", async () => {
    const listed = await agent.get("/api/suppliers?allowParentFallback=true");
    expect(listed.status).toBe(200);

    const listedIds = listed.body.map((supplier: { id: number }) => supplier.id);
    expect(new Set(listedIds).size).toBe(listedIds.length);
    expect(listedIds).toEqual(expect.arrayContaining([supplierId, childSupplierId]));

    const validation = await agent.post("/api/po-import/validate").send({
      containerNumber: `${TEST_PREFIX}-INHERITED-VALIDATE`,
      supplierId,
      preview: [
        {
          containerNumber: `${TEST_PREFIX}-INHERITED-VALIDATE`,
          items: [
            {
              barcode: `${TEST_PREFIX}-ITEM1`,
              itemName: "Test Item 1",
              poNumber: "PO-INHERITED-VALIDATE",
              quantity: 1,
              rate: 20,
              lineTotal: 20,
              currency: "USD",
            },
          ],
          charges: {},
          itemsTotal: 20,
          chargesTotal: 0,
          grandTotal: 20,
          itemsCount: 1,
        },
      ],
    });

    expect(validation.status).toBe(200);
    expect(validation.body).toMatchObject({ valid: true, errors: [] });
  });

  it("keeps SP OTW/Clearing and creates a parent supplier credit for supplier-paid freight", async () => {
    const result = await agent.post("/api/po-import/import").send(
      importPayload({
        suffix: "SP-SUPPLIER",
        poNumber: "PO-SP-SUPPLIER",
        itemTotal: 30,
        freight: 5,
        freightPaidBy: "supplier",
      })
    );

    expect(result.status).toBe(200);

    const ownership = await pool.query<{
      container_company_id: number;
      po_company_id: number;
      voucher_company_id: number;
    }>(
      `SELECT c.company_id AS container_company_id,
              po.company_id AS po_company_id,
              v.company_id AS voucher_company_id
         FROM containers c
         JOIN purchase_orders po ON po.container_id = c.id
         JOIN vouchers v ON v.id = po.voucher_id
        WHERE c.id = $1`,
      [result.body.containerId]
    );
    expect(ownership.rows[0]).toEqual({
      container_company_id: ctx.companyId,
      po_company_id: ctx.companyId,
      voucher_company_id: ctx.companyId,
    });

    const parentPosting = await postingFor("PO-SP-SUPPLIER");
    expect(parentPosting).not.toBeNull();
    expect(parentPosting!.entries).toHaveLength(2);
    expect(parentPosting!.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ supplier_id: supplierId, debit_amount: "0.00", credit_amount: "35.00" }),
      ])
    );

    const localMarker = await pool.query<{ voucher_id: number }>(
      `SELECT voucher_id
         FROM accounting_posting_requests
        WHERE company_id = $1
          AND source_type = 'po-import'
          AND source_id = $2`,
      [ctx.companyId, `${ctx.companyId}:PO-SP-SUPPLIER:purchase`]
    );
    const localEntries = await pool.query<{ sub_type: string | null }>(
      `SELECT la.sub_type
         FROM voucher_entries ve
         JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1`,
      [localMarker.rows[0].voucher_id]
    );
    expect(localEntries.rows.map((row) => row.sub_type)).toEqual(
      expect.arrayContaining(["sp_goods_otw", "sp_otw_clearing"])
    );
  });

  it("splits parent-paid freight and does not duplicate the parent journal on a duplicate request", async () => {
    const payload = importPayload({
      suffix: "SP-PARENT",
      poNumber: "PO-SP-PARENT",
      itemTotal: 100,
      freight: 10,
      freightPaidBy: "parent",
    });

    const first = await agent.post("/api/po-import/import").send(payload);
    expect(first.status).toBe(200);

    const parentPosting = await postingFor("PO-SP-PARENT");
    expect(parentPosting).not.toBeNull();
    expect(parentPosting!.entries).toHaveLength(3);
    expect(parentPosting!.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ supplier_id: supplierId, debit_amount: "0.00", credit_amount: "100.00" }),
        expect.objectContaining({
          ledger_account_id: parentFreightAccountId,
          debit_amount: "0.00",
          credit_amount: "10.00",
        }),
        expect.objectContaining({ debit_amount: "110.00", credit_amount: "0.00" }),
      ])
    );

    const duplicate = await agent.post("/api/po-import/import").send({
      ...payload,
      fileHash: `${payload.fileHash}-duplicate`,
    });
    expect(duplicate.status).toBe(400);

    const replayedParentPosting = await postingFor("PO-SP-PARENT");
    expect(replayedParentPosting!.voucherId).toBe(parentPosting!.voucherId);
    expect(replayedParentPosting!.entries).toHaveLength(3);
  });

  it("does not create a parent journal for an unlinked Supplier Partner", async () => {
    await db.update(schema.companies).set({ parentCompanyId: null }).where(eq(schema.companies.id, ctx.companyId));

    const result = await agent.post("/api/po-import/import").send(
      importPayload({
        suffix: "SP-UNLINKED",
        poNumber: "PO-SP-UNLINKED",
        itemTotal: 40,
        freight: 0,
        freightPaidBy: "supplier",
        supplierId: childSupplierId,
      })
    );

    expect(result.status).toBe(200);
    expect(await postingFor("PO-SP-UNLINKED")).toBeNull();

    await db.update(schema.companies).set({ parentCompanyId }).where(eq(schema.companies.id, ctx.companyId));
  });

  it("keeps the normal linked ERP subsidiary path working", async () => {
    await db.update(schema.companies).set({ companyType: "erp" }).where(eq(schema.companies.id, ctx.companyId));

    const result = await agent.post("/api/po-import/import").send(
      importPayload({
        suffix: "ERP-LINKED",
        poNumber: "PO-ERP-LINKED",
        itemTotal: 50,
        freight: 0,
        freightPaidBy: "supplier",
      })
    );

    expect(result.status).toBe(200);
    const parentPosting = await postingFor("PO-ERP-LINKED");
    expect(parentPosting).not.toBeNull();
    expect(parentPosting!.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ supplier_id: supplierId, debit_amount: "0.00", credit_amount: "50.00" }),
      ])
    );
  });
});
