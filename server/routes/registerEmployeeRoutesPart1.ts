// Extracted from ./employeeRoutes.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { parseMoneyInput } from "../lib/money";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const employeeIdParams = z.strictObject({ id: stringParam });
const looseId = z.union([z.string(), z.number(), z.null()]).optional();
const looseAmount = z.union([z.string(), z.number(), z.null()]).optional();

const updateEmployeeInput = {
  params: employeeIdParams,
  query: emptyQuery,
  body: z.strictObject({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    code: z.string().optional(),
    monthlySalary: z.union([z.string(), z.number()]).optional(),
    department: z.string().nullable().optional(),
    active: z.boolean().optional(),
    joinDate: z.string().optional(),
    employeeGroupId: looseId,
    salesBonusPct: looseAmount,
    salesBonusPctSourceCompanyId: looseId,
    salesBonusPctLocationId: looseId,
    balesBonusRate: looseAmount,
  }),
} satisfies RequestSchemas;

const rateRowFields = {
  locationId: z.union([z.string(), z.number()]).nullable().optional(),
  sourceCompanyId: z.union([z.string(), z.number()]).nullable().optional(),
};
const baleRatesInput = {
  params: employeeIdParams,
  query: emptyQuery,
  body: z.strictObject({ rates: z.array(z.strictObject({ ...rateRowFields, rate: looseAmount })) }),
} satisfies RequestSchemas;
const balePctRatesInput = {
  params: employeeIdParams,
  query: emptyQuery,
  body: z.strictObject({ rates: z.array(z.strictObject({ ...rateRowFields, pct: looseAmount })) }),
} satisfies RequestSchemas;

const deleteEmployeeInput = {
  params: employeeIdParams,
  query: z.strictObject({
    forceDelete: z.string().optional(),
    force: z.unknown().optional(), // sent by client/src/pages/payroll/usePayrollModelPart4.tsx; not used (handler reads forceDelete)
  }),
  body: emptyBody,
} satisfies RequestSchemas;

export function registerEmployeeRoutesPart1(app: Express) {
  app.put("/api/employees/:id/bale-rates", requireAuth, validateRequest(baleRatesInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      const { rates } = req.body;
      if (!Array.isArray(rates)) return res.status(400).json({ message: "rates must be an array" });
      const valid = rates
        .filter((r) => r.locationId && (parseMoneyInput(r.rate)?.gt(0) ?? false))
        .map((r) => ({
          locationId: parseInt(r.locationId),
          rate: parseMoneyInput(r.rate)!.toFixed(),
          sourceCompanyId: r.sourceCompanyId ? parseInt(r.sourceCompanyId) : null,
        }));
      await storage.setEmployeeBaleRates(employeeId, companyId, valid);
      return res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.get("/api/employees/:id/bale-pct-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      const rates = await storage.getEmployeeBalePctRates(employeeId, companyId);
      return res.json(rates);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.put("/api/employees/:id/bale-pct-rates", requireAuth, validateRequest(balePctRatesInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      const { rates } = req.body;
      if (!Array.isArray(rates)) return res.status(400).json({ message: "rates must be an array" });
      const valid = rates
        .filter((r) => r.locationId && (parseMoneyInput(r.pct)?.gt(0) ?? false))
        .map((r) => ({
          locationId: parseInt(r.locationId),
          pct: parseMoneyInput(r.pct)!.toFixed(),
          sourceCompanyId: r.sourceCompanyId ? parseInt(r.sourceCompanyId) : null,
        }));
      await storage.setEmployeeBalePctRates(employeeId, companyId, valid);
      return res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.patch("/api/employees/:id", requireAuth, validateRequest(updateEmployeeInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid employee ID" });

      const {
        firstName,
        lastName,
        code,
        monthlySalary,
        department,
        active,
        joinDate,
        employeeGroupId,
        salesBonusPct,
        salesBonusPctSourceCompanyId,
        salesBonusPctLocationId,
        balesBonusRate,
      } = req.body;

      const updates: Record<string, unknown> = {};
      if (firstName !== undefined) updates.firstName = firstName;
      if (lastName !== undefined) updates.lastName = lastName;
      if (code !== undefined) updates.code = code;
      if (monthlySalary !== undefined) updates.monthlySalary = monthlySalary;
      if (department !== undefined) updates.department = department;
      if (active !== undefined) updates.active = active;
      if (joinDate !== undefined) updates.joinDate = joinDate;
      if (employeeGroupId !== undefined)
        updates.employeeGroupId =
          employeeGroupId === null || employeeGroupId === "" || employeeGroupId === "none"
            ? null
            : parseInt(employeeGroupId);
      if (salesBonusPct !== undefined)
        updates.salesBonusPct = salesBonusPct === "" || salesBonusPct === null ? null : salesBonusPct;
      if (salesBonusPctSourceCompanyId !== undefined)
        updates.salesBonusPctSourceCompanyId =
          salesBonusPctSourceCompanyId === "" || salesBonusPctSourceCompanyId === null
            ? null
            : parseInt(salesBonusPctSourceCompanyId);
      if (salesBonusPctLocationId !== undefined)
        updates.salesBonusPctLocationId =
          salesBonusPctLocationId === "" || salesBonusPctLocationId === null ? null : parseInt(salesBonusPctLocationId);
      if (balesBonusRate !== undefined)
        updates.balesBonusRate = balesBonusRate === "" || balesBonusRate === null ? null : balesBonusRate;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No fields to update" });
      }

      const updated = await storage.updateEmployee(id, companyId, updates);
      if (!updated) return res.status(404).json({ message: "Employee not found" });

      res.json(updated);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/employees/:id", requireAuth, validateRequest(deleteEmployeeInput), async (req, res) => {
    try {
      // Only Admin can delete employees
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Developer") {
        return res.status(403).json({
          message: "Only Admin users can delete employees",
        });
      }

      const employeeId = parseInt(req.params.id);
      if (isNaN(employeeId)) {
        return res.status(400).json({ message: "Invalid employee ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get employee to verify it exists and belongs to current company
      const allEmployees = await storage.getAllEmployees(req.session.currentCompanyId);
      const employee = allEmployees.find((e) => e.id === employeeId);

      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      if (employee.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Employee belongs to a different company",
        });
      }

      // Check for forceDelete flag from query parameter
      const forceDelete = req.query.forceDelete === "true";

      const result = await storage.deleteEmployee(employeeId, forceDelete);

      if (!result.success) {
        // If balance check failed, return 409 Conflict with balance details
        if (result.employeeBalance !== undefined || result.ledgerBalance !== undefined) {
          return res.status(409).json({
            message: result.message,
            employeeBalance: result.employeeBalance,
            ledgerBalance: result.ledgerBalance,
            requiresConfirmation: true,
          });
        }
        // Other errors (salary advances, transaction history)
        return res.status(400).json({ message: result.message });
      }

      res.json({ message: "Employee deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
