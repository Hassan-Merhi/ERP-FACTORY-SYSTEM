import type { NextFunction, Request, Response } from "express";
import {
  authorizeFactoryPageAccess,
  sendFactoryAccessDenied,
  type FactoryAccessDecision,
} from "../lib/factoryAccessControl";
import { isFactoryAccessBoundaryExempt, type FactoryApiAccessRequirement } from "./factoryBackendAccessBoundaryRules";

export type { FactoryApiAccessRequirement } from "./factoryBackendAccessBoundaryRules";

import { resolvePrimaryRequirement } from "./factoryBackendAccessRequirementPrimary";
import { resolveSecondaryRequirement } from "./factoryBackendAccessRequirementSecondary";

/**
 * Resolve Factory API calls to the page/tab that owns them.
 *
 * Order is deliberate: narrow action/detail rules appear before broad parents,
 * so a child API cannot escape the permission of the UI surface that owns it.
 */
export function resolveFactoryBackendAccessRequirement(req: Request): FactoryApiAccessRequirement | null {
  // Normalize from originalUrl so ownership matching is stable whether Express
  // invokes this as mounted middleware or as a direct handler.
  const requestPath = req.originalUrl.split("?", 1)[0] || req.path;
  const path =
    requestPath === "/api/factory"
      ? "/"
      : requestPath.startsWith("/api/factory/")
        ? requestPath.slice("/api/factory".length)
        : req.path;

  // Explicit shared/bootstrap exceptions are handled fail-open here; every
  // other Factory route must resolve to an owner or the middleware denies it.
  if (isFactoryAccessBoundaryExempt(req, path)) return null;

  return resolvePrimaryRequirement(req, path) ?? resolveSecondaryRequirement(req, path);
}

function tabDeniedDecision(message: string): Exclude<FactoryAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    code: "FACTORY_TAB_ACCESS_DENIED",
    message,
  };
}

async function evaluateFactoryRequirement(
  req: Request,
  rule: FactoryApiAccessRequirement
): Promise<FactoryAccessDecision> {
  if (rule.alternatives?.length) {
    let firstDenied: Exclude<FactoryAccessDecision, { allowed: true }> | null = null;
    for (const alternative of rule.alternatives) {
      const decision = await evaluateFactoryRequirement(req, alternative);
      if (decision.allowed) return decision;
      firstDenied ??= decision;
      if (decision.code === "FACTORY_ACCESS_DISABLED") return decision;
    }
    return firstDenied ?? tabDeniedDecision("You do not have access to a Factory page that permits this action.");
  }

  if (!rule.pageKey) {
    return {
      allowed: false,
      code: "FACTORY_PAGE_ACCESS_DENIED",
      message: "No Factory page owns this protected action.",
    };
  }

  const pageDecision = await authorizeFactoryPageAccess(req, rule.pageKey);
  if (!pageDecision.allowed) return pageDecision;
  if (pageDecision.state.privileged) return pageDecision;

  const hidden = new Set(pageDecision.state.hiddenTabs);
  if (rule.tabs?.some((tab) => hidden.has(tab))) {
    return tabDeniedDecision("You do not have access to the Factory tab required for this action.");
  }

  if (
    rule.tabAlternatives?.length &&
    !rule.tabAlternatives.some((alternative) => alternative.every((tab) => !hidden.has(tab)))
  ) {
    return tabDeniedDecision("You do not have access to any Factory tab that permits this action.");
  }

  return pageDecision;
}

export async function enforceFactoryBackendAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return next();

  try {
    const rule = resolveFactoryBackendAccessRequirement(req);
    if (!rule) {
      const requestPath = req.originalUrl.split("?", 1)[0] || req.path;
      const path =
        requestPath === "/api/factory"
          ? "/"
          : requestPath.startsWith("/api/factory/")
            ? requestPath.slice("/api/factory".length)
            : req.path;
      if (isFactoryAccessBoundaryExempt(req, path)) return next();
      return res.status(403).json({
        message: "This Factory API has no declared page permission owner.",
        code: "FACTORY_PAGE_ACCESS_DENIED",
      });
    }

    const decision = await evaluateFactoryRequirement(req, rule);
    if (!decision.allowed) return sendFactoryAccessDenied(res, decision);
    return next();
  } catch (error) {
    return next(error);
  }
}
