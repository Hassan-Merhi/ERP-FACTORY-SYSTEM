import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import * as schema from "../shared/schema";
import { companyScopedSuppliers } from "../shared/schema/supplierCompanyScope";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "supscope";

let ctx: TestContext;
let parentAgent: request.SuperAgentTest;
let childAgent: request.SuperAgentTest;
let childCompanyId: number;
let childCashLedgerId: number;
let parentSupplierId: number;
let childSupplierId: number;
let originalParentCompanyId: number | null;

async function setCompany(agent: request.SuperAgentTest, companyId: number) {
  const response = await agent.post("/api/auth/set-company").send({ companyId });
  if (response.status !== 200) {
    throw new Error(`set-company failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

function supplierJournalBody(supplierId: number, cashLedgerId: number, amount: number) {
  return {
    voucherDate: new Date().toISOString().slice(0, 10),
    notes: "Strict supplier company-scope regression",
    entries: [
      {
        type: "CR",
        accountType: "supplier",
        accountId: supplierId,
        amount: String(amount),
        narration: "Supplier credit",
      },
      {
        type: "DR",
        accountType: "ledger",
        accountId: cashLedgerId,
        amount: String(amount),
        narration: "Offsetting debit",
      },
    ],
  };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  originalParentCompanyId = await storage.getParentCompanyId();
  await storage.setParentCompanyId(ctx.companyId);

  parentAgent = request.agent(ctx.app);
  const parentLogin = await parentAgent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (parentLogin.status !== 200) {
    throw new Error(`Parent login failed: ${parentLogin.status} ${JSON.stringify(parentLogin.body)}`);
  }
  await setCompany(parentAgent, ctx.companyId);

  const [childCompany] = await db
    .insert(schema.companies)
    .values({
      code: `${TEST_PREFIX.toUpperCase().slice(0, 6)}CH`,
      name: `${TEST_PREFIX}_ChildCompany`,
      baseCurrency: "USD",
      parentCompanyId: ctx.companyId,
    })
    .returning();
  childCompanyId = childCompany.id;

  await db.insert(schema.userCompanyRoles).values({
    userId: ctx.userId,
    companyId: childCompanyId,
    role: "Admin",
  });

  const [childCash] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: childCompanyId,
      code: `${TEST_PREFIX}_CHCASH`,
      name: "Child Cash",
      accountType: "Cash",
      subType: "Cash",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  childCashLedgerId = childCash.id;

  childAgent = request.agent(ctx.app);
  const childLogin = await childAgent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (childLogin.status !== 200) {
    throw new Error(`Child login failed: ${childLogin.status} ${JSON.stringify(childLogin.body)}`);
  }
  await setCompany(childAgent, childCompanyId);

  const parentSupplier = await parentAgent.post("/api/suppliers").send({
    code: `${TEST_PREFIX.toUpperCase()}-SUP`,
    legalName: `${TEST_PREFIX} Parent Supplier`,
    email: `${TEST_PREFIX}.parent@example.com`,
    openingBalance: "500.00",
    active: true,
  });
  if (parentSupplier.status !== 201) {
    throw new Error(`Parent supplier creation failed: ${parentSupplier.status} ${JSON.stringify(parentSupplier.body)}`);
  }
  parentSupplierId = parentSupplier.body.id;

  // The same supplier code is valid in another company because uniqueness is
  // now (company_id, code), not global code alone.
  const childSupplier = await childAgent.post("/api/suppliers").send({
    code: `${TEST_PREFIX.toUpperCase()}-SUP`,
    legalName: `${TEST_PREFIX} Child Supplier`,
    email: `${TEST_PREFIX}.child@example.com`,
    openingBalance: "0",
    active: true,
  });
  if (childSupplier.status !== 201) {
    throw new Error(`Child supplier creation failed: ${childSupplier.status} ${JSON.stringify(childSupplier.body)}`);
  }
  childSupplierId = childSupplier.body.id;
}, 60000);

afterAll(async () => {
  if (parentSupplierId || childSupplierId) {
    // Every line of a voucher carrying either supplier goes in one statement:
    // deleting only the supplier legs would leave the vouchers one-sided, which
    // the voucher balance guard refuses at commit.
    await db.delete(schema.voucherEntries).where(
      inArray(
        schema.voucherEntries.voucherId,
        db
          .select({ voucherId: schema.voucherEntries.voucherId })
          .from(schema.voucherEntries)
          .where(inArray(schema.voucherEntries.supplierId, [parentSupplierId, childSupplierId].filter(Boolean)))
      )
    );
    await db
      .delete(companyScopedSuppliers)
      .where(inArray(companyScopedSuppliers.id, [parentSupplierId, childSupplierId].filter(Boolean)));
  }
  await storage.setParentCompanyId(originalParentCompanyId);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("strict supplier company ownership", () => {
  it("returns only suppliers owned by the active company", async () => {
    const [parentResponse, childResponse] = await Promise.all([
      parentAgent.get("/api/suppliers"),
      childAgent.get("/api/suppliers"),
    ]);

    expect(parentResponse.status).toBe(200);
    expect(childResponse.status).toBe(200);
    expect(parentResponse.body.some((supplier: any) => supplier.id === parentSupplierId)).toBe(true);
    expect(parentResponse.body.some((supplier: any) => supplier.id === childSupplierId)).toBe(false);
    expect(childResponse.body.some((supplier: any) => supplier.id === childSupplierId)).toBe(true);
    expect(childResponse.body.some((supplier: any) => supplier.id === parentSupplierId)).toBe(false);
  });

  it("does not expose a foreign supplier by ID, balance, or stats", async () => {
    const [detail, balance, stats] = await Promise.all([
      childAgent.get(`/api/suppliers/${parentSupplierId}`),
      childAgent.get(`/api/suppliers/${parentSupplierId}/balance`),
      childAgent.get("/api/suppliers/stats"),
    ]);

    expect(detail.status).toBe(404);
    expect(balance.status).toBe(404);
    expect(stats.status).toBe(200);
    expect(stats.body.some((supplier: any) => supplier.id === parentSupplierId)).toBe(false);
  });

  it("rejects an active-company override in the supplier list", async () => {
    const response = await childAgent.get(`/api/suppliers?companyId=${ctx.companyId}`);
    expect(response.status).toBe(403);
  });

  it("rejects posting against a supplier owned by another company", async () => {
    const response = await childAgent
      .post("/api/vouchers/journal")
      .send(supplierJournalBody(parentSupplierId, childCashLedgerId, 200));

    expect([400, 403, 404]).toContain(response.status);
  });

  it("allows posting against the supplier owned by the active company", async () => {
    const response = await childAgent
      .post("/api/vouchers/journal")
      .send(supplierJournalBody(childSupplierId, childCashLedgerId, 200));
    expect(response.status).toBe(200);

    const balance = await childAgent.get(`/api/suppliers/${childSupplierId}/balance`);
    expect(balance.status).toBe(200);
    expect(Number(balance.body.balance)).toBeCloseTo(200, 2);
  });

  it("keeps the parent supplier opening balance isolated", async () => {
    const parentBalance = await parentAgent.get(`/api/suppliers/${parentSupplierId}/balance`);
    expect(parentBalance.status).toBe(200);
    expect(Number(parentBalance.body.openingBalance)).toBeCloseTo(500, 2);
    expect(Number(parentBalance.body.balance)).toBeCloseTo(500, 2);
  });

  it("rejects linking a supplier to a stock group from another company", async () => {
    const response = await childAgent
      .patch(`/api/suppliers/${childSupplierId}/stock-group`)
      .send({ stockGroupId: ctx.stockGroupId });
    expect(response.status).toBe(404);

    const [row] = await db
      .select({ stockGroupId: companyScopedSuppliers.stockGroupId })
      .from(companyScopedSuppliers)
      .where(and(eq(companyScopedSuppliers.id, childSupplierId), eq(companyScopedSuppliers.companyId, childCompanyId)));
    expect(row.stockGroupId).toBeNull();
  });
});
