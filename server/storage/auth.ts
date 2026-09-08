import { eq, and, or, sql, asc, type SQL } from "drizzle-orm";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import * as schema from "@shared/schema";
import type { User, InsertUser, Company, InsertCompany, UserCompanyRole, InsertUserCompanyRole } from "@shared/schema";

// Users

export async function getUser(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return user;
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`LOWER(${schema.users.username}) = LOWER(${username})`);
  return user;
}

export async function createUser(insertUser: InsertUser): Promise<User> {
  const [user] = await db.insert(schema.users).values(insertUser).returning();
  return user;
}

export async function getAllUsers(): Promise<User[]> {
  return await db.select().from(schema.users).orderBy(asc(schema.users.username));
}

export async function updateUser(id: string, updates: Partial<InsertUser>): Promise<User> {
  const [user] = await db.update(schema.users).set(updates).where(eq(schema.users.id, id)).returning();
  return user;
}

export async function deleteUser(id: string): Promise<void> {
  await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.userId, id));
  await db.delete(schema.users).where(eq(schema.users.id, id));
}

export async function getUserCompanyRole(
  userId: string,
  companyId: number
): Promise<schema.UserCompanyRole | undefined> {
  const [role] = await db
    .select()
    .from(schema.userCompanyRoles)
    .where(and(eq(schema.userCompanyRoles.userId, userId), eq(schema.userCompanyRoles.companyId, companyId)));
  return role;
}

// Companies

export async function getAllCompanies(): Promise<Company[]> {
  return await db.select().from(schema.companies).orderBy(asc(schema.companies.name));
}

export async function getCompanyById(id: number): Promise<Company | undefined> {
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, id));
  return company;
}

export async function createCompany(company: InsertCompany): Promise<Company> {
  const [created] = await db.insert(schema.companies).values(company).returning();
  return created;
}

export async function updateCompany(id: number, updates: Partial<InsertCompany>): Promise<Company> {
  const [updated] = await db.update(schema.companies).set(updates).where(eq(schema.companies.id, id)).returning();
  return updated;
}

