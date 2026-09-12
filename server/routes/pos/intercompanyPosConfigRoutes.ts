import type { Express } from "express";
import { eq } from "drizzle-orm";

import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { storage } from "../../storage";
import { intercompanyPosConfigs } from "@shared/schema";

export function registerIntercompanyPosConfigRoutes(app: Express): void {
  app.get("/api/intercompany-pos-config", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const [config] = await db
        .select()
        .from(intercompanyPosConfigs)
        .where(eq(intercompanyPosConfigs.sourceCompanyId, companyId));
      res.json(config || null);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/intercompany-pos-config", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { destCompanyId, sourceIntercoAccountId, destIntercoAccountId, enabled, skipSourceVoucher } = req.body;
      if (!destCompanyId || !sourceIntercoAccountId || !destIntercoAccountId) {
        return res.status(400).json({
          message: "destCompanyId, sourceIntercoAccountId, and destIntercoAccountId are required",
        });
      }

      const [existing] = await db
        .select()
        .from(intercompanyPosConfigs)
        .where(eq(intercompanyPosConfigs.sourceCompanyId, companyId));

      if (existing) {
        const [updated] = await db
          .update(intercompanyPosConfigs)
          .set({
            destCompanyId: parseInt(destCompanyId),
            sourceIntercoAccountId: parseInt(sourceIntercoAccountId),
            destIntercoAccountId: parseInt(destIntercoAccountId),
            enabled: enabled !== false,
            skipSourceVoucher: skipSourceVoucher === true,
            updatedAt: new Date(),
          })
          .where(eq(intercompanyPosConfigs.sourceCompanyId, companyId))
          .returning();
        return res.json(updated);
      }

      const [created] = await db
        .insert(intercompanyPosConfigs)
        .values({
          sourceCompanyId: companyId,
          destCompanyId: parseInt(destCompanyId),
          sourceIntercoAccountId: parseInt(sourceIntercoAccountId),
          destIntercoAccountId: parseInt(destIntercoAccountId),
          enabled: enabled !== false,
          skipSourceVoucher: skipSourceVoucher === true,
        })
        .returning();
      return res.status(201).json(created);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get(
    "/api/intercompany-pos-config/dest-accounts",
    requireAuth,
    requireNonPOS,
    async (req, res) => {
      try {
        const { companyId } = req.query;
        if (!companyId) return res.status(400).json({ message: "companyId required" });
        const accounts = await storage.getAllLedgerAccounts(parseInt(companyId as string));
        res.json(accounts);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    },
  );
}
