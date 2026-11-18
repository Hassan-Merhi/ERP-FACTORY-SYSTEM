// Extracted from ./orderCrudRoutes.ts to keep that module under the source-size cap.
import { logAudit } from "../../helpers/auditHelpers";
import { orderAuditIdentifier } from "./orderAuditIdentifier";
import { getErrorMessage, HttpError, sendHttpError } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrders, customerProformas, customers } from "@shared/schema";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { parseListPagination, setListPaginationHeaders } from "../../../lib/listPagination";
import { canViewBookingInfo } from "./bookingInfo";

export function registerOrderCrudRoutesPart1(app: Express) {
  // Reassign an unfinalized loading without touching its bales or creating
  // accounting entries. A proforma belongs to the original customer and
  // must be explicitly replaced after this move.
  app.patch("/api/factory/customer-orders/:id/change-customer", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const role = String(req.session.currentRole || req.session.role || "").toLowerCase();
      if (!["admin", "owner", "developer"].includes(role)) {
        return res.status(403).json({ message: "Only Admin, Owner or Developer can reassign loadings" });
      }
      const orderId = parseId(req.params.id);
      const customerId = parseId(req.body?.customerId);
      if (orderId === null || customerId === null)
        return res.status(400).json({ message: "Valid order and customer IDs required" });
      const updated = await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .for("update");
        if (!order || order.deletedAt) throw new HttpError(404, "Loading not found");
        if (order.status !== "LOADING")
          throw new HttpError(409, "Return the invoice to Loading before changing customer");
        if (order.customerId === customerId) return order;
        const [target] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
        if (!target) throw new HttpError(404, "Target customer not found in this company");
        await tx.execute(
          sql`DELETE FROM customer_order_expected_lines WHERE company_id = ${companyId} AND order_id = ${orderId}`
        );
        // Extras are priced for the old customer; never carry them to a new one.
        await tx.execute(sql`DELETE FROM customer_order_extra_expected_lines
          WHERE company_id = ${companyId} AND order_id = ${orderId}`);
        const [written] = await tx
          .update(customerOrders)
          .set({
            customerId,
            proformaIdUsed: null,
            updatedAt: new Date(),
          })
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .returning();
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: orderAuditIdentifier(order, orderId),
            changes: {
              customerId: { old: order.customerId, new: customerId },
              proformaIdUsed: { old: order.proformaIdUsed, new: null },
            },
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error reassigning loading customer:", { error });
      sendHttpError(res, error);
    }
  });

  app.get("/api/factory/customer-orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const conditions = [eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)];
      const queryCustomerId = parseOptionalId(req.query.customerId);
      if (queryCustomerId !== null) conditions.push(eq(customerOrders.customerId, queryCustomerId));
      if (req.query.status) conditions.push(eq(customerOrders.status, String(req.query.status)));
      const queryProformaId = parseOptionalId(req.query.proformaId);
      if (queryProformaId !== null) conditions.push(eq(customerOrders.proformaIdUsed, queryProformaId));
      if (req.query.showHidden !== "1") conditions.push(eq(customerOrders.isHidden, false));
      if (req.query.dateFrom) conditions.push(gte(customerOrders.orderDate, String(req.query.dateFrom)));
      if (req.query.dateTo) conditions.push(lte(customerOrders.orderDate, String(req.query.dateTo)));
      const pagination = parseListPagination(req.query, {
        defaultPageSize: 100,
        maxPageSize: 250,
        force: req.query.profile === "summary",
      });

      const liveMasterPlan = sql`(
        ${customerOrders.status} IN ('LOADING', 'PENDING_VERIFICATION')
        AND EXISTS (
          SELECT 1 FROM factory_daybook_entries e
          WHERE e.company_id = ${customerOrders.companyId}
            AND e.reference_table = 'customer_orders'
            AND e.reference_id = ${customerOrders.id}
            AND e.tx_type = 'LOADING_CREATED'
            AND e.description LIKE 'Loading started for customer:%'
        )
      )`;

      const ordersQuery = db
        .select({
          id: customerOrders.id,
          companyId: customerOrders.companyId,
          customerId: customerOrders.customerId,
          invoiceNumber: customerOrders.invoiceNumber,
          orderDate: customerOrders.orderDate,
          proformaIdUsed: customerOrders.proformaIdUsed,
          proformaName: customerProformas.name,
          status: customerOrders.status,
          subtotalBales: customerOrders.subtotalBales,
          freightAmount: customerOrders.freightAmount,
          otherChargesTotal: customerOrders.otherChargesTotal,
          isHidden: customerOrders.isHidden,
          grandTotal: sql<string>`(
            COALESCE((
              SELECT SUM(
                CASE
                  WHEN col.pricing_mode = 'per_kg'
                    AND COALESCE(col.price_per_kg::numeric, 0) > 0
                    AND COALESCE(col.total_weight::numeric, 0) > 0
                  THEN col.price_per_kg::numeric * col.total_weight::numeric
                  ELSE COALESCE(col.total_price::numeric, 0)
                END
              )
              FROM customer_order_lines col
              WHERE col.order_id = ${customerOrders.id}
            ), 0)
            + COALESCE(${customerOrders.freightAmount}::numeric, 0)
            + COALESCE(${customerOrders.otherChargesTotal}::numeric, 0)
          )`,
          totalQtyBales: customerOrders.totalQtyBales,
          totalWeightKg: sql<string>`COALESCE((SELECT SUM(cob.weight) FROM customer_order_bales cob WHERE cob.order_id = ${customerOrders.id}), 0)`,
          proformaExpectedBales: sql<string>`CASE WHEN ${liveMasterPlan}
            THEN COALESCE((
              SELECT SUM(quantity) FROM customer_proforma_lines
              WHERE proforma_id = ${customerOrders.proformaIdUsed}
            ), 0)
            ELSE COALESCE((
              SELECT SUM(expected_qty) FROM customer_order_expected_lines
              WHERE company_id = ${customerOrders.companyId}
                AND order_id = ${customerOrders.id}
                AND proforma_id = ${customerOrders.proformaIdUsed}
            ), (
              SELECT SUM(quantity) FROM customer_proforma_lines
              WHERE proforma_id = ${customerOrders.proformaIdUsed}
            ), 0)
          END`,
          // For continuation plans, compute remaining PER ARTICLE. Subtracting
          // total bales alone can hide shortages when another article is over-loaded.
          continuationRemainingBales: sql<string | null>`(
            SELECT SUM(GREATEST(plan.expected - COALESCE(scanned.loaded, 0), 0))::text
            FROM (
              SELECT LOWER(TRIM(article_code)) AS article, SUM(expected_qty)::int AS expected
              FROM customer_order_expected_lines
              WHERE company_id = ${customerOrders.companyId}
                AND order_id = ${customerOrders.id}
                AND proforma_id = ${customerOrders.proformaIdUsed}
                AND NOT ${liveMasterPlan}
              GROUP BY LOWER(TRIM(article_code))
              UNION ALL
              SELECT LOWER(TRIM(article_code)) AS article, SUM(quantity)::int AS expected
              FROM customer_proforma_lines
              WHERE proforma_id = ${customerOrders.proformaIdUsed}
                AND (
                  ${liveMasterPlan}
                  OR NOT EXISTS (
                    SELECT 1 FROM customer_order_expected_lines saved
                    WHERE saved.company_id = ${customerOrders.companyId}
                      AND saved.order_id = ${customerOrders.id}
                      AND saved.proforma_id = ${customerOrders.proformaIdUsed}
                  )
                )
              GROUP BY LOWER(TRIM(article_code))
            ) plan
            LEFT JOIN (
              SELECT LOWER(TRIM(article_code)) AS article, COUNT(DISTINCT bale_id)::int AS loaded
              FROM customer_order_bales
              WHERE order_id = ${customerOrders.id}
              GROUP BY LOWER(TRIM(article_code))
            ) scanned ON scanned.article = plan.article
          )`,
          loadedNotInProformaBales: sql<string>`CASE WHEN ${customerOrders.proformaIdUsed} IS NULL THEN 0 ELSE COALESCE((SELECT COUNT(*)::int FROM customer_order_bales cob2 WHERE cob2.order_id = ${customerOrders.id} AND (cob2.article_code IS NULL OR cob2.article_code NOT IN (SELECT article_code FROM customer_proforma_lines WHERE proforma_id = ${customerOrders.proformaIdUsed}))), 0) END`,
          containerNumber: customerOrders.containerNumber,
          shippingCompany: customerOrders.shippingCompany,
          containerNotes: customerOrders.containerNotes,
          bookingInfo: canViewBookingInfo(req.session) ? customerOrders.bookingInfo : sql<string | null>`NULL`,
          destination: customerOrders.destination,
          locationId: customerOrders.locationId,
          loadingStartedAt: customerOrders.loadingStartedAt,
          loadingFinalizedAt: customerOrders.loadingFinalizedAt,
          verifiedAt: customerOrders.verifiedAt,
          finalizedAt: customerOrders.finalizedAt,
          createdAt: customerOrders.createdAt,
          updatedAt: customerOrders.updatedAt,
          customerName: customers.legalName,
        })
        .from(customerOrders)
        .leftJoin(customers, eq(customerOrders.customerId, customers.id))
        .leftJoin(customerProformas, eq(customerOrders.proformaIdUsed, customerProformas.id))
        .where(and(...conditions))
        .orderBy(desc(customerOrders.createdAt))
        .$dynamic();

      const orders = pagination.requested
        ? await ordersQuery.limit(pagination.pageSize).offset(pagination.offset)
        : await ordersQuery;
      if (pagination.requested) {
        const [countRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(customerOrders)
          .where(and(...conditions));
        setListPaginationHeaders(res, countRow?.count ?? 0, pagination);
      }
      res.set("Cache-Control", "private, max-age=15");
      res.json(orders);
    } catch (error: unknown) {
      logger.error("Error fetching customer orders:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
