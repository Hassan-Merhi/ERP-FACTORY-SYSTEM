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
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import {
  companies,
  employeeGroupMembers,
  employeeGroups,
  employees,
  locations,
  salesItems,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";

export interface BonusLocationOption {
  id: number;
  name: string;
  companyId: number;
  companyName: string;
  hasSales: boolean;
}

/**
 * Decides which company's sales feed a "% of sales" bonus for a picked location.
 *
 * Companies such as GC-LSHI post their sales against a location row owned by
 * another company, so the location's own `companyId` is the wrong source: it
 * would total the owning company's sales (or none at all) instead of the sales
 * of the company the payroll user is working in. Precedence is therefore the
 * company the UI explicitly paired with the location, then the active company
 * whenever it actually has sales there, and only then the location owner.
 */
export function resolveBonusSalesCompanyId(input: {
  explicitSourceCompanyId?: number | null;
  sessionCompanyId: number;
  locationOwnerCompanyId?: number | null;
  sessionCompanyHasSales: boolean;
}): number {
  const { explicitSourceCompanyId, sessionCompanyId, locationOwnerCompanyId, sessionCompanyHasSales } = input;
  if (explicitSourceCompanyId && explicitSourceCompanyId > 0) return explicitSourceCompanyId;
  if (sessionCompanyHasSales) return sessionCompanyId;
  return locationOwnerCompanyId && locationOwnerCompanyId > 0 ? locationOwnerCompanyId : sessionCompanyId;
}

async function hasSalesAtLocation(companyId: number, locationId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.locationId, locationId),
        eq(vouchers.voucherType, "Sales"),
        isNull(vouchers.deletedAt)
      )
    )
    .limit(1);
  return !!row;
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

  // Payroll - Auto-calculate bonuses server-side (single call instead of N×M client fetches)
  app.post("/api/payroll/auto-calculate-bonuses", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate, pctLocationId, pctSourceCompanyId } = req.body;
      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate are required" });

      // Fetch all active employees
      const allEmployees = await storage.getAllEmployees(companyId);
      const activeEmployees = allEmployees.filter((e: Record<string, unknown>) => e.status !== "inactive");

      // Cache sales queries by "companyId|locationId"
      const salesCache = new Map<string, { totalQuantity: string; totalSalesAmount: string; locationName: string }>();
      const querySales = async (locId: number, srcCompanyId: number) => {
        const cacheKey = `${srcCompanyId}|${locId}`;
        if (salesCache.has(cacheKey)) return salesCache.get(cacheKey)!;
        const conds = [
          eq(vouchers.companyId, srcCompanyId),
          eq(vouchers.locationId, locId),
          eq(vouchers.voucherType, "Sales"),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false),
          eq(vouchers.isCreditSale, false),
          sql`${vouchers.voucherDate} >= ${startDate}`,
          sql`${vouchers.voucherDate} <= ${endDate}`,
        ];
        const [result] = await db
          .select({
            totalSalesAmount: sql<string>`COALESCE(SUM(${salesItems.totalSales}), 0)`,
            totalQuantity: sql<string>`COALESCE(SUM(${salesItems.quantity}), 0)`,
          })
          .from(salesItems)
          .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
          .where(and(...conds));
        const [loc] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, locId)).limit(1);
        const entry = {
          totalQuantity: result?.totalQuantity ?? "0",
          totalSalesAmount: result?.totalSalesAmount ?? "0",
          locationName: loc?.name ?? "",
        };
        salesCache.set(cacheKey, entry);
        return entry;
      };

      // Prefetch pct location if provided
      let pctSales: { totalSalesAmount: string; locationName: string } | null = null;
      const pctLocId = pctLocationId ? parseInt(String(pctLocationId)) : NaN;
      if (Number.isInteger(pctLocId)) {
        try {
          const [locRow] = await db
            .select({ companyId: locations.companyId })
            .from(locations)
            .where(eq(locations.id, pctLocId))
            .limit(1);
          const requestedSourceCompanyId = pctSourceCompanyId ? parseInt(String(pctSourceCompanyId)) : null;
          // A caller-supplied company never widens access: it is honoured only
          // when the user is already assigned to it.
          const accessibleCompanyIds = await getAccessibleCompanyIds(String(req.session.userId ?? req.user?.id ?? ""));
          const explicitSourceCompanyId =
            requestedSourceCompanyId && accessibleCompanyIds.has(requestedSourceCompanyId)
              ? requestedSourceCompanyId
              : null;
          // The active company keeps priority over the location owner so a
          // company selling at a location it does not own (GC-LSHI) totals its
          // own sales instead of the owner's.
          const sessionCompanyHasSales = !explicitSourceCompanyId && (await hasSalesAtLocation(companyId, pctLocId));
          const pctCompanyId = resolveBonusSalesCompanyId({
            explicitSourceCompanyId,
            sessionCompanyId: companyId,
            locationOwnerCompanyId: locRow?.companyId ?? null,
            sessionCompanyHasSales,
          });
          pctSales = await querySales(pctLocId, pctCompanyId);
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }

      const results: Array<{ employeeId: number; amount: string; breakdown: string[] }> = [];

      for (const emp of activeEmployees) {
        const lines: string[] = [];
        let total = 0;

        // Per-location bale rates (employee_bale_rates table) — flat $/bale
        const baleRates = await storage.getEmployeeBaleRates(emp.id, companyId);
        for (const entry of baleRates) {
          const rate = parseFloat(entry.rate as string);
          if (!rate || rate <= 0 || !entry.locationId) continue;
          try {
            const srcId = (entry.sourceCompanyId as number | null) ?? companyId;
            const data = await querySales(entry.locationId as number, srcId);
            const qty = parseFloat(data.totalQuantity);
            if (qty > 0) {
              const sub = qty * rate;
              total += sub;
              lines.push(`${qty} bales × $${rate} (${data.locationName}) = $${sub.toFixed(2)}`);
            }
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }

        // Per-location sales % rates (employee_bale_pct_rates table) — % of sales amount
        const balePctRates = await storage.getEmployeeBalePctRates(emp.id, companyId);
        for (const entry of balePctRates) {
          const pct = parseFloat(entry.pct as string);
          if (!pct || pct <= 0 || !entry.locationId) continue;
          try {
            const srcId = (entry.sourceCompanyId as number | null) ?? companyId;
            const data = await querySales(entry.locationId as number, srcId);
            const sales = parseFloat(data.totalSalesAmount);
            if (sales > 0) {
              const sub = (sales * pct) / 100;
              total += sub;
              lines.push(`$${sales.toFixed(2)} sales × ${pct}% (${data.locationName}) = $${sub.toFixed(2)}`);
            }
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }

        // Legacy single bale rate field — only if no per-location rates
        if (baleRates.length === 0 && emp.balesBonusRate != null && parseFloat(emp.balesBonusRate as string) > 0) {
          const locId = emp.salesBonusPctLocationId as number | null;
          const srcId = (emp.salesBonusPctSourceCompanyId as number | null) ?? companyId;
          if (locId) {
            try {
              const data = await querySales(locId, srcId);
              const qty = parseFloat(data.totalQuantity);
              const rate = parseFloat(emp.balesBonusRate as string);
              if (qty > 0) {
                const sub = qty * rate;
                total += sub;
                lines.push(`${qty} bales × $${rate} (${data.locationName}) = $${sub.toFixed(2)}`);
              }
            } catch {
              // Failure here is non-fatal and the surrounding flow continues deliberately.
            }
          }
        }

        // Legacy single-location sales % bonus (emp.salesBonusPct + pctLocationId from UI dropdown)
        if (pctSales && emp.salesBonusPct != null && parseFloat(emp.salesBonusPct as string) > 0) {
          const sales = parseFloat(pctSales.totalSalesAmount);
          const pct = parseFloat(emp.salesBonusPct as string);
          if (sales > 0) {
            const sub = (sales * pct) / 100;
            total += sub;
            lines.push(`$${sales.toFixed(2)} sales × ${pct}% (${pctSales.locationName}) = $${sub.toFixed(2)}`);
          }
        }

        if (total > 0) {
          results.push({ employeeId: emp.id, amount: total.toFixed(2), breakdown: lines });
        }
      }

      return res.json({ results });
    } catch (error: unknown) {
      logger.error("[/api/payroll/auto-calculate-bonuses]", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

      const bonusAmount = parseFloat(amount);
      if (isNaN(bonusAmount) || bonusAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      // Get employee
      const [employee] = await db.select().from(employees).where(eq(employees.id, employeeId));
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

      // Create voucher
      const voucherNumber = `BONUS-${Date.now()}`;
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId: req.session.currentCompanyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: date,
          description: notes || `Bonus for ${employee.firstName} ${employee.lastName}`,
          totalAmount: bonusAmount.toFixed(2),
        })
        .returning();

      // Create voucher entries (double-entry)
      // Debit: Bonus Expense - {Group} (or Bonus Expense for ungrouped)
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: bonusSingleAccount.id,
        debitAmount: bonusAmount.toFixed(2),
        creditAmount: "0",
        narration: `Bonus payment - ${voucherNumber}`,
      });

      // Credit: Employee (using employeeId field directly instead of separate ledger account)
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: null,
        employeeId: employee.id,
        debitAmount: "0",
        creditAmount: bonusAmount.toFixed(2),
        narration: `Bonus payment - ${voucherNumber}`,
      });

      // Sync employee balance from voucher entries (instead of direct update)
      await syncEmployeeBalancesFromEntries(
        [
          {
            ledgerAccountId: null,
            employeeId: employee.id,
            debitAmount: "0",
            creditAmount: bonusAmount.toFixed(2),
          },
        ],
        req.session.currentCompanyId!
      );

      // Get updated employee balance
      const [updatedBonusEmployee] = await db.select().from(employees).where(eq(employees.id, employeeId));

      res.json({
        voucher,
        employee: updatedBonusEmployee || employee,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