export async function deleteCompany(id: number): Promise<void> {
  // Each statement is a drizzle SQL fragment; tables that predate a migration
  // may not exist, which is the only error this swallows.
  const safe = async (query: SQL) => {
    try {
      await db.execute(query);
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "42P01" || getErrorMessage(e)?.includes("does not exist")) return;
      throw e;
    }
  };

  await safe(
    sql`DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM customer_order_lines WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM customer_orders WHERE company_id = ${id}`);
  await safe(
    sql`DELETE FROM customer_proforma_lines WHERE proforma_id IN (SELECT id FROM customer_proformas WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM customer_proformas WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM customer_invoice_sequences WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM credit_note_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ${id})`);

  await db.execute(
    sql`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ${id})`
  );
  await db.execute(sql`DELETE FROM sales_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ${id})`);
  await db.execute(
    sql`DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT stv.id FROM stock_transfer_vouchers stv JOIN vouchers v ON stv.voucher_id = v.id WHERE v.company_id = ${id})`
  );
  await db.execute(
    sql`DELETE FROM stock_transfer_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ${id})`
  );
  await db.execute(
    sql`DELETE FROM stock_adjustment_items WHERE adjustment_id IN (SELECT sav.id FROM stock_adjustment_vouchers sav JOIN vouchers v ON sav.voucher_id = v.id WHERE v.company_id = ${id})`
  );
  await db.execute(
    sql`DELETE FROM stock_adjustment_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ${id})`
  );
  await db.delete(schema.vouchers).where(eq(schema.vouchers.companyId, id));

  await safe(sql`DELETE FROM factory_bale_cost_snapshots WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_bale_photos WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_container_profit_snapshots WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_supplier_score_snapshots WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_daily_kpi_snapshots WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_alerts WHERE company_id = ${id}`);

  await safe(sql`DELETE FROM factory_waste_entries WHERE company_id = ${id}`);
  await safe(
    sql`DELETE FROM factory_daybook_entry_edits WHERE daybook_entry_id IN (SELECT id FROM factory_daybook_entries WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM factory_daybook_entries WHERE company_id = ${id}`);
  await safe(
    sql`DELETE FROM factory_worker_documents WHERE worker_id IN (SELECT id FROM factory_workers WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM factory_payrolls WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_workers WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_bales WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_pressing_batches WHERE company_id = ${id}`);
  await safe(
    sql`DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM factory_mix_batches WHERE company_id = ${id}`);

  await safe(
    sql`DELETE FROM factory_offload_additional_charges WHERE container_id IN (SELECT id FROM factory_containers WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM factory_container_commissions WHERE container_id IN (SELECT id FROM factory_containers WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM factory_duty_audit_log WHERE container_id IN (SELECT id FROM factory_containers WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM factory_raw_stock WHERE container_id IN (SELECT id FROM factory_containers WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM factory_containers WHERE company_id = ${id}`);

  await safe(sql`DELETE FROM factory_bale_sequences WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_bale_products WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_categories WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_fx_rates WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_suppliers WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_settings WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_user_profiles WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM factory_user_page_access WHERE company_id = ${id}`);

  await db.execute(
    sql`DELETE FROM draft_pos_sale_items WHERE draft_id IN (SELECT dps.id FROM draft_pos_sales dps JOIN locations l ON dps.location_id = l.id WHERE l.company_id = ${id})`
  );
  await db.execute(
    sql`DELETE FROM draft_pos_sales WHERE location_id IN (SELECT id FROM locations WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM pos_offline_queue WHERE shift_id IN (SELECT id FROM pos_shifts WHERE location_id IN (SELECT id FROM locations WHERE company_id = ${id}))`
  );
  await safe(sql`DELETE FROM pos_shifts WHERE location_id IN (SELECT id FROM locations WHERE company_id = ${id})`);

  await db.execute(
    sql`DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = ${id})`
  );
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.companyId, id));
  await safe(
    sql`DELETE FROM supplier_container_loaded_items WHERE container_id IN (SELECT id FROM containers WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM container_offload_items WHERE offload_id IN (SELECT co.id FROM container_offloads co WHERE co.container_id IN (SELECT id FROM containers WHERE company_id = ${id}))`
  );
  await db.execute(
    sql`DELETE FROM container_charges WHERE container_id IN (SELECT id FROM containers WHERE company_id = ${id})`
  );
  await db.execute(
    sql`DELETE FROM container_offloads WHERE container_id IN (SELECT id FROM containers WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM container_freight_payments WHERE freight_id IN (SELECT cf.id FROM container_freight cf WHERE cf.container_id IN (SELECT id FROM containers WHERE company_id = ${id}))`
  );
  await safe(
    sql`DELETE FROM container_freight WHERE container_id IN (SELECT id FROM containers WHERE company_id = ${id})`
  );
  await safe(
    sql`DELETE FROM container_documents WHERE container_id IN (SELECT id FROM containers WHERE company_id = ${id})`
  );
  await db.delete(schema.containers).where(eq(schema.containers.companyId, id));

  await db.delete(schema.inventory).where(eq(schema.inventory.companyId, id));
  await db.delete(schema.stockItemCodeAliases).where(eq(schema.stockItemCodeAliases.companyId, id));
  await db.execute(
    sql`DELETE FROM stock_item_location_prices WHERE stock_item_id IN (SELECT id FROM stock_items WHERE company_id = ${id})`
  );
  await db.delete(schema.stockItems).where(eq(schema.stockItems.companyId, id));
  await db.delete(schema.stockGroups).where(eq(schema.stockGroups.companyId, id));
  await safe(
    sql`DELETE FROM stock_group_location_archive_items WHERE archive_id IN (SELECT id FROM stock_group_location_archives WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM stock_group_location_archives WHERE company_id = ${id}`);

  await safe(
    sql`DELETE FROM mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM mix_batches WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM mix_batches WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM pressing_batches WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM production_raw_stock WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM production_bales WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM bale_label_prints WHERE company_id = ${id}`);
  await safe(
    sql`DELETE FROM bale_transfer_items WHERE transfer_id IN (SELECT id FROM bale_transfers WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM bale_transfers WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM bale_product_categories WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM bale_products WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM bale_sequences WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM bales WHERE company_id = ${id}`);

  await safe(
    sql`DELETE FROM salary_advance_deductions WHERE advance_id IN (SELECT id FROM salary_advances WHERE company_id = ${id})`
  );
  await db.delete(schema.salaryAdvances).where(eq(schema.salaryAdvances.companyId, id));
  await db.execute(
    sql`DELETE FROM employee_group_members WHERE employee_group_id IN (SELECT id FROM employee_groups WHERE company_id = ${id})`
  );
  await db.delete(schema.employeeGroups).where(eq(schema.employeeGroups.companyId, id));
  await db.delete(schema.employees).where(eq(schema.employees.companyId, id));

  await db.delete(schema.customerBalances).where(eq(schema.customerBalances.companyId, id));
  await db.delete(schema.customers).where(eq(schema.customers.companyId, id));
  await db.delete(schema.containerSales).where(eq(schema.containerSales.companyId, id));

  await safe(
    sql`DELETE FROM supplier_proforma_lines WHERE proforma_id IN (SELECT id FROM supplier_proformas WHERE company_id = ${id})`
  );
  await safe(sql`DELETE FROM supplier_proformas WHERE company_id = ${id}`);

  try {
    await db
      .delete(schema.interCompanyTransfers)
      .where(or(eq(schema.interCompanyTransfers.fromCompanyId, id), eq(schema.interCompanyTransfers.toCompanyId, id)));
  } catch (e: unknown) {
    if (!getErrorMessage(e)?.includes("does not exist")) throw e;
  }

  await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.companyId, id));
  await safe(sql`DELETE FROM user_locations WHERE company_id = ${id}`);

  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, id));
  await db.delete(schema.fixedAssets).where(eq(schema.fixedAssets.companyId, id));
  await db.delete(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.companyId, id));
  await db.delete(schema.locations).where(eq(schema.locations.companyId, id));
  await db.delete(schema.fiscalPeriodClosures).where(eq(schema.fiscalPeriodClosures.companyId, id));
  await db.delete(schema.dashboardCashAccounts).where(eq(schema.dashboardCashAccounts.companyId, id));
  await db.delete(schema.dashboardPayableAccounts).where(eq(schema.dashboardPayableAccounts.companyId, id));
  await safe(sql`DELETE FROM dashboard_account_selections WHERE company_id = ${id}`);
  await db.delete(schema.companySettings).where(eq(schema.companySettings.companyId, id));

  await safe(sql`DELETE FROM pending_barcodes WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM exchange_rates WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM reference_sequences WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM role_feature_permissions WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM login_history WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM stored_files WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM erp_user_page_access WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM audit_log WHERE company_id = ${id}`);
  await safe(sql`DELETE FROM user_presence WHERE company_id = ${id}`);

  await db.delete(schema.companies).where(eq(schema.companies.id, id));
}

