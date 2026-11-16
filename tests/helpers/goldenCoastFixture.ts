/**
 * Shared fixture for the Golden Coast Phase 5 POS sale suites.
 *
 * Seeds a Supplier Partner company carrying the canonical Golden Coast roles
 * Phase 5 posts against, plus a second Supplier Partner company that is
 * deliberately NOT Golden Coast so the suites can prove the legacy sale path is
 * untouched. Each suite passes its own prefix so the two companies, and their
 * privileged-mutation rate-limit budgets, stay independent.
 */

import { eq } from "drizzle-orm";
import request from "supertest";
import { pool, db } from "../../server/db";
import * as schema from "../../shared/schema";
import { seedTestData, cleanupTestData, type TestContext } from "../setup";

/**
 * `companies.code` and `locations.code` are both globally unique, so a fixture
 * code derived from a truncated prefix would collide between two suites that
 * share the first characters. This mirrors setup.ts's stableTestCompanyCode:
 * the hash covers the whole prefix, so distinct prefixes get distinct codes
 * even when a previous suite's teardown did not run.
 */
function stableFixtureCode(prefix: string, suffix: string): string {
  let hash = 2166136261;
  for (const char of prefix) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const base = prefix
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, "X");
  const digest = (hash >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(-4);
  return `${base}${digest}${suffix}`;
}

export const GOLDEN_COAST_PHASE5_SALE_URL = "/api/sp/golden-coast/phase6/pos-sale";
/** Shared sale date used by the Golden Coast POS integration fixtures. */
export const GOLDEN_COAST_PHASE5_SALE_DATE = "2026-09-05";

/**
 * The sale URL a POS client must actually call. Posting a Golden Coast sale now
 * also posts HADI's side of the automatic collection, so the request has to name
 * the parent as a secondary company and let the tenant boundary verify access
 * before anything is written — the route refuses with 403 otherwise.
 */
export function goldenCoastPhase5SaleUrl(fixture: GoldenCoastPhase5Fixture): string {
  return `${GOLDEN_COAST_PHASE5_SALE_URL}?targetCompanyId=${fixture.hadiCompanyId}`;
}

export interface GoldenCoastPhase5Fixture {
  prefix: string;
  ctx: TestContext;
  agent: request.SuperAgentTest;
  goldenCoastStockItemId: number;
  secondStockItemId: number;
  saleSideAccountId: number;
  salesAccountId: number;
  cogsAccountId: number;
  stockInHandAccountId: number;
  plainCompanyId: number;
  plainLocationId: number;
  plainStockItemId: number;
  plainPayableAccountId: number;
  plainCashAccountId: number;
  hadiCompanyId: number;
  hadiCashAccountId: number;
  goldenCoastHadiIntercompanyAccountId: number;
  hadiGoldenCoastIntercompanyAccountId: number;
}

export interface GoldenCoastNormalPosFixture extends GoldenCoastPhase5Fixture {
  hadiCompanyId: number;
  hadiLocationId: number;
  hadiCashAccountId: number;
  hadiIntercompanyAccountId: number;
  goldenCoastIntercompanyAccountId: number;
  deductionClearingAccountId: number;
}

async function insertLedgerAccount(input: {
  companyId: number;
  code: string;
  name: string;
  accountType: string;
  subType: string;
}): Promise<number> {
  const [account] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: input.companyId,
      code: input.code,
      name: input.name,
      accountType: input.accountType,
      subType: input.subType,
      isHidden: false,
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  return account.id;
}

