/**
 * Employee-group and worker-group management routes.
 *
 * CRUD and membership for employee groups and worker groups. Extracted from
 * employeeRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { employees, insertEmployeeGroupSchema } from "@shared/schema";

export function registerEmployeeGroupRoutes(app: Express) {
  // Employee Groups
  app.get("/api/employee-groups", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const groups = await storage.getAllEmployeeGroups(req.session.currentCompanyId);
      res.json(groups);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/employee-groups/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const group = await storage.getEmployeeGroupById(parseInt(req.params.id));
      if (!group) {
        return res.status(404).json({ message: "Employee group not found" });
      }
      if (group.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied: group belongs to a different company" });
      }
      res.json(group);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/employee-groups", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const parsed = insertEmployeeGroupSchema.parse({
        ...req.body,
        companyId: req.session.currentCompanyId,
      });
      const group = await storage.createEmployeeGroup(parsed);
      res.status(201).json(group);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/employee-groups/:id", requireAuth, async (req, res) => {
    try {
      const group = await storage.updateEmployeeGroup(parseInt(req.params.id), req.body);
      res.json(group);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/employee-groups/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteEmployeeGroup(parseInt(req.params.id));
      res.status(204).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/employee-groups/:id/members", requireAuth, async (req, res) => {
    try {
      const members = await storage.getEmployeeGroupMembers(parseInt(req.params.id));
      res.json(members);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/employee-groups/:groupId/members/:employeeId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const groupId = parseInt(req.params.groupId);
      if (isNaN(groupId)) return res.status(400).json({ message: "Invalid group ID" });
      const employeeId = parseInt(req.params.employeeId);
      if (isNaN(employeeId)) return res.status(400).json({ message: "Invalid employee ID" });
      const group = await storage.getEmployeeGroupById(groupId);
      if (!group || group.companyId !== companyId) {
        return res.status(403).json({ message: "Group not found or access denied" });
      }
      await storage.addEmployeeToGroup(groupId, employeeId);
      res.status(201).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/employee-groups/:groupId/members/:employeeId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const groupId = parseInt(req.params.groupId);
      if (isNaN(groupId)) return res.status(400).json({ message: "Invalid group ID" });
      const group = await storage.getEmployeeGroupById(groupId);
      if (!group || group.companyId !== companyId) {
        return res.status(403).json({ message: "Group not found or access denied" });
      }
      await storage.removeEmployeeFromGroup(groupId, parseInt(req.params.employeeId));
      res.status(204).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Worker Groups
  app.get("/api/worker-groups", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const allGroups = await storage.getAllEmployeeGroups(req.session.currentCompanyId);
      const workerGroups = allGroups.filter((g) => g.groupType === "Worker");
      res.json(workerGroups);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/worker-groups/with-members", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const companyId = req.session.currentCompanyId;
      const allGroups = await storage.getAllEmployeeGroups(companyId);
      const workerGroups = allGroups.filter((g) => g.groupType === "Worker");

      // Get members for each group, filtering by company for security
      const groupsWithMembers = await Promise.all(
        workerGroups.map(async (group) => {
          const memberRecords = await storage.getEmployeeGroupMembers(group.id);
          // Get full worker details for each member, ensuring they belong to the same company
          const members = await Promise.all(
            memberRecords.map(async (m) => {
              // employeeId comes through a LEFT JOIN, so a membership whose
              // employee row is gone carries null. The lookup below would match
              // nothing for it anyway; skipping it saves a query and keeps the
              // filter below as the single place a missing worker is dropped.
              if (m.employeeId === null) return undefined;
              const [worker] = await db
                .select()
                .from(employees)
                .where(and(eq(employees.id, m.employeeId), eq(employees.companyId, companyId)));
              return worker;
            })
          );
          const finalResult = {
            ...group,
            members: members.filter(Boolean),
          };
          return finalResult;
        })
      );
      res.json(groupsWithMembers);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/worker-groups", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const parsed = insertEmployeeGroupSchema.parse({
        ...req.body,
        companyId: req.session.currentCompanyId,
        groupType: "Worker",
      });
      const group = await storage.createEmployeeGroup(parsed);
      res.status(201).json(group);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/worker-groups/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteEmployeeGroup(parseInt(req.params.id));
      res.status(204).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/worker-groups/:id/members", requireAuth, async (req, res) => {
    try {
      const members = await storage.getEmployeeGroupMembers(parseInt(req.params.id));
      res.json(members);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/worker-groups/:groupId/members/:workerId", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const companyId = req.session.currentCompanyId;
      const groupId = parseInt(req.params.groupId);
      const workerId = parseInt(req.params.workerId);

      // Verify group belongs to company
      const group = await storage.getEmployeeGroupById(groupId);
      if (!group || group.companyId !== companyId) {
        return res.status(403).json({ message: "Group not found or access denied" });
      }

      // Verify worker belongs to company
      const [worker] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, workerId), eq(employees.companyId, companyId)));
      if (!worker) {
        return res.status(404).json({ message: "Worker not found" });
      }

      await storage.addEmployeeToGroup(groupId, workerId);
      res.status(201).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/worker-groups/:groupId/members/:workerId", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const companyId = req.session.currentCompanyId;
      const groupId = parseInt(req.params.groupId);
      const workerId = parseInt(req.params.workerId);

      // Verify group belongs to company
      const group = await storage.getEmployeeGroupById(groupId);
      if (!group || group.companyId !== companyId) {
        return res.status(403).json({ message: "Group not found or access denied" });
      }

      await storage.removeEmployeeFromGroup(groupId, workerId);
      res.status(204).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
