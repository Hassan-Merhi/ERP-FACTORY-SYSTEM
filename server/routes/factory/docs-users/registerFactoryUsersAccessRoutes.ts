// Extracted from ./usersAccessRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth, requirePasswordConfirmation } from "../../../auth";
import { privilegedMutationRateLimit } from "../../../middleware/privilegedEndpointSecurity";
import { companies, factoryUserPageAccess, factoryUserProfiles, userCompanyRoles, users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { revokeUserCompanySessions } from "../../../services/security/credentialVersionService";
import {
  normalizeFactoryHiddenFields,
  normalizePersistedFactoryPageKeysFailClosed,
  resolveFactoryEffectiveHiddenFields,
} from "@shared/factoryPermissionCatalog";
import {
  canManageFactoryUsers,
  loadCompanyMembership,
  requesterIsDeveloper,
} from "./usersAccessRoutesLoadCompanyMembership";
import { registerFactoryUsersAccessRoutesPart1 } from "./registerFactoryUsersAccessRoutesPart1";

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

      const result = visibleUsers.map(({ companyRole, ...user }) => {
        const profile = profileMap.get(user.id);
        return {
          ...user,
          role: companyRole,
          displayName: profile?.displayName || null,
          hasErpAccess: profile?.hasErpAccess ?? true,
          hasFactoryAccess: profile?.hasFactoryAccess ?? true,
          hiddenCostFields: normalizeFactoryHiddenFields(profile?.hiddenCostFields),
          hideAllCosts: profile?.hideAllCosts ?? false,
          pageAccess: normalizePersistedFactoryPageKeysFailClosed(accessMap.get(user.id) || []),
        };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching factory users:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryUsersAccessRoutesPart1(app);

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
      const profileHiddenFields = resolveFactoryEffectiveHiddenFields(
        normalizeFactoryHiddenFields(profile?.hiddenCostFields)
      );
      const hiddenCostFields = hideAllCosts
        ? Array.from(new Set([...profileHiddenFields, ...ALL_COST_KEYS]))
        : profileHiddenFields;

      const access = await db
        .select({ pageKey: factoryUserPageAccess.pageKey })
        .from(factoryUserPageAccess)
        .where(and(eq(factoryUserPageAccess.companyId, companyId), eq(factoryUserPageAccess.userId, userId)));
      // Factory page restrictions live only in factory_user_page_access; ERP
      // page restrictions use erp_user_page_access. Known legacy Factory keys
      // are canonicalized here; unknown Factory keys stay fail-closed.
      const factoryPageKeys = normalizePersistedFactoryPageKeysFailClosed(access.map((entry) => entry.pageKey));

      res.set("Cache-Control", "private, max-age=120");
      if (factoryPageKeys.length === 0) {
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
        pageKeys: factoryPageKeys,
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
