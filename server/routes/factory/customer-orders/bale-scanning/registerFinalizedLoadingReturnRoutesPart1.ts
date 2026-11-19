// Extracted from ./finalized-returns.ts
import type { Express, Request, Response } from "express";
import { registerFinalizedReturnImportPreview } from "./finalized-return-import-preview";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../../../auth";
import { db } from "../../../../db";
import { logger } from "../../../../lib/logger";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { customerOrders } from "@shared/schema";
import {
  hasAnyPhysicalDispatchTx,
  hasLiveFinancialTripTx,
} from "../../../../services/factory/dispatchTripFinancialGuards";

/** Finalized customer loading returns, NOT Factory POS. Only Admin/Developer. */
export const gate = [requireAuth, requireRole("Admin", "Developer")] as const;

export const company = (req: Request) => req.session.factoryCompanyId || req.session.currentCompanyId;

export const id = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

const returnErrors = {
  invoiceInvalid: {
    en: "Invalid company or invoice",
    ar: "الشركة أو الفاتورة غير صالحة",
    fr: "Société ou facture non valide",
  },
  invoiceMissing: {
    en: "Finalized invoice not found",
    ar: "تعذر العثور على الفاتورة النهائية",
    fr: "Facture finalisée introuvable",
  },
  baleDuplicate: {
    en: "A bale was selected twice",
    ar: "تم تحديد البالة مرتين",
    fr: "Une balle a été sélectionnée deux fois",
  },
  reasonRequired: {
    en: "Return reason must be 5–500 characters",
    ar: "يجب أن يتراوح سبب الإرجاع بين 5 و500 حرف",
    fr: "Le motif du retour doit comporter entre 5 et 500 caractères",
  },
  physicalConfirm: {
    en: "Confirm selected bales are physically returned",
    ar: "أكد أن البالات المحددة قد عادت فعلياً",
    fr: "Confirmez le retour physique des balles sélectionnées",
  },
  refreshInvoice: {
    en: "Refresh invoice before returning its bales",
    ar: "حدّث الفاتورة قبل إرجاع البالات",
    fr: "Actualisez la facture avant de retourner ses balles",
  },
} as const;

export function returnMessage(req: Request, key: keyof typeof returnErrors): string {
  const requested = String(req.headers["accept-language"] ?? "en")
    .slice(0, 2)
    .toLowerCase();
  const language = requested === "ar" || requested === "fr" ? requested : "en";
  return returnErrors[key][language];
}

export function registerFinalizedLoadingReturnRoutesPart1(app: Express) {
  registerFinalizedReturnImportPreview(app);
  app.get("/api/factory/finalized-sale-returns/orders", ...gate, async (req: Request, res: Response) => {
    try {
      const cid = company(req);
      if (!cid) return res.status(400).json({ message: "Select a Factory company" });
      const term =
        "%" +
        String(req.query.search ?? "")
          .trim()
          .slice(0, 100) +
        "%";
      const result = await db.execute(sql`
        SELECT o.id, o.invoice_number AS "invoiceNumber", o.container_number AS "containerNumber",
          o.grand_total::text AS "grandTotal", o.total_qty_bales AS "quantity",
          c.legal_name AS "customerName"
        FROM customer_orders o LEFT JOIN customers c
          ON c.id=o.customer_id AND c.company_id=o.company_id
        WHERE o.company_id=${cid} AND o.deleted_at IS NULL AND o.status='FINALIZED'
          AND (o.previous_status='LOADING' OR o.loading_started_at IS NOT NULL OR o.loading_finalized_at IS NOT NULL)
          AND (o.invoice_number ILIKE ${term} OR COALESCE(o.container_number,'') ILIKE ${term}
            OR COALESCE(c.legal_name,'') ILIKE ${term})
        ORDER BY o.finalized_at DESC NULLS LAST, o.id DESC LIMIT 100
      `);
      return res.json(result.rows);
    } catch (error) {
      logger.error("finalized loading returns search", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/finalized-sale-returns/orders/:id", ...gate, async (req: Request, res: Response) => {
    try {
      const cid = company(req),
        oid = id(req.params.id);
      if (!cid || !oid) return res.status(400).json({ message: returnMessage(req, "invoiceInvalid") });
      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.companyId, cid), eq(customerOrders.id, oid)));
      if (!order || order.status !== "FINALIZED" || order.deletedAt)
        return res.status(404).json({ message: returnMessage(req, "invoiceMissing") });
      const rows = await db.execute(sql`
        SELECT ob.bale_id AS "baleId", ob.bale_reference AS "referenceNumber",
          ob.article_code AS "articleCode", ob.bale_name AS "productName",
          ob.weight::text AS "weightKg", ob.price_used::text AS "priceUsed",
          b.status, b.total_cost::text AS "costUsd",
          b.erp_location_id AS "currentLocationId", ob.location_id AS "soldLocationId"
        FROM customer_order_bales ob JOIN factory_bales b
          ON b.id=ob.bale_id AND b.company_id=${cid}
        WHERE ob.order_id=${oid}
        ORDER BY ob.article_code, ob.bale_reference
      `);
      const dispatch = await db.transaction(
        async (tx) =>
          !!order.dispatchBatchId ||
          (await hasAnyPhysicalDispatchTx(tx, cid, oid)) ||
          (await hasLiveFinancialTripTx(tx, cid, oid))
      );
      return res.json({
        order: {
          id: order.id,
          invoiceNumber: order.invoiceNumber,
          containerNumber: order.containerNumber,
          grandTotal: order.grandTotal,
          totalQtyBales: order.totalQtyBales,
        },
        bales: rows.rows,
        blockedReason: dispatch
          ? "This invoice has dispatch-trip accounting; use the posted-trip credit/reversal workflow."
          : null,
      });
    } catch (error) {
      logger.error("finalized loading returns invoice", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/finalized-sale-returns/history", ...gate, async (req: Request, res: Response) => {
    try {
      const cid = company(req);
      if (!cid) return res.status(400).json({ message: "Select a Factory company" });
      const rows = await db.execute(sql`
        SELECT return_batch AS "returnBatch", order_id AS "orderId",
          invoice_number AS "invoiceNumber", container_number AS "containerNumber",
          product_name AS "productName", article_code AS "articleCode",
          COUNT(*)::integer AS "quantity",
          STRING_AGG(bale_reference, ', ' ORDER BY bale_reference) AS "baleReferences",
          MAX(original_total)::text AS "originalTotal", MAX(revised_total)::text AS "revisedTotal",
          MIN(returned_at) AS "returnedAt", MAX(returned_by) AS "returnedBy",
          MAX(reason) AS reason
        FROM factory_finalized_sale_returns WHERE company_id=${cid}
        GROUP BY return_batch, order_id, invoice_number, container_number, product_name, article_code
        ORDER BY MIN(returned_at) DESC LIMIT 500
      `);
      return res.json(rows.rows);
    } catch (error) {
      logger.error("finalized loading returns history", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
