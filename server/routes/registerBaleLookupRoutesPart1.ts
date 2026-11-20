// Extracted from ./baleLookupRoutes.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../lib/validateRequest";
import { writeAuditEvent } from "../services/audit/auditService";
import { deletePhysicalFactoryBalesTx, PhysicalBaleDeletionError } from "./factory/stock/physicalBaleDeletion";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "./factory/customer-orders/priorityScanQueue";
import { auditLog, baleLabelPrints, factoryBales } from "@shared/schema";
import { baleLookupRoutesStep } from "./baleLookupRoutesStep";
import { baleLookupRoutesStep2 } from "./baleLookupRoutesStep2";

// Both actions take only the reference number from the path; clients send {}.
const referenceActionInput = {
  params: z.strictObject({ referenceNumber: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerBaleLookupRoutesPart1(app: Express) {
  // Lookup by REFERENCE number
  app.get("/api/lookup/reference/:referenceNumber", requireAuth, async (req, res) => {
    try {
      const blr1 = await baleLookupRoutesStep({ req, res });
      if (blr1.done) return blr1.value;
      const { labelPrint, printedByName, scannedByName, product } = blr1;
      const blr2 = await baleLookupRoutesStep2({ blr1, res });
      if (blr2.done) return blr2.value;
      const { loadedOnOrder, baleInfo, locationInfo, pressingBatch, mixBatch, containers_used } = blr2;

      // If the bale's stored status is IN_STOCK but it's already on a finalized order,
      // derive the correct effective status so the Bale Explorer shows it accurately.
      if (baleInfo && baleInfo.status === "IN_STOCK" && loadedOnOrder?.status) {
        if (["FINALIZED", "DISPATCHED", "SOLD"].includes(loadedOnOrder.status)) {
          baleInfo.status = "SOLD";
        } else if (loadedOnOrder.status === "LOADING") {
          baleInfo.status = "LOADING";
        } else if (["PENDING_VERIFICATION", "VERIFIED"].includes(loadedOnOrder.status)) {
          baleInfo.status = "RESERVED_FOR_ORDER";
        }
      }

      // Fetch audit history for this bale
      let auditHistory: unknown[] = [];
      if (baleInfo?.id) {
        auditHistory = await db
          .select({
            id: auditLog.id,
            action: auditLog.action,
            username: auditLog.username,
            changes: auditLog.changes,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(and(eq(auditLog.tableName, "factory_bales"), eq(auditLog.recordId, baleInfo.id)))
          .orderBy(desc(auditLog.createdAt))
          .limit(30);
      }

      res.json({
        labelPrint: { ...labelPrint, printedByName, scannedByName },
        product: product || null,
        baleInfo,
        locationInfo,
        pressingBatch,
        mixBatch,
        containers_used,
        loadedOnOrder,
        auditHistory,
      });
    } catch (error: unknown) {
      logger.error("Error looking up reference:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Mark a label as scanned
  app.post(
    "/api/lookup/reference/:referenceNumber/scan",
    requireAuth,
    validateRequest(referenceActionInput),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
        const labelMatches = await db
          .select({ id: baleLabelPrints.id })
          .from(baleLabelPrints)
          .where(
            and(
              sql`LOWER(TRIM(${baleLabelPrints.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
              eq(baleLabelPrints.companyId, companyId)
            )
          )
          .limit(2);

        if (labelMatches.length === 0) {
          return res.status(404).json({ message: "Reference number not found" });
        }
        if (labelMatches.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        const [updated] = await db
          .update(baleLabelPrints)
          .set({
            scannedByUserId: req.session.userId || null,
            scannedAt: new Date(),
          })
          .where(eq(baleLabelPrints.id, labelMatches[0].id))
          .returning();

        const scannedUser = await storage.getUser(req.session.userId!);
        res.json({ ...updated, scannedByName: scannedUser?.username || null });
      } catch (error: unknown) {
        logger.error("Error scanning label:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Admin: Delete bale/reference everywhere (soft-delete the factory bale)
  app.delete(
    "/api/lookup/reference/:referenceNumber/delete-everywhere",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    validateRequest(referenceActionInput),
    async (req, res) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
        const labelMatches = await db
          .select({ id: baleLabelPrints.id, productionBaleId: baleLabelPrints.productionBaleId })
          .from(baleLabelPrints)
          .where(
            and(
              sql`LOWER(TRIM(${baleLabelPrints.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
              eq(baleLabelPrints.companyId, companyId)
            )
          )
          .limit(2);

        const linkedBaleIds = [
          ...new Set(labelMatches.map((label) => label.productionBaleId).filter((id): id is number => id != null)),
        ];
        if (linkedBaleIds.length > 1) {
          return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
        }

        let bale: typeof factoryBales.$inferSelect | undefined;
        if (linkedBaleIds.length === 1) {
          [bale] = await db
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, linkedBaleIds[0])))
            .limit(1);
        }

        if (!bale) {
          const baleMatches = await db
            .select()
            .from(factoryBales)
            .where(
              and(
                sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`,
                eq(factoryBales.companyId, companyId)
              )
            )
            .limit(2);

          if (baleMatches.length === 0) {
            return res.status(404).json({ message: "Bale not found for this reference" });
          }
          if (baleMatches.length > 1) {
            return res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" });
          }
          bale = baleMatches[0];
        }

        // Same authoritative physical deletion as every other route: it refuses
        // bales on verified/finalized loadings (409), reverses open loading links,
        // totals and Priority Scan state, and posts one ERP decrement, canonical
        // movement and daybook entry, all in one transaction.
        const baleId = bale.id;
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
          await deletePhysicalFactoryBalesTx(tx, {
            companyId,
            baleIds: [baleId],
            actorId: req.session.userId == null ? null : String(req.session.userId),
            actorName: String(req.session.username || req.session.userId || "unknown"),
            reason: "Bale deleted everywhere from Barcode Lookup",
          });
          // Audit in the deletion's transaction ("Deleted by" on the barcode lookup).
          await writeAuditEvent(
            {
              userId: String(req.session.userId ?? "unknown"),
              username: req.session.username || "unknown",
              companyId,
              action: "delete",
              tableName: "factory_bales",
              recordId: baleId,
              recordIdentifier: referenceNumber,
              changes: { status: { old: bale.status, new: "DELETED" } },
            },
            tx
          );
        });

        res.json({ message: "Bale deleted from linked records" });
      } catch (error: unknown) {
        if (error instanceof PhysicalBaleDeletionError) {
          return res.status(error.status).json({ message: error.message });
        }
        logger.error("Error deleting bale everywhere:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
