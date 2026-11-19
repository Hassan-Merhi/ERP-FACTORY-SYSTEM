// Extracted from ./analyticsRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";

export function registerFactoryAnalyticsRoutesPart2(app: Express) {
  // ── Factory Analytics: Customer orders grouped by customer ──────────────
  app.get("/api/factory/analytics/customer-orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        startDate,
        endDate,
        item,
        customer,
        destination,
        destinationExact,
        location,
        status = "all",
        includeCharges = "false",
        page = "1",
        pageSize = "50",
      } = req.query as Record<string, string>;

      if (!["LOADING", "VERIFIED", "FINALIZED", "VERIFIED_FINALIZED", "all"].includes(status)) {
        return res.status(400).json({ message: "Invalid status filter" });
      }
      if (!["true", "false"].includes(includeCharges)) {
        return res.status(400).json({ message: "Invalid includeCharges filter" });
      }

      const includeOrderCharges = includeCharges === "true";
      const orderChargesSql = includeOrderCharges
        ? sql`COALESCE(MAX(co.freight_amount::numeric), 0) + COALESCE(MAX(co.other_charges_total::numeric), 0)`
        : sql`0`;

      const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
      const safePageSize = Math.min(100, Math.max(10, Number.parseInt(pageSize, 10) || 50));
      const offset = (safePage - 1) * safePageSize;

      const orderFilters = [
        sql`co.company_id = ${companyId}`,
        sql`co.deleted_at IS NULL`,
        status === "all"
          ? sql`co.status IN ('LOADING', 'VERIFIED', 'FINALIZED')`
          : status === "VERIFIED_FINALIZED"
            ? sql`co.status IN ('VERIFIED', 'FINALIZED')`
            : sql`co.status = ${status}`,
      ];
      // The date selected at Validate Loading is the authoritative completion date.
      // Status changes and later accounting/verification entries must not move
      // this order into a different analytics period. Preserve the legacy
      // fallback for direct (non-loading) invoices without a loading date.
      const officialOrderDate = sql`CASE
        WHEN co.loading_finalized_at IS NOT NULL THEN co.loading_finalized_at::date
        WHEN co.status = 'FINALIZED' THEN COALESCE((
          SELECT fde.tx_date::date
          FROM factory_daybook_entries fde
          WHERE fde.company_id = co.company_id
            AND fde.reference_table = 'customer_orders'
            AND fde.reference_id = co.id
            AND fde.tx_type = 'ORDER_VERIFIED'
          ORDER BY fde.created_at DESC
          LIMIT 1
        ), co.finalized_at::date, co.verified_at::date, co.order_date)
        WHEN co.status = 'VERIFIED' THEN COALESCE((
          SELECT fde.tx_date::date
          FROM factory_daybook_entries fde
          WHERE fde.company_id = co.company_id
            AND fde.reference_table = 'customer_orders'
            AND fde.reference_id = co.id
            AND fde.tx_type = 'ORDER_VERIFIED'
          ORDER BY fde.created_at DESC
          LIMIT 1
        ), co.verified_at::date, co.order_date)
        ELSE co.order_date
      END`;
      if (startDate) orderFilters.push(sql`${officialOrderDate} >= ${startDate}`);
      if (endDate) orderFilters.push(sql`${officialOrderDate} <= ${endDate}`);
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
      if (itemSearch) {
        orderFilters.push(sql`EXISTS (
          SELECT 1
          FROM customer_order_lines col_filter
          WHERE col_filter.order_id = co.id
            AND regexp_replace(
              lower(COALESCE(col_filter.article_code, '') || COALESCE(col_filter.bale_name, '')),
              '[.\\s-]+',
              '',
              'g'
            ) LIKE ${`%${itemSearch}%`}
        )`);
      }

      // Populate the dropdown from the current company, period and status even
      // when a particular destination is selected. Existing fuzzy destination
      // search semantics are preserved for other API consumers.
      const availableDestinationFilters = [...orderFilters];
      if (destinationExact?.trim()) {
        orderFilters.push(
          sql`LOWER(BTRIM(COALESCE(co.destination, ''))) = ${destinationExact.trim().toLowerCase().slice(0, 100)}`
        );
      }

      const queryResult = await db.execute(sql`
        WITH available_destinations AS MATERIALIZED (
          SELECT DISTINCT BTRIM(co.destination) AS destination
          FROM customer_orders co
          LEFT JOIN customers c ON c.id = co.customer_id AND c.company_id = co.company_id
          LEFT JOIN locations l ON l.id = co.location_id
          WHERE ${sql.join(availableDestinationFilters, sql` AND `)}
            AND NULLIF(BTRIM(co.destination), '') IS NOT NULL
        ),
        filtered_orders AS MATERIALIZED (
          SELECT
            co.id AS order_id,
            ${officialOrderDate} AS order_date,
            co.customer_id,
            COALESCE(c.legal_name, 'Unknown customer') AS customer_name,
            co.invoice_number,
            co.container_number,
            co.destination,
            co.status,
            COALESCE(SUM(col.qty), 0)::int AS total_bales,
            COALESCE(SUM(col.total_weight::numeric), 0) AS total_weight_kg,
            COALESCE(SUM(
              CASE
                WHEN col.pricing_mode = 'per_kg'
                  AND COALESCE(col.price_per_kg::numeric, 0) > 0
                THEN COALESCE(col.price_per_kg::numeric, 0)
                     * COALESCE(col.total_weight::numeric, 0)
                ELSE COALESCE(col.total_price::numeric, 0)
              END
            ), 0) + ${orderChargesSql} AS invoice_total
          FROM customer_orders co
          LEFT JOIN customers c ON c.id = co.customer_id AND c.company_id = co.company_id
          LEFT JOIN locations l ON l.id = co.location_id
          LEFT JOIN customer_order_lines col ON col.order_id = co.id
          WHERE ${sql.join(orderFilters, sql` AND `)}
          GROUP BY
            co.id,
            co.order_date,
            co.customer_id,
            c.legal_name,
            co.invoice_number,
            co.container_number,
            co.destination,
            co.status
        ),
        customer_rows AS MATERIALIZED (
          SELECT
            fo.customer_id,
            MAX(fo.customer_name) AS customer_name,
            COUNT(*)::int AS invoice_count,
            COALESCE(SUM(fo.total_bales), 0)::int AS total_bales,
            COALESCE(SUM(fo.total_weight_kg), 0) AS total_weight_kg,
            COALESCE(SUM(fo.invoice_total), 0) AS invoice_total,
            MAX(fo.order_date) AS latest_order_date
          FROM filtered_orders fo
          GROUP BY fo.customer_id
        ),
        paged_customers AS MATERIALIZED (
          SELECT *
          FROM customer_rows
          ORDER BY invoice_total DESC, latest_order_date DESC, customer_name
          LIMIT ${safePageSize}
          OFFSET ${offset}
        )
        SELECT
          COALESCE((
            SELECT jsonb_agg(destination ORDER BY LOWER(destination), destination)
            FROM available_destinations
          ), '[]'::jsonb) AS destinations,
          jsonb_build_object(
            'totalOrders', (SELECT COUNT(*)::int FROM filtered_orders),
            'uniqueCustomers', (SELECT COUNT(*)::int FROM customer_rows),
            'totalBales', COALESCE((SELECT SUM(total_bales) FROM filtered_orders), 0),
            'totalWeightKg', COALESCE((SELECT SUM(total_weight_kg) FROM filtered_orders), 0),
            'totalInvoiceAmount', COALESCE((SELECT SUM(invoice_total) FROM filtered_orders), 0)
          ) AS summary,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'customerId', pc.customer_id,
                'customerName', pc.customer_name,
                'invoiceCount', pc.invoice_count,
                'totalBales', pc.total_bales,
                'totalWeightKg', pc.total_weight_kg,
                'invoiceTotal', pc.invoice_total,
                'latestOrderDate', pc.latest_order_date,
                'orders', COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'orderId', fo.order_id,
                      'invoiceNumber', fo.invoice_number,
                      'containerNumber', fo.container_number,
                      'destination', fo.destination,
                      'status', fo.status,
                      'orderDate', fo.order_date,
                      'totalBales', fo.total_bales,
                      'totalWeightKg', fo.total_weight_kg,
                      'invoiceTotal', fo.invoice_total
                    )
                    ORDER BY fo.order_date DESC, fo.order_id DESC
                  )
                  FROM filtered_orders fo
                  WHERE fo.customer_id IS NOT DISTINCT FROM pc.customer_id
                ), '[]'::jsonb)
              )
              ORDER BY pc.invoice_total DESC, pc.latest_order_date DESC, pc.customer_name
            )
            FROM paged_customers pc
          ), '[]'::jsonb) AS rows,
          (SELECT COUNT(*)::int FROM customer_rows) AS total_rows
      `);

      type CustomerOrderSummary = {
        totalOrders?: number | string;
        uniqueCustomers?: number | string;
        totalBales?: number | string;
        totalWeightKg?: number | string;
        totalInvoiceAmount?: number | string;
      };
      type CustomerOrderInvoice = {
        orderId: number | string;
        invoiceNumber: string | null;
        containerNumber: string | null;
        destination: string | null;
        status: string;
        orderDate: string;
        totalBales: number | string;
        totalWeightKg: number | string;
        invoiceTotal: number | string;
      };
      type CustomerOrderCustomer = {
        customerId: number | null;
        customerName: string;
        invoiceCount: number | string;
        totalBales: number | string;
        totalWeightKg: number | string;
        invoiceTotal: number | string;
        latestOrderDate: string;
        orders: CustomerOrderInvoice[] | null;
      };
      type CustomerOrderAggregate = {
        summary: CustomerOrderSummary | null;
        destinations: string[] | null;
        rows: CustomerOrderCustomer[] | null;
        total_rows: number | string;
      };

      const [aggregate] = resultRows<CustomerOrderAggregate>(queryResult);
      const rawSummary = aggregate?.summary ?? {};
      const totalRows = Number(aggregate?.total_rows ?? 0);
      const rows = (aggregate?.rows ?? []).map((customerRow) => ({
        customerId: customerRow.customerId,
        customerName: customerRow.customerName,
        invoiceCount: Number(customerRow.invoiceCount || 0),
        totalBales: Number(customerRow.totalBales || 0),
        totalWeightKg: Number(customerRow.totalWeightKg || 0),
        invoiceTotal: Number(customerRow.invoiceTotal || 0),
        latestOrderDate: customerRow.latestOrderDate,
        orders: (customerRow.orders ?? []).map((order) => ({
          orderId: Number(order.orderId),
          invoiceNumber: order.invoiceNumber,
          containerNumber: order.containerNumber,
          destination: order.destination,
          status: order.status,
          orderDate: order.orderDate,
          totalBales: Number(order.totalBales || 0),
          totalWeightKg: Number(order.totalWeightKg || 0),
          invoiceTotal: Number(order.invoiceTotal || 0),
        })),
      }));

      res.json({
        includeCharges: includeOrderCharges,
        destinations: aggregate?.destinations ?? [],
        summary: {
          totalOrders: Number(rawSummary.totalOrders ?? 0),
          uniqueCustomers: Number(rawSummary.uniqueCustomers ?? 0),
          totalBales: Number(rawSummary.totalBales ?? 0),
          totalWeightKg: Number(rawSummary.totalWeightKg ?? 0),
          totalInvoiceAmount: Number(rawSummary.totalInvoiceAmount ?? 0),
        },
        rows,
        pagination: {
          page: safePage,
          pageSize: safePageSize,
          totalRows,
          totalPages: Math.max(1, Math.ceil(totalRows / safePageSize)),
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
