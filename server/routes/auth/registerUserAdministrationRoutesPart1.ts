// Extracted from ./userAdministrationRoutes.ts
import type { Express, Request, Response } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { replacePasswordAndRevokeSessions } from "../../services/security/userPasswordChangeService";
import { storage } from "../../storage";
import { erpUserPageAccess, insertUserCompanyRoleSchema, userCompanyRoles } from "@shared/schema";
import { refuseInactiveCreateOnlyAssignment } from "../../services/security/createOnlyActivation";
import {
  CompanyAdministratorGuardError,
  assertCompanyKeepsAdministrator,
  refuseSelfRoleChange,
} from "../../services/security/companyAdministratorGuard";
import { recordPermissionSignal } from "../../services/security/permissionMonitor";
import { ERP_TESTER_PAGE_KEYS, ERP_TESTER_ROLE } from "@shared/erpTestCompanyAccess";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, logAudit } from "../_helpers";

export async function invalidateUserSessions(userId: string) {
  try {
    await db.execute(sql`DELETE FROM session WHERE sess::jsonb ->> 'userId' = ${userId}`);
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }
}

/** Answer a refused or failed role assignment and record the monitoring signal. */
export function respondRoleAssignmentFailure(req: Request, res: Response, error: unknown): void {
  const guard = error instanceof CompanyAdministratorGuardError ? error : null;
  recordPermissionSignal({
    kind: "role_assignment_failed",
    code: guard?.code ?? "ROLE_ASSIGNMENT_INVALID",
    companyId: req.session.currentCompanyId ?? null,
    userId: req.session.userId ?? null,
    role: req.session.currentRole ?? null,
    method: req.method,
    path: req.path,
  });
  if (guard) {
    res.status(guard.status).json({ code: guard.code, message: guard.message });
    return;
  }
  res.status(400).json({ message: getErrorMessage(error) });
}

export function registerUserAdministrationRoutesPart1(app: Express) {
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
}
