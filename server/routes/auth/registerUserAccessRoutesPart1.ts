// Extracted from ./userAccessRoutes.ts
import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  ledgerAccounts,
  locations,
  userCompanyRoles,
  userLocationCashAccounts,
  userLocations,
  userPreferences,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

export function registerUserAccessRoutesPart1(app: Express) {
  app.put(
    "/api/user-location-cash-accounts/:userId/:companyId",
    requireAuth,
    requireRole("Admin"),
    async (req, res) => {
      try {
        const { userId, companyId: companyIdStr } = req.params;
        const companyId = parseInt(companyIdStr);
        if (isNaN(companyId)) return res.status(400).json({ message: "Invalid companyId" });
        const { mappings } = req.body;
        if (!Array.isArray(mappings)) return res.status(400).json({ message: "mappings array required" });

        for (const mapping of mappings) {
          if (!mapping.locationId || !mapping.cashAccountId) {
            return res.status(400).json({ message: "Each mapping must have locationId and cashAccountId" });
          }
          const [cashAccount] = await db
            .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.id, mapping.cashAccountId), eq(ledgerAccounts.companyId, companyId)))
            .limit(1);
          if (!cashAccount) {
            return res.status(400).json({ message: `Cash account ${mapping.cashAccountId} not found in this company` });
          }
          if (cashAccount.accountType !== "Cash") {
            return res.status(400).json({ message: `Account ${mapping.cashAccountId} is not a Cash account` });
          }
        }

        await db.transaction(async (tx) => {
          await tx
            .delete(userLocationCashAccounts)
            .where(and(eq(userLocationCashAccounts.userId, userId), eq(userLocationCashAccounts.companyId, companyId)));
          if (mappings.length > 0) {
            await tx.insert(userLocationCashAccounts).values(
              mappings.map((mapping) => ({
                userId,
                companyId,
                locationId: mapping.locationId,
                cashAccountId: mapping.cashAccountId,
                posStation: mapping.posStation ?? null,
              }))
            );
          }
        });
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/my-locations", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const userLocs = await db
        .select({
          id: locations.id,
          name: locations.name,
          code: locations.code,
          city: locations.city,
          state: locations.state,
          country: locations.country,
          cashAccountId: userLocationCashAccounts.cashAccountId,
          cashAccountName: ledgerAccounts.name,
          cashAccountCode: ledgerAccounts.code,
        })
        .from(userLocations)
        .innerJoin(locations, eq(userLocations.locationId, locations.id))
        .leftJoin(
          userLocationCashAccounts,
          and(
            eq(userLocationCashAccounts.userId, req.user.id),
            eq(userLocationCashAccounts.companyId, companyId),
            eq(userLocationCashAccounts.locationId, locations.id)
          )
        )
        .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, userLocationCashAccounts.cashAccountId))
        .where(
          and(eq(userLocations.userId, req.user.id), eq(userLocations.companyId, companyId), eq(locations.active, true))
        );

      if (userLocs.length === 0) {
        const [role] = await db
          .select({ assignedLocationId: userCompanyRoles.assignedLocationId })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.userId, req.user.id), eq(userCompanyRoles.companyId, companyId)))
          .limit(1);
        const fallbackLocId = role?.assignedLocationId;
        if (fallbackLocId) {
          const loc = await db
            .select({
              id: locations.id,
              name: locations.name,
              code: locations.code,
              city: locations.city,
              state: locations.state,
              country: locations.country,
              cashAccountId: userLocationCashAccounts.cashAccountId,
              cashAccountName: ledgerAccounts.name,
              cashAccountCode: ledgerAccounts.code,
            })
            .from(locations)
            .leftJoin(
              userLocationCashAccounts,
              and(
                eq(userLocationCashAccounts.userId, req.user.id),
                eq(userLocationCashAccounts.companyId, companyId),
                eq(userLocationCashAccounts.locationId, locations.id)
              )
            )
            .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, userLocationCashAccounts.cashAccountId))
            .where(and(eq(locations.id, fallbackLocId), eq(locations.active, true)))
            .limit(1);
          if (loc.length > 0) {
            const existing = await db
              .select({ id: userLocations.id })
              .from(userLocations)
              .where(
                and(
                  eq(userLocations.userId, req.user.id),
                  eq(userLocations.companyId, companyId),
                  eq(userLocations.locationId, fallbackLocId)
                )
              )
              .limit(1);
            if (existing.length === 0) {
              await db.insert(userLocations).values({ userId: req.user.id, companyId, locationId: fallbackLocId });
            }
            return res.json(loc);
          }
        }
      }
      res.json(userLocs);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/user-preferences", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const prefs = await db.select().from(userPreferences).where(eq(userPreferences.userId, req.user.id));
      res.json(prefs.length === 0 ? { dateFormat: "MM/DD/YYYY" } : prefs[0]);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
