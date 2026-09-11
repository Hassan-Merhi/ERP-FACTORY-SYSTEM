/**
 * stockGroupsItemsRoutes: StockGrade endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { logAudit } from "../../_helpers";
import { stockGrades, insertStockGradeSchema } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";

export function registerStockGradeRoutes(app: Express) {
  app.get("/api/stock-grades", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const includeInactive = req.query.includeInactive === "true";
      const conds = [eq(stockGrades.companyId, companyId)];
      if (!includeInactive) conds.push(eq(stockGrades.active, true));
      const rows = await db
        .select()
        .from(stockGrades)
        .where(and(...conds))
        .orderBy(asc(stockGrades.name));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/stock-grades", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const parsed = insertStockGradeSchema.parse({ ...req.body, companyId });
      const [created] = await db.insert(stockGrades).values(parsed).returning();
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "create",
          tableName: "stock_grades",
          recordId: created.id,
          recordIdentifier: created.name,
          changes: { name: { old: null, new: created.name } },
        });
      } catch {
        /* non-fatal */
      }
      res.status(201).json(created);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/stock-grades/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const [existing] = await db
        .select()
        .from(stockGrades)
        .where(and(eq(stockGrades.id, id), eq(stockGrades.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Stock grade not found" });
      const updates: Partial<typeof stockGrades.$inferInsert> = {};
      if (req.body.name !== undefined) {
        const n = String(req.body.name).trim();
        if (!n) return res.status(400).json({ message: "Name is required" });
        updates.name = n;
      }
      if (req.body.active !== undefined) updates.active = req.body.active;
      const [updated] = await db.update(stockGrades).set(updates).where(eq(stockGrades.id, id)).returning();
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "stock_grades",
          recordId: id,
          recordIdentifier: updated.name,
          changes: Object.fromEntries(
            Object.entries(updates).map(([k, v]) => [k, { old: (existing as { [key: string]: unknown })[k], new: v }])
          ),
        });
      } catch {
        /* non-fatal */
      }
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/stock-grades/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const [existing] = await db
        .select()
        .from(stockGrades)
        .where(and(eq(stockGrades.id, id), eq(stockGrades.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Stock grade not found" });
      await db.update(stockGrades).set({ active: false }).where(eq(stockGrades.id, id));
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "stock_grades",
          recordId: id,
          recordIdentifier: existing.name,
          changes: { active: { old: true, new: false } },
        });
      } catch {
        /* non-fatal */
      }
      res.json({ message: "Stock grade deactivated" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Stock Categories ─────────────────────────────────────────────────────────
}
