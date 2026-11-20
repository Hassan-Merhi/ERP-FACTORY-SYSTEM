/**
 * Phase 5: reserve article quantities and exact loaded bale references for
 * one truck trip. These are only dispatch planning records (Option A).
 *
 * The loading's Priority Scan config is order-wide; article display order
 * follows its linked proforma (then loading lines), never a fabricated
 * per-article Priority Scan rank.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { logger } from "../../../lib/logger";
import {
  PlanningError,
  access,
  fail,
  num,
  parsePlan,
  str,
  supervisor,
} from "./loadingDispatchAllocationRoutesParsePlan";
import { readSource } from "./loadingDispatchAllocationRoutesReadSource";
import { buildOverview } from "./loadingDispatchAllocationRoutesBuildOverview";
import { z } from "zod";
import { emptyQuery, positiveIntParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// No client sends this today. parsePlan keeps its own INVALID_* answers for
// duplicate codes, negative or fractional quantities and bad bale ids.
const saveAllocationsInput = {
  params: z.strictObject({ id: positiveIntParam, dispatchId: positiveIntParam }),
  query: emptyQuery,
  body: z.strictObject({
    lines: z
      .array(
        z.strictObject({
          articleCode: z.union([z.string(), z.number()]).nullable().optional(),
          expectedQty: z.number().optional(),
        })
      )
      .optional(),
    baleIds: z.array(z.number()).optional(),
    autoAssignBales: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export function registerFactoryLoadingDispatchAllocationRoutes(app: Express) {
  app.get(
    "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/allocations",
    requireAuth,
    access,
    async (req: Request, res: Response) => {
      const state = await getFactoryAccessState(req);
      const orderId = parseId(req.params.id),
        dispatchId = parseId(req.params.dispatchId);
      if (!state) return res.status(403).json({ message: "Factory access unavailable" });
      if (orderId === null || dispatchId === null)
        return res.status(400).json({ message: "Invalid loading/dispatch ID" });
      try {
        const data = await db.transaction(async (tx) => {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          return buildOverview(await readSource(tx, state.companyId, orderId, dispatchId, false), dispatchId, orderId);
        });
        res.set("Cache-Control", "private, no-store");
        return res.json(data);
      } catch (error) {
        if (error instanceof PlanningError)
          return res.status(error.status).json({ code: error.code, message: error.message });
        logger.error("Failed to load dispatch allocation", { error });
        return res.status(500).json({ message: "Could not load truck allocations" });
      }
    }
  );

  app.put(
    "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/allocations",
    requireAuth,
    access,
    validateRequest(saveAllocationsInput),
    async (req: Request, res: Response) => {
      const state = await getFactoryAccessState(req);
      const orderId = parseId(req.params.id),
        dispatchId = parseId(req.params.dispatchId);
      if (!state) return res.status(403).json({ message: "Factory access unavailable" });
      if (!supervisor(state.role))
        return res.status(403).json({ message: "Only Admin, Owner or Developer may assign truck loads" });
      if (orderId === null || dispatchId === null)
        return res.status(400).json({ message: "Invalid loading/dispatch ID" });
      try {
        const plan = parsePlan(req.body);
        const result = await db.transaction(async (tx) => {
          // All dispatch allocation writers must lock their shared customer
          // order first, then the trip: prevents concurrent capacity oversell.
          const s = await readSource(tx, state.companyId, orderId, dispatchId, true);
          if (s.order.deletedAt || s.order.status === "CANCELLED")
            fail(409, "LOADING_INACTIVE", "Cannot allocate a deleted or cancelled loading");
          if (s.trip.status !== "OPEN") fail(409, "DISPATCH_NOT_OPEN", "Only open truck trips can be allocated");
          const overview = buildOverview(s, dispatchId, orderId);
          const loadedById = new Map(s.loaded.map((b) => [b.baleId, b]));
          const requested = new Map(plan.lines.map((line) => [line.articleCode, line.expectedQty]));
          const otherOccupied = new Map(
            overview.candidates.filter((b) => b.assignedElsewhere).map((b) => [b.baleId, b.assignedElsewhere])
          );
          for (const line of plan.lines) {
            const available = overview.articles.find((row) => row.articleCode === line.articleCode);
            if (!available)
              fail(409, "ARTICLE_NOT_LOADED", "Article " + line.articleCode + " has no bales in this loading");
            if (line.expectedQty > available.availableQty) {
              fail(
                409,
                "ARTICLE_OVERALLOCATED",
                "Article " +
                  line.articleCode +
                  " has only " +
                  available.availableQty +
                  " bales available after other trucks' reservations and scans"
              );
            }
          }

          const chosen = new Set<number>(plan.baleIds);
          for (const baleId of chosen) {
            const bale = loadedById.get(baleId);
            if (!bale) fail(409, "BALE_NOT_LOADED", "Bale #" + baleId + " is not currently in this loading");
            const conflict = otherOccupied.get(baleId);
            if (conflict)
              fail(
                409,
                "BALE_ALREADY_ASSIGNED",
                "Bale " + bale.baleReference + " belongs to Dispatch #" + conflict?.dispatchNumber
              );
            if (!requested.has(bale.articleCode))
              fail(
                409,
                "BALE_WITHOUT_TARGET",
                "Add a quantity target for article " + bale.articleCode + " before selecting its bale"
              );
          }
          // Active scans are physical facts, never discarded by plan editing.
          const selfScans = s.scans.filter((r) => str(r.dispatchId) === String(dispatchId));
          for (const scan of selfScans) {
            const b = loadedById.get(num(scan.baleId));
            if (!b)
              fail(
                409,
                "LOADING_CHANGED",
                "A scanned bale was removed from the loading. Correct the scan before planning."
              );
            if ((requested.get(b.articleCode) ?? 0) === 0)
              fail(
                409,
                "TARGET_BELOW_SCANS",
                "Keep a target for " + b.articleCode + "; this truck already has verified bales"
              );
            const conflict = otherOccupied.get(b.baleId);
            if (conflict)
              fail(
                409,
                "WRONG_TRIP_SCAN",
                "Bale " +
                  b.baleReference +
                  " was scanned here but reserved for Dispatch #" +
                  conflict.dispatchNumber +
                  ". Correct the other trip's plan before assigning it."
              );
            chosen.add(b.baleId);
          }

          const countSelected = () => {
            const m = new Map<string, number>();
            for (const id of chosen) {
              const article = loadedById.get(id)!.articleCode;
              m.set(article, (m.get(article) ?? 0) + 1);
            }
            return m;
          };
          const counts = countSelected();
          for (const [article, count] of counts)
            if (count > (requested.get(article) ?? 0))
              fail(
                409,
                "TARGET_BELOW_SELECTED",
                "Article " + article + " has " + count + " selected/scanned bale references, above the target"
              );

          if (plan.autoAssignBales) {
            for (const line of plan.lines) {
              let needed = line.expectedQty - (counts.get(line.articleCode) ?? 0);
              for (const candidate of overview.candidates) {
                if (needed <= 0) break;
                if (
                  candidate.articleCode !== line.articleCode ||
                  chosen.has(candidate.baleId) ||
                  candidate.assignedElsewhere
                )
                  continue;
                chosen.add(candidate.baleId);
                needed--;
              }
              if (needed > 0)
                fail(
                  409,
                  "EXACT_BALES_UNAVAILABLE",
                  "Not enough free exact bale references for " +
                    line.articleCode +
                    ". Reduce the target, or save article targets without auto-assignment."
                );
            }
          }

          const actor = String(state.userId);
          const actorName = String(req.session.username || actor);
          const previousIds = s.existingBales
            .filter((b) => str(b.dispatchId) === String(dispatchId))
            .map((b) => num(b.baleId));
          const kept = new Set(previousIds);
          const removed = previousIds.filter((id) => !chosen.has(id));
          const added = [...chosen].filter((id) => !kept.has(id));
          for (const id of removed) {
            await tx.execute(sql`
              UPDATE factory_loading_dispatch_expected_bales
                 SET removed_at = NOW(), removed_by_user_id = ${actor},
                     removal_reason = 'TRIP_PLAN_REPLACED'
               WHERE company_id = ${state.companyId} AND order_id = ${orderId}
                 AND dispatch_id = ${dispatchId} AND bale_id = ${id}
                 AND removed_at IS NULL
            `);
          }
          // Individual values are bound through Drizzle. The parent row lock
          // serializes assignment updates for all trucks of this loading.
          for (const id of added) {
            await tx.execute(sql`
              INSERT INTO factory_loading_dispatch_expected_bales
                (company_id, order_id, dispatch_id, bale_id, source, assigned_by_user_id)
              VALUES (${state.companyId}, ${orderId}, ${dispatchId}, ${id},
                      ${plan.autoAssignBales ? "PRIORITY" : "MANUAL"}, ${actor})
            `);
          }
          await tx.execute(sql`
            DELETE FROM factory_loading_dispatch_expected_articles
             WHERE company_id = ${state.companyId} AND order_id = ${orderId}
               AND dispatch_id = ${dispatchId}
          `);
          for (const line of plan.lines) {
            const entry = overview.articles.find((a) => a.articleCode === line.articleCode)!;
            await tx.execute(sql`
              INSERT INTO factory_loading_dispatch_expected_articles
                (company_id, order_id, dispatch_id, article_code,
                 product_name, expected_qty, priority_rank, source, assigned_by_user_id)
              VALUES (${state.companyId}, ${orderId}, ${dispatchId}, ${line.articleCode},
                      ${entry.productName}, ${line.expectedQty},
                      ${entry.priorityRank === 999999 ? null : entry.priorityRank},
                      ${plan.autoAssignBales ? "PRIORITY" : "MANUAL"}, ${actor})
            `);
          }
          await tx.execute(sql`
            INSERT INTO factory_loading_dispatch_events
              (company_id, order_id, dispatch_id, event_type, actor_user_id, actor_username, event_data)
            VALUES (${state.companyId}, ${orderId}, ${dispatchId},
                    'TRIP_ALLOCATION_UPDATED', ${actor}, ${actorName},
                    ${JSON.stringify({
                      lines: plan.lines,
                      exactBales: [...chosen],
                      addedBales: added,
                      removedBales: removed,
                      autoAssignBales: plan.autoAssignBales,
                      loadingPriority: s.priority?.priority ?? null,
                    })}::jsonb)
          `);
          return buildOverview(await readSource(tx, state.companyId, orderId, dispatchId, false), dispatchId, orderId);
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof PlanningError)
          return res.status(error.status).json({ code: error.code, message: error.message });
        logger.error("Failed to update dispatch allocation", { error });
        return res.status(500).json({ message: "Could not save truck allocation" });
      }
    }
  );
}
