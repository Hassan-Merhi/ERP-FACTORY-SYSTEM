// Extracted from ./registerFactoryUsersAccessRoutes.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth, requirePasswordConfirmation } from "../../../auth";
import { privilegedMutationRateLimit } from "../../../middleware/privilegedEndpointSecurity";
import { factoryUserPageAccess, factoryUserProfiles, userCompanyRoles, users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "../../_helpers";
import {
  bumpCredentialVersion,
  revokeUserCompanySessions,
  revokeUserSessions,
} from "../../../services/security/credentialVersionService";
import { normalizeAssignableFactoryPageKeys, normalizeFactoryHiddenFields } from "@shared/factoryPermissionCatalog";
import {
  canManageFactoryUsers,
  loadCompanyMembership,
  requesterIsDeveloper,
} from "./usersAccessRoutesLoadCompanyMembership";

export function registerFactoryUsersAccessRoutesPart1(app: Express) {
  app.post(
    "/api/factory/users",
    requireAuth,
    privilegedMutationRateLimit,
    requirePasswordConfirmation,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        const currentRole = req.session.currentRole;
        const requestRole = req.user?.role;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!canManageFactoryUsers(currentRole, requestRole)) {
          return res.status(403).json({ message: "Only Admin or Owner can manage users" });
        }

        const { username, password, displayName, pageAccess, hasErpAccess, hasFactoryAccess } = req.body;
        if (!username || !password) {
          return res.status(400).json({ message: "Username and password are required" });
        }
        if (password.length < 4) {
          return res.status(400).json({ message: "Password must be at least 4 characters" });
        }

        const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (existing.length > 0) {
          return res.status(400).json({ message: "Username already exists" });
        }

        const normalizedPageAccess = normalizeAssignableFactoryPageKeys(pageAccess);

        const newUser = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(users)
            .values({
              username,
              password: await hashPassword(password),
              active: true,
            })
            .returning();

          // Factory users are governed by their page list; "Normal User" is the
          // deny-by-default ERP role. The retired "User" role is not recognised.
          await tx.insert(userCompanyRoles).values({
            userId: created.id,
            companyId,
            role: "Normal User",
          });

          await tx.insert(factoryUserProfiles).values({
            companyId,
            userId: created.id,
            displayName: displayName || username,
            hasErpAccess: hasErpAccess ?? true,
            hasFactoryAccess: hasFactoryAccess ?? true,
          });

          if (normalizedPageAccess.length > 0) {
            await tx.insert(factoryUserPageAccess).values(
              normalizedPageAccess.map((pageKey) => ({
                companyId,
                userId: created.id,
                pageKey,
              }))
            );
          }
          return created;
        });

        const { password: _password, ...userWithoutPassword } = newUser;
        res.status(201).json({
          ...userWithoutPassword,
          displayName: displayName || username,
          hasErpAccess: hasErpAccess ?? true,
          hasFactoryAccess: hasFactoryAccess ?? true,
          pageAccess: normalizedPageAccess,
        });
      } catch (error: unknown) {
        logger.error("Error creating factory user:", { error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.put(
    "/api/factory/users/:userId",
    requireAuth,
    privilegedMutationRateLimit,
    requirePasswordConfirmation,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        const currentRole = req.session.currentRole;
        const requestRole = req.user?.role;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!canManageFactoryUsers(currentRole, requestRole)) {
          return res.status(403).json({ message: "Only Admin or Owner can manage users" });
        }

        const { userId } = req.params;
        const membership = await loadCompanyMembership(userId, companyId);
        if (!membership) return res.status(404).json({ message: "User not found in this company" });

        const isDeveloper = requesterIsDeveloper(currentRole, requestRole);
        if (membership.role === "Developer" && !isDeveloper) {
          return res.status(403).json({ message: "Cannot modify this account" });
        }

        const {
          displayName,
          pageAccess,
          password,
          hasErpAccess,
          hasFactoryAccess,
          hiddenCostFields,
          hideAllCosts,
          username,
        } = req.body;

        // Username/password live on the global identity record, not on a tenant
        // membership. A tenant Admin/Owner must not be able to mutate credentials
        // that may also authorize the same identity in another company.
        if (!isDeveloper && (password !== undefined || username !== undefined)) {
          return res.status(403).json({ message: "Only Developer can change global user credentials" });
        }
        if (password !== undefined && password && password.length < 4) {
          return res.status(400).json({ message: "Password must be at least 4 characters" });
        }

        const normalizedPageAccess = Array.isArray(pageAccess) ? normalizeAssignableFactoryPageKeys(pageAccess) : null;

        const credentialChanged = Boolean(password || (typeof username === "string" && username.trim()));
        const newCredentialVersion = await db.transaction(async (tx) => {
          let credentialVersion: number | null = null;
          const userUpdates: Record<string, unknown> = {};
          if (password) userUpdates.password = await hashPassword(password);
          if (typeof username === "string" && username.trim()) {
            const normalizedUsername = username.trim();
            const existingWithUsername = await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.username, normalizedUsername))
              .limit(1);
            if (existingWithUsername.length > 0 && existingWithUsername[0].id !== userId) {
              throw new Error("Username already taken");
            }
            userUpdates.username = normalizedUsername;
          }
          if (Object.keys(userUpdates).length > 0) {
            await tx.update(users).set(userUpdates).where(eq(users.id, userId));
            credentialVersion = await bumpCredentialVersion(tx, userId);
          }

          const profileUpdates: Record<string, unknown> = { updatedAt: new Date() };
          if (displayName !== undefined) profileUpdates.displayName = displayName;
          if (hasErpAccess !== undefined) profileUpdates.hasErpAccess = hasErpAccess;
          if (hasFactoryAccess !== undefined) profileUpdates.hasFactoryAccess = hasFactoryAccess;
          if (Array.isArray(hiddenCostFields))
            profileUpdates.hiddenCostFields = normalizeFactoryHiddenFields(hiddenCostFields);
          if (hideAllCosts !== undefined) profileUpdates.hideAllCosts = !!hideAllCosts;

          const existingProfile = await tx
            .select({ userId: factoryUserProfiles.userId })
            .from(factoryUserProfiles)
            .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)))
            .limit(1);

          if (existingProfile.length > 0) {
            await tx
              .update(factoryUserProfiles)
              .set(profileUpdates)
              .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)));
          } else {
            await tx.insert(factoryUserProfiles).values({
              companyId,
              userId,
              displayName: displayName || "User",
              hasErpAccess: hasErpAccess ?? true,
              hasFactoryAccess: hasFactoryAccess ?? true,
              hiddenCostFields: normalizeFactoryHiddenFields(hiddenCostFields),
              hideAllCosts: !!hideAllCosts,
            });
          }

          if (normalizedPageAccess !== null) {
            await tx
              .delete(factoryUserPageAccess)
              .where(and(eq(factoryUserPageAccess.companyId, companyId), eq(factoryUserPageAccess.userId, userId)));

            if (normalizedPageAccess.length > 0) {
              await tx.insert(factoryUserPageAccess).values(
                normalizedPageAccess.map((pageKey) => ({
                  companyId,
                  userId,
                  pageKey,
                }))
              );
            }
          }

          return credentialVersion;
        });

        // Global credential rotation invalidates every session for the shared
        // identity. Tenant-only profile/access changes revoke only sessions that
        // are operating inside the affected company.
        if (newCredentialVersion != null) {
          await revokeUserSessions(pool, userId);
        } else {
          await revokeUserCompanySessions(pool, userId, companyId);
        }
        res.json({
          message: credentialChanged || newCredentialVersion != null ? "User updated" : "User access updated",
        });
      } catch (error: unknown) {
        logger.error("Error updating factory user:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
