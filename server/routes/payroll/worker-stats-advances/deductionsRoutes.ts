import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc } from "drizzle-orm";
import { employees, factoryWorkers, factoryWorkerDeductions } from "@shared/schema";
import { getFactoryCompanyId, getErpCompanyId } from "./helpers";
import { moneyString, parseMoneyInput } from "../../../lib/money";

export function registerWorkerDeductionsRoutes(app: Express) {
  app.get("/api/payroll/worker-deductions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getErpCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          id: factoryWorkerDeductions.id,
          companyId: factoryWorkerDeductions.companyId,
          workerId: factoryWorkerDeductions.workerId,
          employeeFirstName: employees.firstName,
          employeeLastName: employees.lastName,
          amount: factoryWorkerDeductions.amount,
          reason: factoryWorkerDeductions.reason,
          deductionDate: factoryWorkerDeductions.deductionDate,
          applied: factoryWorkerDeductions.applied,
          payrollId: factoryWorkerDeductions.payrollId,
          createdAt: factoryWorkerDeductions.createdAt,
        })
        .from(factoryWorkerDeductions)
        .leftJoin(
          employees,
          and(eq(factoryWorkerDeductions.workerId, employees.id), eq(employees.companyId, companyId))
        )
        .where(eq(factoryWorkerDeductions.companyId, companyId))
        .orderBy(desc(factoryWorkerDeductions.createdAt));
      res.json(
        rows.map(({ employeeFirstName, employeeLastName, ...row }) => ({
          ...row,
          workerName: `${employeeFirstName ?? ""} ${employeeLastName ?? ""}`.trim() || `Worker #${row.workerId}`,
        }))
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/payroll/workers/:id/deductions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getErpCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      const { amount, reason, deductionDate } = req.body;
      const exactAmount = parseMoneyInput(amount);
      if (!amount || !exactAmount || exactAmount.lte(0))
        return res.status(400).json({ message: "Amount must be a positive number" });
      if (!deductionDate) return res.status(400).json({ message: "Deduction date is required" });
      const [deduction] = await db
        .insert(factoryWorkerDeductions)
        .values({
          companyId,
          workerId,
          amount: moneyString(exactAmount),
          reason: reason || null,
          deductionDate,
          applied: false,
        })
        .returning();
      res.json(deduction);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/payroll/workers/:workerId/deductions/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getErpCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const deductionId = parseId(req.params.id);
      if (deductionId === null) return res.status(400).json({ message: "Invalid id" });
      const [existing] = await db
        .select()
        .from(factoryWorkerDeductions)
        .where(and(eq(factoryWorkerDeductions.id, deductionId), eq(factoryWorkerDeductions.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Deduction not found" });
      if (existing.applied) return res.status(400).json({ message: "Cannot delete an already-applied deduction" });
      await db.delete(factoryWorkerDeductions).where(eq(factoryWorkerDeductions.id, deductionId));
      res.json({ message: "Deduction deleted" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Worker Deductions CRUD ───────────────────────────────────────────────

  // GET /api/factory/worker-deductions - All deductions for company (joined with worker name)
  app.get("/api/factory/worker-deductions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          id: factoryWorkerDeductions.id,
          companyId: factoryWorkerDeductions.companyId,
          workerId: factoryWorkerDeductions.workerId,
          workerName: factoryWorkers.fullName,
          amount: factoryWorkerDeductions.amount,
          reason: factoryWorkerDeductions.reason,
          deductionDate: factoryWorkerDeductions.deductionDate,
          applied: factoryWorkerDeductions.applied,
          payrollId: factoryWorkerDeductions.payrollId,
          createdAt: factoryWorkerDeductions.createdAt,
        })
        .from(factoryWorkerDeductions)
        .leftJoin(factoryWorkers, eq(factoryWorkerDeductions.workerId, factoryWorkers.id))
        .where(eq(factoryWorkerDeductions.companyId, companyId))
        .orderBy(desc(factoryWorkerDeductions.createdAt));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/:id/deductions
  app.get("/api/factory/workers/:id/deductions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      const deductions = await db
        .select()
        .from(factoryWorkerDeductions)
        .where(and(eq(factoryWorkerDeductions.companyId, companyId), eq(factoryWorkerDeductions.workerId, workerId)))
        .orderBy(desc(factoryWorkerDeductions.createdAt));
      res.json(deductions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/workers/:id/deductions
  app.post("/api/factory/workers/:id/deductions", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      const { amount, reason, deductionDate } = req.body;
      const exactAmount = parseMoneyInput(amount);
      if (!amount || !exactAmount || exactAmount.lte(0)) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }
      if (!deductionDate) return res.status(400).json({ message: "Deduction date is required" });
      const [deduction] = await db
        .insert(factoryWorkerDeductions)
        .values({
          companyId,
          workerId,
          amount: moneyString(exactAmount),
          reason: reason || null,
          deductionDate,
          applied: false,
        })
        .returning();
      res.json(deduction);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE /api/factory/workers/:workerId/deductions/:id
  app.delete("/api/factory/workers/:workerId/deductions/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const deductionId = parseId(req.params.id);
      if (deductionId === null) return res.status(400).json({ message: "Invalid id" });
      const [existing] = await db
        .select()
        .from(factoryWorkerDeductions)
        .where(and(eq(factoryWorkerDeductions.id, deductionId), eq(factoryWorkerDeductions.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Deduction not found" });
      if (existing.applied) return res.status(400).json({ message: "Cannot delete an already-applied deduction" });
      await db.delete(factoryWorkerDeductions).where(eq(factoryWorkerDeductions.id, deductionId));
      res.json({ message: "Deduction deleted" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/advances/bulk - Record advances for multiple workers at once
}
