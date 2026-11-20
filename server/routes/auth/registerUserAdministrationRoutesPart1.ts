// Extracted from ./userAdministrationRoutes.ts
import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  advanceCurrentSessionAfterPasswordChange,
  replacePasswordAndRevokeSessions,
} from "../../services/security/userPasswordChangeService";
import { storage } from "../../storage";
import { erpUserPageAccess, insertUserCompanyRoleSchema, userCompanyRoles } from "@shared/schema";
import { refuseInactiveCreateOnlyAssignment } from "../../services/security/createOnlyActivation";
import { CompanyAdministratorGuardError } from "../../services/security/companyAdministratorGuard";
import { ERP_TESTER_PAGE_KEYS, ERP_TESTER_ROLE } from "@shared/erpTestCompanyAccess";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, logAudit, verifyPassword } from "../_helpers";
import { invalidateUserSessions, respondRoleAssignmentFailure } from "./userAdministrationRoutesHelpers";

export function registerUserAdministrationRoutesPart1(app: Express) {
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
      const createOnlyRefusal = refuseInactiveCreateOnlyAssignment({ requestedRole: parsed.role });
      if (createOnlyRefusal) {
        return res
          .status(createOnlyRefusal.status)
          .json({ code: createOnlyRefusal.code, message: createOnlyRefusal.message });
      }
      if (parsed.role === "POS" && !parsed.assignedLocationId) {
        return res.status(400).json({ message: "POS role requires an assigned location" });
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
      respondRoleAssignmentFailure(req, res, error);
    }
  });
}
