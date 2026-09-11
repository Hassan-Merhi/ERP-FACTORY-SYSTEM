/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { resultRows } from "../../../lib/queryResult";
import { syncProformaReservations } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  customerProformas,
  customerProformaLines,
  customers,
  insertCustomerProformaSchema,
  proformaStockReservations,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";
import { normalizeLoadingArticleCode } from "../customer-orders/bale-scanning/proformaScanPolicy";

/** Row shape returned by the raw `customer_proformas` queries below. */
type ProformaRow = {
  id: number;
  company_id: number;
  customer_id: number;
  name: string | null;
  is_active: boolean | null;
  deleted_at: string | Date | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

/** Row shape returned by the raw `customer_proforma_lines` queries below. */
type ProformaLineRow = {
  id: number;
  proforma_id: number;
  article_code: string | null;
  product_name: string | null;
  quantity: string | number | null;
  price_per_bale: string | null;
  production_price_per_bale: string | null;
  price_fixed: boolean | null;
  pricing_mode: string | null;
  price_per_kg: string | null;
  created_at?: string | Date | null;
};

/** A proforma line after mapping to the UI contract. */
type ProformaLine = {
  id: number;
  proformaId: number;
  articleCode: string;
  productName: string;
  quantity: number;
  pricePerBale: string;
  productionPricePerBale: string;
  priceFixed: boolean;
  pricingMode: string;
  pricePerKg: string | null;
  createdAt?: string | Date | null;
};

export function registerFactoryCustomerProformaCrudRoutes(app: Express) {
  // Authoritative capacity read contract. Keep the summary list compact; screens
  // that need live progress fetch this one snapshot instead of re-deriving it.
  app.get("/api/factory/customer-proformas/:id/capacity", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.id);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
      const currentOrderId = parseOptionalId(req.query.currentOrderId);
      if (req.query.currentOrderId !== undefined && req.query.currentOrderId !== "" && currentOrderId === null) {
        return res.status(400).json({ message: "Invalid currentOrderId" });
      }

      const snapshot = await getProformaCapacitySnapshot(db, { companyId, proformaId, currentOrderId });
      if (!snapshot) return res.status(404).json({ message: "Proforma not found" });

      const sourceLines = await db
        .select({ articleCode: customerProformaLines.articleCode, productName: customerProformaLines.productName })
        .from(customerProformaLines)
        .where(eq(customerProformaLines.proformaId, proformaId));
      const productNames = new Map<string, string>();
      for (const line of sourceLines) {
        const normalized = normalizeLoadingArticleCode(line.articleCode);
        const name = String(line.productName || "").trim();
        if (normalized && name && !productNames.has(normalized)) productNames.set(normalized, name);
      }

      res.set("Cache-Control", "private, no-store");
      return res.json({
        ...snapshot,
        articles: snapshot.articles.map((article) => ({
          ...article,
          productName: productNames.get(article.normalizedArticleCode) || article.articleCode,
        })),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  /* Single proforma by ID — used by EditProformaV5Drawer and lazy detail readers. */
  app.get("/api/factory/customer-proformas/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const rawProformaRes = await db.execute(
        sql`SELECT * FROM customer_proformas WHERE id = ${id} AND company_id = ${companyId} AND deleted_at IS NULL LIMIT 1`
      );
      const rawProformaRows = rawProformaRes.rows ?? (rawProformaRes as unknown as unknown[]);
      if (!rawProformaRows.length) return res.status(404).json({ message: "Proforma not found" });
      const pr = rawProformaRows[0];
      const proforma = {
        id: pr.id,
        companyId: pr.company_id,
        customerId: pr.customer_id,
        name: pr.name ?? "",
        isActive: pr.is_active ?? false,
        deletedAt: pr.deleted_at ?? null,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at ?? pr.created_at,
      };
      const rawLinesRes = await db.execute(sql`SELECT * FROM customer_proforma_lines WHERE proforma_id = ${id}`);
      const lines = resultRows<ProformaLineRow>(rawLinesRes).map((l) => ({
        id: l.id,
        proformaId: l.proforma_id,
        articleCode: l.article_code ?? "",
        productName: l.product_name ?? "",
        quantity: Number(l.quantity) || 0,
        pricePerBale: l.price_per_bale ?? "0",
        productionPricePerBale: l.production_price_per_bale ?? "0",
        priceFixed: l.price_fixed ?? false,
        pricingMode: l.pricing_mode ?? "per_bale",
        pricePerKg: l.price_per_kg ?? null,
        createdAt: l.created_at,
      }));
      const articleCodes = [...new Set(lines.map((l) => l.articleCode).filter(Boolean))];
      const weightMap = new Map<string, string>();
      if (articleCodes.length > 0) {
        const baleProds = await db
          .select({
            articleCode: factoryBaleProducts.articleCode,
            weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
            name: factoryBaleProducts.name,
          })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              inArray(factoryBaleProducts.articleCode, articleCodes as string[])
            )
          );
        baleProds.forEach((p) => {
          if (p.articleCode) weightMap.set(p.articleCode, p.weightPerBaleKg || "0");
        });
      }
      const enrichedLines = lines.map((l) => ({ ...l, weightPerBaleKg: weightMap.get(l.articleCode) || "0" }));
      res.set("Cache-Control", "private, max-age=60");
      res.json({ ...proforma, lines: enrichedLines });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/customer-proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const customerId = req.query.customerId ? parseOptionalId(req.query.customerId) : null;
      if (!customerId) return res.status(400).json({ message: "customerId is required" });

      const profile = String(req.query.profile || "full");
      if (profile === "summary") {
        // Phase 3: summary means summary. Older code fetched every line for every
        // proforma after the metadata query, making the supposedly compact profile
        // almost as large as the full detail list. Aggregate the card/list metrics
        // in SQL and leave line arrays empty; screens that need line detail already
        // have the /:id contract available for lazy reads.
        const rawSummary = await db.execute(sql`
          SELECT
            cp.id,
            cp.company_id,
            cp.customer_id,
            cp.name,
            cp.is_active,
            cp.created_at,
            COALESCE(NULLIF(to_jsonb(cp)->>'updated_at', '')::timestamptz, cp.created_at) AS updated_at,
            COUNT(cpl.id)::int AS line_count,
            COALESCE(SUM(cpl.quantity), 0)::int AS total_qty,
            COALESCE(SUM(
              cpl.quantity::numeric * COALESCE(fbp.weight_per_bale_kg::numeric, 0)
            ), 0)::float AS total_weight_kg,
            COALESCE(SUM(
              cpl.quantity::numeric *
              CASE
                WHEN COALESCE(cpl.pricing_mode, 'per_bale') = 'per_kg'
                  AND COALESCE(cpl.price_per_kg::numeric, 0) > 0
                  AND COALESCE(fbp.weight_per_bale_kg::numeric, 0) > 0
                THEN cpl.price_per_kg::numeric * fbp.weight_per_bale_kg::numeric
                ELSE COALESCE(cpl.price_per_bale::numeric, 0)
              END
            ), 0)::float AS total_amount
          FROM customer_proformas cp
          LEFT JOIN customer_proforma_lines cpl ON cpl.proforma_id = cp.id
          LEFT JOIN factory_bale_products fbp
            ON fbp.company_id = cp.company_id
           AND fbp.article_code = cpl.article_code
           AND fbp.deleted_at IS NULL
          WHERE cp.company_id = ${companyId}
            AND cp.customer_id = ${customerId}
            AND cp.deleted_at IS NULL
          GROUP BY cp.id, cp.company_id, cp.customer_id, cp.name, cp.is_active, cp.created_at
          ORDER BY cp.name ASC
        `);
        const summaryRows = rawSummary.rows ?? (rawSummary as unknown as unknown[]);
        const summaries = summaryRows.map((row) => ({
          id: row.id,
          companyId: row.company_id,
          customerId: row.customer_id,
          name: row.name ?? "",
          isActive: row.is_active ?? false,
          lineCount: Number(row.line_count) || 0,
          totalQty: Number(row.total_qty) || 0,
          totalWeightKg: Number(row.total_weight_kg) || 0,
          totalAmount: Number(row.total_amount) || 0,
          lines: [],
          createdAt: row.created_at,
          updatedAt: row.updated_at ?? row.created_at,
        }));
        res.set("X-ERP-Payload-Profile", "customer-proforma-summary-v2");
        res.set("Cache-Control", "private, max-age=60");
        return res.json(summaries);
      }

      const rawProformasRes = await db.execute(
        sql`SELECT id, company_id, customer_id, name, is_active, deleted_at, created_at,
                   COALESCE(NULLIF(to_jsonb(customer_proformas)->>'updated_at', '')::timestamptz, created_at) AS updated_at
            FROM customer_proformas
            WHERE company_id = ${companyId}
              AND customer_id = ${customerId}
              AND deleted_at IS NULL
            ORDER BY name ASC`
      );
      const proformas = resultRows<ProformaRow>(rawProformasRes).map((r) => ({
        id: r.id,
        companyId: r.company_id,
        customerId: r.customer_id,
        name: r.name ?? "",
        isActive: r.is_active ?? false,
        deletedAt: r.deleted_at ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at ?? r.created_at,
      }));

      const proformaIds = proformas.map((p) => p.id);
      let lines: ProformaLine[] = [];
      if (proformaIds.length > 0) {
        const idList = sql.join(
          proformaIds.map((id: number) => sql`${id}`),
          sql`,`
        );
        // Select only fields rendered/edited by the proforma UI. This removes
        // unused row metadata while preserving the existing full-list contract.
        const rawLines = await db.execute(sql`
          SELECT id, proforma_id, article_code, product_name, quantity,
                 price_per_bale, production_price_per_bale, price_fixed,
                 pricing_mode, price_per_kg
          FROM customer_proforma_lines
          WHERE proforma_id IN (${idList})
        `);
        const rawRows = resultRows<ProformaLineRow>(rawLines);
        lines = rawRows.map((l) => ({
          id: l.id,
          proformaId: l.proforma_id,
          articleCode: l.article_code ?? "",
          productName: l.product_name ?? "",
          quantity: Number(l.quantity) || 0,
          pricePerBale: l.price_per_bale ?? "0",
          productionPricePerBale: l.production_price_per_bale ?? "0",
          priceFixed: l.price_fixed ?? false,
          pricingMode: l.pricing_mode ?? "per_bale",
          pricePerKg: l.price_per_kg ?? null,
        }));
      }

      const articleCodes = [...new Set(lines.map((l) => l.articleCode).filter(Boolean))];
      const weightMap = new Map<string, string>();
      const nameMap = new Map<string, string>();
      if (articleCodes.length > 0) {
        const baleProds = await db
          .select({
            articleCode: factoryBaleProducts.articleCode,
            weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
            name: factoryBaleProducts.name,
          })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              inArray(factoryBaleProducts.articleCode, articleCodes as string[])
            )
          );
        baleProds.forEach((p) => {
          if (p.articleCode) {
            weightMap.set(p.articleCode, p.weightPerBaleKg || "0");
            if (p.name) nameMap.set(p.articleCode, p.name);
          }
        });
      }

      const enrichedLines = lines.map((l) => ({
        ...l,
        weightPerBaleKg: weightMap.get(l.articleCode) || "0",
        productName: nameMap.get(l.articleCode) || l.productName,
      }));

      const linesByProforma = new Map<number, unknown[]>();
      for (const line of enrichedLines) {
        const current = linesByProforma.get(line.proformaId) || [];
        current.push(line);
        linesByProforma.set(line.proformaId, current);
      }
      const result = proformas.map((p) => ({
        ...p,
        lines: linesByProforma.get(p.id) || [],
      }));

      res.set("X-ERP-Payload-Profile", "customer-proforma-full-v2");
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching customer proformas:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/customer-proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertCustomerProformaSchema.parse({ ...req.body, companyId });

      const [duplicate] = await db
        .select({ id: customerProformas.id })
        .from(customerProformas)
        .where(
          and(
            eq(customerProformas.companyId, companyId),
            eq(customerProformas.customerId, parsed.customerId),
            eq(customerProformas.name, parsed.name)
          )
        );
      if (duplicate) {
        return res.status(409).json({
          message: `A proforma named "${parsed.name}" already exists for this customer. Please choose a different name.`,
        });
      }

      const [proforma] = await db.insert(customerProformas).values(parsed).returning();
      await syncProformaReservations(db, companyId, proforma.id);
      res.json(proforma);
    } catch (error: unknown) {
      logger.error("Error creating customer proforma:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/factory/customer-proformas/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [existing] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Proforma not found" });

      if (req.body.name && req.body.name !== existing.name) {
        const [duplicate] = await db
          .select({ id: customerProformas.id })
          .from(customerProformas)
          .where(
            and(
              eq(customerProformas.companyId, companyId),
              eq(customerProformas.customerId, existing.customerId),
              eq(customerProformas.name, req.body.name)
            )
          );
        if (duplicate) {
          return res.status(409).json({
            message: `A proforma named "${req.body.name}" already exists for this customer. Please choose a different name.`,
          });
        }
      }

      const [updated] = await db
        .update(customerProformas)
        .set({ ...req.body, updatedAt: new Date() })
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)))
        .returning();

      await syncProformaReservations(db, companyId, id);
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating customer proforma:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customer-proformas/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [proformaBefore] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      if (proformaBefore) {
        const [custBefore] = await db
          .select({ id: customers.id, legalName: customers.legalName, deletedAt: customers.deletedAt })
          .from(customers)
          .where(eq(customers.id, proformaBefore.customerId));
        logger.info(
          `[PROFORMA DELETE] Deleting proforma id=${id} name="${proformaBefore.name}" customerId=${proformaBefore.customerId} customerName="${custBefore?.legalName}" customerDeletedAt=${custBefore?.deletedAt}`
        );
      }

      await db
        .update(customerProformas)
        .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      await syncProformaReservations(db, companyId, id);
      await db
        .delete(proformaStockReservations)
        .where(and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, id)));
      const [deleted] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));

      if (!deleted) return res.status(404).json({ message: "Proforma not found" });

      if (proformaBefore) {
        const [custAfter] = await db
          .select({ id: customers.id, legalName: customers.legalName, deletedAt: customers.deletedAt })
          .from(customers)
          .where(eq(customers.id, proformaBefore.customerId));
        logger.info(
          `[PROFORMA DELETE] After deletion: customerId=${proformaBefore.customerId} customerName="${custAfter?.legalName}" customerDeletedAt=${custAfter?.deletedAt}`
        );
      }

      res.json({ message: "Proforma deleted" });
    } catch (error: unknown) {
      logger.error("Error deleting customer proforma:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
