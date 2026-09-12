import express from "express";
import session from "express-session";
import { registerRoutes } from "../server/routes";
import { db } from "../server/db";
import { pool } from "../server/db";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "../shared/schema";
import { KNOWN_SECURITY_PERMISSIONS } from "../server/services/security/namedPermissionService";

let testApp: express.Express;
let testServer: any;

export interface TestContext {
  app: express.Express;
  agent: any;
  companyId: number;
  locationId: number;
  location2Id: number;
  stockGroupId: number;
  stockItemIds: number[];
  userId: string;
  sessionCookie: string;
  salesAccountId: number;
  cashAccountId: number;
}

function stableTestCompanyCode(prefix: string): string {
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
  const suffix = (hash >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(-4);
  return `${base}${suffix}`;
}

/**
 * Fixtures that need a factory-typed company.
 *
 * The factory route tree sits behind a guard that rejects a session whose
 * company is not of type "factory", so any suite exercising it has to seed one.
 * Ordinary ERP/POS tests stay on "erp".
 */
const FACTORY_COMPANY_PREFIXES = new Set([
  "xlsexp",
  "charfact",
  "supcrud",
  "balecrud",
  "transwr",
  "ordchg",
  "v3load",
  "advwr",
  "empadv",
  "prodblk",
  "shiprow",
  "ordcrud",
  "rsadj",
  "dbkedit",
  "cntdel",
  "mixbat",
  "facimp",
  "wdedwr",
  "mkpaid",
  "prswr",
  "wbonus",
  "advmgt",
  "dspbat",
  "canonfse",
  "custload",
  "phase4cap",
  "phase2cov",
]);

function testCompanyType(prefix: string): "erp" | "factory" {
  return FACTORY_COMPANY_PREFIXES.has(prefix) ? "factory" : "erp";
}

export async function setupTestApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use(
    session({
      secret: "test-secret-key-for-integration-tests",
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false, httpOnly: true, maxAge: 30 * 60 * 1000 },
    })
  );

  const server = await registerRoutes(app);
  testServer = server;
  testApp = app;
  return app;
}

