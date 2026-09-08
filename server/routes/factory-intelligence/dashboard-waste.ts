/**
 * factoryIntelligenceRoutes: FactoryDashboardWaste endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { factoryWasteEntries, factoryWorkers, customerOrders } from "@shared/schema";

export function registerFactoryDashboardWasteRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  app.get("/api/factory/dashboard", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dateStr = (req.query.date as string) || getClientDate(req);

      // Waste entries for the selected date
      const wasteOnDate = await db
        .select()
        .from(factoryWasteEntries)
        .where(and(eq(factoryWasteEntries.companyId, companyId), eq(factoryWasteEntries.date, dateStr)));

      const wasteBreakdownMap: Record<string, number> = {};
      let wasteTotalKg = 0;
      for (const w of wasteOnDate) {
        const kg = parseFloat(w.kgWaste || "0");
        wasteTotalKg += kg;
        const wType = w.wasteType ? w.wasteType.toUpperCase() : "OTHER";
        wasteBreakdownMap[wType] = (wasteBreakdownMap[wType] || 0) + kg;
      }
      const wasteBreakdown = Object.entries(wasteBreakdownMap).map(([wasteType, kg]) => ({
        wasteType,
        kg: Math.round(kg * 1000) / 1000,
      }));

      // Active workers count
      const activeWorkers = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)));

      // Attendance today — query employee_attendance (the table managed by the attendance page)
      const attendanceTodayResult = await db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM employee_attendance
        WHERE company_id = ${companyId}
          AND attendance_date = ${dateStr}::date
          AND LOWER(status) != 'absent'
      `);
      const attendanceTodayCount = parseInt(String(attendanceTodayResult.rows[0]?.count ?? "0"), 10);

      // Loaded customer containers: finalized orders with containerNumber
      const loadedOrders = await db
        .select({ id: customerOrders.id })
        .from(customerOrders)
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            sql`(${customerOrders.loadingFinalizedAt} IS NOT NULL OR (${customerOrders.status} = 'FINALIZED' AND ${customerOrders.containerNumber} IS NOT NULL))`
          )
        );

      res.json({
        waste: { totalKg: Math.round(wasteTotalKg * 1000) / 1000, breakdown: wasteBreakdown },
        workers: { active: activeWorkers.length, attendanceToday: attendanceTodayCount },
        containers: { loaded: loadedOrders.length },
      });
    } catch (error: unknown) {
      logger.error("Error fetching factory dashboard:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 3. Waste Tracking
  // ───────────────────────────────────────────────

  app.get("/api/factory/waste", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string;
      const to = req.query.to as string;

      const conditions = [eq(factoryWasteEntries.companyId, companyId)];
      if (from) conditions.push(gte(factoryWasteEntries.date, from));
      if (to) conditions.push(lte(factoryWasteEntries.date, to));

      const results = await db
        .select()
        .from(factoryWasteEntries)
        .where(and(...conditions))
        .orderBy(desc(factoryWasteEntries.date));

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching waste entries:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/waste", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { date, mixBatchId, supplierId, containerId, wasteType, kgWaste, reason } = req.body;

      const [entry] = await db
        .insert(factoryWasteEntries)
        .values({
          companyId,
          date,
          mixBatchId: mixBatchId || null,
          supplierId: supplierId || null,
          containerId: containerId || null,
          wasteType: wasteType || null,
          kgWaste: String(kgWaste),
          reason: reason || null,
          // factory_waste_entries.created_by is an integer column; session ids are
          // numeric strings, matching how the POS routes coerce them.
          // The column is a varchar holding users.id. It used to be narrowed to a
          // number, which silently dropped attribution for any non-numeric id;
          // the session value is stored as-is now.
          createdBy: req.session.userId ?? null,
        })
        .returning();

      res.json(entry);
    } catch (error: unknown) {
      logger.error("Error creating waste entry:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/waste/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      const [deleted] = await db
        .delete(factoryWasteEntries)
        .where(and(eq(factoryWasteEntries.id, id), eq(factoryWasteEntries.companyId, companyId)))
        .returning();

      if (!deleted) return res.status(404).json({ message: "Waste entry not found" });
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting waste entry:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 4. KPIs
  // ───────────────────────────────────────────────
}
