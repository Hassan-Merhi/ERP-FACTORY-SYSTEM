import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { employees, insertEmployeeSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
import { registerEmployeeGroupRoutes } from "./employeeGroupRoutes";
import { registerPayrollRoutes } from "./erp-payroll";

export function registerEmployeeRoutes(app: Express) {
  app.get("/api/employees", requireAuth, async (req, res) => {
    // Disable HTTP caching - employee balances are dynamically calculated
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const employees = await storage.getAllEmployees(req.session.currentCompanyId);
      // Ensure proper camelCase field names for frontend
      const transformedEmployees = employees.map((emp) => {
        // Use stored currentBalance which is kept in sync by payroll operations and journal vouchers
        // The syncEmployeePayrollBalance function updates currentBalance when vouchers are created/edited/deleted
        const currentBalance = parseFloat(emp.currentBalance || "0");

        return {
          ...emp,
          firstName:
            emp.firstName ||
            (
              emp as unknown as {
                id: number;
                companyId: number;
                code: string;
                phone: string | null;
                openingBalance: string | null;
                active: boolean;
                deletedAt: Date | null;
                createdAt: Date;
                email: string | null;
                firstName: string;
                lastName: string;
                joinDate: string;
                department: string | null;
                employeeType: string;
                monthlySalary: string;
                currentBalance: string;
                totalDeposits: string;
                totalWithdrawals: string;
                salesBonusPct: string | null;
                salesBonusPctSourceCompanyId: number | null;
                salesBonusPctLocationId: number | null;
                balesBonusRate: string | null;
              } & { first_name: unknown }
            ).first_name,
          lastName:
            emp.lastName ||
            (
              emp as unknown as {
                id: number;
                companyId: number;
                code: string;
                phone: string | null;
                openingBalance: string | null;
                active: boolean;
                deletedAt: Date | null;
                createdAt: Date;
                email: string | null;
                firstName: string;
                lastName: string;
                joinDate: string;
                department: string | null;
                employeeType: string;
                monthlySalary: string;
                currentBalance: string;
                totalDeposits: string;
                totalWithdrawals: string;
                salesBonusPct: string | null;
                salesBonusPctSourceCompanyId: number | null;
                salesBonusPctLocationId: number | null;
                balesBonusRate: string | null;
              } & { last_name: unknown }
            ).last_name,
          currentBalance: currentBalance.toFixed(2),
          calculatedBalance: currentBalance.toFixed(2),
        };
      });
      res.json(transformedEmployees);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/employees/:id/balance", requireAuth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const employeeId = parseInt(req.params.id);
      if (isNaN(employeeId)) {
        return res.status(400).json({ message: "Invalid employee ID" });
      }
      const employees = await storage.getAllEmployees(req.session.currentCompanyId);
      const employee = employees.find((e) => e.id === employeeId);
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }
      const balance = parseFloat(employee.currentBalance || "0").toFixed(2);
      res.json({ balance });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/employees", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const parsed = insertEmployeeSchema.parse(req.body);
      let resolvedCode: string;

      // Auto-generate code from name if not provided
      if (!parsed.code) {
        // Generate code from name: first 3 letters of first name + first 3 letters of last name, uppercase
        const firstPart = parsed.firstName.trim().substring(0, 3).toUpperCase();
        const lastPart = parsed.lastName.trim().substring(0, 3).toUpperCase();
        let baseCode = firstPart + lastPart;

        // Fallback if baseCode is somehow empty (shouldn't happen with validation)
        if (!baseCode || baseCode.length === 0) {
          baseCode = "EMP";
        }

        // Ensure uniqueness by adding suffix if needed
        let code = baseCode;
        let suffix = 1;
        while (await storage.getEmployeeByCode(code)) {
          code = `${baseCode}${suffix}`;
          suffix++;
        }
        resolvedCode = code;
      } else {
        // Check for duplicate code if manually provided
        const existing = await storage.getEmployeeByCode(parsed.code);
        if (existing) {
          return res.status(400).json({ message: "Employee code already exists" });
        }
        resolvedCode = parsed.code;
      }

      let employee = await storage.createEmployee({ ...parsed, code: resolvedCode });

      // Initialize currentBalance to opening balance if provided
      if (parsed.openingBalance && parseFloat(parsed.openingBalance) > 0) {
        await db
          .update(employees)
          .set({
            currentBalance: parsed.openingBalance,
          })
          .where(eq(employees.id, employee.id));

        employee = {
          ...employee,
          currentBalance: parsed.openingBalance,
        };
      }

      res.status(201).json(employee);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Employee bale rates per location
  app.get("/api/employees/:id/bale-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      const rates = await storage.getEmployeeBaleRates(employeeId, companyId);
      return res.json(rates);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.put("/api/employees/:id/bale-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      const { rates } = req.body;
      if (!Array.isArray(rates)) return res.status(400).json({ message: "rates must be an array" });
      const valid = rates
        .filter((r) => r.locationId && parseFloat(r.rate) > 0)
        .map((r) => ({
          locationId: parseInt(r.locationId),
          rate: String(parseFloat(r.rate)),
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

  app.put("/api/employees/:id/bale-pct-rates", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const employeeId = parseInt(req.params.id);
      const { rates } = req.body;
      if (!Array.isArray(rates)) return res.status(400).json({ message: "rates must be an array" });
      const valid = rates
        .filter((r) => r.locationId && parseFloat(r.pct) > 0)
        .map((r) => ({
          locationId: parseInt(r.locationId),
          pct: String(parseFloat(r.pct)),
          sourceCompanyId: r.sourceCompanyId ? parseInt(r.sourceCompanyId) : null,
        }));
      await storage.setEmployeeBalePctRates(employeeId, companyId, valid);
      return res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.patch("/api/employees/:id", requireAuth, async (req, res) => {
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

  app.delete("/api/employees/:id", requireAuth, async (req, res) => {
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

  registerEmployeeGroupRoutes(app);

  registerPayrollRoutes(app);

  // Suppliers
}
