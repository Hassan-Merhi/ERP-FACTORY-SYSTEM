import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import {
  inventory,
  stockItems,
  containers,
  bankAccounts,
  vouchers,
  voucherEntries,
  salesItems,
  locations,
  employees,
  ledgerAccounts,
  userCompanyRoles,
  FEATURE_KEYS,
  salaryAdvances,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull, isNotNull, like } from "drizzle-orm";

// Shared helper: compute the raw import cycle balance for a given company.
// Uses the identical formula as /api/stats/import-cycle-balance (without the stored equity adjustment).
// Shared by both the single-company and all-companies recalculate endpoints.
export async function computeRawBalance(companyId: number): Promise<number> {
  const getBalance = async (accountType: string, isLiability = false): Promise<number> => {
    const accts = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.accountType, accountType),
          isNull(ledgerAccounts.deletedAt)
        )
      );
    let total = 0;
    for (const acct of accts) {
      const entries = await db
        .select({ cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, acct.id),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false)
          )
        );
      const raw = parseFloat(acct.openingBalance || "0");
      const side = acct.openingBalanceSide || "Dr";
      const signedOpening = isLiability ? (side === "Cr" ? raw : -raw) : side === "Dr" ? raw : -raw;
      total += entries.reduce((s, e) => {
        const cr = parseFloat(e.cr || "0");
        const dr = parseFloat(e.dr || "0");
        return s + (isLiability ? cr - dr : dr - cr);
      }, signedOpening);
    }
    return total;
  };

  const getTxBalance = async (accountType: string, isLiability = true): Promise<number> => {
    const r = await db
      .select({
        totalCredit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS DECIMAL)), 0)`,
        totalDebit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount}  AS DECIMAL)), 0)`,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.accountType, accountType),
          isNull(ledgerAccounts.deletedAt),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      );
    const cr = parseFloat(r[0]?.totalCredit || "0");
    const dr = parseFloat(r[0]?.totalDebit || "0");
    return isLiability ? cr - dr : dr - cr;
  };

  const supplierEntries = await db
    .select({ supplierId: voucherEntries.supplierId, cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(
      and(
        isNotNull(voucherEntries.supplierId),
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false)
      )
    );
  const allSuppliersRaw = await storage.getAllSuppliers();
  const activeSupplierIds = new Set(supplierEntries.map((e) => e.supplierId).filter(Boolean));
  const coContainers = await db
    .select({ supplierId: containers.supplierId })
    .from(containers)
    .where(eq(containers.companyId, companyId));
  for (const c of coContainers) {
    if (c.supplierId) activeSupplierIds.add(c.supplierId);
  }
  const supplierOpeningTotal = allSuppliersRaw
    .filter((s) => activeSupplierIds.has(s.id))
    .reduce((s, sup) => s + parseFloat(sup.openingBalance || "0"), 0);
  const supplierBalance = supplierEntries.reduce(
    (s, e) => s + parseFloat(e.cr || "0") - parseFloat(e.dr || "0"),
    supplierOpeningTotal
  );

  const otwRows = await db
    .select({ grandTotal: containers.grandTotal })
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
  const stockOtwValue = otwRows.reduce((s, c) => s + parseFloat(c.grandTotal || "0"), 0);

  const dutyAgentBalance = await getBalance("Duty Agent", true);
  const transporterAgentBalance = await getBalance("Transporter Agent", true);
  const loansBalance = await getBalance("Loans", true);
  const cashBalance = await getBalance("Cash", false);

  const ledgerBankBalance = await getBalance("Bank", false);
  const standaloneBankEntries = await db
    .select({ cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .innerJoin(bankAccounts, eq(voucherEntries.bankAccountId, bankAccounts.id))
    .where(
      and(
        isNotNull(voucherEntries.bankAccountId),
        isNull(voucherEntries.ledgerAccountId),
        isNull(bankAccounts.linkedLedgerId),
        eq(bankAccounts.companyId, companyId),
        isNull(bankAccounts.deletedAt),
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false)
      )
    );
  const standaloneBankAccts = await db
    .select()
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt), isNull(bankAccounts.linkedLedgerId))
    );
  const standaloneOpening = standaloneBankAccts.reduce((s, a) => {
    const raw = parseFloat(a.openingBalance || "0");
    return s + ((a.openingBalanceSide || "Dr") === "Dr" ? raw : -raw);
  }, 0);
  const standaloneVoucher = standaloneBankEntries.reduce(
    (s, e) => s + parseFloat(e.dr || "0") - parseFloat(e.cr || "0"),
    0
  );
  const bankBalance = ledgerBankBalance + standaloneOpening + standaloneVoucher;

  const indirectExpenseBalance = await getBalance("Indirect Expense", false);
  const incomeBalance = await getBalance("Income", true);

  const invRows = await db
    .select({ quantity: inventory.quantity, averageRate: inventory.averageRate })
    .from(inventory)
    .innerJoin(locations, eq(inventory.locationId, locations.id))
    .where(and(eq(inventory.companyId, companyId), isNull(locations.deletedAt)));
  const stockOnFloorValue = invRows.reduce(
    (s, i) => s + parseFloat(i.quantity || "0") * parseFloat(i.averageRate || "0"),
    0
  );

  const cogsRows = await db
    .select({ totalCost: salesItems.totalCost })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));
  const cogsBalance = cogsRows.reduce((s, i) => s + parseFloat(i.totalCost || "0"), 0);

  const payrollAccts = await db
    .select({ id: ledgerAccounts.id, openingBalance: ledgerAccounts.openingBalance })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.accountType, "Expense"),
        sql`(${ledgerAccounts.name} ILIKE '%salary%' OR ${ledgerAccounts.name} ILIKE '%payroll%' OR ${ledgerAccounts.name} ILIKE '%wage%')`,
        isNull(ledgerAccounts.deletedAt)
      )
    );
  let payrollExpenseBalance = 0;
  if (payrollAccts.length > 0) {
    const payrollIds = payrollAccts.map((a) => a.id);
    const payrollEntries = await db
      .select({ cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(
          inArray(voucherEntries.ledgerAccountId, payrollIds),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      );
    const openingTot = payrollAccts.reduce((s, a) => s + parseFloat(a.openingBalance || "0"), 0);
    const txTot = payrollEntries.reduce((s, e) => s + parseFloat(e.dr || "0") - parseFloat(e.cr || "0"), 0);
    payrollExpenseBalance = openingTot + txTot;
  }

  const advRows = await db
    .select({ remainingBalance: salaryAdvances.remainingBalance })
    .from(salaryAdvances)
    .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false)));
  const salaryAdvancesBalance = advRows.reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);

  const empRows = await db
    .select({ currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  const payrollLiabilitiesBalance = empRows.reduce((s, e) => {
    const b = parseFloat(e.currentBalance || "0");
    return s + (b > 0 ? b : 0);
  }, 0);

  const assetBalance = await getBalance("Asset", false);
  const governmentTaxesBalance = await getBalance("Government Taxes", false);
  const liabilityBalance = await getBalance("Liability", true);
  const profitBalance = await getBalance("Profit", true);
  const equityTransactionBalance = await getTxBalance("Equity", true);
  const apTransactionBalance = await getTxBalance("Accounts Payable", true);

  const allLedgerAccts = await db
    .select({ openingBalance: ledgerAccounts.openingBalance, openingBalanceSide: ledgerAccounts.openingBalanceSide })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  let totalDrOpenings = 0;
  let totalCrOpenings = 0;
  for (const a of allLedgerAccts) {
    const raw = parseFloat(a.openingBalance || "0");
    if (raw === 0) continue;
    if ((a.openingBalanceSide || "Dr") === "Dr") totalDrOpenings += raw;
    else totalCrOpenings += raw;
  }
  const empOpenings = await db
    .select({ openingBalance: employees.openingBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  totalCrOpenings += empOpenings.reduce((s, e) => s + parseFloat(e.openingBalance || "0"), 0);
  let openingBalanceEquity = totalCrOpenings - totalDrOpenings;

  const stockItemOpenings = await db
    .select({ openingValue: stockItems.openingValue })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
  openingBalanceEquity -= stockItemOpenings.reduce((s, i) => s + parseFloat(i.openingValue || "0"), 0);

  return (
    Math.round(
      (stockOtwValue +
        cashBalance +
        bankBalance +
        stockOnFloorValue +
        assetBalance +
        indirectExpenseBalance +
        payrollExpenseBalance +
        governmentTaxesBalance +
        cogsBalance +
        salaryAdvancesBalance -
        (supplierBalance +
          dutyAgentBalance +
          transporterAgentBalance +
          loansBalance +
          liabilityBalance +
          profitBalance +
          equityTransactionBalance +
          apTransactionBalance +
          incomeBalance +
          payrollLiabilitiesBalance -
          openingBalanceEquity)) *
        100
    ) / 100
  );
}

export function registerUserManagementRoutes(app: Express) {
  app.get("/api/admin/legacy-employee-accounts", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all EMP-* ledger accounts (both active and soft-deleted)
      const allAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), like(ledgerAccounts.code, "EMP-%")));

      // For each account, get usage count in voucher entries
      const accountsWithUsage = await Promise.all(
        allAccounts.map(async (account) => {
          const entries = await db
            .select({ count: sql<number>`count(*)` })
            .from(voucherEntries)
            .where(eq(voucherEntries.ledgerAccountId, account.id));

          const usageCount = entries[0]?.count || 0;

          // Extract employee code from EMP-{code}
          const employeeCode = account.code.replace("EMP-", "");

          // Try to find matching employee in the same company
          const employee = await storage.getEmployeeByCode(employeeCode);
          const employeeInSameCompany = employee && employee.companyId === companyId ? employee : null;

          return {
            id: account.id,
            code: account.code,
            name: account.name,
            accountType: account.accountType,
            isDeleted: !!account.deletedAt,
            deletedAt: account.deletedAt,
            usageCount,
            employeeCode,
            employeeId: employeeInSameCompany?.id || null,
            employeeName: employeeInSameCompany
              ? `${employeeInSameCompany.firstName} ${employeeInSameCompany.lastName}`
              : null,
            canMigrate: !!employeeInSameCompany && usageCount > 0,
            canDelete: usageCount === 0,
          };
        })
      );

      res.json({
        accounts: accountsWithUsage,
        totalCount: accountsWithUsage.length,
        activeCount: accountsWithUsage.filter((a) => !a.isDeleted).length,
        withEntriesCount: accountsWithUsage.filter((a) => a.usageCount > 0).length,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Migrate voucher entries from EMP-* ledger account to use employeeId directly
  app.post("/api/admin/migrate-employee-account/:accountId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const accountId = parseInt(req.params.accountId);
      if (isNaN(accountId)) {
        return res.status(400).json({ message: "Invalid account ID" });
      }

      // Get the EMP-* account
      const account = await storage.getLedgerAccountById(accountId);
      if (!account) {
        return res.status(404).json({ message: "Account not found" });
      }
      if (!account.code || !account.code.startsWith("EMP-")) {
        return res.status(400).json({ message: "Not an EMP-* legacy account" });
      }
      if (account.companyId !== companyId) {
        return res.status(403).json({ message: "Account belongs to a different company" });
      }

      // Extract employee code and find matching employee in the same company
      const employeeCode = account.code.replace("EMP-", "");
      const employee = await storage.getEmployeeByCode(employeeCode);
      if (!employee) {
        return res.status(400).json({
          message: `Cannot migrate: No employee found with code "${employeeCode}"`,
        });
      }
      if (employee.companyId !== companyId) {
        return res.status(400).json({
          message: `Cannot migrate: Employee "${employeeCode}" belongs to a different company`,
        });
      }

      // Migrate all voucher entries from ledgerAccountId to employeeId
      const result = await db
        .update(voucherEntries)
        .set({
          ledgerAccountId: null,
          employeeId: employee.id,
        })
        .where(eq(voucherEntries.ledgerAccountId, accountId))
        .returning();

      // Soft-delete the EMP-* account since it's no longer needed
      await db
        .update(ledgerAccounts)
        .set({ deletedAt: new Date(), active: false })
        .where(eq(ledgerAccounts.id, accountId));

      res.json({
        message: `Migrated ${result.length} voucher entries from ${account.code} to employee ${employee.code}`,
        migratedCount: result.length,
        accountDeleted: true,
        employeeId: employee.id,
        employeeCode: employee.code,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk migrate and cleanup all EMP-* accounts for the current company
  app.post("/api/admin/cleanup-legacy-employee-accounts", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all active EMP-* ledger accounts
      const empAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            like(ledgerAccounts.code, "EMP-%"),
            isNull(ledgerAccounts.deletedAt)
          )
        );

      const results: Array<{
        accountCode: string;
        accountId: number;
        employeeCode: string;
        migratedEntries: number;
        status: "migrated" | "deleted" | "skipped";
        message: string;
      }> = [];

      for (const account of empAccounts) {
        const employeeCode = account.code.replace("EMP-", "");
        const employeeRaw = await storage.getEmployeeByCode(employeeCode);
        // Only use employee if in same company
        const employee = employeeRaw && employeeRaw.companyId === companyId ? employeeRaw : null;

        // Get voucher entries count for this account
        const entries = await db.select().from(voucherEntries).where(eq(voucherEntries.ledgerAccountId, account.id));

        if (entries.length === 0) {
          // No entries - just soft-delete the account
          await db
            .update(ledgerAccounts)
            .set({ deletedAt: new Date(), active: false })
            .where(eq(ledgerAccounts.id, account.id));

          results.push({
            accountCode: account.code,
            accountId: account.id,
            employeeCode,
            migratedEntries: 0,
            status: "deleted",
            message: "Account had no entries, soft-deleted",
          });
        } else if (employee) {
          // Has entries and matching employee - migrate then delete
          await db
            .update(voucherEntries)
            .set({
              ledgerAccountId: null,
              employeeId: employee.id,
            })
            .where(eq(voucherEntries.ledgerAccountId, account.id));

          await db
            .update(ledgerAccounts)
            .set({ deletedAt: new Date(), active: false })
            .where(eq(ledgerAccounts.id, account.id));

          results.push({
            accountCode: account.code,
            accountId: account.id,
            employeeCode,
            migratedEntries: entries.length,
            status: "migrated",
            message: `Migrated ${entries.length} entries to employee ${employee.code}`,
          });
        } else {
          // Has entries but no matching employee - skip
          results.push({
            accountCode: account.code,
            accountId: account.id,
            employeeCode,
            migratedEntries: 0,
            status: "skipped",
            message: `Skipped: No matching employee found for code "${employeeCode}"`,
          });
        }
      }

      const migrated = results.filter((r) => r.status === "migrated").length;
      const deleted = results.filter((r) => r.status === "deleted").length;
      const skipped = results.filter((r) => r.status === "skipped").length;

      res.json({
        message: `Cleanup complete: ${migrated} migrated, ${deleted} deleted, ${skipped} skipped`,
        results,
        summary: { migrated, deleted, skipped, total: results.length },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Recalculate Opening Balance Equity adjustment
  // Self-sufficient: computes rawBalance server-side so no body params are needed.

  app.get("/api/settings/role-permissions", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      // Allow Developer/Admin to query any company via ?companyId=N; others use session
      let companyId = req.session.currentCompanyId;
      if ((req.user?.role === "Developer" || req.user?.role === "Admin") && req.query.companyId) {
        companyId = parseInt(req.query.companyId as string);
      }
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const permissions = await storage.getRoleFeaturePermissions(companyId);
      res.json(permissions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update role permissions (bulk upsert)
  app.put("/api/settings/role-permissions", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { permissions } = req.body;
      if (!Array.isArray(permissions)) {
        return res.status(400).json({ message: "permissions must be an array" });
      }

      // Add companyId to each permission
      const permissionsWithCompany = permissions.map((p) => ({
        ...p,
        companyId,
      }));

      const results = await storage.bulkUpsertRoleFeaturePermissions(permissionsWithCompany);

      // Audit: log each permission change
      for (const p of permissions) {
        await logAudit({
          userId: req.user!.id,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "role_feature_permissions",
          recordId: null,
          recordIdentifier: `role:${p.role} feature:${p.featureKey} enabled:${p.enabled}`,
          changes: { enabled: { old: !p.enabled, new: p.enabled } },
        });
      }

      // Session invalidation: force affected users to re-login so new permissions take effect
      try {
        const affectedRoles = [...new Set(permissions.map((p) => p.role as string))];
        const affectedUsers = await db
          .select({ userId: userCompanyRoles.userId })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.companyId, companyId), inArray(userCompanyRoles.role, affectedRoles)));
        for (const u of affectedUsers) {
          await db.execute(sql`DELETE FROM session WHERE sess::jsonb ->> 'userId' = ${u.userId}`);
        }
      } catch (_err) {
        // Non-fatal — session table may not exist in all environments
      }

      res.json({ message: "Permissions updated successfully", permissions: results });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get permissions for the current user's role (used by sidebar)
  app.get("/api/my-permissions", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const role = req.session.currentRole;

      if (!companyId || !role) {
        return res.status(400).json({ message: "No company or role selected" });
      }

      // Get all permissions for this company and role
      const allPermissions = await storage.getRoleFeaturePermissions(companyId);
      const rolePermissions = allPermissions.filter((p) => p.role === role);

      res.json(rolePermissions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Test Data Import API (for testing Net Profit)
  // ==========================================

  // Create a test data voucher (Journal entry marked as optional with TEST- prefix)

  app.get("/api/erp-user-page-access/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const pageKeys = await storage.getErpUserPageAccess(companyId, req.params.userId);
      res.json({ pageKeys });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/erp-user-page-access/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { pageKeys } = req.body;
      if (!Array.isArray(pageKeys)) return res.status(400).json({ message: "pageKeys must be an array" });
      await storage.setErpUserPageAccess(companyId, req.params.userId, pageKeys);
      res.json({ message: "Page access updated", pageKeys });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/erp-user-hidden-costs/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const fields = await storage.getErpUserHiddenCostFields(req.params.userId);
      res.json({ hiddenCostFields: fields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/erp-user-hidden-costs/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { hiddenCostFields } = req.body;
      if (!Array.isArray(hiddenCostFields))
        return res.status(400).json({ message: "hiddenCostFields must be an array" });
      await storage.setErpUserHiddenCostFields(req.params.userId, hiddenCostFields);
      res.json({ message: "Cost visibility updated", hiddenCostFields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/my-erp-pages", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const role = req.session.currentRole;
      const userId = req.user?.id;
      if (!companyId || !role || !userId) return res.status(400).json({ message: "No company or role selected" });
      const hiddenErpCostFields = await storage.getErpUserHiddenCostFields(userId);
      if (role === "Admin" || role === "Developer") {
        return res.json({ pageKeys: [...FEATURE_KEYS], fullAccess: true, hiddenErpCostFields: [] });
      }
      const pageKeys = await storage.getErpUserPageAccess(companyId, userId);
      res.json({ pageKeys, fullAccess: false, hiddenErpCostFields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── File Folders ──────────────────────────────────────────────
}
