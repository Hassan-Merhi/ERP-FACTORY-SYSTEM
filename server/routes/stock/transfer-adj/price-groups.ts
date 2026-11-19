/**
 * stockTransferAdjRoutes: LocationPriceGroup endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { locationPriceGroups } from "@shared/schema";
import { eq } from "drizzle-orm";
import { validateRequest } from "../../../lib/validateRequest";
import { replacePriceGroupsInput } from "./transferAdjRouteSchemas";

export function registerLocationPriceGroupRoutes(app: Express) {
  app.get("/api/location-price-groups", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db.select().from(locationPriceGroups).where(eq(locationPriceGroups.companyId, companyId));

      // Group by masterLocationId
      const map = new Map<number, number[]>();
      for (const r of rows) {
        if (!map.has(r.masterLocationId)) map.set(r.masterLocationId, []);
        map.get(r.masterLocationId)!.push(r.followerLocationId);
      }
      const result = Array.from(map.entries()).map(([masterLocationId, followerLocationIds]) => ({
        masterLocationId,
        followerLocationIds,
      }));
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PUT: replaces the full group config for the company
  app.put(
    "/api/location-price-groups",
    requireAuth,
    requireNonPOS,
    validateRequest(replacePriceGroupsInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        // groups: Array<{ masterLocationId: number; followerLocationIds: number[] }>
        const { groups } = req.body as { groups: { masterLocationId: number; followerLocationIds: number[] }[] };
        if (!Array.isArray(groups)) return res.status(400).json({ message: "groups must be an array" });

        // Delete all existing for this company, then re-insert.
        // Wrapped in a transaction so a failed insert does not leave the
        // company with zero price groups after the delete succeeded.
        await db.transaction(async (tx) => {
          await tx.delete(locationPriceGroups).where(eq(locationPriceGroups.companyId, companyId));

          const toInsert = groups.flatMap((g) =>
            g.followerLocationIds.map((fid) => ({
              companyId,
              masterLocationId: g.masterLocationId,
              followerLocationId: fid,
            }))
          );
          if (toInsert.length > 0) {
            await tx.insert(locationPriceGroups).values(toInsert);
          }
        });

        res.json({ message: "Price groups saved" });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