export async function setupGoldenCoastPhase5Fixture(prefix: string): Promise<GoldenCoastPhase5Fixture> {
  const ctx = await seedTestData(prefix);

  await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);

  // The two partner-capital roles are what identifies a Golden Coast company.
  // Phase 5 never posts to them and never changes their balances.
  await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "GC-FSCAP",
    name: "Fresh Start FZ Equity",
    accountType: "Equity",
    subType: "gc_partner_capital",
  });
  await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "GC-HCAP",
    name: "Hassan Dakik Equity",
    accountType: "Equity",
    subType: "gc_owner_capital",
  });
  const saleSideAccountId = await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "SP-PAY",
    name: "GC Sales Cash",
    accountType: "Liability",
    subType: "sp_payable",
  });
  const stockInHandAccountId = await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "SP-STOCK",
    name: "Stock in Hand",
    accountType: "Asset",
    subType: "sp_stock",
  });
  await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "GC-HSAV",
    name: "Hassan Savings",
    accountType: "Loans",
    subType: "gc_hassan_savings",
  });
  const salesAccountId = await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "SP-SALES",
    name: "Sales",
    accountType: "Income",
    subType: "sp_sales",
  });
  const cogsAccountId = await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "SP-COGS",
    name: "Cost of Goods Sold",
    accountType: "Direct Expense",
    subType: "sp_cogs",
  });

  const plainCompanyCode = stableFixtureCode(prefix, "PLN");
  const [plainCompany] = await db
    .insert(schema.companies)
    .values({
      code: plainCompanyCode,
      name: `${prefix}_PlainSupplierPartner`,
      companyType: "supplier_partner",
      baseCurrency: "USD",
    })
    .returning();

  await db.insert(schema.userCompanyRoles).values({
    userId: ctx.userId,
    companyId: plainCompany.id,
    role: "Admin",
  });

  const [plainLocation] = await db
    .insert(schema.locations)
    .values({ companyId: plainCompany.id, code: `${plainCompanyCode}-WH1`, name: `${prefix}_PlainWarehouse` })
    .returning();

  const [plainStockGroup] = await db
    .insert(schema.stockGroups)
    .values({ companyId: plainCompany.id, name: `${prefix}_PlainGroup`, code: "PLNG" })
    .returning();
  const [plainStockItem] = await db
    .insert(schema.stockItems)
    .values({
      companyId: plainCompany.id,
      code: `${prefix}-PLAIN-ITEM`,
      name: "Plain Item",
      uom: "PCS",
      stockGroupId: plainStockGroup.id,
      active: true,
    })
    .returning();

  await db.insert(schema.inventory).values({
    companyId: plainCompany.id,
    locationId: plainLocation.id,
    stockItemId: plainStockItem.id,
    quantity: "100.000",
    averageRate: "10.00",
    totalValue: "1000.00",
  });

  const plainPayableAccountId = await insertLedgerAccount({
    companyId: plainCompany.id,
    code: "SP-PAY",
    name: "Supplier Cash Payable",
    accountType: "Liability",
    subType: "sp_payable",
  });
  const plainCashAccountId = await insertLedgerAccount({
    companyId: plainCompany.id,
    code: "PLN-CASH",
    name: "Plain Cash",
    accountType: "Cash",
    subType: "Cash",
  });

  // Phase 6 routes every Golden Coast sale's cash to HADI inside the same
  // transaction, so a Golden Coast company without a parent can no longer post
  // a sale at all. Seed the parent and the reciprocal intercompany pair the
  // collection needs, plus exactly one active HADI Cash ledger.
  const hadiCompanyCode = stableFixtureCode(prefix, "HDI");
  const [hadiCompany] = await db
    .insert(schema.companies)
    .values({
      code: hadiCompanyCode,
      name: `${prefix}_Hadi`,
      companyType: "trading",
      baseCurrency: "USD",
    })
    .returning();

  await db.insert(schema.userCompanyRoles).values({
    userId: ctx.userId,
    companyId: hadiCompany.id,
    role: "Admin",
  });

  await pool.query(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [hadiCompany.id, ctx.companyId]);

  const goldenCoastHadiIntercompanyAccountId = await insertLedgerAccount({
    companyId: ctx.companyId,
    code: "GC-IC-HADI",
    name: "HADI Intercompany",
    accountType: "Intercompany",
    subType: "sp_hadi_intercompany",
  });
  const hadiGoldenCoastIntercompanyAccountId = await insertLedgerAccount({
    companyId: hadiCompany.id,
    code: "HADI-IC-GC",
    name: "Golden Coast Intercompany",
    accountType: "Intercompany",
    subType: "hadi_sp_intercompany",
  });
  const hadiCashAccountId = await insertLedgerAccount({
    companyId: hadiCompany.id,
    code: "HADI-CASH",
    name: "Cash Account",
    accountType: "Cash",
    subType: "Cash",
  });

  // Keep ERP inventory comfortably positive so a suite never creates shortage
  // layers, which the shared teardown does not know how to clear.
  await pool.query(`UPDATE inventory SET quantity = '1000.000', total_value = '10000.00' WHERE company_id = $1`, [
    ctx.companyId,
  ]);

  const agent = request.agent(ctx.app) as request.SuperAgentTest;
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ username: `${prefix}_testuser`, password: "testpassword123" });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  const fixture: GoldenCoastPhase5Fixture = {
    prefix,
    ctx,
    agent,
    goldenCoastStockItemId: ctx.stockItemIds[0],
    secondStockItemId: ctx.stockItemIds[1],
    saleSideAccountId,
    salesAccountId,
    cogsAccountId,
    stockInHandAccountId,
    plainCompanyId: plainCompany.id,
    plainLocationId: plainLocation.id,
    plainStockItemId: plainStockItem.id,
    plainPayableAccountId,
    plainCashAccountId,
    hadiCompanyId: hadiCompany.id,
    hadiCashAccountId,
    goldenCoastHadiIntercompanyAccountId,
    hadiGoldenCoastIntercompanyAccountId,
  };

  await selectCompany(fixture, ctx.companyId);
  return fixture;
}