// User-Company Roles

export async function getUserCompaniesWithRoles(userId: string): Promise<UserCompanyRole[]> {
  return await db.select().from(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.userId, userId));
}

export async function createUserCompanyRole(role: InsertUserCompanyRole): Promise<UserCompanyRole> {
  const [created] = await db.insert(schema.userCompanyRoles).values(role).returning();
  return created;
}

export async function updateUserCompanyRole(
  id: number,
  updates: Partial<InsertUserCompanyRole>
): Promise<UserCompanyRole> {
  const [updated] = await db
    .update(schema.userCompanyRoles)
    .set(updates)
    .where(eq(schema.userCompanyRoles.id, id))
    .returning();
  return updated;
}

export async function deleteUserCompanyRole(id: number): Promise<void> {
  await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.id, id));
}

// System Settings

export async function getSystemSetting(key: string): Promise<schema.SystemSetting | undefined> {
  const [setting] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
  return setting;
}

export async function setSystemSetting(key: string, value: string | null): Promise<schema.SystemSetting> {
  const existing = await getSystemSetting(key);
  if (existing) {
    const [updated] = await db
      .update(schema.systemSettings)
      .set({ value, updatedAt: sql`now()` })
      .where(eq(schema.systemSettings.key, key))
      .returning();
    return updated;
  } else {
    const [created] = await db.insert(schema.systemSettings).values({ key, value }).returning();
    return created;
  }
}

