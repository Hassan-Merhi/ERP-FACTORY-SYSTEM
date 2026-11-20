import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { requireAuth } from "../auth";
import { factoryBales, baleLabelPrints, referenceSequences, factoryBaleSequences } from "@shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { LabelPrintRequestError, registerBaleRoutesPart1 } from "./registerBaleRoutesPart1";
import { registerBaleRoutesPart2 } from "./registerBaleRoutesPart2";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const numberOrString = z.union([z.number(), z.string()]);

const allocatePoolInput = {
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ count: numberOrString.nullable().optional() })]),
} satisfies RequestSchemas;

const labelPrintBale = z.strictObject({
  productionBaleId: numberOrString.nullable().optional(),
  productId: numberOrString.nullable().optional(),
  articleCode: z.string().nullable().optional(),
  // Pre-allocated offline reference (client/src/lib/refPool.ts pool).
  referenceNumber: z.string().nullable().optional(),
  pieces: numberOrString.nullable().optional(),
  approxWeightKg: numberOrString.nullable().optional(),
});

const labelPrintsInput = {
  query: emptyQuery,
  body: z.strictObject({ bales: z.array(labelPrintBale).optional() }),
} satisfies RequestSchemas;

export function registerBaleRoutes(app: Express) {
  registerBaleRoutesPart1(app);

  // Helper: generate a reference number that is guaranteed not to clash with any
  // existing factory_bales ref for this company, by taking the max across both
  // sequence tables and the actual data.
  async function generateSafeRef(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    companyId: number
  ): Promise<string> {
    // Find the true max numeric ref already in use for this company
    const [maxRow] = await tx
      .select({
        m: sql<number>`COALESCE(MAX(CAST(REGEXP_REPLACE(reference_number, '[^0-9]', '', 'g') AS BIGINT)), 0)`,
      })
      .from(factoryBales)
      .where(and(eq(factoryBales.companyId, companyId), sql`reference_number ~ '^REF[0-9]+'`));
    const dbMax = Number(maxRow?.m) || 0;

    // Also check both sequence tables
    const [refSeq] = await tx
      .select()
      .from(referenceSequences)
      .where(eq(referenceSequences.companyId, companyId))
      .for("update");
    const [baleSeq] = await tx.select().from(factoryBaleSequences).where(eq(factoryBaleSequences.companyId, companyId));

    const seqMax = Math.max(refSeq?.nextNumber ?? 0, baleSeq?.nextNumber ?? 0);
    const safeNext = Math.max(dbMax + 1, seqMax, 300000);
    const referenceNumber = `REF${String(safeNext).padStart(6, "0")}`;

    // Update (or insert) referenceSequences so next call gets safeNext+1
    if (refSeq) {
      await tx
        .update(referenceSequences)
        .set({ nextNumber: safeNext + 1 })
        .where(eq(referenceSequences.id, refSeq.id));
    } else {
      await tx.insert(referenceSequences).values({ companyId, nextNumber: safeNext + 1 });
    }

    return referenceNumber;
  }

  // Bale Label Prints - pre-allocate a batch of reference numbers for offline label printing
  app.post(
    "/api/bale-label-prints/allocate-pool",
    requireAuth,
    validateRequest(allocatePoolInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const count = Math.min(Math.max(parseInt(req.body?.count ?? "200", 10) || 200, 1), 500);
        const refs = await db.transaction(async (tx) => {
          const result: string[] = [];
          for (let i = 0; i < count; i++) {
            result.push(await generateSafeRef(tx, companyId));
          }
          return result;
        });
        res.json({ refs });
      } catch (error: unknown) {
        logger.error("Error allocating label ref pool:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Bale Label Prints - create label print records with unique reference numbers
  app.post("/api/bale-label-prints", requireAuth, validateRequest(labelPrintsInput), async (req, res) => {
    try {
      // Print records and offline/standalone references keep the active
      // session company, exactly as before.
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { bales } = req.body;
      if (!bales || !Array.isArray(bales) || bales.length === 0) {
        return res.status(400).json({ message: "No bales provided" });
      }

      // A physical bale may belong to the active company or the session's
      // pinned Factory company; never to any other company.
      const authorizedCompanyIds = [
        ...new Set(
          [req.session.currentCompanyId, req.session.factoryCompanyId].filter(
            (id): id is number => Number.isSafeInteger(id) && Number(id) > 0
          )
        ),
      ];
      const physicalBaleIds = [
        ...new Set(
          bales
            .map((item: { productionBaleId?: unknown }) => Number(item.productionBaleId))
            .filter((id: number) => Number.isSafeInteger(id) && id > 0)
        ),
      ];
      const { prepareAutomaticPriorityPrintBatchTx } = await import("./factory/customer-orders/priorityAutoAllocation");
      const { PRIORITY_SCAN_LOCK_NAMESPACE } = await import("./factory/customer-orders/priorityScanQueue");
      const actorName = String(req.session.username || req.session.userId || "automatic");
      const actorId = req.session.userId == null ? null : String(req.session.userId);

      const { labelPrints, priorityAllocations } = await db.transaction(async (tx) => {
        const owners =
          physicalBaleIds.length > 0
            ? await tx
                .select({ id: factoryBales.id, companyId: factoryBales.companyId })
                .from(factoryBales)
                .where(
                  and(inArray(factoryBales.id, physicalBaleIds), inArray(factoryBales.companyId, authorizedCompanyIds))
                )
            : [];
        const ownerById = new Map(owners.map((row) => [row.id, row.companyId]));
        if (ownerById.size !== physicalBaleIds.length) {
          throw new LabelPrintRequestError("Cannot print a physical bale belonging to another company or not found");
        }
        const baleCompanyIds = [...new Set(owners.map((row) => row.companyId))].sort((a, b) => a - b);
        // Priority Scan queue locks come first (ascending company), matching
        // Stock Entry, before any bale/reference-sequence row locks below.
        // One statement takes every lock, in ascending company order.
        if (baleCompanyIds.length > 0) {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, company_id)
              FROM (
                SELECT company_id
                  FROM unnest(string_to_array(${baleCompanyIds.join(",")}, ',')::int[]) AS company_id
                 ORDER BY company_id
              ) ordered_companies
          `);
        }

        const results = [];
        for (const bale of bales) {
          let referenceNumber: string;

          // If the bale already has a reference number (assigned by stock-entry),
          // reuse it — do NOT generate a new one or we'll collide with factory_bales unique constraint.
          if (bale.productionBaleId) {
            const baleCompanyId = ownerById.get(Number(bale.productionBaleId))!;
            const [existingBale] = await tx
              .select({ referenceNumber: factoryBales.referenceNumber })
              .from(factoryBales)
              .where(and(eq(factoryBales.id, bale.productionBaleId), eq(factoryBales.companyId, baleCompanyId)));

            if (existingBale?.referenceNumber) {
              // Bale already has a reference (e.g. assigned by stock-entry) — reuse it
              referenceNumber = existingBale.referenceNumber;
            } else {
              // Bale has no ref yet (e.g. pressing batch bale) — generate one safely
              referenceNumber = await generateSafeRef(tx, companyId);
              await tx
                .update(factoryBales)
                .set({ referenceNumber })
                .where(and(eq(factoryBales.id, bale.productionBaleId), eq(factoryBales.companyId, baleCompanyId)));
            }
          } else if (bale.referenceNumber) {
            // Pre-allocated offline ref — use it directly (sequence was already advanced)
            referenceNumber = bale.referenceNumber;
          } else {
            // No productionBaleId — standalone label print, generate from sequence
            referenceNumber = await generateSafeRef(tx, companyId);
          }

          const [labelPrint] = await tx
            .insert(baleLabelPrints)
            .values({
              companyId,
              productionBaleId: bale.productionBaleId || null,
              productId: bale.productId || null,
              articleCode: bale.articleCode,
              referenceNumber,
              pieces: bale.pieces || 1,
              approxWeightKg: String(bale.approxWeightKg),
              printedByUserId: req.session.userId || null,
              printedAt: new Date(),
            })
            .returning();

          results.push(labelPrint);
        }

        // Resolve priority assignments in the SAME transaction as the print
        // records, after every bale has its reference: either both commit or
        // neither does. Saved snapshots are returned even when the mode is OFF;
        // the mode only gates NEW automatic allocations.
        const allocations = [];
        for (const ownerCompanyId of baleCompanyIds) {
          const ids = physicalBaleIds.filter((id) => ownerById.get(id) === ownerCompanyId);
          const prepared = await prepareAutomaticPriorityPrintBatchTx(
            tx,
            ownerCompanyId,
            ids.map((baleId) => ({ baleId })),
            actorName,
            actorId
          );
          for (const item of prepared) if (item.priorityAllocation) allocations.push(item.priorityAllocation);
        }
        return { labelPrints: results, priorityAllocations: allocations };
      });

      // Diagnose missing priority colors without exposing customer/order details.
      // HTTP 200 alone does not mean the priority-color assignment succeeded.
      const allocatedIds = new Set(priorityAllocations.map((row) => Number(row.baleId)));
      const uncolored = labelPrints.filter(
        (row) => row.productionBaleId && !allocatedIds.has(Number(row.productionBaleId))
      );
      if (uncolored.length > 0) {
        logger.warn("Priority print returned uncolored physical bales", {
          event: "bale-label-prints.missing-priority-color",
          companyId,
          referenceNumbers: uncolored.map((row) => row.referenceNumber),
          baleIds: uncolored.map((row) => row.productionBaleId),
          printedCount: labelPrints.length,
          assignedCount: priorityAllocations.length,
        });
      }
      res.json({ labelPrints, priorityAllocations });
    } catch (error: unknown) {
      if (error instanceof LabelPrintRequestError) {
        return res.status(400).json({ message: error.message });
      }
      logger.error("Error creating bale label prints:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
  registerBaleRoutesPart2(app);

  // Orphaned Records Cleanup API - Find and reassign vouchers with deleted locations + unbalanced vouchers
}
