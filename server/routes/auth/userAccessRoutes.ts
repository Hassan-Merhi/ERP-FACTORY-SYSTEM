import type { Express } from "express";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

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

export function registerUserAccessRoutes(app: Express) {
  app.get("/api/user-locations/:userId/:companyId", requireAuth, async (req, res) => {
    try {
      const { userId, companyId } = req.params;
      res.json(
        await db
          .select()
          .from(userLocations)
          .where(and(eq(userLocations.userId, userId), eq(userLocations.companyId, parseInt(companyId))))
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/user-locations/:userId/:companyId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { userId, companyId } = req.params;
      const { locationIds } = req.body;
      const companyIdNum = parseInt(companyId);
      if (!Array.isArray(locationIds)) return res.status(400).json({ message: "locationIds must be an array" });

      await db
        .delete(userLocations)
        .where(and(eq(userLocations.userId, userId), eq(userLocations.companyId, companyIdNum)));
      if (locationIds.length > 0) {
        await db
          .insert(userLocations)
          .values(locationIds.map((locationId: number) => ({ userId, companyId: companyIdNum, locationId })));
        await db
          .update(userCompanyRoles)
          .set({ assignedLocationId: locationIds[0] })
          .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyIdNum)));
      }
      res.json(
        await db
          .select()
          .from(userLocations)
          .where(and(eq(userLocations.userId, userId), eq(userLocations.companyId, companyIdNum)))
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/user-location-cash-accounts/:userId/:companyId", requireAuth, async (req, res) => {
    try {
      const { currentRole } = req.session;
      if (!currentRole || !["Admin", "Owner", "Developer"].includes(currentRole)) {
        return res.status(403).json({ message: "Admin access required" });
      }
      const { userId, companyId: companyIdStr } = req.params;
      const companyId = parseInt(companyIdStr);
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid companyId" });
      const mappings = await db
        .select({
          id: userLocationCashAccounts.id,
          locationId: userLocationCashAccounts.locationId,
          cashAccountId: userLocationCashAccounts.cashAccountId,
          posStation: userLocationCashAccounts.posStation,
        })
        .from(userLocationCashAccounts)
        .where(and(eq(userLocationCashAccounts.userId, userId), eq(userLocationCashAccounts.companyId, companyId)));
      res.json(mappings);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

  app.put("/api/user-preferences", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const { dateFormat, preferredCurrency, showProfitComparisonOnPOS, showChatWidget, showNotesPanel } = req.body;
      if (dateFormat && !["MM/DD/YYYY", "DD/MM/YYYY"].includes(dateFormat)) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      if (preferredCurrency && !["USD", "CFA"].includes(preferredCurrency)) {
        return res.status(400).json({ message: "Invalid currency" });
      }
      const existing = await db.select().from(userPreferences).where(eq(userPreferences.userId, req.user.id));
      const updateFields: PgUpdateSetSource<typeof userPreferences> = { updatedAt: new Date() };
      if (dateFormat) updateFields.dateFormat = dateFormat;
      if (preferredCurrency !== undefined) updateFields.preferredCurrency = preferredCurrency;
      if (showProfitComparisonOnPOS !== undefined) updateFields.showProfitComparisonOnPOS = showProfitComparisonOnPOS;
      if (showChatWidget !== undefined) updateFields.showChatWidget = showChatWidget;
      if (showNotesPanel !== undefined) updateFields.showNotesPanel = showNotesPanel;

      if (existing.length === 0) {
        const created = await db
          .insert(userPreferences)
          .values({
            userId: req.user.id,
            dateFormat: dateFormat || "MM/DD/YYYY",
            preferredCurrency: preferredCurrency || null,
            showProfitComparisonOnPOS: showProfitComparisonOnPOS ?? false,
            showChatWidget: showChatWidget ?? true,
            showNotesPanel: showNotesPanel ?? true,
          })
          .returning();
        return res.json(created[0]);
      }
      const updated = await db
        .update(userPreferences)
        .set(updateFields)
        .where(eq(userPreferences.userId, req.user.id))
        .returning();
      res.json(updated[0]);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
