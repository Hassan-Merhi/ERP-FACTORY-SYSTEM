/**
 * payrollRoutes: PayrollBonus endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { postEmployeeVoucherTx } from "./postEmployeeBatch";
import { erpRequestSourceId, pairLines, sessionPostingActor } from "../../services/accounting/erpVoucherPosting";
import {
  companies,
  employeeGroupMembers,
  employeeGroups,
  employees,
  locations,
  salesItems,
  vouchers,
} from "@shared/schema";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { moneyString, parseMoneyInput } from "../../lib/money";
import { registerPayrollBonusRoutesPart1 } from "./registerPayrollBonusRoutesPart1";
export { resolveBonusSalesCompanyId } from "./registerPayrollBonusRoutesPart1";

export interface BonusLocationOption {
  id: number;
  name: string;
  companyId: number;
  companyName: string;
  hasSales: boolean;
}

/**
 * Bonus location options for every company the user can access.
 *
 * The payroll UI cannot build this list from /api/locations: that route is
 * gated behind the inventory module and only knows location ownership, so a
 * company that sells at a location owned by another company (GC-LSHI) ends up
 * with an empty picker. Here each company keeps its owned locations and also
 * gains every location its own Sales vouchers reference.
 */
async function loadBonusLocationOptions(userId: string): Promise<BonusLocationOption[]> {
  const accessibleIds = Array.from(await getAccessibleCompanyIds(userId));
  if (accessibleIds.length === 0) return [];

  const companyRows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(inArray(companies.id, accessibleIds));
  const companyNameById = new Map(companyRows.map((company) => [company.id, company.name]));

  const locationRows = await db
    .select({ id: locations.id, name: locations.name, companyId: locations.companyId })
    .from(locations)
    .where(isNull(locations.deletedAt));
  const locationNameById = new Map(locationRows.map((location) => [location.id, location.name]));

  const salesRows = await db
    .selectDistinct({ companyId: vouchers.companyId, locationId: vouchers.locationId })
    .from(vouchers)
    .where(
      and(
        inArray(vouchers.companyId, accessibleIds),
        eq(vouchers.voucherType, "Sales"),
        isNull(vouchers.deletedAt),
        sql`${vouchers.locationId} IS NOT NULL`
      )
    );

  const byKey = new Map<string, BonusLocationOption>();
  const put = (companyId: number, locationId: number, hasSales: boolean) => {
    const name = locationNameById.get(locationId);
    const companyName = companyNameById.get(companyId);
    if (!name || !companyName) return;
    const key = `${companyId}|${locationId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.hasSales = existing.hasSales || hasSales;
      return;
    }
    byKey.set(key, { id: locationId, name, companyId, companyName, hasSales });
  };

  for (const location of locationRows) {
    if (companyNameById.has(location.companyId)) put(location.companyId, location.id, false);
  }
  for (const row of salesRows) {
    if (row.locationId != null) put(row.companyId, row.locationId, true);
  }

  return Array.from(byKey.values()).sort(
    (a, b) => a.companyName.localeCompare(b.companyName) || a.name.localeCompare(b.name)
  );
}

export function registerPayrollBonusRoutes(app: Express) {
  // Payroll - Location options for bonus rates and % bonuses
  app.get("/api/payroll/bonus-locations", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) return res.status(400).json({ message: "No company selected" });
      const userId = String(req.session.userId ?? req.user?.id ?? "");
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      return res.json({ locations: await loadBonusLocationOptions(userId) });
    } catch (error: unknown) {
      logger.error("[/api/payroll/bonus-locations]", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Payroll - Sales Summary for bonus calculation
  app.get("/api/payroll/sales-summary", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const sessionCompanyId = req.session.currentCompanyId;
      if (!sessionCompanyId) return res.status(400).json({ message: "No company selected" });
      const { locationId, startDate, endDate, sourceCompanyId } = req.query;
      if (!locationId || !startDate || !endDate) {
        return res.status(400).json({ message: "locationId, startDate, and endDate are required" });
      }
      const locId = parseInt(locationId as string);
      // Allow querying another company's sales if sourceCompanyId is provided
      const companyId = sourceCompanyId ? parseInt(sourceCompanyId as string) : sessionCompanyId;
      const conditions = [
        eq(vouchers.companyId, companyId),
        eq(vouchers.locationId, locId),
        eq(vouchers.voucherType, "Sales"),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
        eq(vouchers.isCreditSale, false),
        sql`${vouchers.voucherDate} >= ${startDate}`,
        sql`${vouchers.voucherDate} <= ${endDate}`,
      ];
      const result = await db
        .select({
          totalSalesAmount: sql<string>`COALESCE(SUM(${salesItems.totalSales}), 0)`,
          totalQuantity: sql<string>`COALESCE(SUM(${salesItems.quantity}), 0)`,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(and(...conditions));
      const loc = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, locId)).limit(1);
      return res.json({
        totalSalesAmount: result[0]?.totalSalesAmount ?? "0",
        totalQuantity: result[0]?.totalQuantity ?? "0",
        locationName: loc[0]?.name ?? "",
      });
    } catch (error: unknown) {
      logger.error("[/api/payroll/sales-summary]", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerPayrollBonusRoutesPart1(app);

  // Payroll - Employee Bonus
  app.post("/api/payroll/bonus-employee", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { employeeId, amount, date, notes } = req.body;

      if (!employeeId || !amount || !date) {
        return res.status(400).json({ message: "Employee, amount, and date are required" });
      }

      const parsedBonus = parseMoneyInput(amount);
      if (!parsedBonus || !parsedBonus.gt(0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }
      const bonusCents = moneyString(parsedBonus);

      // Get employee
      const [employee] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), eq(employees.companyId, req.session.currentCompanyId)));
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      // Look up the employee's group for per-group bonus expense splitting
      const bonusDepGroupRows = await db
        .select({ groupName: employeeGroups.name })
        .from(employeeGroupMembers)
        .innerJoin(employeeGroups, eq(employeeGroupMembers.employeeGroupId, employeeGroups.id))
        .where(
          and(
            eq(employeeGroupMembers.employeeId, employee.id),
            eq(employeeGroups.companyId, req.session.currentCompanyId!),
            eq(employeeGroups.active, true)
          )
        )
        .limit(1);
      const bonusSingleGrp = bonusDepGroupRows[0]?.groupName?.trim() || "__default__";
      const bonusSingleIsDefault = bonusSingleGrp === "__default__";
      const bonusSingleCode = bonusSingleIsDefault
        ? "BONUS_EXPENSE"
        : `BONUS_EXP_${bonusSingleGrp
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "_")
            .substring(0, 25)}`;
      const bonusSingleName = bonusSingleIsDefault ? "Bonus Expense" : `Bonus Expense - ${bonusSingleGrp}`;

      const bonusSingleAccounts = await storage.getAllLedgerAccounts(req.session.currentCompanyId);
      let bonusSingleAccount = bonusSingleAccounts.find((a: Record<string, unknown>) => a.code === bonusSingleCode);
      if (!bonusSingleAccount) {
        bonusSingleAccount = await storage.createLedgerAccount({
          companyId: req.session.currentCompanyId!,
          code: bonusSingleCode,
          name: bonusSingleName,
          accountType: "Indirect Expense",
          openingBalance: "0",
          active: true,
        });
      }

      // Phase 22 (B): Dr bonus expense / Cr employee through the central engine,
      // the employee balance moved from the posted lines in the same transaction.
      const requestSourceId = erpRequestSourceId(req);
      const voucher = await db.transaction(async (tx) => {
        const { voucher } = await postEmployeeVoucherTx(tx, {
          companyId: req.session.currentCompanyId!,
          voucherType: "Journal",
          voucherDate: date,
          description: notes || `Bonus for ${employee.firstName} ${employee.lastName}`,
          lines: pairLines(
            { ledgerAccountId: bonusSingleAccount.id },
            { employeeId: employee.id },
            bonusCents,
            "Bonus payment"
          ),
          source: { type: "employee-bonus", id: `${employee.id}:${requestSourceId}` },
          actor: sessionPostingActor(req, "Bonus payment"),
        });
        return voucher;
      });

      // Get updated employee balance
      const [updatedBonusEmployee] = await db.select().from(employees).where(eq(employees.id, employee.id));

      res.json({
        voucher,
        employee: updatedBonusEmployee || employee,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
