/**
 * factoryDispatchBatchRoutes: DispatchTruckRideDispatch endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";
import { sql, eq, and } from "drizzle-orm";
import { customerDispatchBatches, customerDispatchTruckRides } from "@shared/schema";

import { getCompanyId, isAdmin } from "./_helpers";
import { firstRow } from "../../../lib/queryResult";

const dispatchRideInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
// The handler keeps its own "reason is required" check and message.
const reopenRideInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ reason: z.string().optional() }),
} satisfies RequestSchemas;

export function registerDispatchTruckRideDispatchRoutes(app: Express) {
  // ── POST /api/factory/dispatch-truck-rides/:id/dispatch ───────────────────
  // Mark a truck ride as DISPATCHED — locks bales for this ride
  app.post(
    "/api/factory/dispatch-truck-rides/:id/dispatch",
    requireAuth,
    validateRequest(dispatchRideInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const rideId = validatedInput(req, dispatchRideInput).params.id;

        const result = await db.transaction(async (tx) => {
          const [ride] = await tx
            .select()
            .from(customerDispatchTruckRides)
            .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)));
          if (!ride) throw new Error("Ride not found");
          if (ride.status === "DISPATCHED") throw new Error("Ride already dispatched");
          if (ride.status === "CANCELLED") throw new Error("Ride is cancelled");

          // Must have at least one active bale scan
          const countRows = await tx.execute(sql`
          SELECT COUNT(*) AS cnt FROM customer_dispatch_bale_scans
          WHERE truck_ride_id = ${rideId} AND company_id = ${companyId} AND removed_at IS NULL
        `);
          const cnt = parseInt(firstRow<{ cnt: string | null }>(countRows)?.cnt || "0");
          if (cnt === 0) throw new Error("Cannot dispatch a ride with no scanned bales");

          const [updated] = await tx
            .update(customerDispatchTruckRides)
            .set({ status: "DISPATCHED", dispatchedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)))
            .returning();

          return updated;
        });

        res.json(result);
      } catch (err: unknown) {
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── POST /api/factory/dispatch-truck-rides/:id/reopen ────────────────────
  // Admin only: reopen a DISPATCHED ride before invoice generation
  app.post(
    "/api/factory/dispatch-truck-rides/:id/reopen",
    requireAuth,
    validateRequest(reopenRideInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const rideId = validatedInput(req, reopenRideInput).params.id;

        const admin = await isAdmin(req, companyId);
        if (!admin) return res.status(403).json({ message: "Only admins can reopen a dispatched ride" });

        const { reason } = req.body;
        if (!reason || !reason.trim())
          return res.status(400).json({ message: "reason is required to reopen a dispatched ride" });

        const result = await db.transaction(async (tx) => {
          const [ride] = await tx
            .select()
            .from(customerDispatchTruckRides)
            .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)));
          if (!ride) throw new Error("Ride not found");
          if (ride.status !== "DISPATCHED") throw new Error("Only DISPATCHED rides can be reopened");

          // Check batch not invoiced
          const [batch] = await tx
            .select()
            .from(customerDispatchBatches)
            .where(eq(customerDispatchBatches.id, ride.batchId));
          if (batch?.status === "INVOICED") throw new Error("Batch is already invoiced — cannot reopen a ride");

          const [updated] = await tx
            .update(customerDispatchTruckRides)
            .set({
              status: "LOADING",
              reopenedAt: new Date(),
              reopenReason: reason.trim(),
              dispatchedAt: null,
              updatedAt: new Date(),
            })
            .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)))
            .returning();

          return updated;
        });

        res.json(result);
      } catch (err: unknown) {
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );
}
