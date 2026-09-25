/**
 * factoryDocsUsersRoutes: FactoryAnalytics endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryContainers,
  factoryRawStock,
  factoryBales,
  customers,
  containerSales,
  factoryPosSales,
} from "@shared/schema";
import { eq, and, desc, sql, ne } from "drizzle-orm";
import { serveAccountListForCompany } from "../../accounts/all";

export function registerFactoryAnalyticsRoutes(app: Express) {
  // Keep account balances pinned to the Factory company. Shared ERP account
  // endpoints intentionally follow currentCompanyId, which may point at a
  // different company when another browser tab switches ERP context.
  app.get("/api/factory/analytics/accounts", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    return serveAccountListForCompany(req, res, companyId);
  });

  // ── Factory Analytics: Sales by Customer ─────────────────────────────────
  app.get("/api/factory/analytics/sales-by-customer", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { startDate, endDate } = req.query as Record<string, string>;
      const conditions = [eq(containerSales.companyId, companyId)];
      if (startDate) conditions.push(sql`${containerSales.saleDate} >= ${startDate}`);
      if (endDate) conditions.push(sql`${containerSales.saleDate} <= ${endDate}`);

      const rows = await db
        .select({
          customerId: containerSales.customerId,
          customerName: customers.legalName,
          containers: sql<number>`COUNT(${containerSales.id})`,
          totalAmount: sql<string>`COALESCE(SUM(${containerSales.totalAmount}), '0')`,
          paidAmount: sql<string>`COALESCE(SUM(${containerSales.paidAmount}), '0')`,
        })
        .from(containerSales)
        .leftJoin(customers, eq(containerSales.customerId, customers.id))
        .where(and(...conditions))
        .groupBy(containerSales.customerId, customers.legalName)
        .orderBy(sql`SUM(${containerSales.totalAmount}) DESC`);

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Factory Analytics: POS Sales Summary (by customer + grand total) ─────
  app.get("/api/factory/analytics/pos-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { startDate, endDate } = req.query as Record<string, string>;
      const conditions = [eq(factoryPosSales.companyId, companyId), ne(factoryPosSales.status, "VOID")];
      if (startDate) conditions.push(sql`${factoryPosSales.txDate} >= ${startDate}`);
      if (endDate) conditions.push(sql`${factoryPosSales.txDate} <= ${endDate}`);

      // Aggregate POS sales by customer (customerId may be null = walk-in)
      const byCustomer = await db
        .select({
          customerId: factoryPosSales.customerId,
          customerName: sql<string>`COALESCE(${customers.legalName}, ${factoryPosSales.customerName}, 'Walk-in / Cash')`,
          sales: sql<number>`COUNT(${factoryPosSales.id})`,
          totalAmount: sql<string>`COALESCE(SUM(${factoryPosSales.totalAmount}), '0')`,
          depositAmount: sql<string>`COALESCE(SUM(${factoryPosSales.depositAmount}), '0')`,
          cashSales: sql<string>`COALESCE(SUM(CASE WHEN ${factoryPosSales.paymentType} = 'CASH' THEN ${factoryPosSales.totalAmount} ELSE 0 END), '0')`,
          creditSales: sql<string>`COALESCE(SUM(CASE WHEN ${factoryPosSales.paymentType} = 'CREDIT' THEN ${factoryPosSales.totalAmount} ELSE 0 END), '0')`,
        })
        .from(factoryPosSales)
        .leftJoin(customers, eq(factoryPosSales.customerId, customers.id))
        .where(and(...conditions))
        .groupBy(factoryPosSales.customerId, customers.legalName, factoryPosSales.customerName)
        .orderBy(sql`SUM(${factoryPosSales.totalAmount}) DESC`);

      // Grand total
      const [grand] = await db
        .select({
          sales: sql<number>`COUNT(${factoryPosSales.id})`,
          totalAmount: sql<string>`COALESCE(SUM(${factoryPosSales.totalAmount}), '0')`,
          depositAmount: sql<string>`COALESCE(SUM(${factoryPosSales.depositAmount}), '0')`,
          cashSales: sql<string>`COALESCE(SUM(CASE WHEN ${factoryPosSales.paymentType} = 'CASH' THEN ${factoryPosSales.totalAmount} ELSE 0 END), '0')`,
          creditSales: sql<string>`COALESCE(SUM(CASE WHEN ${factoryPosSales.paymentType} = 'CREDIT' THEN ${factoryPosSales.totalAmount} ELSE 0 END), '0')`,
        })
        .from(factoryPosSales)
        .where(and(...conditions));

      res.json({
        byCustomer,
        grand: grand ?? { sales: 0, totalAmount: "0", depositAmount: "0", cashSales: "0", creditSales: "0" },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Factory Analytics: Container Sales Report (loaded containers by customer) ──
  app.get("/api/factory/analytics/container-sales-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { startDate, endDate, customerId, paymentStatus } = req.query as Record<string, string>;

      const conditions = [eq(containerSales.companyId, companyId)];
      if (startDate) conditions.push(sql`${containerSales.saleDate} >= ${startDate}`);
      if (endDate) conditions.push(sql`${containerSales.saleDate} <= ${endDate}`);
      if (customerId && customerId !== "all") conditions.push(eq(containerSales.customerId, parseInt(customerId)));
      if (paymentStatus && paymentStatus !== "all") conditions.push(eq(containerSales.paymentStatus, paymentStatus));

      const rows = await db
        .select({
          id: containerSales.id,
          saleDate: containerSales.saleDate,
          invoiceNumber: containerSales.invoiceNumber,
          paymentStatus: containerSales.paymentStatus,
          totalAmount: containerSales.totalAmount,
          paidAmount: containerSales.paidAmount,
          containerNumber: factoryContainers.containerNumber,
          containerStatus: factoryContainers.status,
          customerId: containerSales.customerId,
          customerName: customers.legalName,
        })
        .from(containerSales)
        .leftJoin(factoryContainers, eq(containerSales.containerId, factoryContainers.id))
        .leftJoin(customers, eq(containerSales.customerId, customers.id))
        .where(and(...conditions))
        .orderBy(desc(containerSales.saleDate));

      const total = rows.reduce((sum, r) => sum + parseFloat(r.totalAmount || "0"), 0);
      const paid = rows.reduce((sum, r) => sum + parseFloat(r.paidAmount || "0"), 0);

      res.json({ rows, summary: { total, paid, outstanding: total - paid, count: rows.length } });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Factory Analytics: Stock Summary (opening + closing stock) ───────────
  app.get("/api/factory/analytics/stock-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Opening stock = total raw material received (cost basis)
      const [rawReceived] = await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg} * ${factoryRawStock.costPerKgUsd}), '0')`,
          totalKg: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg}), '0')`,
        })
        .from(factoryRawStock)
        .where(eq(factoryRawStock.companyId, companyId));

      // Closing stock = remaining raw material (not yet used) + bale stock in stock
      const [rawRemaining] = await db
        .select({
          remainingCost: sql<string>`COALESCE(SUM((${factoryRawStock.receivedKg} - ${factoryRawStock.usedKg}) * ${factoryRawStock.costPerKgUsd}), '0')`,
          remainingKg: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg} - ${factoryRawStock.usedKg}), '0')`,
        })
        .from(factoryRawStock)
        .where(eq(factoryRawStock.companyId, companyId));

      const [baleStock] = await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(${factoryBales.totalCost}), '0')`,
          totalWeightKg: sql<string>`COALESCE(SUM(${factoryBales.weightKg}), '0')`,
          count: sql<number>`COUNT(${factoryBales.id})`,
        })
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.status, "IN_STOCK")));

      const openingStock = parseFloat(rawReceived?.totalCost || "0");
      const closingRaw = parseFloat(rawRemaining?.remainingCost || "0");
      const closingBales = parseFloat(baleStock?.totalCost || "0");
      const closingStock = closingRaw + closingBales;

      res.json({
        openingStock,
        closingStock,
        detail: {
          rawReceived: { cost: openingStock, kg: parseFloat(rawReceived?.totalKg || "0") },
          rawRemaining: { cost: closingRaw, kg: parseFloat(rawRemaining?.remainingKg || "0") },
          balesInStock: {
            cost: closingBales,
            kg: parseFloat(baleStock?.totalWeightKg || "0"),
            count: baleStock?.count ?? 0,
          },
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
