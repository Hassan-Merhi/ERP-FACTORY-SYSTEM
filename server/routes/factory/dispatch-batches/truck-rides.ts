/**
 * factoryDispatchBatchRoutes: DispatchTruckRide endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { parseId } from "../../../lib/parseId";
import { sql, eq, and } from "drizzle-orm";
import { customerDispatchBatches, customerDispatchTruckRides } from "@shared/schema";

import { getCompanyId, getUsername } from "./_helpers";
import { firstRow } from "../../../lib/queryResult";

export function registerDispatchTruckRideRoutes(app: Express) {
  // ── POST /api/factory/dispatch-batches/:id/truck-rides ────────────────────
  // Add a new truck ride to a batch
  app.post("/api/factory/dispatch-batches/:id/truck-rides", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const batchId = parseId(req.params.id);
      if (batchId === null) return res.status(400).json({ message: "Invalid id" });

      const result = await db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(customerDispatchBatches)
          .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)));
        if (!batch) throw new Error("Batch not found");
        if (batch.status === "INVOICED") throw new Error("Batch is already invoiced");
        if (batch.status === "CANCELLED") throw new Error("Batch is cancelled");

        // Get next ride number for this batch
        const countRows = await tx.execute(
          sql`SELECT COALESCE(MAX(ride_number), 0) + 1 AS next_num FROM customer_dispatch_truck_rides WHERE batch_id = ${batchId}`
        );
        const nextRideNum = firstRow(countRows)?.next_num || 1;

        const { truckPlate, driverName, destination, notes } = req.body;

        const [ride] = await tx
          .insert(customerDispatchTruckRides)
          .values({
            companyId,
            batchId,
            rideNumber: parseInt(String(nextRideNum)),
            truckPlate: truckPlate || null,
            driverName: driverName || null,
            destination: destination || null,
            notes: notes || null,
            status: "DRAFT",
            createdBy: getUsername(req),
          })
          .returning();

        // Advance batch to LOADING if it was DRAFT
        if (batch.status === "DRAFT") {
          await tx
            .update(customerDispatchBatches)
            .set({ status: "LOADING", updatedAt: new Date() })
            .where(eq(customerDispatchBatches.id, batchId));
        }

        return ride;
      });

      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });

  // ── PATCH /api/factory/dispatch-truck-rides/:id ───────────────────────────
  // Update ride info (plate, driver, notes)
  app.patch("/api/factory/dispatch-truck-rides/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rideId = parseId(req.params.id);
      if (rideId === null) return res.status(400).json({ message: "Invalid id" });

      const [ride] = await db
        .select()
        .from(customerDispatchTruckRides)
        .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)));
      if (!ride) return res.status(404).json({ message: "Ride not found" });
      if (ride.status === "DISPATCHED")
        return res.status(400).json({ message: "Cannot edit a dispatched ride. Reopen it first." });
      if (ride.status === "CANCELLED") return res.status(400).json({ message: "Ride is cancelled" });

      const { truckPlate, driverName, destination, notes } = req.body;
      const updates: Partial<typeof customerDispatchTruckRides.$inferInsert> = { updatedAt: new Date() };
      if (truckPlate !== undefined) updates.truckPlate = truckPlate;
      if (driverName !== undefined) updates.driverName = driverName;
      if (destination !== undefined) updates.destination = destination;
      if (notes !== undefined) updates.notes = notes;

      const [updated] = await db
        .update(customerDispatchTruckRides)
        .set(updates)
        .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)))
        .returning();
      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
