#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL || "";
const username = process.env.ERP_E2E_USERNAME || "";
const password = process.env.ERP_E2E_PASSWORD || "";
const posUsername = process.env.ERP_E2E_POS_USERNAME || "";
const posPassword = process.env.ERP_E2E_POS_PASSWORD || "";
const outputDir = path.resolve("artifacts/phase7-browser-e2e");

function fail(message) {
  console.error(`Phase 7 browser fixture failed: ${message}`);
  process.exit(1);
}

if (process.env.NODE_ENV !== "test") fail("NODE_ENV must be test");
if (process.env.ERP_E2E_DISPOSABLE_DB !== "1") fail("ERP_E2E_DISPOSABLE_DB must explicitly allow disposable seeding");
if (!databaseUrl) fail("DATABASE_URL is required");
if (!username || !password) fail("ERP_E2E_USERNAME and ERP_E2E_PASSWORD are required");
if (!posUsername || !posPassword) fail("ERP_E2E_POS_USERNAME and ERP_E2E_POS_PASSWORD are required");

let database;
try {
  database = new URL(databaseUrl);
} catch {
  fail("DATABASE_URL is invalid");
}

if (!new Set(["localhost", "127.0.0.1", "::1"]).has(database.hostname)) {
  fail(`refusing to seed a non-local database host (${database.hostname})`);
}
if (database.pathname !== "/heliumdb") {
  fail("refusing to seed anything except the dedicated heliumdb test database");
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  const passwordHash = await bcrypt.hash(password, 12);
  const posPasswordHash = await bcrypt.hash(posPassword, 12);

  await client.query("BEGIN");

  const companyRows = {};
  for (const company of [
    { code: "PHASE7-ERP", name: "Phase 7 Browser ERP", type: "erp" },
    { code: "PHASE7-FACTORY", name: "Phase 7 Browser Factory", type: "factory" },
    { code: "PHASE7-SP", name: "Phase 7 Browser Supplier Partner", type: "supplier_partner" },
  ]) {
    const result = await client.query(
      `INSERT INTO companies (code, name, company_type, base_currency, active)
       VALUES ($1, $2, $3, 'USD', true)
       RETURNING id, code`,
      [company.code, company.name, company.type],
    );
    companyRows[company.code] = Number(result.rows[0].id);
  }

  const erpCompanyId = companyRows["PHASE7-ERP"];
  const factoryCompanyId = companyRows["PHASE7-FACTORY"];
  const spCompanyId = companyRows["PHASE7-SP"];

  const userResult = await client.query(
    `INSERT INTO users (username, password, active)
     VALUES ($1, $2, true)
     RETURNING id`,
    [username, passwordHash],
  );
  const userId = userResult.rows[0].id;

  const posUserResult = await client.query(
    `INSERT INTO users (username, password, active)
     VALUES ($1, $2, true)
     RETURNING id`,
    [posUsername, posPasswordHash],
  );
  const posUserId = posUserResult.rows[0].id;

  const erpLocations = await client.query(
    `INSERT INTO locations (company_id, code, name, active)
     VALUES ($1, 'P7-ERP-A', 'Phase 7 Main', true),
            ($1, 'P7-ERP-B', 'Phase 7 Branch', true)
     RETURNING id, code`,
    [erpCompanyId],
  );
  const erpLocationId = Number(erpLocations.rows.find((row) => row.code === "P7-ERP-A").id);
  const erpLocation2Id = Number(erpLocations.rows.find((row) => row.code === "P7-ERP-B").id);

  const stockGroup = await client.query(
    `INSERT INTO stock_groups (company_id, code, name, active)
     VALUES ($1, 'P7-GROUP', 'Phase 7 Browser Stock', true)
     RETURNING id`,
    [erpCompanyId],
  );
  const stockGroupId = Number(stockGroup.rows[0].id);

  const stockItem = await client.query(
    `INSERT INTO stock_items
       (company_id, code, name, stock_group_id, uom, selling_price, active)
     VALUES ($1, 'P7-ITEM', 'Phase 7 Browser Item', $2, 'PCS', '25.00', true)
     RETURNING id`,
    [erpCompanyId, stockGroupId],
  );
  const stockItemId = Number(stockItem.rows[0].id);

  await client.query(
    `INSERT INTO inventory
       (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $4, '100.000', '10.00', '1000.00'),
            ($1, $3, $4, '50.000', '10.00', '500.00')`,
    [erpCompanyId, erpLocationId, erpLocation2Id, stockItemId],
  );

  const erpAccounts = await client.query(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, 'P7-CASH', 'Phase 7 Cash', 'Cash', 'Cash', '0', 'Dr'),
            ($1, 'P7-SALES', 'Phase 7 Sales', 'Income', 'Sales', '0', 'Cr')
     RETURNING id, code`,
    [erpCompanyId],
  );
  const erpCashAccountId = Number(erpAccounts.rows.find((row) => row.code === "P7-CASH").id);
  const erpSalesAccountId = Number(erpAccounts.rows.find((row) => row.code === "P7-SALES").id);

  for (const companyId of [erpCompanyId, factoryCompanyId, spCompanyId]) {
    await client.query(
      `INSERT INTO user_company_roles (user_id, company_id, role)
       VALUES ($1, $2, 'Developer')`,
      [userId, companyId],
    );
  }

  await client.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, assigned_location_id, cash_account_id, pos_station)
     VALUES ($1, $2, 'POS', $3, $4, 1)`,
    [posUserId, erpCompanyId, erpLocationId, erpCashAccountId],
  );
  await client.query(
    `INSERT INTO user_locations (user_id, company_id, location_id)
     VALUES ($1, $2, $3)`,
    [posUserId, erpCompanyId, erpLocationId],
  );

  const factorySupplier = await client.query(
    `INSERT INTO factory_suppliers
       (company_id, name, opening_balance, is_active, current_raw_material_cost_per_kg_usd)
     VALUES ($1, 'Phase 7 Supplier', '0', true, '0')
     RETURNING id`,
    [factoryCompanyId],
  );
  const factorySupplierId = Number(factorySupplier.rows[0].id);

  const factoryContainer = await client.query(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, total_kg, rate_per_kg,
        rate_per_kg_usd, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        freight, other_charges, commission_amount, status)
     VALUES ($1, 'P7-FACTORY-CONT-001', $2, '100', '2', '2', 'USD', '1', true,
             '0', '0', '0', 'ARRIVED')
     RETURNING id`,
    [factoryCompanyId, factorySupplierId],
  );
  const factoryContainerId = Number(factoryContainer.rows[0].id);

  const spLocation = await client.query(
    `INSERT INTO locations (company_id, code, name, active)
     VALUES ($1, 'P7-SP-MAIN', 'Phase 7 SP Main', true)
     RETURNING id`,
    [spCompanyId],
  );
  const spLocationId = Number(spLocation.rows[0].id);

  const spItem = await client.query(
    `INSERT INTO stock_items (company_id, code, name, uom, selling_price, active)
     VALUES ($1, 'P7-SP-ITEM', 'Phase 7 SP Item', 'PCS', '30.00', true)
     RETURNING id`,
    [spCompanyId],
  );
  const spStockItemId = Number(spItem.rows[0].id);

  const spAccounts = await client.query(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, 'P7-SP-CASH', 'Phase 7 SP Cash', 'Cash', 'Cash', '0', 'Dr'),
            ($1, 'SP-PAY', 'Supplier Cash Payable', 'Liability', 'sp_payable', '0', 'Cr')
     RETURNING id, code`,
    [spCompanyId],
  );
  const spCashAccountId = Number(spAccounts.rows.find((row) => row.code === "P7-SP-CASH").id);
  const spPayableAccountId = Number(spAccounts.rows.find((row) => row.code === "SP-PAY").id);

  await client.query(
    `INSERT INTO sp_stock_movements
       (company_id, article_code, description, stock_item_id, location_id,
        qty_in, qty_remaining, base_unit_cost_usd, landed_unit_cost_usd, final_unit_cost_usd)
     VALUES ($1, 'P7-SP-ITEM', 'Phase 7 SP Item', $2, $3, '5', '5', '12', '14', '15')`,
    [spCompanyId, spStockItemId, spLocationId],
  );

  await client.query("COMMIT");

  const fixture = {
    status: "phase7-browser-fixture-ready",
    companies: {
      erp: erpCompanyId,
      factory: factoryCompanyId,
      supplierPartner: spCompanyId,
    },
    erp: {
      locationId: erpLocationId,
      location2Id: erpLocation2Id,
      stockItemId,
      cashAccountId: erpCashAccountId,
      salesAccountId: erpSalesAccountId,
    },
    factory: {
      supplierId: factorySupplierId,
      containerId: factoryContainerId,
    },
    supplierPartner: {
      locationId: spLocationId,
      stockItemId: spStockItemId,
      cashAccountId: spCashAccountId,
      payableAccountId: spPayableAccountId,
    },
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: fixture.status }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  fail(error instanceof Error ? error.message : String(error));
} finally {
  client.release();
  await pool.end();
}
