/**
 * Fixture builders for the Supplier Partner migration coverage suites.
 *
 * Each suite creates its own ERP source company and Supplier Partner target
 * company, named after a unique prefix, so cleanupTestData(prefix) tears both
 * down. The migration bookkeeping tables (runs, links, tracked rows, cutovers)
 * have no foreign key to companies, so cleanupSpMigrationPair clears them by
 * company id first.
 *
 * `captureRouteHandlers` stands in for Express: it records each registered
 * route chain and runs only the final handler, which is how these suites reach
 * the migration handlers behind requireAuth/requireRole("Developer") (the HTTP
 * gate itself is exercised separately in sp-migration-http-gate-coverage).
 */
import type { PoolClient } from "pg";
import { pool } from "../../server/db";
import { cleanupTestData } from "../setup";
import { withFixtureTransaction } from "./voucherFixtureTransaction";

export const REQUIRED_TARGET_SUBTYPES = [
  "sp_goods_otw",
  "sp_otw_clearing",
  "sp_prepaid",
  "sp_stock",
  "sp_cost_clearing",
  "sp_pay_deduction_clearing",
  "sp_payable",
  "sp_sales",
  "sp_cogs",
  "sp_shared_charges",
  "sp_opnbal",
  "sp_prepaid_expenses",
  "sp_hadi_intercompany",
  "gc_our_profit_share",
  "gc_supplier_profit_share",
  "gc_accumulated_profit_clearing",
] as const;

export const MIGRATION_ACTIONS = ["gc_stock_master", "gc_stock_opening", "gc_sales_readonly", "gc_containers"] as const;

export interface SpMigrationPair {
  prefix: string;
  code: string;
  sourceId: number;
  targetId: number;
  sourceName: string;
  targetName: string;
}

function fixtureCode(prefix: string): string {
  let hash = 2166136261;
  for (const char of prefix) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `SPM${(hash >>> 0).toString(36).toUpperCase()}`;
}

async function insertCompany(code: string, name: string, type: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, $3, 'USD') RETURNING id`,
    [code, name, type]
  );
  return result.rows[0].id;
}

export async function createSpMigrationPair(prefix: string): Promise<SpMigrationPair> {
  await cleanupSpMigrationPair(prefix);
  const code = fixtureCode(prefix);
  const sourceName = `${prefix}_Source`;
  const targetName = `${prefix}_Target`;
  const sourceId = await insertCompany(`${code}S`, sourceName, "erp");
  const targetId = await insertCompany(`${code}T`, targetName, "supplier_partner");
  // The Supplier Partner company is a subsidiary of the ERP source, as in
  // production; the voucher-line guard only accepts the source's suppliers on
  // target lines across that parent/child link.
  await pool.query(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [sourceId, targetId]);
  return { prefix, code, sourceId, targetId, sourceName, targetName };
}

export async function cleanupSpMigrationPair(prefix: string): Promise<void> {
  const companies = await pool.query<{ id: number }>(`SELECT id FROM companies WHERE name LIKE $1`, [`%${prefix}%`]);
  const ids = companies.rows.map((row) => row.id);
  if (ids.length > 0) {
    await pool.query(`UPDATE companies SET parent_company_id = NULL WHERE id = ANY($1)`, [ids]);
    await pool.query(
      `DELETE FROM sp_migration_cutovers WHERE source_company_id = ANY($1) OR target_company_id = ANY($1)`,
      [ids]
    );
    const runs = `SELECT id FROM sp_migration_rehearsal_runs WHERE source_company_id = ANY($1) OR target_company_id = ANY($1)`;
    await pool.query(`DELETE FROM sp_migration_container_charges WHERE run_id IN (${runs})`, [ids]);
    await pool.query(`DELETE FROM sp_migration_source_links WHERE run_id IN (${runs})`, [ids]);
    await pool.query(`DELETE FROM sp_migration_run_rows WHERE run_id IN (${runs})`, [ids]);
    await pool.query(
      `DELETE FROM sp_migration_rehearsal_runs WHERE source_company_id = ANY($1) OR target_company_id = ANY($1)`,
      [ids]
    );
    await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM user_location_cash_accounts WHERE company_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM user_locations WHERE company_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM user_company_roles WHERE company_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM sp_container_lines WHERE company_id = ANY($1)`, [ids]);
    await pool.query(`UPDATE sp_containers SET goods_otw_voucher_id = NULL WHERE company_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM sp_containers WHERE company_id = ANY($1)`, [ids]);
    // Target lines name the source company's suppliers, so the pair's voucher
    // children go before cleanupTestData removes the source suppliers.
    const vouchers = `SELECT id FROM vouchers WHERE company_id = ANY($1)`;
    await pool.query(`DELETE FROM sales_items WHERE voucher_id IN (${vouchers})`, [ids]);
    await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (${vouchers})`, [ids]);
  }
  await pool.query(`DELETE FROM session WHERE sess->>'spMigrationFixture' = $1`, [prefix]);
  await cleanupTestData(prefix);
}

export async function insertAccount(
  companyId: number,
  code: string,
  accountType: string,
  subType: string | null,
  name = code
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active, is_hidden)
     VALUES ($1, $2, $3, $4, $5, '0', 'Dr', true, false) RETURNING id`,
    [companyId, code, name, accountType, subType]
  );
  return result.rows[0].id;
}

