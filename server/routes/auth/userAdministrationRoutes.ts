import type { Express } from "express";

import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { storage } from "../../storage";
import { erpUserPageAccess, insertUserCompanyRoleSchema, insertUserSchema, userCompanyRoles } from "@shared/schema";
import { refuseInactiveCreateOnlyAssignment } from "../../services/security/createOnlyActivation";
import {
  assertCompanyKeepsAdministrator,
  refuseSelfRoleChange,
} from "../../services/security/companyAdministratorGuard";
import { ERP_TESTER_PAGE_KEYS, ERP_TESTER_ROLE } from "@shared/erpTestCompanyAccess";
import { and, eq } from "drizzle-orm";
import { hashPassword, logAudit } from "../_helpers";
import { invalidateUserSessions, respondRoleAssignmentFailure } from "./userAdministrationRoutesHelpers";
import { registerUserAdministrationRoutesPart1 } from "./registerUserAdministrationRoutesPart1";

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

  registerUserAdministrationRoutesPart1(app);

  app.patch("/api/user-company-roles/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = insertUserCompanyRoleSchema.partial().parse(req.body);
      if (parsed.role === "POS" && !parsed.assignedLocationId) {
        return res.status(400).json({ message: "POS role requires an assigned location" });
      }
      const [oldRecord] = await db.select().from(userCompanyRoles).where(eq(userCompanyRoles.id, id)).limit(1);
      if (!oldRecord) return res.status(404).json({ message: "Role assignment not found" });
      const createOnlyRefusal = refuseInactiveCreateOnlyAssignment({
        requestedRole: parsed.role,
        previousRole: oldRecord.role,
      });
      if (createOnlyRefusal) {
        return res
          .status(createOnlyRefusal.status)
          .json({ code: createOnlyRefusal.code, message: createOnlyRefusal.message });
      }
      const selfRefusal = refuseSelfRoleChange({
        actorUserId: req.session.userId,
        actorRole: req.session.currentRole,
        targetUserId: oldRecord.userId,
        previousRole: oldRecord.role,
        nextRole: parsed.role,
        removing: false,
      });
      if (selfRefusal) throw selfRefusal;
      const effectiveRole = parsed.role ?? oldRecord.role;
      // Phase 21 (B): the role change and its audit row commit together; the
      // sessions are invalidated after commit, as before.
      const role = await db.transaction(async (tx) => {
        await assertCompanyKeepsAdministrator(tx, {
          companyId: parsed.companyId ?? oldRecord.companyId,
          targetRowId: id,
          targetRole: oldRecord.role,
          nextRole: effectiveRole,
        });
        // Moving an Admin row to another company also removes it from this one.
        if (parsed.companyId !== undefined && parsed.companyId !== oldRecord.companyId) {
          await assertCompanyKeepsAdministrator(tx, {
            companyId: oldRecord.companyId,
            targetRowId: id,
            targetRole: oldRecord.role,
            nextRole: null,
          });
        }
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
      respondRoleAssignmentFailure(req, res, error);
    }
  });

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
