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
  customerOrders,
  customerOrderLines,
  locations,
} from "@shared/schema";
import { eq, and, desc, sql, ne, isNull, gte, lte } from "drizzle-orm";
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

  // ── Factory Analytics: Customer order item profitability ────────────────
  app.get("/api/factory/analytics/customer-order-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        startDate,
        endDate,
        item,
        customer,
        destination,
        location,
        status = "FINALIZED",
        profit = "all",
        page = "1",
        pageSize = "100",
      } = req.query as Record<string, string>;

      const conditions = [
        eq(customerOrders.companyId, companyId),
        isNull(customerOrders.deletedAt),
      ];

      if (status === "all") {
        conditions.push(sql`${customerOrders.status} IN ('VERIFIED', 'FINALIZED')`);
      } else if (status === "VERIFIED" || status === "FINALIZED") {
        conditions.push(eq(customerOrders.status, status));
      } else {
        return res.status(400).json({ message: "Invalid status filter" });
      }

      if (startDate) conditions.push(gte(customerOrders.orderDate, startDate));
      if (endDate) conditions.push(lte(customerOrders.orderDate, endDate));

      const normalizeSearch = (value: string) => value.toLowerCase().replace(/[.\s-]+/g, "").slice(0, 100);
      const itemSearch = item ? normalizeSearch(item) : "";
      if (itemSearch) {
        conditions.push(sql`
          regexp_replace(
            lower(COALESCE(${customerOrderLines.articleCode}, '') || COALESCE(${customerOrderLines.baleName}, '')),
            '[.\\s-]+',
            '',
            'g'
          ) LIKE ${`%${itemSearch}%`}
        `);
      }
      if (customer?.trim()) {
        conditions.push(sql`lower(COALESCE(${customers.legalName}, '')) LIKE ${`%${customer.trim().toLowerCase().slice(0, 100)}%`}`);
      }
      if (destination?.trim()) {
        conditions.push(sql`lower(COALESCE(${customerOrders.destination}, '')) LIKE ${`%${destination.trim().toLowerCase().slice(0, 100)}%`}`);
      }
      if (location?.trim()) {
        conditions.push(sql`lower(COALESCE(${locations.name}, '')) LIKE ${`%${location.trim().toLowerCase().slice(0, 100)}%`}`);
      }

      const rawRows = await db
        .select({
          orderId: customerOrders.id,
          invoiceNumber: customerOrders.invoiceNumber,
          orderDate: customerOrders.orderDate,
          status: customerOrders.status,
          customerId: customerOrders.customerId,
          customerName: customers.legalName,
          destination: customerOrders.destination,
          locationId: customerOrders.locationId,
          locationName: locations.name,
          articleCode: customerOrderLines.articleCode,
          itemName: sql<string>`MAX(${customerOrderLines.baleName})`,
          category: sql<string | null>`(
            SELECT MAX(fb.category)
            FROM factory_bales fb
            JOIN customer_order_bales cob ON cob.bale_id = fb.id
            WHERE cob.order_id = ${customerOrders.id}
              AND COALESCE(cob.article_code, fb.article_code) = ${customerOrderLines.articleCode}
              AND fb.company_id = ${companyId}
          )`,
          grade: sql<string | null>`(
            SELECT MAX(fb.grade)
            FROM factory_bales fb
            JOIN customer_order_bales cob ON cob.bale_id = fb.id
            WHERE cob.order_id = ${customerOrders.id}
              AND COALESCE(cob.article_code, fb.article_code) = ${customerOrderLines.articleCode}
              AND fb.company_id = ${companyId}
          )`,
          qty: sql<number>`COALESCE(SUM(${customerOrderLines.qty}), 0)::int`,
          totalWeightKg: sql<string>`COALESCE(SUM(${customerOrderLines.totalWeight}::numeric), 0)`,
          salesAmount: sql<string>`
            COALESCE(SUM(
              CASE
                WHEN ${customerOrderLines.pricingMode} = 'per_kg'
                  AND COALESCE(${customerOrderLines.pricePerKg}::numeric, 0) > 0
                THEN COALESCE(${customerOrderLines.pricePerKg}::numeric, 0)
                     * COALESCE(${customerOrderLines.totalWeight}::numeric, 0)
                ELSE COALESCE(${customerOrderLines.totalPrice}::numeric, 0)
              END
            ), 0)
          `,
          costAmount: sql<string>`COALESCE((
            SELECT SUM(COALESCE(fb.total_cost::numeric, 0))
            FROM customer_order_bales cob
            LEFT JOIN factory_bales fb
              ON fb.id = cob.bale_id
             AND fb.company_id = ${companyId}
            WHERE cob.order_id = ${customerOrders.id}
              AND COALESCE(cob.article_code, fb.article_code) = ${customerOrderLines.articleCode}
          ), 0)`,
        })
        .from(customerOrderLines)
        .innerJoin(customerOrders, eq(customerOrderLines.orderId, customerOrders.id))
        .leftJoin(customers, eq(customerOrders.customerId, customers.id))
        .leftJoin(locations, eq(customerOrders.locationId, locations.id))
        .where(and(...conditions))
        .groupBy(
          customerOrders.id,
          customerOrders.invoiceNumber,
          customerOrders.orderDate,
          customerOrders.status,
          customerOrders.customerId,
          customers.legalName,
          customerOrders.destination,
          customerOrders.locationId,
          locations.name,
          customerOrderLines.articleCode
        )
        .orderBy(desc(customerOrders.orderDate), desc(customerOrders.id), customerOrderLines.articleCode);

      const rows = rawRows.map((row) => {
        const qty = Number(row.qty || 0);
        const totalWeightKg = Number(row.totalWeightKg || 0);
        const salesAmount = Number(row.salesAmount || 0);
        const costAmount = Number(row.costAmount || 0);
        const profitAmount = salesAmount - costAmount;
        return {
          ...row,
          qty,
          totalWeightKg,
          salesAmount,
          costAmount,
          profitAmount,
          profitPct: salesAmount !== 0 ? (profitAmount / salesAmount) * 100 : 0,
          profitPerBale: qty !== 0 ? profitAmount / qty : 0,
          avgSellingPrice: qty !== 0 ? salesAmount / qty : 0,
          avgCostPerBale: qty !== 0 ? costAmount / qty : 0,
        };
      });

      const profitFilteredRows = rows.filter((row) => {
        if (profit === "profitable") return row.profitAmount > 0;
        if (profit === "loss") return row.profitAmount < 0;
        if (profit === "break-even") return Math.abs(row.profitAmount) < 0.005;
        return true;
      });

      const uniqueOrderIds = new Set(profitFilteredRows.map((row) => row.orderId));
      const uniqueCustomerIds = new Set(profitFilteredRows.map((row) => row.customerId));
      const summary = profitFilteredRows.reduce(
        (acc, row) => {
          acc.totalBales += row.qty;
          acc.totalWeightKg += row.totalWeightKg;
          acc.totalSales += row.salesAmount;
          acc.totalCost += row.costAmount;
          acc.grossProfit += row.profitAmount;
          return acc;
        },
        {
          totalOrders: uniqueOrderIds.size,
          uniqueCustomers: uniqueCustomerIds.size,
          totalBales: 0,
          totalWeightKg: 0,
          totalSales: 0,
          totalCost: 0,
          grossProfit: 0,
          marginPct: 0,
          avgProfitPerBale: 0,
        }
      );
      summary.marginPct = summary.totalSales !== 0 ? (summary.grossProfit / summary.totalSales) * 100 : 0;
      summary.avgProfitPerBale = summary.totalBales !== 0 ? summary.grossProfit / summary.totalBales : 0;

      const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
      const safePageSize = Math.min(250, Math.max(25, Number.parseInt(pageSize, 10) || 100));
      const totalRows = profitFilteredRows.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / safePageSize));
      const currentPage = Math.min(safePage, totalPages);
      const offset = (currentPage - 1) * safePageSize;

      res.json({
        summary,
        rows: profitFilteredRows.slice(offset, offset + safePageSize),
        pagination: {
          page: currentPage,
          pageSize: safePageSize,
          totalRows,
          totalPages,
        },
      });
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
