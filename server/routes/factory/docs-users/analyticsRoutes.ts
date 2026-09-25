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
import { resultRows } from "../../../lib/queryResult";
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

      if (!["FINALIZED", "VERIFIED", "all"].includes(status)) {
        return res.status(400).json({ message: "Invalid status filter" });
      }
      if (!["all", "profitable", "loss", "break-even"].includes(profit)) {
        return res.status(400).json({ message: "Invalid profit filter" });
      }

      const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
      const safePageSize = Math.min(250, Math.max(25, Number.parseInt(pageSize, 10) || 100));
      const offset = (safePage - 1) * safePageSize;

      const orderFilters = [
        sql`co.company_id = ${companyId}`,
        sql`co.deleted_at IS NULL`,
        status === "all" ? sql`co.status IN ('VERIFIED', 'FINALIZED')` : sql`co.status = ${status}`,
      ];
      if (startDate) orderFilters.push(sql`co.order_date >= ${startDate}`);
      if (endDate) orderFilters.push(sql`co.order_date <= ${endDate}`);
      if (customer?.trim()) {
        orderFilters.push(
          sql`lower(COALESCE(c.legal_name, '')) LIKE ${`%${customer.trim().toLowerCase().slice(0, 100)}%`}`
        );
      }
      if (destination?.trim()) {
        orderFilters.push(
          sql`lower(COALESCE(co.destination, '')) LIKE ${`%${destination.trim().toLowerCase().slice(0, 100)}%`}`
        );
      }
      if (location?.trim()) {
        orderFilters.push(sql`lower(COALESCE(l.name, '')) LIKE ${`%${location.trim().toLowerCase().slice(0, 100)}%`}`);
      }

      const normalizeSearch = (value: string) =>
        value
          .toLowerCase()
          .replace(/[.\s-]+/g, "")
          .slice(0, 100);
      const itemSearch = item ? normalizeSearch(item) : "";
      const lineFilter = itemSearch
        ? sql`regexp_replace(
            lower(COALESCE(col.article_code, '') || COALESCE(col.bale_name, '')),
            '[.\\s-]+',
            '',
            'g'
          ) LIKE ${`%${itemSearch}%`}`
        : sql`TRUE`;

      const profitFilter =
        profit === "profitable"
          ? sql`ir.profit_amount > 0`
          : profit === "loss"
            ? sql`ir.profit_amount < 0`
            : profit === "break-even"
              ? sql`ABS(ir.profit_amount) < 0.005`
              : sql`TRUE`;

      // Build order-level item totals first, then roll them up to one row per
      // article. Customer totals are kept separately for the Qty hover card.
      const queryResult = await db.execute(sql`
        WITH filtered_orders AS MATERIALIZED (
          SELECT
            co.id AS order_id,
            co.order_date,
            co.customer_id,
            c.legal_name AS customer_name
          FROM customer_orders co
          LEFT JOIN customers c ON c.id = co.customer_id
          LEFT JOIN locations l ON l.id = co.location_id
          WHERE ${sql.join(orderFilters, sql` AND `)}
        ),
        line_totals AS MATERIALIZED (
          SELECT
            fo.order_id,
            fo.order_date,
            fo.customer_id,
            fo.customer_name,
            col.article_code,
            MAX(col.bale_name) AS item_name,
            COALESCE(SUM(col.qty), 0)::int AS qty,
            COALESCE(SUM(col.total_weight::numeric), 0) AS total_weight_kg,
            COALESCE(SUM(
              CASE
                WHEN col.pricing_mode = 'per_kg'
                  AND COALESCE(col.price_per_kg::numeric, 0) > 0
                THEN COALESCE(col.price_per_kg::numeric, 0)
                     * COALESCE(col.total_weight::numeric, 0)
                ELSE COALESCE(col.total_price::numeric, 0)
              END
            ), 0) AS sales_amount
          FROM filtered_orders fo
          JOIN customer_order_lines col ON col.order_id = fo.order_id
          WHERE ${lineFilter}
          GROUP BY
            fo.order_id,
            fo.order_date,
            fo.customer_id,
            fo.customer_name,
            col.article_code
        ),
        bale_totals AS MATERIALIZED (
          SELECT
            cob.order_id,
            COALESCE(cob.article_code, fb.article_code) AS article_code,
            MAX(fb.category) AS category,
            MAX(fb.grade) AS grade,
            COALESCE(SUM(fb.total_cost::numeric), 0) AS cost_amount
          FROM customer_order_bales cob
          JOIN filtered_orders fo ON fo.order_id = cob.order_id
          LEFT JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = ${companyId}
          JOIN line_totals lt
            ON lt.order_id = cob.order_id
           AND lt.article_code = COALESCE(cob.article_code, fb.article_code)
          GROUP BY cob.order_id, COALESCE(cob.article_code, fb.article_code)
        ),
        analytics_rows AS MATERIALIZED (
          SELECT
            lt.*,
            bt.category,
            bt.grade,
            COALESCE(bt.cost_amount, 0) AS cost_amount,
            lt.sales_amount - COALESCE(bt.cost_amount, 0) AS profit_amount
          FROM line_totals lt
          LEFT JOIN bale_totals bt
            ON bt.order_id = lt.order_id
           AND bt.article_code = lt.article_code
        ),
        item_rows AS MATERIALIZED (
          SELECT
            ar.article_code,
            MAX(ar.item_name) AS item_name,
            MAX(ar.category) AS category,
            MAX(ar.grade) AS grade,
            MAX(ar.order_date) AS last_order_date,
            COALESCE(SUM(ar.qty), 0)::int AS qty,
            COALESCE(SUM(ar.total_weight_kg), 0) AS total_weight_kg,
            COALESCE(SUM(ar.sales_amount), 0) AS sales_amount,
            COALESCE(SUM(ar.cost_amount), 0) AS cost_amount,
            COALESCE(SUM(ar.profit_amount), 0) AS profit_amount
          FROM analytics_rows ar
          GROUP BY ar.article_code
        ),
        filtered_item_rows AS MATERIALIZED (
          SELECT ir.*
          FROM item_rows ir
          WHERE ${profitFilter}
        ),
        customer_totals AS MATERIALIZED (
          SELECT
            ar.article_code,
            ar.customer_id,
            ar.customer_name,
            COALESCE(SUM(ar.qty), 0)::int AS qty,
            COALESCE(SUM(ar.sales_amount), 0) AS sales_amount,
            COUNT(DISTINCT ar.order_id)::int AS orders
          FROM analytics_rows ar
          JOIN filtered_item_rows fir ON fir.article_code = ar.article_code
          GROUP BY ar.article_code, ar.customer_id, ar.customer_name
        ),
        customer_breakdowns AS MATERIALIZED (
          SELECT
            ct.article_code,
            COUNT(*)::int AS customer_count,
            jsonb_agg(
              jsonb_build_object(
                'customerId', ct.customer_id,
                'customerName', ct.customer_name,
                'qty', ct.qty,
                'salesAmount', ct.sales_amount,
                'orders', ct.orders
              )
              ORDER BY ct.qty DESC, ct.sales_amount DESC, ct.customer_name
            ) AS customer_breakdown
          FROM customer_totals ct
          GROUP BY ct.article_code
        )
        SELECT
          COALESCE((
            SELECT jsonb_build_object(
              'totalOrders', (
                SELECT COUNT(DISTINCT ar.order_id)
                FROM analytics_rows ar
                JOIN filtered_item_rows fir ON fir.article_code = ar.article_code
              ),
              'uniqueCustomers', (
                SELECT COUNT(DISTINCT ar.customer_id)
                FROM analytics_rows ar
                JOIN filtered_item_rows fir ON fir.article_code = ar.article_code
              ),
              'totalBales', COALESCE(SUM(fir.qty), 0),
              'totalWeightKg', COALESCE(SUM(fir.total_weight_kg), 0),
              'totalSales', COALESCE(SUM(fir.sales_amount), 0),
              'totalCost', COALESCE(SUM(fir.cost_amount), 0),
              'grossProfit', COALESCE(SUM(fir.profit_amount), 0)
            )
            FROM filtered_item_rows fir
          ), '{}'::jsonb) AS summary,
          COALESCE((
            SELECT jsonb_agg(row_to_json(paged))
            FROM (
              SELECT
                fir.article_code AS "articleCode",
                fir.item_name AS "itemName",
                fir.category,
                fir.grade,
                fir.last_order_date AS "orderDate",
                fir.qty,
                fir.total_weight_kg AS "totalWeightKg",
                fir.sales_amount AS "salesAmount",
                fir.cost_amount AS "costAmount",
                fir.profit_amount AS "profitAmount",
                COALESCE(cb.customer_count, 0) AS "customerCount",
                COALESCE(cb.customer_breakdown, '[]'::jsonb) AS "customerBreakdown"
              FROM filtered_item_rows fir
              LEFT JOIN customer_breakdowns cb ON cb.article_code = fir.article_code
              ORDER BY fir.sales_amount DESC, fir.qty DESC, fir.article_code
              LIMIT ${safePageSize}
              OFFSET ${offset}
            ) paged
          ), '[]'::jsonb) AS rows,
          (SELECT COUNT(*)::int FROM filtered_item_rows) AS total_rows
      `);

      type AggregateSummary = {
        totalOrders?: number | string;
        uniqueCustomers?: number | string;
        totalBales?: number | string;
        totalWeightKg?: number | string;
        totalSales?: number | string;
        totalCost?: number | string;
        grossProfit?: number | string;
      };
      type CustomerBreakdown = {
        customerId: number | null;
        customerName: string | null;
        qty: number | string;
        salesAmount: number | string;
        orders: number | string;
      };
      type AggregateRow = {
        articleCode: string;
        itemName: string;
        category: string | null;
        grade: string | null;
        orderDate: string;
        qty: number | string;
        totalWeightKg: number | string;
        salesAmount: number | string;
        costAmount: number | string;
        profitAmount: number | string;
        customerCount: number | string;
        customerBreakdown: CustomerBreakdown[] | null;
      };
      type AggregateResult = {
        summary: AggregateSummary | null;
        rows: AggregateRow[] | null;
        total_rows: number | string;
      };

      const [aggregate] = resultRows<AggregateResult>(queryResult);
      const rawSummary = aggregate?.summary ?? {};
      const totalRows = Number(aggregate?.total_rows ?? 0);
      const rows = (aggregate?.rows ?? []).map((row) => {
        const qty = Number(row.qty || 0);
        const totalWeightKg = Number(row.totalWeightKg || 0);
        const salesAmount = Number(row.salesAmount || 0);
        const costAmount = Number(row.costAmount || 0);
        const profitAmount = Number(row.profitAmount || 0);
        const customerBreakdown = (row.customerBreakdown ?? []).map((customerRow) => ({
          customerId: customerRow.customerId,
          customerName: customerRow.customerName,
          qty: Number(customerRow.qty || 0),
          salesAmount: Number(customerRow.salesAmount || 0),
          orders: Number(customerRow.orders || 0),
        }));
        return {
          ...row,
          qty,
          totalWeightKg,
          salesAmount,
          costAmount,
          profitAmount,
          customerCount: Number(row.customerCount || customerBreakdown.length),
          customerBreakdown,
          profitPct: salesAmount !== 0 ? (profitAmount / salesAmount) * 100 : 0,
          profitPerBale: qty !== 0 ? profitAmount / qty : 0,
          avgSellingPrice: qty !== 0 ? salesAmount / qty : 0,
          avgCostPerBale: qty !== 0 ? costAmount / qty : 0,
        };
      });

      const totalBales = Number(rawSummary.totalBales ?? 0);
      const totalSales = Number(rawSummary.totalSales ?? 0);
      const totalCost = Number(rawSummary.totalCost ?? 0);
      const grossProfit = Number(rawSummary.grossProfit ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalRows / safePageSize));

      res.json({
        summary: {
          totalOrders: Number(rawSummary.totalOrders ?? 0),
          uniqueCustomers: Number(rawSummary.uniqueCustomers ?? 0),
          totalBales,
          totalWeightKg: Number(rawSummary.totalWeightKg ?? 0),
          totalSales,
          totalCost,
          grossProfit,
          marginPct: totalSales !== 0 ? (grossProfit / totalSales) * 100 : 0,
          avgProfitPerBale: totalBales !== 0 ? grossProfit / totalBales : 0,
        },
        rows,
        pagination: {
          page: safePage,
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