export async function insertRequiredTargetAccounts(targetId: number): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  for (const subType of REQUIRED_TARGET_SUBTYPES) {
    ids[subType] = await insertAccount(targetId, subType.toUpperCase(), "Asset", subType);
  }
  return ids;
}

export async function insertLocation(companyId: number, code: string, name: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [companyId, code, name]
  );
  return result.rows[0].id;
}

export async function insertStockItem(companyId: number, code: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, $3, 'PCS', true) RETURNING id`,
    [companyId, code, `${code} name`]
  );
  return result.rows[0].id;
}

export async function insertInventory(
  companyId: number,
  locationId: number,
  stockItemId: number,
  quantity: string,
  averageRate: string,
  totalValue: string | null = null
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, locationId, stockItemId, quantity, averageRate, totalValue]
  );
  return result.rows[0].id;
}

export async function insertSupplier(companyId: number, code: string, legalName: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [companyId, code, legalName, `${code.toLowerCase()}@spmig.test`]
  );
  return result.rows[0].id;
}

export async function insertRun(
  sourceId: number,
  targetId: number,
  action: string,
  status = "completed"
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO sp_migration_rehearsal_runs (source_company_id, target_company_id, action, status, rows_created, notes)
     VALUES ($1, $2, $3, $4, 0, 'coverage fixture') RETURNING id`,
    [sourceId, targetId, action, status]
  );
  return result.rows[0].id;
}

export async function completeAllActions(pair: SpMigrationPair): Promise<string> {
  let lastRun = "";
  for (const action of MIGRATION_ACTIONS) lastRun = await insertRun(pair.sourceId, pair.targetId, action);
  return lastRun;
}

export async function linkRows(
  runId: string,
  sourceTable: string,
  sourceId: number,
  targetTable: string,
  targetId: number
): Promise<void> {
  await pool.query(
    `INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, sourceTable, sourceId, targetTable, targetId]
  );
}

export async function trackFixtureRow(runId: string, tableName: string, rowId: number): Promise<void> {
  await pool.query(`INSERT INTO sp_migration_run_rows (run_id, table_name, row_id) VALUES ($1, $2, $3)`, [
    runId,
    tableName,
    rowId,
  ]);
}

export type FixtureEntry = { accountId: number | null; debit: string; credit: string; narration?: string };

/** Inserts a voucher with its entries in one transaction (balanced unless `unbalanced`). */
export async function insertVoucher(input: {
  companyId: number;
  number: string;
  type?: string;
  date?: string;
  total?: string;
  sourceModule?: string | null;
  supplierId?: number | null;
  entries?: FixtureEntry[];
  unbalanced?: boolean;
}): Promise<{ voucherId: number; entryIds: number[] }> {
  return withFixtureTransaction(
    async (client: PoolClient) => {
      const voucher = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module, supplier_id)
         VALUES ($1, $2, $3, $4, 'SP migration coverage', $5, 'USD', $6, $7) RETURNING id`,
        [
          input.companyId,
          input.number,
          input.type ?? "Sales",
          input.date ?? "2026-09-01",
          input.total ?? "0",
          input.sourceModule ?? null,
          input.supplierId ?? null,
        ]
      );
      const voucherId = voucher.rows[0].id;
      const entryIds: number[] = [];
      for (const entry of input.entries ?? []) {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [voucherId, entry.accountId, entry.debit, entry.credit, entry.narration ?? null]
        );
        entryIds.push(inserted.rows[0].id);
      }
      return { voucherId, entryIds };
    },
    { legacyUnbalanced: input.unbalanced }
  );
}

