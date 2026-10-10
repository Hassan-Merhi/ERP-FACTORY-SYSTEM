import type { Express, Request, Response } from "express";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { getCompanyBusinessDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { firstRow, resultRows } from "../../../lib/queryResult";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity } from "./proformaCapacityEnforcement";
import {
  advanceSatisfiedPriorityScanConfigs,
  loadActivePriorityRows,
  PRIORITY_SCAN_LOCK_NAMESPACE,
  rewriteActivePriorityQueue,
} from "./priorityScanQueue";
import { customerOrderPriorityScanConfigs, customerOrders, factoryBales } from "@shared/schema";
import { runAutomaticPriorityPrintBatch, runAutomaticPriorityReprint } from "./priorityAutoAllocation";
import { registerPriorityAllocationHistoryRoutes } from "./priorityAllocationHistoryRoutes";

import { isApprovedPriorityScanColor, PRIORITY_SCAN_COLORS } from "@shared/priorityScanColors";

const MAX_PRIORITY = 10_000;
const PRIORITY_SCAN_LIST_PATH = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const PRIORITY_SCAN_ORDER_PATH = "/api/factory/customer-orders/:id/loading-list/priority-scan-config";
const PRIORITY_SCAN_ROUTE_PATH = "/api/factory/customer-orders/loading-list/priority-scan-route";

function normalizeColor(raw: unknown): { color: string; colorKey: string } | null {
  if (!isApprovedPriorityScanColor(raw)) return null;
  // Persist the approved canonical uppercase HEX value regardless of input casing.
  const color = PRIORITY_SCAN_COLORS.find((preset) => preset.toLowerCase() === raw.toLowerCase())!;
  return { color, colorKey: color.toLowerCase() };
}

function parsePriority(raw: unknown): number | null {
  const priority = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(priority) && priority > 0 && priority <= MAX_PRIORITY ? priority : null;
}

function canManagePriorityPosition(req: Request): boolean {
  const role = String(req.session.currentRole || req.session.role || req.user?.role || "").toLocaleLowerCase("en-US");
  return role === "admin" || role === "developer" || role === "owner";
}

function uniqueConstraint(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; constraint?: unknown };
  return value.code === "23505" && typeof value.constraint === "string" ? value.constraint : null;
}

function sendPriorityConflict(res: Response, constraint: string | null) {
  if (constraint === "copsc_active_color_unique") {
    return res.status(409).json({ message: "That color is already assigned to another active priority loading." });
  }
  if (constraint === "copsc_active_priority_unique") {
    return res.status(409).json({ message: "That priority is already assigned to another active priority loading." });
  }
  return res.status(409).json({ message: "Priority Scan configuration changed at the same time. Please try again." });
}