/**
 * Fixture for the canonical itemized POS path.
 *
 * Unlike the Phase 5 fixture, this creates the actual Golden Coast/HADI
 * relationship used by normal POS settlement. The user is a member of both
 * companies so requests can authorize the HADI target-company scope without
 * bypassing the tenant boundary.
 */
export async function setupGoldenCoastNormalPosFixture(prefix: string): Promise<GoldenCoastNormalPosFixture> {
  const fixture = await setupGoldenCoastPhase5Fixture(prefix);
  const hadiCompanyId = fixture.hadiCompanyId;
  const hadiCompanyCode = stableFixtureCode(prefix, "HDI");

  const [hadiLocation] = await db
    .insert(schema.locations)
    .values({
      companyId: hadiCompanyId,
      code: `${hadiCompanyCode}-WH1`,
      name: `${prefix}_HadiWarehouse`,
    })
    .returning();
  const deductionClearingAccountId = await insertLedgerAccount({
    companyId: fixture.ctx.companyId,
    code: "SP-PAYDDC",
    name: "Supplier Payable Deduction Clearing",
    accountType: "Liability",
    subType: "sp_pay_deduction_clearing",
  });

  await db.insert(schema.companySettings).values({
    companyId: fixture.ctx.companyId,
    spPosPayableAccountId: fixture.saleSideAccountId,
    spPosProfitAccountId: fixture.salesAccountId,
  });
  await pool.query(
    `UPDATE locations SET supplier_partner_payable_deduction_per_qty = $1 WHERE id = $2 AND company_id = $3`,
    ["10.0000", fixture.ctx.locationId, fixture.ctx.companyId]
  );

  return {
    ...fixture,
    hadiCompanyId,
    hadiLocationId: hadiLocation.id,
    hadiCashAccountId: fixture.hadiCashAccountId,
    hadiIntercompanyAccountId: fixture.hadiGoldenCoastIntercompanyAccountId,
    goldenCoastIntercompanyAccountId: fixture.goldenCoastHadiIntercompanyAccountId,
    deductionClearingAccountId,
  };
}