// 5-minute in-memory cache for the parent company ID setting.
let _parentCompanyIdCache: { value: number | null; expiresAt: number } | null = null;
const _PARENT_ID_TTL_MS = 5 * 60 * 1000;

export async function getParentCompanyId(): Promise<number | null> {
  const now = Date.now();
  if (_parentCompanyIdCache && now < _parentCompanyIdCache.expiresAt) {
    return _parentCompanyIdCache.value;
  }
  const setting = await getSystemSetting("parentCompanyId");
  const value = setting?.value ? parseInt(setting.value, 10) || null : null;
  _parentCompanyIdCache = { value, expiresAt: now + _PARENT_ID_TTL_MS };
  return value;
}

export async function setParentCompanyId(companyId: number | null): Promise<void> {
  _parentCompanyIdCache = null;
  await setSystemSetting("parentCompanyId", companyId?.toString() ?? null);
}

// Role Feature Permissions

export async function getRoleFeaturePermissions(companyId: number): Promise<schema.RoleFeaturePermission[]> {
  return await db
    .select()
    .from(schema.roleFeaturePermissions)
    .where(eq(schema.roleFeaturePermissions.companyId, companyId));
}

export async function getRoleFeaturePermission(
  companyId: number,
  role: string,
  featureKey: string
): Promise<schema.RoleFeaturePermission | undefined> {
  const [permission] = await db
    .select()
    .from(schema.roleFeaturePermissions)
    .where(
      and(
        eq(schema.roleFeaturePermissions.companyId, companyId),
        eq(schema.roleFeaturePermissions.role, role),
        eq(schema.roleFeaturePermissions.featureKey, featureKey)
      )
    );
  return permission;
}

export async function upsertRoleFeaturePermission(
  permission: schema.InsertRoleFeaturePermission
): Promise<schema.RoleFeaturePermission> {
  const [result] = await db
    .insert(schema.roleFeaturePermissions)
    .values(permission)
    .onConflictDoUpdate({
      target: [
        schema.roleFeaturePermissions.companyId,
        schema.roleFeaturePermissions.role,
        schema.roleFeaturePermissions.featureKey,
      ],
      set: {
        enabled: permission.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result;
}

export async function bulkUpsertRoleFeaturePermissions(
  permissions: schema.InsertRoleFeaturePermission[]
): Promise<schema.RoleFeaturePermission[]> {
  if (permissions.length === 0) return [];
  const results: schema.RoleFeaturePermission[] = [];
  for (const permission of permissions) {
    const result = await upsertRoleFeaturePermission(permission);
    results.push(result);
  }
  return results;
}

// ERP User Page Access

export async function getErpUserPageAccess(companyId: number, userId: string): Promise<string[]> {
  const rows = await db
    .select({ pageKey: schema.erpUserPageAccess.pageKey })
    .from(schema.erpUserPageAccess)
    .where(and(eq(schema.erpUserPageAccess.companyId, companyId), eq(schema.erpUserPageAccess.userId, userId)));
  return rows.map((r) => r.pageKey);
}

export async function setErpUserPageAccess(companyId: number, userId: string, pageKeys: string[]): Promise<void> {
  await db
    .delete(schema.erpUserPageAccess)
    .where(and(eq(schema.erpUserPageAccess.companyId, companyId), eq(schema.erpUserPageAccess.userId, userId)));
  if (pageKeys.length > 0) {
    await db.insert(schema.erpUserPageAccess).values(pageKeys.map((pageKey) => ({ companyId, userId, pageKey })));
  }
}

export async function getErpUserHiddenCostFields(userId: string): Promise<string[]> {
  const [user] = await db
    .select({ hiddenErpCostFields: schema.users.hiddenErpCostFields })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return user?.hiddenErpCostFields ?? [];
}

export async function setErpUserHiddenCostFields(userId: string, fields: string[]): Promise<void> {
  await db.update(schema.users).set({ hiddenErpCostFields: fields }).where(eq(schema.users.id, userId));
}
