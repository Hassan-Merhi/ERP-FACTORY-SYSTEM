import type { NextFunction, Request, RequestHandler, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { factoryUserPageAccess, factoryUserProfiles } from "@shared/schema";
import {
  FACTORY_ACCESS_REGISTRY,
  factoryPageAllowsRole,
  hasFactoryPageKey,
} from "@shared/factoryAccessRegistry";

export const FACTORY_PRIVILEGED_ROLES = new Set(["Admin", "Owner", "Developer"]);

export type FactoryAccessState = {
  userId: string;
  companyId: number;
  role: string;
  privileged: boolean;
  fullAccess: boolean;
  hasErpAccess: boolean;
  hasFactoryAccess: boolean;
  pageKeys: string[];
  hiddenTabs: string[];
};

export type FactoryAccessDecision =
  | { allowed: true; state: FactoryAccessState }
  | {
      allowed: false;
      code:
        | "FACTORY_ACCESS_DISABLED"
        | "FACTORY_PAGE_ACCESS_DENIED"
        | "FACTORY_TAB_ACCESS_DENIED"
        | "FACTORY_ROLE_ACCESS_DENIED"
        | "FACTORY_ACCESS_CONTEXT_MISSING";
      message: string;
      state?: FactoryAccessState;
    };

const accessStateCache = new WeakMap<Request, Promise<FactoryAccessState | null>>();

export function isFactoryPrivilegedRole(role: unknown): boolean {
  return FACTORY_PRIVILEGED_ROLES.has(String(role ?? ""));
}

export async function getFactoryAccessState(req: Request): Promise<FactoryAccessState | null> {
  const cached = accessStateCache.get(req);
  if (cached) return cached;

  const pending = (async () => {
    let context;
    try {
      context = await getActiveCompanyPermissionContext(req);
    } catch {
      return null;
    }

    const userId = context.userId;
    const companyId = context.companyId;
    const role = context.role;
    const privileged = isFactoryPrivilegedRole(role);
    if (privileged) {
      return {
        userId,
        companyId,
        role,
        privileged: true,
        fullAccess: true,
        hasErpAccess: true,
        hasFactoryAccess: true,
        pageKeys: [],
        hiddenTabs: [],
      };
    }

    const [[profile], pageRows] = await Promise.all([
      db
        .select({
          hasErpAccess: factoryUserProfiles.hasErpAccess,
          hasFactoryAccess: factoryUserProfiles.hasFactoryAccess,
          hiddenCostFields: factoryUserProfiles.hiddenCostFields,
        })
        .from(factoryUserProfiles)
        .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)))
        .limit(1),
      db
        .select({ pageKey: factoryUserPageAccess.pageKey })
        .from(factoryUserPageAccess)
        .where(and(eq(factoryUserPageAccess.companyId, companyId), eq(factoryUserPageAccess.userId, userId))),
    ]);

    // Keep the backend identical to GET /api/factory/my-access: only Factory
    // keys participate in Factory allow-list authorization. No Factory rows
    // means unrestricted Factory pages; once any Factory row exists the list
    // becomes an allow-list.
    const pageKeys = pageRows.map((row) => row.pageKey).filter((key) => key.startsWith("factory/"));

    return {
      userId,
      companyId,
      role,
      privileged: false,
      fullAccess: pageKeys.length === 0,
      hasErpAccess: profile?.hasErpAccess ?? true,
      hasFactoryAccess: profile?.hasFactoryAccess ?? true,
      pageKeys,
      hiddenTabs: Array.isArray(profile?.hiddenCostFields) ? profile.hiddenCostFields : [],
    };
  })();

  accessStateCache.set(req, pending);
  return pending;
}

function findFactoryPage(pageKey: string) {
  return FACTORY_ACCESS_REGISTRY.find((page) => page.key === pageKey) ?? null;
}

export async function authorizeFactoryPageAccess(req: Request, pageKey: string): Promise<FactoryAccessDecision> {
  const state = await getFactoryAccessState(req);
  if (!state) {
    return {
      allowed: false,
      code: "FACTORY_ACCESS_CONTEXT_MISSING",
      message: "Factory access context is unavailable.",
    };
  }

  const page = findFactoryPage(pageKey);
  if (!page || !factoryPageAllowsRole(page, state.role)) {
    return {
      allowed: false,
      code: "FACTORY_ROLE_ACCESS_DENIED",
      message: "You do not have access to this Factory page.",
      state,
    };
  }

  if (state.privileged) return { allowed: true, state };

  if (!state.hasFactoryAccess) {
    return {
      allowed: false,
      code: "FACTORY_ACCESS_DISABLED",
      message: "Factory access is disabled for this user.",
      state,
    };
  }

  if (!state.fullAccess && !hasFactoryPageKey(page, state.pageKeys)) {
    return {
      allowed: false,
      code: "FACTORY_PAGE_ACCESS_DENIED",
      message: "You do not have access to this Factory page.",
      state,
    };
  }

  return { allowed: true, state };
}

export async function authorizeFactoryTabAccess(
  req: Request,
  pageKey: string,
  tabKey: string
): Promise<FactoryAccessDecision> {
  const pageDecision = await authorizeFactoryPageAccess(req, pageKey);
  if (!pageDecision.allowed) return pageDecision;
  if (pageDecision.state.privileged) return pageDecision;

  if (pageDecision.state.hiddenTabs.includes(tabKey)) {
    return {
      allowed: false,
      code: "FACTORY_TAB_ACCESS_DENIED",
      message: "You do not have access to this Factory tab.",
      state: pageDecision.state,
    };
  }

  return pageDecision;
}

export function sendFactoryAccessDenied(res: Response, decision: Exclude<FactoryAccessDecision, { allowed: true }>) {
  return res.status(403).json({
    message: decision.message,
    code: decision.code,
  });
}

function skipUntilAuthenticated(req: Request): boolean {
  // These guards are commonly mounted before a route's requireAuth middleware.
  // Authentication remains responsible for 401; this layer owns authenticated 403s.
  return !req.session?.userId;
}

export function requireFactoryPageAccess(pageKey: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (skipUntilAuthenticated(req)) return next();
    try {
      const decision = await authorizeFactoryPageAccess(req, pageKey);
      if (!decision.allowed) return sendFactoryAccessDenied(res, decision);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireFactoryTabAccess(pageKey: string, tabKey: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (skipUntilAuthenticated(req)) return next();
    try {
      const decision = await authorizeFactoryTabAccess(req, pageKey, tabKey);
      if (!decision.allowed) return sendFactoryAccessDenied(res, decision);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