async function disableStalePriorityScanConfigs(companyId: number): Promise<void> {
  // Stale cleanup is a QUEUE WRITE, even when triggered by a GET request.
  // Serialize it with stock-entry routing, manual scan, deletion/recovery,
  // and configuration edits. A read must never race a queue rewrite.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    const disabled = await tx.execute(sql`
      UPDATE customer_order_priority_scan_configs AS config
      SET enabled = FALSE,
          updated_by = NULL,
          updated_by_name = 'system:stale-disabled',
          updated_at = now()
      FROM customer_orders AS order_row
      WHERE config.order_id = order_row.id
        AND config.company_id = ${companyId}
        AND order_row.company_id = ${companyId}
        AND config.enabled = TRUE
        AND (
          order_row.status <> 'LOADING'
          OR order_row.deleted_at IS NOT NULL
          OR order_row.proforma_id_used IS NULL
        )
      RETURNING config.id
    `);
    if (resultRows(disabled).length === 0) return;
    const active = await loadActivePriorityRows(tx, companyId);
    await rewriteActivePriorityQueue(
      tx,
      companyId,
      active.map((row) => row.id),
      null,
      "system:stale-compact"
    );
  });
}

class PriorityScanConfigError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function registerPriorityScanConfigRoutes(app: Express) {
  registerPriorityAllocationHistoryRoutes(app);
  // Prepare whole sets of existing factory bales before any label is rendered.
  // Each request is atomic: a bad reference cannot leave half the set newly
  // allocated. Existing snapshot colors are returned even when the switch is OFF.
  app.post(
    "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const items = req.body?.items;
        if (
          !Array.isArray(items) ||
          items.length === 0 ||
          items.length > 200 ||
          items.some(
            (item) =>
              !item ||
              typeof item !== "object" ||
              ((item.baleId === undefined || !Number.isSafeInteger(item.baleId) || item.baleId < 1) &&
                (typeof item.referenceNumber !== "string" || !item.referenceNumber.trim()))
          )
        ) {
          return res.status(400).json({ message: "Provide 1–200 valid bale IDs or reference numbers" });
        }
        const results = await runAutomaticPriorityPrintBatch(
          companyId,
          items,
          String(req.session.username || req.session.userId || "automatic"),
          req.session.userId == null ? null : String(req.session.userId)
        );
        res.set("Cache-Control", "private, no-store");
        return res.json({ results });
      } catch (error) {
        logger.error("Automatic Priority Print batch preflight failed", { error });
        const message = getErrorMessage(error);
        if (/Bale not found|Print reference does not match|Invalid|requires|must contain/i.test(message)) {
          return res.status(400).json({ message });
        }
        return res.status(500).json({ message: "Failed to prepare priority labels" });
      }
    }
  );

  // Used by specialist relabel screens where the API returns a REF but not a
  // physical bale ID. Resolve server-side, never trusting the client to choose
  // a loading or a priority color.
  app.post(
    "/api/factory/customer-orders/loading-list/automatic-print-preflight",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const referenceNumber = String(req.body?.referenceNumber || "").trim();
        if (!referenceNumber) return res.status(400).json({ message: "referenceNumber required" });
        const [bale] = await db
          .select({ id: factoryBales.id })
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              isNull(factoryBales.deletedAt),
              sql`LOWER(${factoryBales.referenceNumber}) = ${referenceNumber.toLowerCase()}`
            )
          )
          .limit(1);
        if (!bale) return res.status(404).json({ message: "Bale not found" });
        const priorityAllocation = await runAutomaticPriorityReprint(
          companyId,
          bale.id,
          String(req.session.username || req.session.userId || "automatic"),
          req.session.userId == null ? null : String(req.session.userId)
        );
        return res.json({ priorityAllocation });
      } catch (error) {
        logger.error("Automatic Priority Print preflight failed", { error });
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

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

  app.get(PRIORITY_SCAN_LIST_PATH, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      await disableStalePriorityScanConfigs(companyId);
      await advanceSatisfiedPriorityScanConfigs(companyId);

      const rows = await db
        .select({
          id: customerOrderPriorityScanConfigs.id,
          companyId: customerOrderPriorityScanConfigs.companyId,
          orderId: customerOrderPriorityScanConfigs.orderId,
          color: customerOrderPriorityScanConfigs.color,
          priority: customerOrderPriorityScanConfigs.priority,
          enabled: customerOrderPriorityScanConfigs.enabled,
          createdBy: customerOrderPriorityScanConfigs.createdBy,
          createdByName: customerOrderPriorityScanConfigs.createdByName,
          updatedBy: customerOrderPriorityScanConfigs.updatedBy,
          updatedByName: customerOrderPriorityScanConfigs.updatedByName,
          createdAt: customerOrderPriorityScanConfigs.createdAt,
          updatedAt: customerOrderPriorityScanConfigs.updatedAt,
          orderStatus: customerOrders.status,
          proformaIdUsed: customerOrders.proformaIdUsed,
        })
        .from(customerOrderPriorityScanConfigs)
        .innerJoin(customerOrders, eq(customerOrders.id, customerOrderPriorityScanConfigs.orderId))
        .where(
          and(
            eq(customerOrderPriorityScanConfigs.companyId, companyId),
            eq(customerOrders.companyId, companyId),
            isNull(customerOrders.deletedAt)
          )
        )
        .orderBy(asc(customerOrderPriorityScanConfigs.priority), asc(customerOrderPriorityScanConfigs.orderId));

      return res.json(rows);
    } catch (error: unknown) {
      logger.error("Error listing Priority Scan configs", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to load Priority Scan configuration." });
    }
  });

  app.put(PRIORITY_SCAN_ORDER_PATH, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      await disableStalePriorityScanConfigs(companyId);

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid loading id" });

      // An existing legacy priority may be moved without recoloring it.
      // Every create, re-enable or color edit still requires an approved color.
      const moveOnly = req.body?.color === undefined && req.body?.enabled === true;
      const normalizedRequestedColor = moveOnly ? null : normalizeColor(req.body?.color);
      if (!moveOnly && !normalizedRequestedColor) {
        return res.status(400).json({ message: "Priority color must be one of the 11 approved HEX colors." });
      }

      const canManagePriority = canManagePriorityPosition(req);
      if (moveOnly && !canManagePriority) {
        return res.status(403).json({ code: "PRIORITY_POSITION_ADMIN_ONLY", message: "Access denied" });
      }
      if (!canManagePriority && req.body?.priority !== undefined) {
        return res.status(403).json({ code: "PRIORITY_POSITION_ADMIN_ONLY", message: "Access denied" });
      }

      const requestedPriority = canManagePriority ? parsePriority(req.body?.priority) : null;
      if (canManagePriority && requestedPriority === null) {
        return res.status(400).json({ message: "Priority must be a whole number between 1 and 10000." });
      }

      if (req.body?.enabled !== undefined && typeof req.body.enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be true or false." });
      }
      const enabled = req.body?.enabled !== false;

      const actorId = req.session.userId == null ? null : String(req.session.userId);
      const actorName = String(req.session.username ?? req.session.userId ?? "unknown");

      const saved = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);

        const [order] = await tx
          .select({
            id: customerOrders.id,
            status: customerOrders.status,
            proformaIdUsed: customerOrders.proformaIdUsed,
          })
          .from(customerOrders)
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          )
          .limit(1);

        if (!order) throw new PriorityScanConfigError(404, "Pending loading not found.");
        if (order.status !== "LOADING") {
          throw new PriorityScanConfigError(409, "Only pending loadings in LOADING status can use Priority Scan.");
        }
        if (enabled && !order.proformaIdUsed) {
          throw new PriorityScanConfigError(409, "Link a proforma before enabling Priority Scan for this loading.");
        }
        if (enabled && order.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
          const snapshot = await getProformaCapacitySnapshot(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
            currentOrderId: orderId,
          });
          if (snapshot && snapshot.requestedTotalQty > 0 && snapshot.remainingTotalQty <= 0) {
            throw new PriorityScanConfigError(
              409,
              "This loading already satisfies its linked proforma and does not need Priority Scan."
            );
          }
        }

        const existing = await tx
          .select({
            id: customerOrderPriorityScanConfigs.id,
            createdBy: customerOrderPriorityScanConfigs.createdBy,
            createdByName: customerOrderPriorityScanConfigs.createdByName,
            priority: customerOrderPriorityScanConfigs.priority,
            color: customerOrderPriorityScanConfigs.color,
            colorKey: customerOrderPriorityScanConfigs.colorKey,
            enabled: customerOrderPriorityScanConfigs.enabled,
          })
          .from(customerOrderPriorityScanConfigs)
          .where(
            and(
              eq(customerOrderPriorityScanConfigs.companyId, companyId),
              eq(customerOrderPriorityScanConfigs.orderId, orderId)
            )
          )
          .limit(1);

        if (moveOnly && !existing[0]?.enabled) {
          throw new PriorityScanConfigError(409, "Only an existing active priority can be moved without choosing a new color.");
        }
        const normalizedColor = moveOnly
          ? { color: existing[0].color, colorKey: existing[0].colorKey }
          : normalizedRequestedColor!;

        const activeRows = await loadActivePriorityRows(tx, companyId);
        if (enabled && activeRows.some((row) => row.orderId !== orderId && row.colorKey === normalizedColor.colorKey)) {
          throw new PriorityScanConfigError(409, "That color is already assigned to another active priority loading.");
        }

        const remainingActiveIds = activeRows.filter((row) => row.orderId !== orderId).map((row) => row.id);
        const effectivePriority = canManagePriority
          ? requestedPriority!
          : existing[0]?.enabled
            ? existing[0].priority
            : remainingActiveIds.length + 1;

        // Temporarily keep the target disabled while the active queue is rewritten.
        // This releases the partial unique indexes so moving #2 to #1 can be done
        // atomically without transient duplicate-priority failures.
        const [target] = await tx
          .insert(customerOrderPriorityScanConfigs)
          .values({
            companyId,
            orderId,
            color: normalizedColor.color,
            colorKey: normalizedColor.colorKey,
            priority: effectivePriority,
            enabled: false,
            createdBy: existing[0]?.createdBy ?? actorId,
            createdByName: existing[0]?.createdByName ?? actorName,
            updatedBy: actorId,
            updatedByName: actorName,
          })
          .onConflictDoUpdate({
            target: [customerOrderPriorityScanConfigs.companyId, customerOrderPriorityScanConfigs.orderId],
            set: {
              color: normalizedColor.color,
              colorKey: normalizedColor.colorKey,
              priority: effectivePriority,
              enabled: false,
              updatedBy: actorId,
              updatedByName: actorName,
              updatedAt: sql`now()`,
            },
          })
          .returning();

        if (enabled) {
          const insertAt = Math.min(Math.max(effectivePriority - 1, 0), remainingActiveIds.length);
          const orderedIds = [...remainingActiveIds];
          orderedIds.splice(insertAt, 0, target.id);
          await rewriteActivePriorityQueue(tx, companyId, orderedIds, actorId, actorName);
        } else if (existing[0]?.enabled) {
          await rewriteActivePriorityQueue(tx, companyId, remainingActiveIds, actorId, actorName);
        }

        const [result] = await tx
          .select()
          .from(customerOrderPriorityScanConfigs)
          .where(
            and(
              eq(customerOrderPriorityScanConfigs.companyId, companyId),
              eq(customerOrderPriorityScanConfigs.orderId, orderId)
            )
          )
          .limit(1);
        return result;
      });

      return res.json(saved);
    } catch (error: unknown) {
      if (error instanceof PriorityScanConfigError) {
        return res.status(error.status).json({ message: error.message });
      }
      const constraint = uniqueConstraint(error);
      if (constraint) return sendPriorityConflict(res, constraint);
      logger.error("Error saving Priority Scan config", { error: getErrorMessage(error) });
      return res.status(500).json({ message: "Failed to save Priority Scan configuration." });
    }
  });

  app.delete(
    "/api/factory/customer-orders/:id/loading-list/priority-scan-config",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!canManagePriorityPosition(req)) {
          return res.status(403).json({ code: "PRIORITY_POSITION_ADMIN_ONLY", message: "Access denied" });
        }

        const orderId = parseId(req.params.id);
        if (orderId === null) return res.status(400).json({ message: "Invalid loading id" });

        const actorId = req.session.userId == null ? null : String(req.session.userId);
        const actorName = String(req.session.username ?? req.session.userId ?? "unknown");

        const cleared = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);

          const activeRows = await loadActivePriorityRows(tx, companyId);
          const targetWasActive = activeRows.some((row) => row.orderId === orderId);

          const deleted = await tx
            .delete(customerOrderPriorityScanConfigs)
            .where(
              and(
                eq(customerOrderPriorityScanConfigs.companyId, companyId),
                eq(customerOrderPriorityScanConfigs.orderId, orderId)
              )
            )
            .returning({ id: customerOrderPriorityScanConfigs.id });

          if (targetWasActive) {
            const remainingIds = activeRows.filter((row) => row.orderId !== orderId).map((row) => row.id);
            await rewriteActivePriorityQueue(tx, companyId, remainingIds, actorId, actorName);
          }

          return deleted.length > 0;
        });

        return res.json({ success: true, cleared });
      } catch (error: unknown) {
        logger.error("Error clearing Priority Scan config", { error: getErrorMessage(error) });
        return res.status(500).json({ message: "Failed to clear Priority Scan configuration." });
      }
    }
  );
}
