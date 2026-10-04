import type { Express } from "express";
import { and, eq, gte, lte, or, sql } from "drizzle-orm";

import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { db } from "../../db";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { recalculateIntercompanyForDate } from "../helpers/intercompanyHelpers";
import { storage } from "../../storage";
import { intercompanyPosConfigs, vouchers } from "@shared/schema";

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

  app.get("/api/intercompany-pos-config/dest-accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { companyId } = req.query;
      if (!companyId) return res.status(400).json({ message: "companyId required" });
      const accounts = await storage.getAllLedgerAccounts(parseInt(companyId as string));
      res.json(accounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Rebuilds the intercompany POS journals of the selected (source) company
  // for every date in a range that has sales or an existing mirror journal.
  // Used to repair dates whose destination side was never written (row-level
  // security hid the destination company before the mirror was fixed) and
  // after configuration changes. Each date is an atomic, idempotent rebuild.
  app.post("/api/intercompany-pos-config/rebuild", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { fromDate, toDate } = req.body ?? {};
      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (
        typeof fromDate !== "string" ||
        typeof toDate !== "string" ||
        !isoDate.test(fromDate) ||
        !isoDate.test(toDate)
      ) {
        return res.status(400).json({ message: "fromDate and toDate must be YYYY-MM-DD dates" });
      }
      const spanDays = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
      if (!Number.isFinite(spanDays) || spanDays < 0 || spanDays > 366) {
        return res.status(400).json({ message: "The date range must run forwards and cover at most 366 days" });
      }

      const [config] = await db
        .select()
        .from(intercompanyPosConfigs)
        .where(eq(intercompanyPosConfigs.sourceCompanyId, companyId));
      if (!config || !config.enabled) {
        return res.status(400).json({ message: "Intercompany POS is not enabled for this company" });
      }

      // Dates with sales (deleted ones too, so their removal is rebuilt) or
      // with an existing source mirror journal.
      const dateRows = await db
        .selectDistinct({ date: vouchers.voucherDate })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            gte(vouchers.voucherDate, fromDate),
            lte(vouchers.voucherDate, toDate),
            or(eq(vouchers.voucherType, "Sales"), sql`${vouchers.voucherNumber} LIKE ${`INTERCO-SRC-${companyId}-%`}`)
          )
        )
        .orderBy(vouchers.voucherDate);

      const failedDates: string[] = [];
      for (const { date } of dateRows) {
        if (!(await recalculateIntercompanyForDate(companyId, date))) failedDates.push(date);
      }

      res.json({
        datesChecked: dateRows.length,
        datesRebuilt: dateRows.length - failedDates.length,
        failedDates,
      });
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
