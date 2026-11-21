// Extracted from ./rows.ts
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrders, factoryShippingContainerRows } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getCompanyId } from "./_helpers";
import { parseListPagination, setListPaginationHeaders } from "../../../lib/listPagination";

export function registerShippingContainerRowRoutesPart1(app: Express) {
  // ── GET list all shipping container rows ─────────────────────────────────────
  app.get("/api/factory/shipping-container-rows", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const pagination = parseListPagination(req.query, { defaultPageSize: 100, maxPageSize: 500, force: true });
      const params: unknown[] = [companyId];
      const clauses = ["r.company_id = $1"];
      if (req.query.isDone === "true" || req.query.isDone === "false") {
        params.push(req.query.isDone === "true");
        clauses.push(`r.is_done = $${params.length}`);
      }
      if (req.query.dateFrom) {
        params.push(String(req.query.dateFrom));
        clauses.push(`r.order_date >= $${params.length}`);
      }
      if (req.query.dateTo) {
        params.push(String(req.query.dateTo));
        clauses.push(`r.order_date <= $${params.length}`);
      }
      if (String(req.query.search || "").trim()) {
        const rawSearch = String(req.query.search).trim();
        params.push(`%${rawSearch}%`);
        const index = params.length;
        params.push(`%${normalizeSearchText(rawSearch)}%`);
        const compactIndex = params.length;
        clauses.push(`(
          COALESCE(co.invoice_number, '') ILIKE $${index}
          OR COALESCE(c.legal_name, '') ILIKE $${index}
          OR COALESCE(co.container_number, '') ILIKE $${index}
          OR COALESCE(co.shipping_company, '') ILIKE $${index}
          OR COALESCE(co.destination, '') ILIKE $${index}
          OR COALESCE(r.anything, '') ILIKE $${index}
          OR regexp_replace(lower(COALESCE(co.invoice_number, '')), '[^[:alnum:]]+', '', 'g') LIKE $${compactIndex}
          OR regexp_replace(lower(COALESCE(c.legal_name, '')), '[^[:alnum:]]+', '', 'g') LIKE $${compactIndex}
          OR regexp_replace(lower(COALESCE(co.container_number, '')), '[^[:alnum:]]+', '', 'g') LIKE $${compactIndex}
          OR regexp_replace(lower(COALESCE(co.shipping_company, '')), '[^[:alnum:]]+', '', 'g') LIKE $${compactIndex}
          OR regexp_replace(lower(COALESCE(co.destination, '')), '[^[:alnum:]]+', '', 'g') LIKE $${compactIndex}
          OR regexp_replace(lower(COALESCE(r.anything, '')), '[^[:alnum:]]+', '', 'g') LIKE $${compactIndex}
        )`);
      }
      const whereSql = clauses.join(" AND ");
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM factory_shipping_container_rows r
         INNER JOIN customer_orders co ON r.customer_order_id = co.id
         LEFT JOIN customers c ON co.customer_id = c.id
         WHERE ${whereSql}`,
        params
      );
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
      const { rows } = await pool.query(
        `SELECT
           r.id,
           r.company_id AS "companyId",
           r.customer_order_id AS "customerOrderId",
           r.order_date AS "orderDate",
           r.eta,
           r.container_arrived_date AS "containerArrivedDate",
           r.note,
           r.anything,
           r.ci_number AS "ciNumber",
           r.is_done AS "isDone",
           r.done_at AS "doneAt",
           r.done_by AS "doneBy",
           r.whatsapp_sent_at AS "whatsappSentAt",
           r.created_at AS "createdAt",
           r.shipping_invoice_file_name AS "shippingInvoiceFileName",
           r.shipping_invoice_original_name AS "shippingInvoiceOriginalName",
           r.shipping_invoice_file_url AS "shippingInvoiceFileUrl",
           r.shipping_invoice_file_type AS "shippingInvoiceFileType",
           r.tracking_link AS "trackingLink",
           co.invoice_number AS "invoiceNumber",
           co.customer_id AS "customerId",
           c.legal_name AS "clientName",
           c.phone AS "customerPhone",
           co.status,
           co.loading_started_at AS "loadingDate",
           co.loading_finalized_at AS "finalizedDate",
           co.container_number AS "containerNumber",
           co.shipping_company AS "shippingCompany",
           co.destination,
           co.grand_total AS "grandTotal",
           COALESCE(dc.doc_count, 0)::int AS "documentCount"
         FROM factory_shipping_container_rows r
         INNER JOIN customer_orders co ON r.customer_order_id = co.id
         LEFT JOIN customers c ON co.customer_id = c.id
         LEFT JOIN (
           SELECT scr_id, COUNT(*)::int AS doc_count
           FROM factory_shipping_container_documents
           WHERE file_name IS NOT NULL
             AND trim(file_name) <> ''
             AND file_name <> '-'
             AND ((display_name IS NOT NULL AND trim(display_name) <> '')
               OR (original_name IS NOT NULL AND trim(original_name) <> ''))
           GROUP BY scr_id
         ) dc ON dc.scr_id = r.id
         WHERE ${whereSql}
         ORDER BY r.created_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...params, pagination.pageSize, pagination.offset]
      );
      setListPaginationHeaders(res, countResult.rows[0]?.count ?? 0, pagination);
      res.set("Cache-Control", "private, max-age=15");
      res.json(rows);
    } catch (error: unknown) {
      logger.error("Error fetching shipping container rows:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── POST create row ───────────────────────────────────────────────────────────
  app.post("/api/factory/shipping-container-rows", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerOrderId, orderDate, containerArrivedDate, note, anything } = req.body;
      if (!customerOrderId || !orderDate) {
        return res.status(400).json({ message: "customerOrderId and orderDate are required" });
      }

      // Verify the order belongs to this company
      const [order] = await db
        .select({ id: customerOrders.id })
        .from(customerOrders)
        .where(
          and(
            eq(customerOrders.id, Number(customerOrderId)),
            eq(customerOrders.companyId, companyId),
            isNull(customerOrders.deletedAt)
          )
        );
      if (!order) return res.status(404).json({ message: "Invoice not found" });

      // Uniqueness check (belt-and-suspenders on top of the DB unique index)
      const existing = await db
        .select({ id: factoryShippingContainerRows.id })
        .from(factoryShippingContainerRows)
        .where(
          and(
            eq(factoryShippingContainerRows.companyId, companyId),
            eq(factoryShippingContainerRows.customerOrderId, Number(customerOrderId))
          )
        )
        .limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ message: "This invoice already has a shipping container row" });
      }

      const [newRow] = await db
        .insert(factoryShippingContainerRows)
        .values({
          companyId,
          customerOrderId: Number(customerOrderId),
          orderDate,
          containerArrivedDate: containerArrivedDate || null,
          note: note || null,
          anything: anything || null,
        })
        .returning();

      res.status(201).json(newRow);
    } catch (error: unknown) {
      logger.error("Error creating shipping container row:", { error: error });
      if ((error as { code?: string }).code === "23505") {
        return res.status(409).json({ message: "This invoice already has a shipping container row" });
      }
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── PATCH update row-only fields (arrived date, note) ────────────────────────
  app.patch("/api/factory/shipping-container-rows/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [existing] = await db
        .select({ id: factoryShippingContainerRows.id })
        .from(factoryShippingContainerRows)
        .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Row not found" });

      const patch: Partial<typeof factoryShippingContainerRows.$inferInsert> = { updatedAt: new Date() };
      if (req.body.eta !== undefined) patch.eta = req.body.eta || null;
      if (req.body.containerArrivedDate !== undefined)
        patch.containerArrivedDate = req.body.containerArrivedDate || null;
      if (req.body.note !== undefined) patch.note = req.body.note || null;
      if (req.body.anything !== undefined) patch.anything = req.body.anything || null;
      if (req.body.ciNumber !== undefined) patch.ciNumber = req.body.ciNumber || null;
      if (req.body.trackingLink !== undefined) patch.trackingLink = req.body.trackingLink || null;

      const [updated] = await db
        .update(factoryShippingContainerRows)
        .set(patch)
        .where(eq(factoryShippingContainerRows.id, id))
        .returning();

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating shipping container row:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── PATCH sync editable fields to customer_orders ────────────────────────────
  app.patch("/api/factory/shipping-container-rows/:id/sync-order", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [row] = await db
        .select({ customerOrderId: factoryShippingContainerRows.customerOrderId })
        .from(factoryShippingContainerRows)
        .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
      if (!row) return res.status(404).json({ message: "Row not found" });

      const patch: Partial<typeof customerOrders.$inferInsert> = { updatedAt: new Date() };
      if (req.body.containerNumber !== undefined) patch.containerNumber = req.body.containerNumber || null;
      if (req.body.shippingCompany !== undefined) patch.shippingCompany = req.body.shippingCompany || null;
      if (req.body.destination !== undefined) patch.destination = req.body.destination || null;

      const [updated] = await db
        .update(customerOrders)
        .set(patch)
        .where(and(eq(customerOrders.id, row.customerOrderId), eq(customerOrders.companyId, companyId)))
        .returning();

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error syncing order fields:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
