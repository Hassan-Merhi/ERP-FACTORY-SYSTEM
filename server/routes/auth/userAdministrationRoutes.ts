import type { Express } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  advanceCurrentSessionAfterPasswordChange,
  replacePasswordAndRevokeSessions,
} from "../../services/security/userPasswordChangeService";
import { storage } from "../../storage";
import {
  companies,
  erpUserPageAccess,
  insertUserCompanyRoleSchema,
  insertUserSchema,
  userCompanyRoles,
} from "@shared/schema";
import { ERP_TESTER_PAGE_KEYS, ERP_TESTER_ROLE, isErpTestCompanyCode } from "@shared/erpTestCompanyAccess";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, logAudit, verifyPassword } from "../_helpers";

async function isErpTestCompany(companyId: number): Promise<boolean> {
  const [company] = await db
    .select({ code: companies.code, type: companies.companyType, parentId: companies.parentCompanyId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return !!company && company.type === "erp" && company.parentId === null && isErpTestCompanyCode(company.code);
}

async function invalidateUserSessions(userId: string) {
  try {
    await db.execute(sql`DELETE FROM session WHERE sess::jsonb ->> 'userId' = ${userId}`);
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }
}

export function registerUserAdministrationRoutes(app: Express) {
  app.get("/api/users", requireAuth, requireRole("Admin"), async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const devRoles = await db
        .select({ userId: userCompanyRoles.userId })
        .from(userCompanyRoles)
        .where(eq(userCompanyRoles.role, "Developer"));
      const devUserIds = new Set(devRoles.map((role) => role.userId));
      res.json(allUsers.filter((user) => !devUserIds.has(user.id)).map(({ password, ...user }) => user));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/users", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const parsed = insertUserSchema.parse(req.body);
      if (await storage.getUserByUsername(parsed.username)) {
        return res.status(400).json({ message: "Username already exists" });
      }
      const user = await storage.createUser({ ...parsed, password: await hashPassword(parsed.password) });
      const { password, ...userWithoutPassword } = user;
      res.status(201).json(userWithoutPassword);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/users/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const updates = req.body;
      const requestedPassword = typeof updates.password === "string" ? updates.password : null;
      delete updates.password;

      let rotatedCredentialVersion: number | null = null;
      if (requestedPassword) {
        rotatedCredentialVersion = await replacePasswordAndRevokeSessions(
          req.params.id,
          await hashPassword(requestedPassword),
          { exceptSid: req.params.id === req.session.userId ? req.sessionID : undefined }
        );
      }

      const user =
        Object.keys(updates).length > 0
          ? await storage.updateUser(req.params.id, updates)
          : await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });

      if (rotatedCredentialVersion !== null && req.params.id === req.session.userId) {
        advanceCurrentSessionAfterPasswordChange(req.session, rotatedCredentialVersion);
        await new Promise<void>((resolve, reject) => {
          req.session.save((error: unknown) => (error ? reject(error) : resolve()));
        });
      }

      const { password, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/users/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { id } = req.params;
      if (req.user?.id === id) return res.status(400).json({ message: "Cannot delete your own account" });
      if (req.user?.role !== "Developer") {
        const targetRoles = await db
          .select({ role: userCompanyRoles.role })
          .from(userCompanyRoles)
          .where(eq(userCompanyRoles.userId, id));
        if (targetRoles.some((role) => role.role === "Developer")) {
          return res.status(403).json({ message: "Cannot delete this account" });
        }
      }
      await storage.deleteUser(id);
      await invalidateUserSessions(id);
      res.json({ message: "User deleted successfully" });
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/user/change-password", requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current password and new password are required" });
      }
      if (newPassword.length < 6)
        return res.status(400).json({ message: "New password must be at least 6 characters." });
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      const { valid } = await verifyPassword(currentPassword, user.password);
      if (!valid) return res.status(400).json({ message: "Current password is incorrect" });

      const credentialVersion = await replacePasswordAndRevokeSessions(userId, await hashPassword(newPassword), {
        exceptSid: req.sessionID,
      });
      advanceCurrentSessionAfterPasswordChange(req.session, credentialVersion);
      await new Promise<void>((resolve, reject) => {
        req.session.save((error: unknown) => (error ? reject(error) : resolve()));
      });
      res.json({ message: "Password changed successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/reset-password/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body;
      if (!newPassword) return res.status(400).json({ message: "New password is required" });
      if (newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      await replacePasswordAndRevokeSessions(userId, await hashPassword(newPassword));
      res.json({ message: `Password reset successfully for user: ${user.username}` });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/users/:userId/company-roles", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      res.json(await storage.getUserCompaniesWithRoles(req.params.userId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/user-company-roles", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const parsed = insertUserCompanyRoleSchema.parse(req.body);
      if (parsed.role === "POS" && !parsed.assignedLocationId) {
        return res.status(400).json({ message: "POS role requires an assigned location" });
      }
      if (parsed.role === ERP_TESTER_ROLE && !(await isErpTestCompany(parsed.companyId))) {
        return res.status(400).json({ message: "ERP Tester can only be assigned to a standalone ERP Test Company" });
      }
      const existing = await db
        .select({ id: userCompanyRoles.id })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, parsed.userId), eq(userCompanyRoles.companyId, parsed.companyId)))
        .limit(1);
      if (existing.length > 0) {
        return res
          .status(409)
          .json({ message: "This user already has a role in this company. Edit the existing role instead." });
      }
      // Phase 21 (B): the role and its audit row commit together.
      const role = await db.transaction(async (tx) => {
        const created = await storage.createUserCompanyRole(parsed, tx);
        if (parsed.role === ERP_TESTER_ROLE) {
          await tx
            .insert(erpUserPageAccess)
            .values(
              ERP_TESTER_PAGE_KEYS.map((pageKey) => ({
                userId: parsed.userId,
                companyId: parsed.companyId,
                pageKey,
              }))
            )
            .onConflictDoNothing();
        }
        await logAudit(
          {
            userId: req.user!.id,
            username: req.user!.username || req.session.username || "unknown",
            companyId: req.session.currentCompanyId,
            action: "create",
            tableName: "user_company_roles",
            recordId: created.id,
            recordIdentifier: `userId:${parsed.userId} role:${parsed.role} company:${parsed.companyId}`,
            changes: null,
          },
          tx
        );
        return created;
      });
      res.status(201).json(role);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/user-company-roles/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = insertUserCompanyRoleSchema.partial().parse(req.body);
      if (parsed.role === "POS" && !parsed.assignedLocationId) {
        return res.status(400).json({ message: "POS role requires an assigned location" });
      }
      const [oldRecord] = await db.select().from(userCompanyRoles).where(eq(userCompanyRoles.id, id)).limit(1);
      if (!oldRecord) return res.status(404).json({ message: "Role assignment not found" });
      const effectiveRole = parsed.role ?? oldRecord.role;
      const effectiveCompanyId = parsed.companyId ?? oldRecord.companyId;
      if (effectiveRole === ERP_TESTER_ROLE && !(await isErpTestCompany(effectiveCompanyId))) {
        return res.status(400).json({ message: "ERP Tester can only be assigned to a standalone ERP Test Company" });
      }
      // Phase 21 (B): the role change and its audit row commit together; the
      // sessions are invalidated after commit, as before.
      const role = await db.transaction(async (tx) => {
        const updatedRole = await storage.updateUserCompanyRole(id, parsed, tx);
        if (effectiveRole === ERP_TESTER_ROLE) {
          await tx
            .delete(erpUserPageAccess)
            .where(
              and(
                eq(erpUserPageAccess.userId, updatedRole.userId),
                eq(erpUserPageAccess.companyId, updatedRole.companyId)
              )
            );
          await tx.insert(erpUserPageAccess).values(
            ERP_TESTER_PAGE_KEYS.map((pageKey) => ({
              userId: updatedRole.userId,
              companyId: updatedRole.companyId,
              pageKey,
            }))
          );
        }
        if (oldRecord) {
          const changes: Record<string, { old?: unknown; new?: unknown }> = {};
          for (const key of Object.keys(parsed) as Array<keyof typeof parsed>) {
            const oldVal = oldRecord[key];
            const newVal = parsed[key];
            if (newVal !== undefined && String(oldVal) !== String(newVal)) changes[key] = { old: oldVal, new: newVal };
          }
          await logAudit(
            {
              userId: req.user!.id,
              username: req.user!.username || req.session.username || "unknown",
              companyId: req.session.currentCompanyId,
              action: "update",
              tableName: "user_company_roles",
              recordId: id,
              recordIdentifier: `userId:${oldRecord.userId} role:${oldRecord.role} company:${oldRecord.companyId}`,
              changes: Object.keys(changes).length > 0 ? changes : null,
            },
            tx
          );
        }
        return updatedRole;
      });
      if (oldRecord) await invalidateUserSessions(oldRecord.userId);
      res.json(role);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/user-company-roles/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [oldRecord] = await db.select().from(userCompanyRoles).where(eq(userCompanyRoles.id, id)).limit(1);
      // Phase 21 (B): the delete and its audit row commit together; the
      // sessions are invalidated after commit, as before.
      await db.transaction(async (tx) => {
        await storage.deleteUserCompanyRole(id, tx);
        if (oldRecord) {
          await logAudit(
            {
              userId: req.user!.id,
              username: req.user!.username || req.session.username || "unknown",
              companyId: req.session.currentCompanyId,
              action: "delete",
              tableName: "user_company_roles",
              recordId: id,
              recordIdentifier: `userId:${oldRecord.userId} role:${oldRecord.role} company:${oldRecord.companyId}`,
              changes: null,
            },
            tx
          );
        }
      });
      if (oldRecord) await invalidateUserSessions(oldRecord.userId);
      res.status(204).send();
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
