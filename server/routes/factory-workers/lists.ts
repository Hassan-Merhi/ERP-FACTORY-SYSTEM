import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
/**
 * factoryWorkerRoutes: FactoryWorkerList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool, type Database } from "../../db";
import { eq, and, sql, ilike, isNotNull } from "drizzle-orm";
import { factoryWorkers, factoryPayrolls, factoryWorkerDocuments, factoryWorkerAdvances } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";
import { parseListPagination, setListPaginationHeaders } from "../../lib/listPagination";

export function registerFactoryWorkerListRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // GET /api/factory/workers/with-balances - List active workers with computed current balances
  // Balance = total advances (debit) minus total paid payroll net salary (credit), all-time
  app.get("/api/factory/workers/with-balances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const workers = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)))
        .orderBy(factoryWorkers.fullName);

      // Compute balance for each worker using SQL aggregation
      const advanceTotals = await db
        .select({
          workerId: factoryWorkerAdvances.workerId,
          total: sql<string>`COALESCE(SUM(${factoryWorkerAdvances.amount}), 0)`,
        })
        .from(factoryWorkerAdvances)
        .where(eq(factoryWorkerAdvances.companyId, companyId))
        .groupBy(factoryWorkerAdvances.workerId);

      const payrollTotals = await db
        .select({
          workerId: factoryPayrolls.workerId,
          total: sql<string>`COALESCE(SUM(${factoryPayrolls.netSalary}), 0)`,
        })
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.companyId, companyId), sql`${factoryPayrolls.status} = 'PAID'`))
        .groupBy(factoryPayrolls.workerId);

      const advanceMap = new Map<number, number>(
        advanceTotals.map((r: { workerId: number; total: string }): [number, number] => [
          r.workerId,
          parseFloat(r.total),
        ])
      );
      const payrollMap = new Map<number, number>(
        payrollTotals.map((r: { workerId: number; total: string }): [number, number] => [
          r.workerId,
          parseFloat(r.total),
        ])
      );

      const result = workers.map((w: typeof factoryWorkers.$inferSelect) => ({
        ...w,
        currentBalance: (advanceMap.get(w.id) ?? 0) - (payrollMap.get(w.id) ?? 0),
      }));

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching factory workers with balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers - List workers
  app.get("/api/factory/workers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { active, search, position, department } = req.query;

      const conditions = [eq(factoryWorkers.companyId, companyId)];

      if (active === "true") {
        conditions.push(eq(factoryWorkers.active, true));
      } else if (active === "false") {
        conditions.push(eq(factoryWorkers.active, false));
      }

      if (search) {
        conditions.push(punctuationInsensitiveSearch(factoryWorkers.fullName, String(search)));
      }
      if (position) {
        conditions.push(eq(factoryWorkers.position, position as string));
      }
      if (department) {
        conditions.push(eq(factoryWorkers.department, department as string));
      }

      // Picker/filter screens need worker identity only. Keep this projection
      // separate from payroll/roster summary fields so salary and rate columns
      // are never selected, serialized, transferred, or parsed unnecessarily.
      if (req.query.profile === "picker") {
        const workers = await db
          .select({
            id: factoryWorkers.id,
            employeeCode: factoryWorkers.employeeCode,
            fullName: factoryWorkers.fullName,
            position: factoryWorkers.position,
            department: factoryWorkers.department,
            active: factoryWorkers.active,
          })
          .from(factoryWorkers)
          .where(and(...conditions))
          .orderBy(factoryWorkers.fullName);
        return res.json(workers);
      }

      if (req.query.profile !== "full") {
        const pagination = parseListPagination(req.query, {
          defaultPageSize: 250,
          maxPageSize: 500,
          force: req.query.profile === "summary",
        });
        const summaryQuery = db
          .select({
            id: factoryWorkers.id,
            companyId: factoryWorkers.companyId,
            employeeCode: factoryWorkers.employeeCode,
            fullName: factoryWorkers.fullName,
            position: factoryWorkers.position,
            department: factoryWorkers.department,
            dateJoined: factoryWorkers.dateJoined,
            salaryType: factoryWorkers.salaryType,
            baseSalary: factoryWorkers.baseSalary,
            perBaleRate: factoryWorkers.perBaleRate,
            perKgRate: factoryWorkers.perKgRate,
            overtimeRate: factoryWorkers.overtimeRate,
            shiftType: factoryWorkers.shiftType,
            active: factoryWorkers.active,
            paymentMethod: factoryWorkers.paymentMethod,
            payFrequency: factoryWorkers.payFrequency,
            hourlyRate: factoryWorkers.hourlyRate,
            weeklySalary: factoryWorkers.weeklySalary,
            biWeeklySalary: factoryWorkers.biWeeklySalary,
            transportAllowance: factoryWorkers.transportAllowance,
            pendingAdvanceBalance: sql<string>`COALESCE((
              SELECT SUM(fwa.remaining_balance)
              FROM factory_worker_advances fwa
              WHERE fwa.worker_id = ${factoryWorkers.id}
                AND fwa.company_id = ${companyId}
                AND fwa.remaining_balance > 0
            ), 0)::text`,
          })
          .from(factoryWorkers)
          .where(and(...conditions))
          .orderBy(factoryWorkers.fullName)
          .$dynamic();
        const summary = pagination.requested
          ? await summaryQuery.limit(pagination.pageSize).offset(pagination.offset)
          : await summaryQuery;
        if (pagination.requested) {
          const countRows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(factoryWorkers)
            .where(and(...conditions));
          setListPaginationHeaders(res, countRows[0]?.count ?? 0, pagination);
        }
        res.set("Cache-Control", "private, max-age=120");
        return res.json(summary);
      }

      const results = await db
        .select()
        .from(factoryWorkers)
        .where(and(...conditions))
        .orderBy(factoryWorkers.fullName);

      // Attach pending advance balance per worker
      const advRows = await pool.query(
        `SELECT worker_id, COALESCE(SUM(remaining_balance), 0) AS pending_balance
         FROM factory_worker_advances
         WHERE company_id = $1 AND remaining_balance > 0
         GROUP BY worker_id`,
        [companyId]
      );
      const advMap: Record<number, number> = {};
      for (const r of advRows.rows) advMap[r.worker_id] = parseFloat(r.pending_balance);

      const enriched = results.map((w: typeof factoryWorkers.$inferSelect) => ({
        ...w,
        pendingAdvanceBalance: (advMap[w.id] ?? 0).toFixed(2),
      }));

      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching factory workers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/nationalities - Distinct nationalities saved for this company
  app.get("/api/factory/workers/nationalities", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .selectDistinct({ nationality: factoryWorkers.nationality })
        .from(factoryWorkers)
        .where(
          and(
            eq(factoryWorkers.companyId, companyId),
            isNotNull(factoryWorkers.nationality),
            sql`${factoryWorkers.nationality} <> ''`
          )
        )
        .orderBy(factoryWorkers.nationality);
      const list = rows.map((r) => r.nationality as string).filter(Boolean);
      res.json(list);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/document-counts - Document count per worker
  app.get("/api/factory/workers/document-counts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          workerId: factoryWorkerDocuments.workerId,
          count: sql<number>`count(*)::int`,
        })
        .from(factoryWorkerDocuments)
        .where(eq(factoryWorkerDocuments.companyId, companyId))
        .groupBy(factoryWorkerDocuments.workerId);
      const result: Record<number, number> = {};
      for (const row of rows) result[row.workerId] = row.count;
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
