/**
 * payrollRoutes: PayrollRun endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { requireAuth, requireNonPOS } from "../../auth";
import { erpPayrollRunItems, erpPayrollRuns } from "@shared/schema";
import { moneyString, sumMoney } from "../../lib/money";
import { payrollItemRows, payrollDeductionOf } from "./runsHelpers";
import { registerPayrollRunRoutesPart1 } from "./registerPayrollRunRoutesPart1";

export function registerPayrollRunRoutes(app: Express) {
  // ── ERP Payroll Runs (draft → paid workflow) ──────────────────────────────

  // Create a new payroll run (saves as DRAFT, no ledger entries yet)
  app.post("/api/payroll/runs", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date, notes, items } = req.body;
      if (!date || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "date and items are required" });
      const checked = payrollItemRows(items, 0);
      if ("invalidEmployee" in checked)
        return res.status(400).json({ message: "Invalid payroll salary amounts", employee: checked.invalidEmployee });
      const createdAt = new Date().toISOString();
      const [run] = await db
        .insert(erpPayrollRuns)
        .values({ companyId, status: "DRAFT", date, notes: notes || null, createdAt })
        .returning();
      await db.insert(erpPayrollRunItems).values(checked.rows.map((row) => ({ ...row, runId: run.id })));
      res.json({ ...run, items });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // List payroll runs for current company
  app.get("/api/payroll/runs", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      // Accept companyId from query param (explicit) or fall back to session
      const paramCompanyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
      const sessionCompanyId = req.session.currentCompanyId;
      const companyId = paramCompanyId || sessionCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Validate that the requesting user has access to this company
      if (paramCompanyId && paramCompanyId !== sessionCompanyId) {
        const accessibleCompanyIds = await getAccessibleCompanyIds(req.session.userId!);
        if (!accessibleCompanyIds.has(paramCompanyId)) {
          return res.status(403).json({ message: "Access denied to this company" });
        }
      }

      const runs = await db
        .select()
        .from(erpPayrollRuns)
        .where(eq(erpPayrollRuns.companyId, companyId))
        .orderBy(desc(erpPayrollRuns.createdAt));
      // Attach item counts + totals
      const result = await Promise.all(
        runs.map(async (run) => {
          const rawItems = await db.select().from(erpPayrollRunItems).where(eq(erpPayrollRunItems.runId, run.id));
          const items = rawItems.map((i) => ({ ...i, payrollDeduction: moneyString(payrollDeductionOf(i)) }));
          return {
            ...run,
            itemCount: items.length,
            totalNet: moneyString(sumMoney(items.map((i) => i.netPay))),
            totalBase: moneyString(sumMoney(items.map((i) => i.baseSalary))),
            items,
          };
        })
      );
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  registerPayrollRunRoutesPart1(app);
}
