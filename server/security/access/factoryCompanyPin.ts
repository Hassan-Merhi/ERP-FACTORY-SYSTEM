/**
 * Pins the Factory company for /api/factory requests.
 *
 * Factory screens run against the server-pinned Factory company rather than
 * the ERP company selected in another tab. This resolver chooses that company
 * from the caller's own Factory memberships, or refuses the request when the
 * caller has none. The access boundary runs it as the `factory-company-pin`
 * policy with the request path relative to /api/factory.
 */
import type { NextFunction, Request, Response } from "express";
import { and, eq, or } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";

import { db } from "../../db";
import { chooseAuthorizedFactoryCompany } from "../../services/security/factoryCompanyScopePolicy";
import { isFactoryCompanyOptionalRoute } from "../../services/security/companyResourceRoutePolicy";

function isActiveCompanyAttendanceRequest(req: Request): boolean {
  const method = req.method.toUpperCase();
  const path = req.path;

  if (method === "GET" && path === "/staff-tracking" && String(req.query.page || "") === "attendance") {
    return true;
  }
  if (method === "POST" && path === "/staff-tracking/bulk" && req.body?.page === "attendance") {
    return true;
  }
  if ((method === "GET" || method === "PUT") && path === "/settings" && req.query.scope === "attendance") {
    return true;
  }
  if (
    method === "POST" &&
    path === "/send-mix-batch-image-whatsapp" &&
    (req.body?.destination === "attendance" || req.body?.recipient === "attendance")
  ) {
    return true;
  }

  return false;
}

export async function pinFactoryCompany(req: Request, res: Response, next: NextFunction) {
  try {
    const session = req.session;
    if (!session?.userId) return next();
    if (isFactoryCompanyOptionalRoute(req.path)) return next();

    // Attendance belongs to the company the user is actively viewing, even
    // when that company is not typed as a dedicated Factory company. Do not
    // let an older pinned factory company leak into Attendance Register reads,
    // saves, image sends, or its dedicated WhatsApp setting.
    if (isActiveCompanyAttendanceRequest(req)) {
      delete session.factoryCompanyId;
      return next();
    }

    const assignedFactories = await db
      .select({ id: companies.id, companyType: companies.companyType, active: companies.active })
      .from(userCompanyRoles)
      .innerJoin(companies, eq(companies.id, userCompanyRoles.companyId))
      .where(
        and(
          eq(userCompanyRoles.userId, session.userId),
          eq(companies.active, true),
          or(eq(companies.companyType, "factory"), eq(companies.companyType, "factory_v2"))
        )
      )
      .orderBy(companies.id);

    let currentCompany = assignedFactories.find((company) => company.id === session.currentCompanyId) ?? null;
    if (!currentCompany && session.currentRole === "Developer" && session.currentCompanyId) {
      const [developerCurrent] = await db
        .select({ id: companies.id, companyType: companies.companyType, active: companies.active })
        .from(companies)
        .where(eq(companies.id, session.currentCompanyId))
        .limit(1);
      if (
        developerCurrent?.active &&
        (developerCurrent.companyType === "factory" || developerCurrent.companyType === "factory_v2")
      ) {
        currentCompany = developerCurrent;
        assignedFactories.unshift(developerCurrent);
      }
    }

    const factoryCompanyId = chooseAuthorizedFactoryCompany({
      pinnedFactoryId: session.factoryCompanyId,
      currentCompany,
      assignedFactoryIds: assignedFactories.map((company) => company.id),
    });

    if (!factoryCompanyId) {
      delete session.factoryCompanyId;
      return res.status(403).json({
        message: "You do not have access to a Factory company.",
        code: "FACTORY_COMPANY_ACCESS_REQUIRED",
      });
    }

    session.factoryCompanyId = factoryCompanyId;
    return next();
  } catch (error) {
    return next(error);
  }
}
