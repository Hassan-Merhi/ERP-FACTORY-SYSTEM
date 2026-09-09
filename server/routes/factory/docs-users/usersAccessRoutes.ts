/**
 * factoryDocsUsersRoutes: FactoryUsersAccess endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth, requirePasswordConfirmation } from "../../../auth";
import { privilegedMutationRateLimit } from "../../../middleware/privilegedEndpointSecurity";
import { users, companies, userCompanyRoles, factoryUserProfiles, factoryUserPageAccess } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "../../_helpers";
import {
  bumpCredentialVersion,
  revokeUserCompanySessions,
  revokeUserSessions,
} from "../../../services/security/credentialVersionService";

function requesterIsDeveloper(currentRole: unknown, requestRole: unknown): boolean {
  return currentRole === "Developer" || requestRole === "Developer";
}

function canManageFactoryUsers(currentRole: unknown, requestRole: unknown): boolean {
  return (
    ["Admin", "Owner", "Developer"].includes(String(currentRole ?? "")) ||
    ["Admin", "Developer"].includes(String(requestRole ?? ""))
  );
}

async function loadCompanyMembership(userId: string, companyId: number) {
  const [membership] = await db
    .select({ role: userCompanyRoles.role })
    .from(userCompanyRoles)
    .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyId)))
    .limit(1);
  return membership ?? null;
}

export function registerFactoryUsersAccessRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // Factory User Management
  // ───────────────────────────────────────────────

  app.get("/api/factory/users", requireAuth, async (req: Request, res: Response) => {
    try {
      // Factory user management is tenant scoped. Never use a cached/pinned
      // company different from the authenticated request company here; Phase 3
      // RLS and the application boundary must agree on the same tenant.
      const companyId = req.session.currentCompanyId;
      const currentRole = req.session.currentRole;
      const requestRole = req.user?.role;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!canManageFactoryUsers(currentRole, requestRole)) {
        return res.status(403).json({ message: "Only Admin or Owner can manage users" });
      }

      const companyUsers = await db
        .select({
          id: users.id,
          username: users.username,
          active: users.active,
          createdAt: users.createdAt,
          companyRole: userCompanyRoles.role,
        })
        .from(users)
        .innerJoin(
          userCompanyRoles,
          and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, companyId))
        );

      const isDeveloper = requesterIsDeveloper(currentRole, requestRole);
      const visibleUsers = companyUsers.filter((user) => isDeveloper || user.companyRole !== "Developer");

      const profiles = await db.select().from(factoryUserProfiles).where(eq(factoryUserProfiles.companyId, companyId));
      const access = await db
        .select()
        .from(factoryUserPageAccess)
        .where(eq(factoryUserPageAccess.companyId, companyId));

      const profileMap = new Map(profiles.map((profile) => [profile.userId, profile]));
      const accessMap = new Map<string, string[]>();
      access.forEach((entry) => {
        if (!accessMap.has(entry.userId)) accessMap.set(entry.userId, []);
        accessMap.get(entry.userId)!.push(entry.pageKey);
      });

      const result = visibleUsers.map(({ companyRole: _companyRole, ...user }) => {
        const profile = profileMap.get(user.id);
        return {
          ...user,
          displayName: profile?.displayName || null,
          hasErpAccess: profile?.hasErpAccess ?? true,
          hasFactoryAccess: profile?.hasFactoryAccess ?? true,
          hiddenCostFields: profile?.hiddenCostFields ?? [],
          hideAllCosts: profile?.hideAllCosts ?? false,
          pageAccess: accessMap.get(user.id) || [],
        };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching factory users:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
        if (password.length < 6) {
          return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

        const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (existing.length > 0) {
          return res.status(400).json({ message: "Username already exists" });
        }

        const newUser = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(users)
            .values({
              username,
              password: await hashPassword(password),
              active: true,
            })
            .returning();

          await tx.insert(userCompanyRoles).values({
            userId: created.id,
            companyId,
            role: "User",
          });

          await tx.insert(factoryUserProfiles).values({
            companyId,
            userId: created.id,
            displayName: displayName || username,
            hasErpAccess: hasErpAccess ?? true,
            hasFactoryAccess: hasFactoryAccess ?? true,
          });

          if (Array.isArray(pageAccess) && pageAccess.length > 0) {
            await tx.insert(factoryUserPageAccess).values(
              pageAccess.map((pageKey: string) => ({
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
          pageAccess: pageAccess || [],
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
        if (password !== undefined && password && password.length < 6) {
          return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

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
          if (Array.isArray(hiddenCostFields)) profileUpdates.hiddenCostFields = hiddenCostFields;
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
              hiddenCostFields: Array.isArray(hiddenCostFields) ? hiddenCostFields : [],
              hideAllCosts: !!hideAllCosts,
            });
          }

          if (Array.isArray(pageAccess)) {
            await tx
              .delete(factoryUserPageAccess)
              .where(and(eq(factoryUserPageAccess.companyId, companyId), eq(factoryUserPageAccess.userId, userId)));

            if (pageAccess.length > 0) {
              await tx.insert(factoryUserPageAccess).values(
                pageAccess.map((pageKey: string) => ({
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

  app.delete(
    "/api/factory/users/:userId",
    requireAuth,
    privilegedMutationRateLimit,
    requirePasswordConfirmation,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        const currentRole = req.session.currentRole;
        const requestRole = req.user?.role;
        const sessionUserId = req.session.userId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!canManageFactoryUsers(currentRole, requestRole)) {
          return res.status(403).json({ message: "Only Admin or Owner can manage users" });
        }

        const { userId } = req.params;
        if (userId === sessionUserId) {
          return res.status(400).json({ message: "You cannot remove your own account" });
        }

        const membership = await loadCompanyMembership(userId, companyId);
        if (!membership) return res.status(404).json({ message: "User not found in this company" });
        if (membership.role === "Developer" && !requesterIsDeveloper(currentRole, requestRole)) {
          return res.status(403).json({ message: "Cannot remove this account" });
        }

        // Removing a user from one tenant must never delete their global identity
        // or memberships in other tenants. Only current-company rows are removed.
        await db.transaction(async (tx) => {
          await tx
            .delete(factoryUserPageAccess)
            .where(and(eq(factoryUserPageAccess.companyId, companyId), eq(factoryUserPageAccess.userId, userId)));
          await tx
            .delete(factoryUserProfiles)
            .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)));
          await tx
            .delete(userCompanyRoles)
            .where(and(eq(userCompanyRoles.companyId, companyId), eq(userCompanyRoles.userId, userId)));
        });
        await revokeUserCompanySessions(pool, userId, companyId);
        res.json({ message: "User access removed from this company" });
      } catch (error: unknown) {
        logger.error("Error removing factory user:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/factory/my-access", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId;
      const currentCompanyId = req.session.currentCompanyId;
      const pinnedFactoryId = req.session.factoryCompanyId;
      const cachedFactoryName = req.session.factoryCompanyName;
      const role = req.session.currentRole;

      if (!currentCompanyId || !userId) return res.status(400).json({ message: "No company or user" });

      // A pinned factory company is only a cache hint. It can never widen the
      // authenticated tenant context. Cross-company fallback to the first active
      // factory used to let a normal session discover/use another tenant.
      if (
        pinnedFactoryId === currentCompanyId &&
        cachedFactoryName &&
        (role === "Admin" || role === "Owner" || role === "Developer")
      ) {
        res.set("Cache-Control", "private, max-age=120");
        return res.json({
          fullAccess: true,
          pageKeys: [],
          hasErpAccess: true,
          hasFactoryAccess: true,
          hiddenCostFields: [],
          hideAllCosts: false,
          companyId: currentCompanyId,
          companyName: cachedFactoryName,
        });
      }

      const [current] = await db
        .select({ id: companies.id, name: companies.name, companyType: companies.companyType })
        .from(companies)
        .where(eq(companies.id, currentCompanyId))
        .limit(1);
      if (!current) return res.status(404).json({ message: "Company not found" });

      const companyId = current.id;
      const companyName = current.name;
      if (current.companyType === "factory") {
        req.session.factoryCompanyId = companyId;
        req.session.factoryCompanyName = companyName;
      } else {
        delete req.session.factoryCompanyId;
        delete req.session.factoryCompanyName;
      }

      if (role === "Admin" || role === "Owner" || role === "Developer") {
        res.set("Cache-Control", "private, max-age=120");
        return res.json({
          fullAccess: true,
          pageKeys: [],
          hasErpAccess: true,
          hasFactoryAccess: true,
          hiddenCostFields: [],
          hideAllCosts: false,
          companyId,
          companyName,
        });
      }

      const [profile] = await db
        .select({
          hasErpAccess: factoryUserProfiles.hasErpAccess,
          hasFactoryAccess: factoryUserProfiles.hasFactoryAccess,
          hiddenCostFields: factoryUserProfiles.hiddenCostFields,
          hideAllCosts: factoryUserProfiles.hideAllCosts,
        })
        .from(factoryUserProfiles)
        .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)));

      const hasErpAccess = profile ? profile.hasErpAccess : true;
      const hasFactoryAccess = profile ? profile.hasFactoryAccess : true;
      const hideAllCosts = profile?.hideAllCosts ?? false;
      const ALL_COST_KEYS = [
        "inventory_avg_rate",
        "inventory_total_value",
        "inventory_sell_price",
        "inventory_sell_value",
        "bale_history_cost_per_kg",
        "bale_history_total_cost",
        "bales_list_cost_per_kg",
        "hide_proforma_price",
      ];
      const hiddenCostFields = hideAllCosts ? ALL_COST_KEYS : (profile?.hiddenCostFields ?? []);

      const access = await db
        .select({ pageKey: factoryUserPageAccess.pageKey })
        .from(factoryUserPageAccess)
        .where(and(eq(factoryUserPageAccess.companyId, companyId), eq(factoryUserPageAccess.userId, userId)));

      res.set("Cache-Control", "private, max-age=120");
      if (access.length === 0) {
        return res.json({
          fullAccess: true,
          pageKeys: [],
          hasErpAccess,
          hasFactoryAccess,
          hiddenCostFields,
          hideAllCosts,
          companyId,
          companyName,
        });
      }

      res.json({
        fullAccess: false,
        pageKeys: access.map((entry) => entry.pageKey),
        hasErpAccess,
        hasFactoryAccess,
        hiddenCostFields,
        hideAllCosts,
        companyId,
        companyName,
      });
    } catch (error: unknown) {
      logger.error("Error fetching my access:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
