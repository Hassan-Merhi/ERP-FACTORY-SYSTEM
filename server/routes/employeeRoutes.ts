import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { storage } from "../storage";
import { masterDataDbErrorResponse } from "../lib/masterDataDbError";
import { requireAuth, requireNonPOS } from "../auth";
import { insertEmployeeSchema } from "@shared/schema";
import { registerEmployeeGroupRoutes } from "./employeeGroupRoutes";
import { registerPayrollRoutes } from "./erp-payroll";
import { toMoney } from "../lib/money";
import { registerEmployeeRoutesPart1 } from "./registerEmployeeRoutesPart1";

export function registerEmployeeRoutes(app: Express) {
  app.get("/api/employees", requireAuth, async (req, res) => {
    // Disable HTTP caching - employee balances are dynamically calculated
    res.set("Cache-Control", "no-store");
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const employees = await storage.getEmployeesWithBalances(req.session.currentCompanyId);
      // Ensure proper camelCase field names for frontend
      const transformedEmployees = employees.map((emp) => {
        // This is the ledger-authoritative amount: Cr positive for Payroll.
        // Do not fall back to the write-side employee.current_balance cache.
        const currentBalance = toMoney(emp.currentBalance).toNumber();

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
      const balance = toMoney(employee.currentBalance).toFixed(2);
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

      // Storage atomically normalizes a signed opening: positive is Credit,
      // negative is Debit. It also initializes the payroll balance with the
      // same sign, so a later separate update cannot invert it.
      const employee = await storage.createEmployee({ ...parsed, code: resolvedCode });
      res.status(201).json(employee);
    } catch (error: unknown) {
      const dbError = masterDataDbErrorResponse(error, "employee", req.session.currentCompanyId);
      if (dbError) return res.status(dbError.status).json(dbError.body);
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

  registerEmployeeRoutesPart1(app);

  registerEmployeeGroupRoutes(app);

  registerPayrollRoutes(app);

  // Suppliers
}
