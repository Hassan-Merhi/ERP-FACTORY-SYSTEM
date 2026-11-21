// Extracted from ./bonuses.ts
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { locations, salesItems, vouchers } from "@shared/schema";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { sumMoney, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";

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

export function registerPayrollBonusRoutesPart1(app: Express) {
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
        const subtotals: Decimal[] = [];

        // Per-location bale rates (employee_bale_rates table) — flat $/bale
        const baleRates = await storage.getEmployeeBaleRates(emp.id, companyId);
        for (const entry of baleRates) {
          const rate = toMoney(entry.rate as string);
          if (!rate.gt(0) || !entry.locationId) continue;
          try {
            const srcId = (entry.sourceCompanyId as number | null) ?? companyId;
            const data = await querySales(entry.locationId as number, srcId);
            const qty = toMoney(data.totalQuantity);
            if (qty.gt(0)) {
              const sub = qty.times(rate);
              subtotals.push(sub);
              lines.push(`${qty} bales × $${rate} (${data.locationName}) = $${sub.toFixed(2)}`);
            }
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }

        // Per-location sales % rates (employee_bale_pct_rates table) — % of sales amount
        const balePctRates = await storage.getEmployeeBalePctRates(emp.id, companyId);
        for (const entry of balePctRates) {
          const pct = toMoney(entry.pct as string);
          if (!pct.gt(0) || !entry.locationId) continue;
          try {
            const srcId = (entry.sourceCompanyId as number | null) ?? companyId;
            const data = await querySales(entry.locationId as number, srcId);
            const sales = toMoney(data.totalSalesAmount);
            if (sales.gt(0)) {
              const sub = sales.times(pct).div(100);
              subtotals.push(sub);
              lines.push(`$${sales.toFixed(2)} sales × ${pct}% (${data.locationName}) = $${sub.toFixed(2)}`);
            }
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }

        // Legacy single bale rate field — only if no per-location rates
        if (baleRates.length === 0 && emp.balesBonusRate != null && toMoney(emp.balesBonusRate as string).gt(0)) {
          const locId = emp.salesBonusPctLocationId as number | null;
          const srcId = (emp.salesBonusPctSourceCompanyId as number | null) ?? companyId;
          if (locId) {
            try {
              const data = await querySales(locId, srcId);
              const qty = toMoney(data.totalQuantity);
              const rate = toMoney(emp.balesBonusRate as string);
              if (qty.gt(0)) {
                const sub = qty.times(rate);
                subtotals.push(sub);
                lines.push(`${qty} bales × $${rate} (${data.locationName}) = $${sub.toFixed(2)}`);
              }
            } catch {
              // Failure here is non-fatal and the surrounding flow continues deliberately.
            }
          }
        }

        // Legacy single-location sales % bonus (emp.salesBonusPct + pctLocationId from UI dropdown)
        if (pctSales && emp.salesBonusPct != null && toMoney(emp.salesBonusPct as string).gt(0)) {
          const sales = toMoney(pctSales.totalSalesAmount);
          const pct = toMoney(emp.salesBonusPct as string);
          if (sales.gt(0)) {
            const sub = sales.times(pct).div(100);
            subtotals.push(sub);
            lines.push(`$${sales.toFixed(2)} sales × ${pct}% (${pctSales.locationName}) = $${sub.toFixed(2)}`);
          }
        }

        const total = sumMoney(subtotals);
        if (total.gt(0)) {
          results.push({ employeeId: emp.id, amount: total.toFixed(2), breakdown: lines });
        }
      }

      return res.json({ results });
    } catch (error: unknown) {
      logger.error("[/api/payroll/auto-calculate-bonuses]", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
