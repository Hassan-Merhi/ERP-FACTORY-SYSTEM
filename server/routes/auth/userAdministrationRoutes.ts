import type { Express } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  advanceCurrentSessionAfterPasswordChange,
  replacePasswordAndRevokeSessions,
} from "../../services/security/userPasswordChangeService";
import { storage } from "../../storage";
import { insertUserSchema, userCompanyRoles } from "@shared/schema";
import {
  CompanyAdministratorGuardError,
  assertCompanyKeepsAdministrator,
  refuseSelfRoleChange,
} from "../../services/security/companyAdministratorGuard";
import { eq, sql } from "drizzle-orm";
import { hashPassword, logAudit, verifyPassword } from "../_helpers";
import {
  registerUserAdministrationRoutesPart1,
  invalidateUserSessions,
  respondRoleAssignmentFailure,
} from "./registerUserAdministrationRoutesPart1";

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
      // Deleting the account removes all its company roles; refuse when it is
      // any company's last Admin.
      const soleAdminCompanies = await db.execute(sql`
        SELECT mine.company_id
          FROM user_company_roles mine
         WHERE mine.user_id = ${id} AND mine.role = 'Admin'
           AND NOT EXISTS (
             SELECT 1 FROM user_company_roles other
              WHERE other.company_id = mine.company_id AND other.role = 'Admin' AND other.user_id <> ${id}
           )
         LIMIT 1`);
      if (soleAdminCompanies.rows.length > 0) {
        throw new CompanyAdministratorGuardError(
          409,
          "LAST_COMPANY_ADMINISTRATOR",
          "This account is a company's last administrator. Assign another Admin before deleting it."
        );
      }
      await storage.deleteUser(id);
      await invalidateUserSessions(id);
      res.json({ message: "User deleted successfully" });
    } catch (error: unknown) {
      if (error instanceof CompanyAdministratorGuardError) {
        respondRoleAssignmentFailure(req, res, error);
        return;
      }
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

  registerUserAdministrationRoutesPart1(app);

  app.delete("/api/user-company-roles/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [oldRecord] = await db.select().from(userCompanyRoles).where(eq(userCompanyRoles.id, id)).limit(1);
      if (oldRecord) {
        const selfRefusal = refuseSelfRoleChange({
          actorUserId: req.session.userId,
          actorRole: req.session.currentRole,
          targetUserId: oldRecord.userId,
          previousRole: oldRecord.role,
          nextRole: null,
          removing: true,
        });
        if (selfRefusal) throw selfRefusal;
      }
      // Phase 21 (B): the delete and its audit row commit together; the
      // sessions are invalidated after commit, as before.
      await db.transaction(async (tx) => {
        if (oldRecord) {
          await assertCompanyKeepsAdministrator(tx, {
            companyId: oldRecord.companyId,
            targetRowId: id,
            targetRole: oldRecord.role,
            nextRole: null,
          });
        }
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
      respondRoleAssignmentFailure(req, res, error);
    }
  });
}
