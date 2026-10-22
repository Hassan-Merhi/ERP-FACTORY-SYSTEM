import { logAudit } from "../../helpers/auditHelpers";
import { orderAuditIdentifier } from "./orderAuditIdentifier";
import { getErrorMessage, HttpError, sendHttpError } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBales,
  customerProformas,
  customerProformaLines,
  customerOrderExpectedLines,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customers,
  insertCustomerOrderSchema,
} from "@shared/schema";
import { eq, and, or, desc, sql, isNull, gte, lte } from "drizzle-orm";
import { parseListPagination, setListPaginationHeaders } from "../../../lib/listPagination";
import { resultRows } from "../../../lib/queryResult";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { mergeNewProformaArticles, getLoadingPlanKind, usesLiveMasterProforma } from "./proformaPlan";
import { allocateRemainingProformaLines } from "./proformaCapacityEnforcement";
import { guardProformaOrderCreation } from "./proformaCapacityWriteGuards";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { linkOrderProformaAtomically, LinkOrderProformaError } from "./linkProformaAtomic";
import { canViewBookingInfo, isValidBookingInfo } from "./bookingInfo";
import { registerOrderProfitabilityRoute } from "./orderProfitabilityRoute";

export function registerOrderCrudRoutes(app: Express) {
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

  app.get("/api/factory/customer-orders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      // SELECT * so that schema drift (missing newer columns) never causes a
      // parse-time "column does not exist" 500.  JS-side defaults applied below.
      const rawOrderRes = await db.execute(
        sql`SELECT co.*, c.legal_name AS customer_name, c.code AS customer_code
            FROM customer_orders co
            LEFT JOIN customers c ON c.id = co.customer_id
            WHERE co.id = ${id} AND co.company_id = ${companyId}
            LIMIT 1`
      );
      const rawOrderRows = resultRows(rawOrderRes);
      if (!rawOrderRows.length) return res.status(404).json({ message: "Order not found" });
      const r = rawOrderRows[0];
      const order = {
        id: r.id,
        companyId: r.company_id,
        customerId: r.customer_id,
        invoiceNumber: r.invoice_number ?? null,
        orderDate: r.order_date,
        proformaIdUsed: r.proforma_id_used ?? null,
        status: String(r.status ?? "DRAFT"),
        subtotalBales: r.subtotal_bales ?? "0",
        freightAmount: r.freight_amount ?? "0",
        otherChargesTotal: r.other_charges_total ?? "0",
        grandTotal: r.grand_total ?? "0",
        totalQtyBales: r.total_qty_bales ?? 0,
        containerNumber: r.container_number ?? null,
        shippingCompany: r.shipping_company ?? null,
        containerNotes: r.container_notes ?? null,
        bookingInfo: canViewBookingInfo(req.session) ? (r.booking_info ?? null) : null,
        destination: r.destination ?? null,
        verifiedByUserId: r.verified_by_user_id ?? null,
        verifiedAt: r.verified_at ?? null,
        loadingStartedAt: r.loading_started_at ?? null,
        loadingFinalizedAt: r.loading_finalized_at ?? null,
        locationId: r.location_id ?? null,
        createdAt: r.created_at as Date | string,
        updatedAt: r.updated_at ?? r.created_at,
        customerName: r.customer_name ?? null,
        customerCode: r.customer_code ?? null,
        dispatchBatchId: r.dispatch_batch_id ?? null,
      };
      const orderProformaId = order.proformaIdUsed == null ? null : Number(order.proformaIdUsed);

      let proformaRemainingLines:
        | Array<{
            id: number;
            articleCode: string;
            productName: string;
            quantity: number;
            pricePerBale: string;
            pricingMode: string;
            pricePerKg: string | null;
          }>
        | undefined;
      if (req.query.continuationFromOrderId && orderProformaId) {
        const [continuationProforma] = await db
          .select({ id: customerProformas.id })
          .from(customerProformas)
          .where(and(eq(customerProformas.id, orderProformaId), eq(customerProformas.companyId, companyId)));
        // Continuations have a loading-specific remaining plan; prefer it
        // over the full reusable proforma when calculating follow-on quantities.
        const currentExpectedLines = continuationProforma
          ? await db
              .select()
              .from(customerOrderExpectedLines)
              .where(
                and(
                  eq(customerOrderExpectedLines.companyId, companyId),
                  eq(customerOrderExpectedLines.orderId, id),
                  eq(customerOrderExpectedLines.proformaId, orderProformaId)
                )
              )
          : [];
        const originalProformaLines = continuationProforma
          ? await db.select().from(customerProformaLines).where(eq(customerProformaLines.proformaId, orderProformaId))
          : [];
        const savedProformaLines = currentExpectedLines.map((line) => {
          const source =
            originalProformaLines.find((original) => original.id === line.proformaLineId) ||
            originalProformaLines.find(
              (original) => original.articleCode.trim().toLowerCase() === line.articleCode.trim().toLowerCase()
            );
          return {
            id: line.id,
            articleCode: line.articleCode,
            productName: line.productName || source?.productName || line.articleCode,
            quantity: line.expectedQty,
            pricePerBale: source?.pricePerBale ?? "0",
            pricingMode: source?.pricingMode ?? "per_bale",
            pricePerKg: source?.pricePerKg ?? null,
          };
        });
        const planKind = await getLoadingPlanKind(db, companyId, id);
        const proformaLines = usesLiveMasterProforma(order.status, planKind)
          ? originalProformaLines
          : mergeNewProformaArticles(
              savedProformaLines,
              originalProformaLines,
              planKind === "continuation" && !["VERIFIED", "FINALIZED", "CANCELLED"].includes(order.status),
              order.createdAt as Date | string | null
            );
        const capacity = continuationProforma
          ? await getProformaCapacitySnapshot(db, {
              companyId,
              proformaId: orderProformaId,
              currentOrderId: id,
            })
          : null;
        const remainingAllocations = capacity ? allocateRemainingProformaLines(proformaLines, capacity) : [];

        proformaRemainingLines = remainingAllocations.map(({ line, remainingQty }) => ({
          id: line.id,
          articleCode: line.articleCode,
          productName: line.productName,
          quantity: remainingQty,
          pricePerBale: line.pricePerBale,
          pricingMode: line.pricingMode,
          pricePerKg: line.pricePerKg,
        }));
      }

      // customer_order_lines has no known schema drift — Drizzle is fine here
      const lines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, id));

      // customer_order_bales and customer_order_charges both have newer columns
      // added via migrations that may be absent in production — use raw SQL.
      const rawBalesRes = await db.execute(sql`SELECT * FROM customer_order_bales WHERE order_id = ${id} ORDER BY id`);
      const bales = resultRows(rawBalesRes).map((b) => ({
        id: b.id,
        orderId: b.order_id,
        baleId: b.bale_id,
        baleReference: b.bale_reference ?? "",
        locationId: b.location_id ?? null,
        weight: b.weight ?? "0",
        articleCode: b.article_code ?? null,
        baleName: b.bale_name ?? null,
        priceUsed: b.price_used ?? "0",
        scannedBy: b.scanned_by ?? null,
        scannedAt: b.scanned_at ?? null,
      }));

      const rawChargesRes = await db.execute(
        sql`SELECT * FROM customer_order_charges WHERE order_id = ${id} ORDER BY id`
      );
      const charges = resultRows(rawChargesRes).map((c) => ({
        id: c.id,
        orderId: c.order_id,
        name: c.name ?? "",
        amount: c.amount ?? "0",
        chargeType: c.charge_type ?? "OTHER",
        ledgerAccountId: c.ledger_account_id ?? null,
        voucherId: c.voucher_id ?? null,
      }));

      res.json({ ...order, lines, bales, charges, ...(proformaRemainingLines ? { proformaRemainingLines } : {}) });
    } catch (error: unknown) {
      logger.error("Error fetching customer order:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/customer-orders/:id/hidden", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { isHidden } = req.body;
      if (typeof isHidden !== "boolean") return res.status(400).json({ message: "isHidden must be boolean" });
      await db
        .update(customerOrders)
        .set({ isHidden })
        .where(and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId)));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerOrderProfitabilityRoute(app);

  app.post("/api/factory/customer-orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertCustomerOrderSchema.parse({ ...req.body, companyId, status: "DRAFT" });

      // Guard and insert in one locked transaction. Guarding outside it let two
      // orders for the same proforma each read the last remaining slot.
      const creation = await db.transaction(async (tx) => {
        if (parsed.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: parsed.proformaIdUsed,
          });
          const guard = await guardProformaOrderCreation(tx, {
            companyId,
            proformaId: parsed.proformaIdUsed,
            customerId: parsed.customerId,
          });
          if (!guard.allowed) return { ok: false, rejection: guard } as const;
        }
        const [created] = await tx.insert(customerOrders).values(parsed).returning();
        // Phase 21 (B): the create audit commits with the order.
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "create",
            tableName: "factory_customer_orders",
            recordId: created.id,
            recordIdentifier: orderAuditIdentifier(created, created.id),
            changes: null,
          },
          tx
        );
        return { ok: true, order: created } as const;
      });

      if (!creation.ok) return res.status(creation.rejection.status).json(creation.rejection.body);
      const order = creation.order;
      res.json(order);
    } catch (error: unknown) {
      logger.error("Error creating customer order:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/customer-orders/:id/link-proforma", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(orderId)) return res.status(400).json({ message: "Invalid order ID" });

      const { proformaId } = req.body;
      // proformaId may be null/0 to unlink
      const isUnlink = proformaId == null || proformaId === 0 || proformaId === "0";
      const proformaIdInt = isUnlink ? null : parseInt(proformaId);
      if (!isUnlink && (proformaIdInt === null || isNaN(proformaIdInt!)))
        return res.status(400).json({ message: "Invalid proformaId" });

      // Lock, checks and write run in one transaction (see linkProformaAtomic.ts):
      // a link made during loading is reference-only and re-linking the same
      // proforma keeps the order's expected plan.
      res.json(await linkOrderProformaAtomically({ companyId, orderId, proformaId: proformaIdInt }));
    } catch (error: unknown) {
      if (error instanceof LinkOrderProformaError) {
        return res.status(error.status).json(error.details ?? { message: error.message });
      }
      logger.error("Error linking proforma to loading:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/factory/customer-orders/:id/loading-note — update the free-text
  // note on a loading order (works on any non-cancelled status so floor staff
  // can add or edit notes at any point during the loading lifecycle).
  app.patch("/api/factory/customer-orders/:id/loading-note", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { note } = req.body;

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Loading not found" });

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(customerOrders)
          .set({ containerNotes: note?.trim() || null, updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId))
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
            changes: { loadingNote: { old: order.containerNotes ?? null, new: note?.trim() || null } },
          },
          tx
        );
        return written;
      });
      res.json({ success: true, order: updated });
    } catch (error: unknown) {
      logger.error("Error updating loading note:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customer-orders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          );
        // Both conditions are caller errors, and throwing plain Errors from
        // inside the transaction meant the catch reported them as 500s. The
        // checks stay inside the transaction so the row stays locked between
        // the read and the soft-delete.
        if (!order) throw new HttpError(404, "Order not found");

        if (order.status === "FINALIZED") {
          throw new HttpError(409, "Cannot delete a finalized invoice. Cancel it first if needed.");
        }

        // Soft-delete: release bales back to stock so they can be re-sold,
        // but preserve order/lines/charges/bale links so the order can be
        // restored from Settings → Deleted Items (note: bales currently in
        // stock will need to be re-reserved manually after restore).
        const bales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        for (const b of bales) {
          await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", updatedAt: new Date() })
            .where(eq(factoryBales.id, b.baleId));
        }

        await tx
          .update(customerOrders)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId));
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "delete",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: `Order #${orderId}`,
            changes: null,
          },
          tx
        );
      });

      res.json({ success: true, message: "Invoice moved to Deleted Items" });
    } catch (error: unknown) {
      logger.error("Error deleting customer order:", { error: error });
      sendHttpError(res, error);
    }
  });

  app.patch("/api/factory/customer-orders/:id/date", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { orderDate } = req.body;
      if (!orderDate) return res.status(400).json({ message: "orderDate is required" });

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status !== "DRAFT")
        return res.status(400).json({ message: "Only DRAFT orders can have their date changed" });

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(customerOrders)
          .set({ orderDate, updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId))
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
            changes: { orderDate: { old: order.orderDate ?? null, new: orderDate } },
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating order date:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Single source of truth for the Invoicing table, loading form, shipping
  // containers, tracking and invoice detail. Never mirror these values into a
  // separate display-only table.
  app.post("/api/factory/customer-orders/:id/assign-container", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { containerNumber, shippingCompany, containerNotes, bookingInfo, destination } = req.body || {};
      // Existing loading forms may submit an empty bookingInfo along with
      // unrelated changes. Treat that as omitted for non-privileged staff;
      // never let them change or clear the private stored value.
      let requestedBookingInfo: unknown = bookingInfo;
      if (bookingInfo !== undefined && !canViewBookingInfo(req.session)) {
        if (bookingInfo === "" || bookingInfo === null) {
          requestedBookingInfo = undefined;
        } else {
          return res.status(403).json({ message: "Only Admin, Owner or Developer can edit booking info" });
        }
      }

      const normalizeText = (value: unknown, max: number, field: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string" || value.length > max) {
          throw new HttpError(400, `${field} must be text up to ${max} characters`);
        }
        return value.trim() || null;
      };
      const normalizedContainer = normalizeText(containerNumber, 100, "Container");
      const normalizedShipping = normalizeText(shippingCompany, 200, "Shipping company");
      const normalizedNotes = normalizeText(containerNotes, 10000, "Notes");
      if (requestedBookingInfo !== undefined && !isValidBookingInfo(requestedBookingInfo)) {
        return res.status(400).json({ message: "Booking info must be text up to 2000 characters" });
      }
      const normalizedBooking = normalizeText(requestedBookingInfo, 2000, "Booking info");
      const normalizedDestination = normalizeText(destination, 500, "Destination");
      const updateData: Partial<typeof customerOrders.$inferInsert> = {};
      if (normalizedContainer !== undefined) updateData.containerNumber = normalizedContainer;
      if (normalizedShipping !== undefined) updateData.shippingCompany = normalizedShipping;
      if (normalizedNotes !== undefined) updateData.containerNotes = normalizedNotes;
      if (normalizedBooking !== undefined) updateData.bookingInfo = normalizedBooking;
      if (normalizedDestination !== undefined) updateData.destination = normalizedDestination;
      if (!Object.keys(updateData).length) return res.status(400).json({ message: "No fields to update" });

      const updated = await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .for("update");
        if (!order || order.deletedAt) throw new HttpError(404, "Loading not found");

        const changes: Record<string, { old: string | null; new: string | null }> = {};
        const fieldNames = [
          "containerNumber",
          "shippingCompany",
          "containerNotes",
          "bookingInfo",
          "destination",
        ] as const;
        for (const field of fieldNames) {
          if (updateData[field] !== undefined && updateData[field] !== (order[field] || null)) {
            changes[field] = { old: order[field] ?? null, new: updateData[field] as string | null };
          }
        }
        if (!Object.keys(changes).length) return order;
        const [written] = await tx
          .update(customerOrders)
          .set({ ...updateData, updatedAt: new Date() })
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
            changes,
          },
          tx
        );
        return written;
      });
      // Booking information is private even when the caller edits other fields.
      res.json(canViewBookingInfo(req.session) ? updated : { ...updated, bookingInfo: null });
    } catch (error: unknown) {
      logger.error("Error updating container details:", { error });
      sendHttpError(res, error);
    }
  });

  // ───────────────────────────────────────────────
  // BALE SCAN LOOKUP
  // ───────────────────────────────────────────────

  app.get("/api/factory/bale-lookup", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const code = req.query.code as string;
      const locationId = req.query.locationId ? parseOptionalId(req.query.locationId) : null;
      if (!code) return res.status(400).json({ message: "code is required" });

      const conditions = [
        eq(factoryBales.companyId, companyId),
        eq(factoryBales.status, "IN_STOCK"),
        or(eq(factoryBales.referenceNumber, code), eq(factoryBales.baleCode, code), eq(factoryBales.articleCode, code)),
      ];

      if (locationId) {
        conditions.push(eq(factoryBales.erpLocationId, locationId));
      }

      const results = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions));

      if (results.length === 0)
        return res.status(404).json({ message: "No available bale found with that code at this location" });

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error looking up bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // INVOICE EXPORT (Excel/CSV)
  // ───────────────────────────────────────────────
}
