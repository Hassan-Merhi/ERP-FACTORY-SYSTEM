import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { companyStockValue } from "../../services/inventory/stockValuation";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import {
  stockItems,
  containers,
  bankAccounts,
  vouchers,
  voucherEntries,
  salesItems,
  employees,
  ledgerAccounts,
  userCompanyRoles,
  FEATURE_KEYS,
  salaryAdvances,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull, isNotNull, like } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, debitMinusCredit, sumMoney, toMoney } from "../../lib/money";

/** An opening balance signed for a debit-normal account: positive unless its side is not "Dr". */
const drOpening = (amount: string | null, side: string | null) =>
  (side || "Dr") === "Dr" ? toMoney(amount) : toMoney(amount).negated();
/** An opening balance signed for a credit-normal account: positive only when its side is "Cr". */
const crOpening = (amount: string | null, side: string | null) =>
  side === "Cr" ? toMoney(amount) : toMoney(amount).negated();

// Shared helper: compute the raw import cycle balance for a given company.
// Uses the identical formula as /api/stats/import-cycle-balance (without the stored equity adjustment).
// Shared by both the single-company and all-companies recalculate endpoints.
export async function computeRawBalance(companyId: number): Promise<number> {
  const getBalance = async (accountType: string, isLiability = false): Promise<Decimal> => {
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
    let total: Decimal = new MoneyDecimal(0);
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
      const movement = debitMinusCredit(entries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr })));
      total = total.plus(
        isLiability
          ? crOpening(acct.openingBalance, acct.openingBalanceSide).minus(movement)
          : drOpening(acct.openingBalance, acct.openingBalanceSide).plus(movement)
      );
    }
    return total;
  };

  const getTxBalance = async (accountType: string, isLiability = true): Promise<Decimal> => {
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
    const cr = toMoney(r[0]?.totalCredit);
    const dr = toMoney(r[0]?.totalDebit);
    return isLiability ? cr.minus(dr) : dr.minus(cr);
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
  const supplierOpeningTotal = sumMoney(
    allSuppliersRaw.filter((s) => activeSupplierIds.has(s.id)).map((sup) => sup.openingBalance)
  );
  const supplierBalance = supplierOpeningTotal.minus(
    debitMinusCredit(supplierEntries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr })))
  );

  const otwRows = await db
    .select({ grandTotal: containers.grandTotal })
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
  const stockOtwValue = sumMoney(otwRows.map((c) => c.grandTotal));

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
  const standaloneOpening = sumMoney(standaloneBankAccts.map((a) => drOpening(a.openingBalance, a.openingBalanceSide)));
  const standaloneVoucher = debitMinusCredit(
    standaloneBankEntries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr }))
  );
  const bankBalance = ledgerBankBalance.plus(standaloneOpening).plus(standaloneVoucher);

  const indirectExpenseBalance = await getBalance("Indirect Expense", false);
  const incomeBalance = await getBalance("Income", true);

  // Wave 11: the one stock valuation (stockValuation.ts, SUM(total_value)).
  const stockOnFloorValue = toMoney(await companyStockValue(db, companyId));

  const cogsRows = await db
    .select({ totalCost: salesItems.totalCost })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));
  const cogsBalance = sumMoney(cogsRows.map((i) => i.totalCost));

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
  let payrollExpenseBalance: Decimal = new MoneyDecimal(0);
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
    const openingTot = sumMoney(payrollAccts.map((a) => a.openingBalance));
    const txTot = debitMinusCredit(payrollEntries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr })));
    payrollExpenseBalance = openingTot.plus(txTot);
  }

  const advRows = await db
    .select({ remainingBalance: salaryAdvances.remainingBalance })
    .from(salaryAdvances)
    .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false)));
  const salaryAdvancesBalance = sumMoney(advRows.map((a) => a.remainingBalance));

  const empRows = await db
    .select({ currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  const payrollLiabilitiesBalance = sumMoney(empRows.map((e) => MoneyDecimal.max(toMoney(e.currentBalance), 0)));

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
  let totalDrOpenings: Decimal = new MoneyDecimal(0);
  let totalCrOpenings: Decimal = new MoneyDecimal(0);
  for (const a of allLedgerAccts) {
    const raw = toMoney(a.openingBalance);
    if (raw.isZero()) continue;
    if ((a.openingBalanceSide || "Dr") === "Dr") totalDrOpenings = totalDrOpenings.plus(raw);
    else totalCrOpenings = totalCrOpenings.plus(raw);
  }
  const empOpenings = await db
    .select({ openingBalance: employees.openingBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  totalCrOpenings = totalCrOpenings.plus(sumMoney(empOpenings.map((e) => e.openingBalance)));
  let openingBalanceEquity = totalCrOpenings.minus(totalDrOpenings);

  const stockItemOpenings = await db
    .select({ openingValue: stockItems.openingValue })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
  openingBalanceEquity = openingBalanceEquity.minus(sumMoney(stockItemOpenings.map((i) => i.openingValue)));

  const assets = sumMoney([
    stockOtwValue,
    cashBalance,
    bankBalance,
    stockOnFloorValue,
    assetBalance,
    indirectExpenseBalance,
    payrollExpenseBalance,
    governmentTaxesBalance,
    cogsBalance,
    salaryAdvancesBalance,
  ]);
  const liabilities = sumMoney([
    supplierBalance,
    dutyAgentBalance,
    transporterAgentBalance,
    loansBalance,
    liabilityBalance,
    profitBalance,
    equityTransactionBalance,
    apTransactionBalance,
    incomeBalance,
    payrollLiabilitiesBalance,
  ]).minus(openingBalanceEquity);
  // Cents, rounding halves toward +infinity as Math.round did.
  return assets.minus(liabilities).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_CEIL).toNumber();
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
      const visiblePageKeys = role === "Owner" ? pageKeys.filter((key) => key !== "analytics") : pageKeys;
      res.json({ pageKeys: visiblePageKeys, fullAccess: false, hiddenErpCostFields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── File Folders ──────────────────────────────────────────────
}
