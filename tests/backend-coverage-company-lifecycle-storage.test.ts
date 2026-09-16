/**
 * Company lifecycle and the per-company access records that hang off it.
 *
 * Deleting a company is the one operation that has to leave nothing behind:
 * every row keyed to it, in every module, across tables that predate their own
 * migrations. A single orphan keeps the company row alive behind a foreign key
 * or, worse, leaves another tenant's query joining onto a dead id. The rest of
 * this file covers the records that decide what a user may see once the company
 * exists — role feature flags, per-user page access and hidden cost fields —
 * and the parent-company setting that intercompany posting reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import * as authStorage from "../server/storage/auth";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "colife";
let ctx: TestContext;

async function countIn(table: string, column: string, value: number | string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [value]
  );
  return Number(result.rows[0].count);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("company deletion", () => {
  it("removes every record keyed to the company, including the ones behind restricting keys", async () => {
    // A throwaway company carrying a row in each family the cascade has to
    // reach: accounting, inventory, access control and the audit trail.
    const disposable = await seedTestData(`${TEST_PREFIX}del`);
    const companyId = disposable.companyId;

    const voucher = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, description,
                             total_amount, currency)
       VALUES ($1, $2, $3, 'Journal', '2026-09-14', 'lifecycle voucher', '50.00', 'USD') RETURNING id`,
      [companyId, disposable.locationId, `${TEST_PREFIX}-V1`]
    );
    const voucherId = voucher.rows[0].id;
    await pool.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES ($1, $2, '50.00', '0', 'debit side'), ($1, $3, '0', '50.00', 'credit side')`,
      [voucherId, disposable.cashAccountId, disposable.salesAccountId]
    );
    await pool.query(
      `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
       VALUES ($1, 'USD', 'CDF', '2800', '2026-09-14')`,
      [companyId]
    );
    await pool.query(
      `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled)
       VALUES ($1, 'Admin', 'lifecycle-feature', true)`,
      [companyId]
    );
    await pool.query(
      `INSERT INTO erp_user_page_access (company_id, user_id, page_key) VALUES ($1, $2, 'lifecycle-page')`,
      [companyId, disposable.userId]
    );
    await pool.query(
      `INSERT INTO audit_log (company_id, user_id, username, action, table_name, record_identifier)
       VALUES ($1, $2, $3, 'create', 'vouchers', 'lifecycle')`,
      [companyId, disposable.userId, `${TEST_PREFIX}del_testuser`]
    );
    // Two tables the ordered deletes never named. They restrict companies, so
    // before the catalogue-driven sweep either one of them alone was enough to
    // make deleting this company fail outright.
    await pool.query(
      `INSERT INTO user_security_permissions (user_id, company_id, permission)
       VALUES ($1, $2, 'lifecycle-permission')`,
      [disposable.userId, companyId]
    );
    await pool.query(
      `INSERT INTO user_activity_log (user_id, username, company_id, company_name, route)
       VALUES ($1, $2, $3, $4, '/api/vouchers')`,
      [disposable.userId, `${TEST_PREFIX}del_testuser`, companyId, `${TEST_PREFIX}del_TestCompany`]
    );

    // Everything is really there before the delete, so the assertions after it
    // mean something.
    expect(await countIn("vouchers", "company_id", companyId)).toBeGreaterThan(0);
    expect(await countIn("voucher_entries", "voucher_id", voucherId)).toBe(2);
    expect(await countIn("locations", "company_id", companyId)).toBeGreaterThan(0);
    expect(await countIn("ledger_accounts", "company_id", companyId)).toBeGreaterThan(0);
    expect(await countIn("user_company_roles", "company_id", companyId)).toBeGreaterThan(0);
    expect(await countIn("stock_items", "company_id", companyId)).toBeGreaterThan(0);
    expect(await countIn("user_security_permissions", "company_id", companyId)).toBeGreaterThan(0);
    expect(await countIn("user_activity_log", "company_id", companyId)).toBeGreaterThan(0);

    await authStorage.deleteCompany(companyId);

    expect(await authStorage.getCompanyById(companyId)).toBeUndefined();
    for (const table of [
      "vouchers",
      "locations",
      "ledger_accounts",
      "bank_accounts",
      "stock_items",
      "stock_groups",
      "inventory",
      "user_company_roles",
      "user_locations",
      "company_settings",
      "exchange_rates",
      "role_feature_permissions",
      "erp_user_page_access",
      "audit_log",
      "user_security_permissions",
      "user_activity_log",
    ]) {
      expect(await countIn(table, "company_id", companyId), `${table} still holds rows`).toBe(0);
    }
    // Child rows keyed to the voucher rather than the company must go too.
    expect(await countIn("voucher_entries", "voucher_id", voucherId)).toBe(0);
  }, 180_000);

  it("is safe to run against a company id that no longer exists", async () => {
    // Re-deleting is how a retried teardown behaves; it must not throw.
    await expect(authStorage.deleteCompany(2147481900)).resolves.toBeUndefined();
  }, 60_000);
});

describe("company and user records", () => {
  it("reads, updates and lists companies", async () => {
    const company = await authStorage.getCompanyById(ctx.companyId);
    expect(company?.id).toBe(ctx.companyId);

    const updated = await authStorage.updateCompany(ctx.companyId, { name: `${TEST_PREFIX}_Renamed` });
    expect(updated.name).toBe(`${TEST_PREFIX}_Renamed`);

    const all = await authStorage.getAllCompanies();
    expect(all.some((entry) => entry.id === ctx.companyId)).toBe(true);

    await authStorage.updateCompany(ctx.companyId, { name: `${TEST_PREFIX}_TestCompany` });
  }, 60_000);

  it("reads a user by id and by username, and updates them", async () => {
    const byId = await authStorage.getUser(ctx.userId);
    expect(byId?.username).toBe(`${TEST_PREFIX}_testuser`);

    const byName = await authStorage.getUserByUsername(`${TEST_PREFIX}_testuser`);
    expect(byName?.id).toBe(ctx.userId);

    expect(await authStorage.getUserByUsername(`${TEST_PREFIX}_no_such_user`)).toBeUndefined();

    const updated = await authStorage.updateUser(ctx.userId, { chatbotEnabled: true });
    expect(updated.chatbotEnabled).toBe(true);
    await authStorage.updateUser(ctx.userId, { chatbotEnabled: false });

    const all = await authStorage.getAllUsers();
    expect(all.some((entry) => entry.id === ctx.userId)).toBe(true);
  }, 60_000);

  it("carries a user's role for one company and not for another", async () => {
    const role = await authStorage.getUserCompanyRole(ctx.userId, ctx.companyId);
    expect(role?.companyId).toBe(ctx.companyId);

    expect(await authStorage.getUserCompanyRole(ctx.userId, 2147481900)).toBeUndefined();

    const roles = await authStorage.getUserCompaniesWithRoles(ctx.userId);
    expect(roles.map((entry) => entry.companyId)).toContain(ctx.companyId);
  }, 60_000);

  it("creates, updates and removes a company role assignment", async () => {
    const extraCompany = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type, active, base_currency)
       VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
      ["COLIFEX", `${TEST_PREFIX}_ExtraCompany`]
    );
    const extraCompanyId = extraCompany.rows[0].id;

    const created = await authStorage.createUserCompanyRole({
      userId: ctx.userId,
      companyId: extraCompanyId,
      role: "Normal User",
    });
    expect(created.role).toBe("Normal User");
    expect(await authStorage.getUserCompanyRole(ctx.userId, extraCompanyId)).toBeDefined();

    const updated = await authStorage.updateUserCompanyRole(created.id, { role: "Manager" });
    expect(updated.role).toBe("Manager");

    await authStorage.deleteUserCompanyRole(created.id);
    expect(await authStorage.getUserCompanyRole(ctx.userId, extraCompanyId)).toBeUndefined();

    await authStorage.deleteCompany(extraCompanyId);
  }, 120_000);
});

describe("system settings and the parent company", () => {
  it("inserts a setting the first time and updates it after that", async () => {
    const key = `${TEST_PREFIX}-setting`;
    const created = await authStorage.setSystemSetting(key, "first");
    expect(created.value).toBe("first");

    const updated = await authStorage.setSystemSetting(key, "second");
    expect(updated.id).toBe(created.id);
    expect(updated.value).toBe("second");

    expect((await authStorage.getSystemSetting(key))?.value).toBe("second");
    expect(await authStorage.getSystemSetting(`${TEST_PREFIX}-absent`)).toBeUndefined();

    await pool.query(`DELETE FROM system_settings WHERE key = $1`, [key]);
  }, 60_000);

  it("serves the parent company id from cache and invalidates it on write", async () => {
    const original = await authStorage.getParentCompanyId();
    try {
      await authStorage.setParentCompanyId(ctx.companyId);
      expect(await authStorage.getParentCompanyId()).toBe(ctx.companyId);

      // A second read comes from the in-memory cache and must agree.
      expect(await authStorage.getParentCompanyId()).toBe(ctx.companyId);

      // Writing through the setter clears the cache rather than leaving the
      // previous value to be served for another five minutes.
      await authStorage.setParentCompanyId(null);
      expect(await authStorage.getParentCompanyId()).toBeNull();
    } finally {
      await authStorage.setParentCompanyId(original);
    }
  }, 60_000);
});

describe("feature permissions and per-user access", () => {
  it("upserts a role feature flag rather than duplicating it", async () => {
    const created = await authStorage.upsertRoleFeaturePermission({
      companyId: ctx.companyId,
      role: "Manager",
      featureKey: `${TEST_PREFIX}-feature`,
      enabled: true,
    });
    expect(created.enabled).toBe(true);

    const flipped = await authStorage.upsertRoleFeaturePermission({
      companyId: ctx.companyId,
      role: "Manager",
      featureKey: `${TEST_PREFIX}-feature`,
      enabled: false,
    });
    expect(flipped.id).toBe(created.id);
    expect(flipped.enabled).toBe(false);

    const one = await authStorage.getRoleFeaturePermission(ctx.companyId, "Manager", `${TEST_PREFIX}-feature`);
    expect(one?.enabled).toBe(false);
    expect(
      await authStorage.getRoleFeaturePermission(ctx.companyId, "Manager", `${TEST_PREFIX}-absent`)
    ).toBeUndefined();

    const all = await authStorage.getRoleFeaturePermissions(ctx.companyId);
    expect(all.some((entry) => entry.featureKey === `${TEST_PREFIX}-feature`)).toBe(true);
  }, 60_000);

  it("applies a bulk permission change and treats an empty change as a no-op", async () => {
    expect(await authStorage.bulkUpsertRoleFeaturePermissions([])).toEqual([]);

    const results = await authStorage.bulkUpsertRoleFeaturePermissions([
      { companyId: ctx.companyId, role: "POS", featureKey: `${TEST_PREFIX}-bulk-1`, enabled: true },
      { companyId: ctx.companyId, role: "POS", featureKey: `${TEST_PREFIX}-bulk-2`, enabled: false },
    ]);
    expect(results).toHaveLength(2);

    const stored = await authStorage.getRoleFeaturePermissions(ctx.companyId);
    const bulk = stored.filter((entry) => entry.featureKey.startsWith(`${TEST_PREFIX}-bulk`));
    expect(bulk).toHaveLength(2);
    expect(bulk.find((entry) => entry.featureKey === `${TEST_PREFIX}-bulk-1`)?.enabled).toBe(true);
    expect(bulk.find((entry) => entry.featureKey === `${TEST_PREFIX}-bulk-2`)?.enabled).toBe(false);
  }, 60_000);

  it("replaces a user's page access rather than adding to it", async () => {
    await authStorage.setErpUserPageAccess(ctx.companyId, ctx.userId, ["dashboard", "vouchers"]);
    expect((await authStorage.getErpUserPageAccess(ctx.companyId, ctx.userId)).sort()).toEqual([
      "dashboard",
      "vouchers",
    ]);

    await authStorage.setErpUserPageAccess(ctx.companyId, ctx.userId, ["reports"]);
    expect(await authStorage.getErpUserPageAccess(ctx.companyId, ctx.userId)).toEqual(["reports"]);

    // Clearing is an empty list, not a delete call of its own.
    await authStorage.setErpUserPageAccess(ctx.companyId, ctx.userId, []);
    expect(await authStorage.getErpUserPageAccess(ctx.companyId, ctx.userId)).toEqual([]);
  }, 60_000);

  it("stores the cost fields a user may not see", async () => {
    expect(await authStorage.getErpUserHiddenCostFields(ctx.userId)).toEqual([]);

    await authStorage.setErpUserHiddenCostFields(ctx.userId, ["costPrice", "offloadingCost"]);
    expect(await authStorage.getErpUserHiddenCostFields(ctx.userId)).toEqual(["costPrice", "offloadingCost"]);

    // An unknown user has nothing hidden rather than an undefined list.
    expect(await authStorage.getErpUserHiddenCostFields("00000000-0000-0000-0000-000000000000")).toEqual([]);

    await authStorage.setErpUserHiddenCostFields(ctx.userId, []);
    expect(await authStorage.getErpUserHiddenCostFields(ctx.userId)).toEqual([]);
  }, 60_000);
});
