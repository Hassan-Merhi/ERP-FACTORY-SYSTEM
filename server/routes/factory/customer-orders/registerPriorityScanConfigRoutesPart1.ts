// Extracted from ./priorityScanConfigRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { advanceSatisfiedPriorityScanConfigs } from "./priorityScanQueue";
import { customerOrderPriorityScanConfigs, customerOrders, factoryBales } from "@shared/schema";
import { runAutomaticPriorityPrintBatch, runAutomaticPriorityReprint } from "./priorityAutoAllocation";
import { registerPriorityAllocationHistoryRoutes } from "./priorityAllocationHistoryRoutes";
import { PRIORITY_SCAN_LIST_PATH, disableStalePriorityScanConfigs } from "./disableStalePriorityScanConfigs";
import { registerPriorityScanConfigRoutesPart2 } from "./registerPriorityScanConfigRoutesPart2";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// client/src/lib/priorityPrintPreflight.ts sends { items: [{ baleId } | { referenceNumber }] };
// the handler keeps its 1–200 valid items check.
const printPreflightBatchInput = {
  query: emptyQuery,
  body: z.strictObject({
    items: z
      .array(z.strictObject({ baleId: z.number().optional(), referenceNumber: z.string().optional() }))
      .optional(),
  }),
} satisfies RequestSchemas;

// The handler keeps its "referenceNumber required" check.
const printPreflightInput = {
  query: emptyQuery,
  body: z.strictObject({ referenceNumber: z.string().optional() }),
} satisfies RequestSchemas;

export function registerPriorityScanConfigRoutesPart1(app: Express) {
  registerPriorityAllocationHistoryRoutes(app);
  // Prepare whole sets of existing factory bales before any label is rendered.
  // Each request is atomic: a bad reference cannot leave half the set newly
  // allocated. Existing snapshot colors are returned even when the switch is OFF.
  app.post(
    "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch",
    requireAuth,
    validateRequest(printPreflightBatchInput),
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
    validateRequest(printPreflightInput),
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

  registerPriorityScanConfigRoutesPart2(app);

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
}