export async function selectCompany(fixture: GoldenCoastPhase5Fixture, companyId: number): Promise<void> {
  const res = await fixture.agent.post("/api/auth/set-company").send({ companyId });
  if (res.status !== 200) {
    throw new Error(`set-company failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

export async function teardownGoldenCoastPhase5Fixture(fixture: GoldenCoastPhase5Fixture): Promise<void> {
  const companyIds = [fixture.ctx.companyId, fixture.plainCompanyId, fixture.hadiCompanyId];
  // Drop the parent link before the shared cleanup, which deletes companies by
  // prefix and would otherwise trip the self-referential foreign key.
  await pool.query(`UPDATE companies SET parent_company_id = NULL WHERE parent_company_id = $1`, [
    fixture.hadiCompanyId,
  ]);
  // The shared teardown does not know about shortage layers, and an oversold
  // item would otherwise hold stock_items down on the next run.
  await pool.query(
    `DELETE FROM inventory_negative_layers
     WHERE stock_item_id IN (SELECT id FROM stock_items WHERE company_id = ANY($1::int[]))`,
    [companyIds]
  );
  await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = ANY($1::int[])`, [companyIds]);
  await pool.query(`DELETE FROM sp_sale_lines WHERE company_id = ANY($1::int[])`, [companyIds]);
  await pool.query(`DELETE FROM sp_sales WHERE company_id = ANY($1::int[])`, [companyIds]);
  await cleanupTestData(fixture.prefix);
}

export async function teardownGoldenCoastNormalPosFixture(fixture: GoldenCoastNormalPosFixture): Promise<void> {
  // The parent FK is intentionally restrictive in production. Clear the link
  // before the shared teardown discovers and deletes the HADI fixture company.
  await pool.query(`UPDATE companies SET parent_company_id = NULL WHERE id = $1`, [fixture.ctx.companyId]);
  await db.delete(schema.companySettings).where(eq(schema.companySettings.companyId, fixture.ctx.companyId));
  await teardownGoldenCoastPhase5Fixture(fixture);
}

/** Mirrors what the Phase 4 opening FIFO bridge writes. */
export async function seedCutoverLot(input: {
  prefix: string;
  companyId: number;
  locationId: number;
  stockItemId: number;
  qty: string;
  unitCost: string;
  createdAt?: string;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sp_stock_movements
       (company_id, source_type, article_code, description, stock_item_id, location_id,
        qty_in, qty_remaining, base_unit_cost_usd, landed_unit_cost_usd, final_unit_cost_usd, created_at)
     VALUES ($1, 'golden_coast_cutover', $2, 'Golden Coast opening lot', $3, $4, $5, $5, $6, $6, $6,
             COALESCE($7::timestamp, now()))
     RETURNING id`,
    [
      input.companyId,
      `${input.prefix}-ART`,
      input.stockItemId,
      input.locationId,
      input.qty,
      input.unitCost,
      input.createdAt ?? null,
    ]
  );
  return Number(rows[0].id);
}

/** A pre-cutover Supplier Partner movement row, as it exists before Phase 4. */
export async function seedLegacyLot(input: {
  prefix: string;
  companyId: number;
  locationId: number;
  stockItemId: number;
  qty: string;
  unitCost: string;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sp_stock_movements
       (company_id, source_type, article_code, description, stock_item_id, location_id,
        qty_in, qty_remaining, base_unit_cost_usd, landed_unit_cost_usd, final_unit_cost_usd, created_at)
     VALUES ($1, 'offload', $2, 'Legacy pre-cutover lot', $3, $4, $5, $5, $6, $6, $6, '2026-01-05 00:00:00')
     RETURNING id`,
    [input.companyId, `${input.prefix}-LEGACY`, input.stockItemId, input.locationId, input.qty, input.unitCost]
  );
  return Number(rows[0].id);
}

export async function lotRemaining(lotId: number): Promise<number> {
  const { rows } = await pool.query(`SELECT qty_remaining::numeric AS qty FROM sp_stock_movements WHERE id = $1`, [
    lotId,
  ]);
  return Number(rows[0].qty);
}

export async function inventoryQuantity(companyId: number, locationId: number, stockItemId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(quantity::numeric, 0) AS qty FROM inventory
     WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [companyId, locationId, stockItemId]
  );
  return rows.length === 0 ? 0 : Number(rows[0].qty);
}

export async function clearLots(companyId: number): Promise<void> {
  await pool.query(`DELETE FROM sp_stock_movements WHERE company_id = $1`, [companyId]);
}

export async function voucherEntriesFor(voucherId: number) {
  return db.select().from(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, voucherId));
}
