import type { Express } from "express";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { userCompanyRoles, userLocationCashAccounts, userLocations, userPreferences } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { registerUserAccessRoutesPart1 } from "./registerUserAccessRoutesPart1";

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

  registerUserAccessRoutesPart1(app);

  const MHD_PREFERENCE_ERROR = "Invalid Factory MHD view preference";
  app.put("/api/user-preferences", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const {
        dateFormat,
        preferredCurrency,
        showProfitComparisonOnPOS,
        showChatWidget,
        showNotesPanel,
        factoryNetPositionValuationMode,
        factoryMhdViewDefault,
        hiddenTransactionJournalVoucherIds,
      } = req.body;
      if (dateFormat && !["MM/DD/YYYY", "DD/MM/YYYY"].includes(dateFormat)) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      if (preferredCurrency && !["USD", "CFA"].includes(preferredCurrency)) {
        return res.status(400).json({ message: "Invalid currency" });
      }
      if (
        factoryNetPositionValuationMode !== undefined &&
        !["cost", "selling"].includes(factoryNetPositionValuationMode)
      ) {
        return res.status(400).json({ message: "Invalid factory net position valuation mode" });
      }
      if (factoryMhdViewDefault !== undefined && typeof factoryMhdViewDefault !== "boolean") {
        return res.status(400).json({ message: MHD_PREFERENCE_ERROR });
      }
      let normalizedHiddenTransactionJournalVoucherIds: number[] | undefined;
      if (hiddenTransactionJournalVoucherIds !== undefined) {
        if (
          !Array.isArray(hiddenTransactionJournalVoucherIds) ||
          hiddenTransactionJournalVoucherIds.length > 5000 ||
          hiddenTransactionJournalVoucherIds.some(
            (value: unknown) => !Number.isSafeInteger(value) || Number(value) <= 0
          )
        ) {
          return res.status(400).json({ message: "Invalid hidden transaction journal voucher IDs" });
        }
        normalizedHiddenTransactionJournalVoucherIds = Array.from(
          new Set(hiddenTransactionJournalVoucherIds.map((value: number) => Number(value)))
        );
      }
      const existing = await db.select().from(userPreferences).where(eq(userPreferences.userId, req.user.id));
      const updateFields: PgUpdateSetSource<typeof userPreferences> = { updatedAt: new Date() };
      if (dateFormat) updateFields.dateFormat = dateFormat;
      if (preferredCurrency !== undefined) updateFields.preferredCurrency = preferredCurrency;
      if (showProfitComparisonOnPOS !== undefined) updateFields.showProfitComparisonOnPOS = showProfitComparisonOnPOS;
      if (showChatWidget !== undefined) updateFields.showChatWidget = showChatWidget;
      if (showNotesPanel !== undefined) updateFields.showNotesPanel = showNotesPanel;
      if (factoryNetPositionValuationMode !== undefined) {
        updateFields.factoryNetPositionValuationMode = factoryNetPositionValuationMode;
      }
      if (factoryMhdViewDefault !== undefined) updateFields.factoryMhdViewDefault = factoryMhdViewDefault;
      if (normalizedHiddenTransactionJournalVoucherIds !== undefined) {
        updateFields.hiddenTransactionJournalVoucherIds = normalizedHiddenTransactionJournalVoucherIds;
      }

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
            factoryNetPositionValuationMode: factoryNetPositionValuationMode ?? "cost",
            factoryMhdViewDefault: factoryMhdViewDefault ?? false,
            hiddenTransactionJournalVoucherIds: normalizedHiddenTransactionJournalVoucherIds ?? [],
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