export async function insertSaleItem(
  voucherId: number,
  stockItemId: number,
  quantity = "2",
  sellingPrice = "15",
  costPrice = "10"
): Promise<number> {
  const qty = Number(quantity);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      voucherId,
      stockItemId,
      quantity,
      sellingPrice,
      costPrice,
      String(qty * Number(sellingPrice)),
      String(qty * Number(costPrice)),
      String(qty * (Number(sellingPrice) - Number(costPrice))),
    ]
  );
  return result.rows[0].id;
}

export async function insertUser(username: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (username, password) VALUES ($1, 'not-a-real-hash') RETURNING id`,
    [username]
  );
  return String(result.rows[0].id);
}

export async function insertRole(
  userId: string,
  companyId: number,
  role: string,
  extra: { assignedLocationId?: number | null; cashAccountId?: number | null; posStation?: number | null } = {}
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO user_company_roles (user_id, company_id, role, assigned_location_id, cash_account_id, pos_station, daybook_edit_days, can_access_customers)
     VALUES ($1, $2, $3, $4, $5, $6, 3, true) RETURNING id`,
    [userId, companyId, role, extra.assignedLocationId ?? null, extra.cashAccountId ?? null, extra.posStation ?? null]
  );
  return result.rows[0].id;
}

export async function insertSession(prefix: string, sid: string, userId: string, companyId: number): Promise<void> {
  await pool.query(`INSERT INTO session (sid, sess, expire) VALUES ($1, $2::json, now() + interval '1 hour')`, [
    sid,
    JSON.stringify({ userId, currentCompanyId: companyId, currentRole: "Manager", spMigrationFixture: prefix }),
  ]);
}

export async function insertCutover(
  pair: SpMigrationPair,
  status: string,
  extra: { rollbackDeadlineSql?: string; targetWriteHold?: boolean; activatedAtSql?: string } = {}
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO sp_migration_cutovers
       (source_company_id, target_company_id, status, source_company_name, target_company_name,
        target_write_hold, rollback_deadline, activated_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${extra.rollbackDeadlineSql ?? "NULL"}, ${extra.activatedAtSql ?? "NULL"})
     RETURNING id`,
    [pair.sourceId, pair.targetId, status, pair.sourceName, pair.targetName, extra.targetWriteHold ?? false]
  );
  return Number(result.rows[0].id);
}

type Handler = (req: unknown, res: unknown, next?: () => void) => unknown;
export type CapturedResult = { status: number; body: any };

/** Records registered routes on a stand-in Express app and runs a route's final handler. */
export function captureRouteHandlers(register: (app: never) => void) {
  const routes = new Map<string, Handler[]>();
  const app = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (path: unknown, ...handlers: Handler[]) => {
          if (typeof path === "string" && handlers.length > 0) routes.set(`${method.toUpperCase()} ${path}`, handlers);
        },
    }
  );
  register(app as never);

  async function call(route: string, req: Record<string, any> = {}): Promise<CapturedResult> {
    const handlers = routes.get(route);
    if (!handlers) throw new Error(`route not registered: ${route}`);
    let status = 200;
    let body: any;
    const res: Record<string, any> = {
      status(code: number) {
        status = code;
        return res;
      },
      json(value: unknown) {
        body = value;
        return res;
      },
      send(value: unknown) {
        body = value;
        return res;
      },
    };
    const request = {
      params: {},
      query: {},
      body: {},
      ...req,
      session: { userId: "spmig-dev", username: "spmig-dev", ...(req.session ?? {}) },
    };
    await handlers[handlers.length - 1](request, res);
    return { status, body };
  }

  return { call, routes };
}

/** A request body naming the pair and its exact source-name confirmation. */
export function pairBody(pair: SpMigrationPair, extra: Record<string, unknown> = {}) {
  return {
    sourceCompanyId: pair.sourceId,
    targetCompanyId: pair.targetId,
    companyNameConfirm: pair.sourceName,
    ...extra,
  };
}

export async function scalar<T = unknown>(query: string, params: unknown[] = []): Promise<T> {
  const result = await pool.query(query, params);
  const row = result.rows[0] ?? {};
  return Object.values(row)[0] as T;
}

/**
 * Gives the target every required Supplier Partner account, records all four
 * migration steps as completed and posts the profit-share opening voucher: the
 * readiness prerequisites a cutover checks before it may be prepared.
 */
export async function makePairReady(pair: SpMigrationPair): Promise<Record<string, number>> {
  const accounts = await insertRequiredTargetAccounts(pair.targetId);
  await completeAllActions(pair);
  await insertVoucher({
    companyId: pair.targetId,
    number: `GC-PROFIT-OPN-${pair.code}`,
    type: "Journal",
    sourceModule: "SP_MIGRATION",
  });
  return accounts;
}
