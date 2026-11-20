// Extracted from ./orderCrudRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrderExpectedLines,
  customerOrderLines,
  customerOrders,
  customerProformaLines,
  customerProformas,
} from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { getLoadingPlanKind, mergeNewProformaArticles, usesLiveMasterProforma } from "./proformaPlan";
import { allocateRemainingProformaLines } from "./proformaCapacityEnforcement";
import { canViewBookingInfo } from "./bookingInfo";
import { z } from "zod";
import {
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

const hiddenInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ isHidden: z.boolean() }),
} satisfies RequestSchemas;
import { registerOrderProfitabilityRoute } from "./orderProfitabilityRoute";

export function registerOrderCrudRoutesPart2(app: Express) {
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

  app.patch(
    "/api/factory/customer-orders/:id/hidden",
    requireAuth,
    validateRequest(hiddenInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { id } = validatedInput(req, hiddenInput).params;
        const { isHidden } = req.body;
        await db
          .update(customerOrders)
          .set({ isHidden })
          .where(and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId)));
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  registerOrderProfitabilityRoute(app);
}