export async function cleanupTestData(prefix: string): Promise<void> {
  const companies = await db
    .select()
    .from(schema.companies)
    .where(sql`${schema.companies.name} LIKE ${"%" + prefix + "%"}`);

  for (const company of companies) {
    await pool.query("DELETE FROM audit_log WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM login_history WHERE company_id = $1", [company.id]);
    await db.delete(schema.inventory).where(eq(schema.inventory.companyId, company.id));
    await db
      .delete(schema.salesItems)
      .where(sql`${schema.salesItems.voucherId} IN (SELECT id FROM vouchers WHERE company_id = ${company.id})`);
    await db
      .delete(schema.voucherEntries)
      .where(sql`${schema.voucherEntries.voucherId} IN (SELECT id FROM vouchers WHERE company_id = ${company.id})`);
    await db
      .delete(schema.stockTransferItems)
      .where(
        sql`${schema.stockTransferItems.transferId} IN (SELECT stv.id FROM stock_transfer_vouchers stv JOIN vouchers v ON stv.voucher_id = v.id WHERE v.company_id = ${company.id})`
      );
    await db
      .delete(schema.stockTransferVouchers)
      .where(
        sql`${schema.stockTransferVouchers.voucherId} IN (SELECT id FROM vouchers WHERE company_id = ${company.id})`
      );
    // The customer-order family, cleared early for three reasons:
    // customer_order_charges references vouchers, customer_order_bales
    // references locations, and customer_orders.proforma_id_used references
    // customer_proformas — so all of it has to go before the voucher, location
    // and company deletes below. Without this a suite that created a proforma
    // or scanned a bale into an order leaves the company undeletable.
    await pool.query(
      "DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM customer_order_lines WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)",
      [company.id]
    );
    await pool.query("DELETE FROM factory_shipping_container_rows WHERE company_id = $1", [company.id]);
    // The dispatch-batch family, cleared here for the same reason: batches
    // reference customers and proformas with ON DELETE RESTRICT, and rides
    // reference batches, so all of it must go before the customer delete below.
    await pool.query("DELETE FROM customer_dispatch_bale_scans WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM customer_dispatch_truck_rides WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM customer_dispatch_batches WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM customer_dispatch_batch_sequences WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM customer_orders WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM proforma_stock_reservations WHERE company_id = $1", [company.id]);
    await pool.query(
      "DELETE FROM customer_proforma_lines WHERE proforma_id IN (SELECT id FROM customer_proformas WHERE company_id = $1)",
      [company.id]
    );
    await pool.query("DELETE FROM customer_proformas WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM customer_balances WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM customers WHERE company_id = $1", [company.id]);
    // Transporter transactions reference vouchers with ON DELETE RESTRICT, so
    // they must be cleared before the vouchers themselves — a suite that
    // recorded a transporter charge otherwise leaves the company undeletable.
    await pool.query("DELETE FROM factory_transporter_transactions WHERE company_id = $1", [company.id]);
    // Same constraint, same reason: employee_bonuses.voucher_id is ON DELETE
    // RESTRICT, so a suite that recorded a bonus blocks the voucher delete.
    await pool.query("DELETE FROM employee_bonuses WHERE company_id = $1", [company.id]);
    // worker_bonuses.cash_account_id is ON DELETE RESTRICT against
    // ledger_accounts, so a paid worker bonus blocks the ledger delete below.
    await pool.query("DELETE FROM worker_bonuses WHERE company_id = $1", [company.id]);
    // Documents that hang off a voucher with a restricting key: a credit or
    // debit note's lines, a waste dispatch, and a stock adjustment's header and
    // lines (which the waste dispatch also creates, since waste is dispatched
    // as an adjustment). Each blocks the voucher delete below, and none of them was
    // reachable from a fixture company until the canonical journal work gave
    // these routes end-to-end coverage.
    await pool.query(
      `DELETE FROM credit_note_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [company.id]
    );
    await pool.query(
      `DELETE FROM stock_adjustment_items WHERE adjustment_id IN (
         SELECT sav.id FROM stock_adjustment_vouchers sav
         JOIN vouchers v ON v.id = sav.voucher_id
         WHERE v.company_id = $1)`,
      [company.id]
    );
    await pool.query(
      `DELETE FROM waste_dispatch_items WHERE dispatch_id IN (SELECT id FROM waste_dispatches WHERE company_id = $1)`,
      [company.id]
    );
    await pool.query("DELETE FROM waste_dispatches WHERE company_id = $1", [company.id]);
    await pool.query(
      `DELETE FROM stock_adjustment_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
      [company.id]
    );
    // accounting_posting_requests deliberately uses ON DELETE RESTRICT for
    // vouchers in production. Replay/idempotency tests intentionally keep
    // explicit request identities alive until teardown, so clear this test
    // ledger before deleting the fixture company's vouchers.
    await pool.query("DELETE FROM accounting_posting_requests WHERE company_id = $1", [company.id]);
    // Purchase orders retain a restricting voucher_id foreign key, so their
    // headers must be removed before the vouchers they created.
    await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, company.id));
    await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, company.id));
    // stock_adjustment_items.stock_item_id is a foreign key against stock_items,
    // so any adjustment line left by a test blocks the stock_items delete below
    // with 'update or delete on table "stock_items" violates foreign key
    // constraint stock_adjustment_items_stock_item_id_stock_items_id_fk'. It does
    // not bite on a fresh CI database because the ordering happens to work out,
    // which is exactly what makes it worth deleting explicitly rather than
    // relying on that.
    await pool.query(
      `DELETE FROM stock_adjustment_items WHERE stock_item_id IN (SELECT id FROM stock_items WHERE company_id = $1)`,
      [company.id]
    );
    // The canonical stock movement journal holds restricting foreign keys to
    // stock_items, locations and companies, so any transfer a test posted keeps
    // its fixture alive. The journal is append-only in production — there is no
    // delete path in the application — which is precisely why the fixture has to
    // clear it explicitly here.
    await pool.query("DELETE FROM canonical_stock_movement_audit WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM canonical_stock_movement_requests WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM canonical_stock_movements WHERE company_id = $1", [company.id]);
    await db.delete(schema.stockItems).where(eq(schema.stockItems.companyId, company.id));
    await db.delete(schema.stockGroups).where(eq(schema.stockGroups.companyId, company.id));
    await db.delete(schema.locations).where(eq(schema.locations.companyId, company.id));
    await pool.query("DELETE FROM factory_transporters WHERE company_id = $1", [company.id]);
    await db.delete(schema.companySettings).where(eq(schema.companySettings.companyId, company.id));
    await db.delete(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.companyId, company.id));
    await db.delete(schema.userSecurityPermissions).where(eq(schema.userSecurityPermissions.companyId, company.id));
    await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.companyId, company.id));
    await db.delete(schema.userLocations).where(eq(schema.userLocations.companyId, company.id));

    // Normal container records are also created by PO tests. Remove their
    // restricting child rows before deleting the containers themselves.
    await pool.query(
      "DELETE FROM container_offload_items WHERE offload_id IN (SELECT id FROM container_offloads WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1))",
      [company.id]
    );
    await pool.query(
      "DELETE FROM container_freight_payments WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM container_freight_payments WHERE container_freight_id IN (SELECT id FROM container_freight WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM container_offloads WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM container_charges WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM supplier_container_loaded_items WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query("DELETE FROM container_sales WHERE company_id = $1", [company.id]);
    await pool.query(
      "DELETE FROM container_documents WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM import_logs WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM container_tracking_events WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query(
      "DELETE FROM container_tracking_checks WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
      [company.id]
    );
    await pool.query("DELETE FROM container_freight WHERE company_id = $1", [company.id]);
    await db.delete(schema.containers).where(eq(schema.containers.companyId, company.id));
    // Supplier company scoping was added by a startup migration before the
    // shared Drizzle definition was updated. Use SQL so stale company-owned
    // suppliers cannot keep the fixture company alive.
    await pool.query("DELETE FROM suppliers WHERE company_id = $1", [company.id]);

    // A crashed/interrupted factory test can leave rows in factory_* tables
    // referencing this company; those FKs otherwise block the company delete
    // below on the NEXT run that reuses this prefix. Delete in FK-safe order.
    await pool.query("DELETE FROM factory_bales WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_bale_products WHERE company_id = $1", [company.id]);
    await pool.query(
      "DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)",
      [company.id]
    );
    await pool.query("DELETE FROM factory_mix_batches WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_raw_stock WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_container_other_charges WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_offload_additional_charges WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_container_commissions WHERE company_id = $1", [company.id]);
    // Every table below carries a foreign key to factory_containers and was
    // added after this teardown was written, so the container delete that
    // follows started failing the moment a test actually offloaded one. Found
    // by the raw-stock offload response pin, which is the only test that
    // exercises that path end to end. Kept in one block so the next table with
    // an FK to factory_containers is added here rather than discovered later.
    await pool.query("DELETE FROM factory_container_receipts WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_container_profit_snapshots WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_duty_audit_log WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_fx_allocations WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_waste_entries WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_containers WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_suppliers WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_daybook_entries WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_settings WHERE company_id = $1", [company.id]);
    // Employees, once the voucher_entries keyed by employee_id are gone.
    await pool.query("DELETE FROM employee_advance_repayments WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM employee_advances WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM employees WHERE company_id = $1", [company.id]);
    // Barcode sequence rows are allocated lazily on read — GET
    // /api/production-bales/next-barcode writes one — so a test that only
    // exercises read endpoints can still leave an FK reference behind.
    // POST /api/bale-label-prints/allocate-pool allocates from this table, so a
    // suite that printed labels leaves a row here holding the company down.
    await pool.query("DELETE FROM reference_sequences WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM bale_sequences WHERE company_id = $1", [company.id]);
    await pool.query("DELETE FROM factory_bale_sequences WHERE company_id = $1", [company.id]);

    // Authentication and audit middleware finish asynchronously, so a request
    // that a test already stopped waiting on can still insert an audit_log or
    // login_history row while this teardown runs. These two deletes used to sit
    // above the factory_* block, which left ~15 round trips between them and the
    // company delete — wide enough for a late write to land and fail the delete
    // on login_history_company_id_fkey. That is a race, so it broke CI on runs
    // where the timing happened to line up rather than on any particular change.
    //
    // Clearing them last shrinks the window to a single statement. It cannot
    // close it completely — nothing short of quiescing the middleware can — so
    // the delete below retries once, re-clearing whatever arrived in between.
    async function clearAsyncReferences(): Promise<void> {
      await pool.query("DELETE FROM audit_log WHERE company_id = $1", [company.id]);
      await pool.query("DELETE FROM login_history WHERE company_id = $1", [company.id]);
    }

    // Durable financial request reservations are company-scoped and must be
    // removed before deleting the fixture company.
    await pool.query("DELETE FROM financial_operation_requests WHERE company_id = $1", [company.id]);
    await clearAsyncReferences();

    try {
      await db.delete(schema.companies).where(eq(schema.companies.id, company.id));
    } catch (error) {
      await clearAsyncReferences();
      await db.delete(schema.companies).where(eq(schema.companies.id, company.id));
      void error;
    }
  }

  const usersToDelete = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.username} LIKE ${"%" + prefix + "%"}`);

  for (const u of usersToDelete) {
    await pool.query("DELETE FROM login_history WHERE user_id = $1", [u.id]);
    await db.delete(schema.users).where(eq(schema.users.id, u.id));
  }

  // Drop the parent-company pin with the fixture that owned it, so a later run
  // cannot resolve a parent company that no longer exists. A delete is used
  // rather than setParentCompanyId(null) because it is idempotent and cannot
  // race another suite into a duplicate-key insert.
  await pool.query("DELETE FROM system_settings WHERE key = 'parentCompanyId'");
}

export async function seedTestData(prefix: string): Promise<TestContext> {
  const app = await setupTestApp();

  await cleanupTestData(prefix);

  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.hash("testpassword123", 10);

  const [user] = await db
    .insert(schema.users)
    .values({
      username: `${prefix}_testuser`,
      password: hashedPassword,
    })
    .returning();

  const companyCode = stableTestCompanyCode(prefix);
  const [company] = await db
    .insert(schema.companies)
    .values({
      code: companyCode,
      name: `${prefix}_TestCompany`,
      companyType: testCompanyType(prefix),
      baseCurrency: "USD",
    })
    .returning();

  // Pin the legacy parent company to this fixture.
  //
  // resolveParentCompanyId() falls back to "the only ERP company" when the
  // parentCompanyId setting is unset, and throws outright when more than one
  // exists. Companies default to companyType "erp", so the moment a test
  // creates a second company - which several do, to exercise isolation - every
  // endpoint that reads supplier balances starts returning 500, including
  // /api/accounts/all. Configuring the setting is what a real deployment is
  // required to do, and it makes resolution succeed no matter how many
  // companies a test creates. In the single-company case it resolves to exactly
  // the same company the fallback would have chosen.
  //
  // Written as an upsert rather than through setParentCompanyId(): test files
  // are not serialised, and system_settings.key is unique, so a read-then-
  // insert loses the race when two suites seed at the same moment.
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('parentCompanyId', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(company.id)]
  );

  await db.insert(schema.userCompanyRoles).values({
    userId: user.id,
    companyId: company.id,
    role: "Admin",
  });

  await db.insert(schema.userSecurityPermissions).values(
    KNOWN_SECURITY_PERMISSIONS.map((permission) => ({
      userId: user.id,
      companyId: company.id,
      permission,
      grantedBy: user.id,
    }))
  );

  const [location1] = await db
    .insert(schema.locations)
    .values({
      companyId: company.id,
      code: `${companyCode}-WH1`,
      name: `${prefix}_Warehouse1`,
    })
    .returning();

  const [location2] = await db
    .insert(schema.locations)
    .values({
      companyId: company.id,
      code: `${companyCode}-WH2`,
      name: `${prefix}_Warehouse2`,
    })
    .returning();

  const [stockGroup] = await db
    .insert(schema.stockGroups)
    .values({
      companyId: company.id,
      name: `${prefix}_TestGroup`,
      code: `T${prefix.slice(-2).toUpperCase()}`,
    })
    .returning();

  const stockItemIds: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const [item] = await db
      .insert(schema.stockItems)
      .values({
        companyId: company.id,
        code: `${prefix}-ITEM${i}`,
        name: `Test Item ${i}`,
        uom: "PCS",
        stockGroupId: stockGroup.id,
        active: true,
      })
      .returning();
    stockItemIds.push(item.id);
  }

  for (const stockItemId of stockItemIds) {
    await db.insert(schema.inventory).values({
      companyId: company.id,
      locationId: location1.id,
      stockItemId,
      quantity: "100.000",
      averageRate: "10.00",
      totalValue: "1000.00",
    });
  }

  const [salesAccount] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: company.id,
      code: `${prefix}_SALES`,
      name: "Sales Revenue",
      accountType: "Income",
      subType: "Sales",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();

  const [cashAccount] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: company.id,
      code: `${prefix}_CASH`,
      name: "Cash Account",
      accountType: "Cash",
      subType: "Cash",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();

  return {
    app,
    agent: null,
    companyId: company.id,
    locationId: location1.id,
    location2Id: location2.id,
    stockGroupId: stockGroup.id,
    stockItemIds,
    userId: user.id,
    sessionCookie: "",
    salesAccountId: salesAccount.id,
    cashAccountId: cashAccount.id,
  };
}

export async function getInventoryQty(locationId: number, stockItemId: number): Promise<number> {
  const [inv] = await db
    .select()
    .from(schema.inventory)
    .where(and(eq(schema.inventory.locationId, locationId), eq(schema.inventory.stockItemId, stockItemId)))
    .limit(1);
  return inv ? parseFloat(inv.quantity) : 0;
}

export async function getInventoryRecord(locationId: number, stockItemId: number) {
  const [inv] = await db
    .select()
    .from(schema.inventory)
    .where(and(eq(schema.inventory.locationId, locationId), eq(schema.inventory.stockItemId, stockItemId)))
    .limit(1);
  return inv;
}

export function closeTestServer(): void {
  if (testServer) {
    testServer.close();
  }
}
