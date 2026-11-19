// Extracted from ./registerPriorityScanConfigRoutesPart1.ts
import type { Express, Request, Response } from "express";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { getCompanyBusinessDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { firstRow, resultRows } from "../../../lib/queryResult";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { evaluateProformaArticleCapacity } from "./proformaCapacityEnforcement";
import { advanceSatisfiedPriorityScanConfigs } from "./priorityScanQueue";
import { customerOrderPriorityScanConfigs, customerOrders, factoryBales } from "@shared/schema";
import { PRIORITY_SCAN_ROUTE_PATH, disableStalePriorityScanConfigs } from "./disableStalePriorityScanConfigs";

export function registerPriorityScanConfigRoutesPart2(app: Express) {
  app.get(PRIORITY_SCAN_ROUTE_PATH, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      if (req.query.view === "today-history") {
        const companySettings = await storage.getCompanySettings(companyId);
        const businessDate = getCompanyBusinessDate(companySettings?.timezone);
        // The scanner polls this every second. Most polls find nothing new, so
        // a client that sends back the signature of the list it already has
        // gets a few bytes instead of the whole day's history again.
        const signatureResult = await db.execute(sql`
          SELECT count(*)::int AS "count", coalesce(max(id), 0)::text AS "maxId"
          FROM factory_priority_scan_history
          WHERE company_id = ${companyId}
            AND business_date = ${businessDate}
            AND reversed_at IS NULL
        `);
        const [signatureRow] = resultRows(signatureResult) as Array<{ count: number; maxId: string }>;
        const signature = `${businessDate}:${signatureRow?.count ?? 0}:${signatureRow?.maxId ?? 0}`;
        res.set("Cache-Control", "private, no-store");
        if (req.query.known === signature) {
          return res.json({ businessDate, serverNow: new Date().toISOString(), signature, unchanged: true });
        }
        const historyResult = await db.execute(sql`
          SELECT id,
                 reference_number AS "referenceNumber",
                 product_name AS "productName",
                 article_code AS "articleCode",
                 order_id AS "orderId",
                 priority,
                 color,
                 scanned_by AS "scannedBy",
                 scanned_at AS "scannedAt"
          FROM factory_priority_scan_history
          WHERE company_id = ${companyId}
            AND business_date = ${businessDate}
            AND reversed_at IS NULL
          ORDER BY scanned_at DESC, id DESC
        `);
        return res.json({
          businessDate,
          serverNow: new Date().toISOString(),
          signature,
          scans: resultRows(historyResult),
        });
      }

      await disableStalePriorityScanConfigs(companyId);
      await advanceSatisfiedPriorityScanConfigs(companyId);

      const rawCode = typeof req.query.code === "string" ? req.query.code.trim() : "";
      if (!rawCode) return res.status(400).json({ message: "code is required" });

      const scanLower = rawCode.toLocaleLowerCase("en-US");

      const [bale] = await db
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          baleCode: factoryBales.baleCode,
          articleCode: factoryBales.articleCode,
          productName: factoryBales.productName,
          productId: factoryBales.productId,
          erpLocationId: factoryBales.erpLocationId,
          canonicalArticleCode: sql<string | null>`(
            SELECT fbp.article_code
            FROM factory_bale_products fbp
            WHERE fbp.id = ${factoryBales.productId}
              AND fbp.company_id = ${companyId}
            LIMIT 1
          )`,
          canonicalProductName: sql<string | null>`(
            SELECT fbp.name
            FROM factory_bale_products fbp
            WHERE fbp.id = ${factoryBales.productId}
              AND fbp.company_id = ${companyId}
            LIMIT 1
          )`,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            isNull(factoryBales.deletedAt),
            eq(factoryBales.status, "IN_STOCK"),
            or(
              sql`LOWER(${factoryBales.referenceNumber}) = ${scanLower}`,
              sql`LOWER(${factoryBales.baleCode}) = ${scanLower}`
            )
          )
        )
        .limit(1);

      if (!bale) {
        return res.status(404).json({ message: "Reference is not available in stock." });
      }
      if (!bale.erpLocationId) {
        return res.status(409).json({ message: "Reference has no stock location and cannot be routed." });
      }

      const duplicateCheck = await db.execute(sql`
        SELECT cob.order_id, co.status, co.invoice_number
        FROM customer_order_bales cob
        JOIN customer_orders co ON co.id = cob.order_id
        WHERE cob.bale_id = ${bale.id}
          AND co.status <> 'CANCELLED'
          AND co.deleted_at IS NULL
        ORDER BY cob.order_id
        LIMIT 1
      `);
      const duplicate = firstRow(duplicateCheck);
      if (duplicate) {
        const orderRef = duplicate.invoice_number
          ? `invoice ${duplicate.invoice_number}`
          : `loading #${duplicate.order_id}`;
        return res.status(409).json({
          message: `Bale ${bale.referenceNumber} is already in ${orderRef} (${duplicate.status}).`,
        });
      }

      const effectiveArticleCode = (bale.articleCode || bale.canonicalArticleCode || "").trim();
      if (!effectiveArticleCode) {
        return res.status(409).json({ message: "Reference has no article code and cannot be matched to a priority." });
      }

      const queue = await db
        .select({
          orderId: customerOrderPriorityScanConfigs.orderId,
          color: customerOrderPriorityScanConfigs.color,
          priority: customerOrderPriorityScanConfigs.priority,
          proformaIdUsed: customerOrders.proformaIdUsed,
        })
        .from(customerOrderPriorityScanConfigs)
        .innerJoin(customerOrders, eq(customerOrders.id, customerOrderPriorityScanConfigs.orderId))
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrderPriorityScanConfigs.enabled, true),
            eq(customerOrders.companyId, companyId),
            eq(customerOrders.status, "LOADING"),
            isNull(customerOrders.deletedAt)
          )
        )
        .orderBy(asc(customerOrderPriorityScanConfigs.priority), asc(customerOrderPriorityScanConfigs.orderId));

      const candidates: Array<{
        orderId: number;
        priority: number;
        color: string;
        proformaId: number;
        remainingQty: number;
      }> = [];
      let matchesAnyActiveProforma = false;

      for (const row of queue) {
        if (!row.proformaIdUsed) continue;
        const snapshot = await getProformaCapacitySnapshot(db, {
          companyId,
          proformaId: row.proformaIdUsed,
          currentOrderId: row.orderId,
        });
        if (!snapshot) continue;
        const decision = evaluateProformaArticleCapacity(snapshot, effectiveArticleCode, 1, "per_loading");
        if (decision.reason !== "not_in_proforma") matchesAnyActiveProforma = true;
        if (!decision.allowed) continue;
        candidates.push({
          orderId: row.orderId,
          priority: row.priority,
          color: row.color,
          proformaId: row.proformaIdUsed,
          remainingQty: decision.remainingQty,
        });
      }

      if (candidates.length === 0) {
        return res.status(409).json({
          code: matchesAnyActiveProforma ? "PRIORITY_SCAN_NO_CAPACITY" : "PRIORITY_SCAN_NOT_REQUIRED",
          message:
            "This reference is not required by any active Priority Scan loading. Use the normal Pending Loading scanner for overload or items not requested on the proforma.",
          referenceNumber: bale.referenceNumber,
          articleCode: effectiveArticleCode,
        });
      }

      return res.json({
        referenceNumber: bale.referenceNumber,
        baleId: bale.id,
        productName: bale.canonicalProductName || bale.productName || null,
        articleCode: effectiveArticleCode,
        locationId: bale.erpLocationId,
        target: candidates[0],
        candidates,
      });
    } catch (error: unknown) {
      logger.error("Error resolving Priority Scan route", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to resolve Priority Scan destination." });
    }
  });
}
