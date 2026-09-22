import type { Database } from "../db";
import type { Express, RequestHandler } from "express";
import { eq, and, or } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";
import { registerFactoryStockRoutes } from "./factory/stock";
import { registerFactorySuppliersRoutes } from "./factory/factorySuppliersRoutes";
import { registerFactoryBilingualCatalogRoutes } from "./factory/factoryBilingualCatalogRoutes";
import { registerFactoryBilingualSnapshotRoutes } from "./factory/factoryBilingualSnapshotRoutes";
import { registerFactoryFrenchTranslationRoutes } from "./factory/factoryFrenchTranslationRoutes";
import { registerFactoryProductsRoutes } from "./factory/products";
import { registerFactoryContainersRoutes } from "./factory/containers";
import { registerFactoryBalesRoutes } from "./factory/bales";
import { registerFactoryCustomersRoutes } from "./factory/customers-core";
import { registerFactoryContainerReadAccessRoutes } from "./factory/factoryContainerReadAccessRoutes";
import { registerFactoryDocsUsersRoutes } from "./factory/docs-users";
import { registerFactoryEmployeesPosRoutes } from "./factory/factoryEmployeesPosRoutes";
import { registerFactoryTransporterRoutes } from "./factory/factoryTransporterRoutes";
import { registerFactoryStockAllocationV2Routes } from "./factory/factoryStockAllocationV2Routes";
import { registerFactoryStockAllocationV5Routes } from "./factory/stock-allocation-v5";
import { registerFactoryShippingContainerRoutes } from "./factory/shipping-containers";
import { registerFactoryDailyScanRoutes } from "./factory/factoryDailyScanRoutes";
import { registerFactoryGroundScanRoutes } from "./factory/factoryGroundScanRoutes";
import { registerFactoryContainerTrackingRoutes } from "./factory/factoryContainerTrackingRoutes";
import { registerEndProductionRoutes } from "./factory/endProductionRoutes";
import { registerProductionPlannerRoutes } from "./factory/factoryProductionPlannerRoutes";
import { registerProductionPositionPlannerRoutes } from "./factory/productionPositionPlannerRoutes";
import { registerFactoryContactRoutes } from "./factory/factoryContactRoutes";
import { registerFactoryStaffTrackingRoutes } from "./factory/factoryStaffTrackingRoutes";
import { registerFactoryProductionWorkerLinkRoutes } from "./factory/factoryProductionWorkerLinkRoutes";
import { registerPerformanceReadMicrocache } from "./performance/readMicrocache";
import { registerFactoryDaybookPaginationRoutes } from "./factory/factoryDaybookPaginationRoutes";
import { registerFactoryStockEntryHistoryPaginationRoutes } from "./factory/factoryStockEntryHistoryPaginationRoutes";
import { registerFactoryStockAllocationV5PaginationRoutes } from "./factory/factoryStockAllocationV5PaginationRoutes";
import { registerCentralFactoryPayrollGenerationRoute } from "./payroll/centralFactoryPayrollGenerationRoute";
import { registerCentralGlobalTransactionRoutes } from "./global/centralGlobalTransactionRoutes";
import { createContainerDocumentDownloadHandler } from "../services/security/protectedAssetDownloadAdapter";
import { enforceCompanyUserRoleScope } from "../middleware/companyUserRoleScope";
import { enforceCompanyResourceScope } from "../middleware/companyResourceScope";
import { enforceDeletedItemCompanyScope } from "../middleware/deletedItemCompanyScope";
import { enforceGlobalTransactionCompanyScope } from "../middleware/globalTransactionCompanyScope";
import { enforceOperationalPermissionScope } from "../middleware/operationalPermissionScope";
import { operationalBandwidthCompactResponse } from "../middleware/operationalBandwidthCompactResponse";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { chooseAuthorizedFactoryCompany } from "../services/security/factoryCompanyScopePolicy";
import { isFactoryCompanyOptionalRoute } from "../services/security/companyResourceRoutePolicy";

function isActiveCompanyAttendanceRequest(req: import("express").Request): boolean {
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

export function registerFactoryRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.use("/api/factory", async (req: import("express").Request, res: import("express").Response, next) => {
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
  });

  app.use(async (req, res, next) => {
    try {
      if (!(await enforceCompanyUserRoleScope(req, res))) return;
      if (!(await enforceCompanyResourceScope(req, res))) return;
      if (!(await enforceDeletedItemCompanyScope(req, res))) return;
      if (!(await enforceGlobalTransactionCompanyScope(req, res))) return;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use(enforceOperationalPermissionScope);
  // Negotiated wire compaction runs after security gates but before the legacy
  // route handlers. It changes only serialized response bytes; route code still
  // sees and produces its existing business objects.
  app.use(operationalBandwidthCompactResponse);
  registerCentralGlobalTransactionRoutes(app, requireAuth);
  registerPerformanceReadMicrocache(app);

  app.use("/api/factory", async (req, res: import("express").Response, next) => {
    if (!["PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (!req.session?.userId) return next();
    if (req.method === "DELETE" && /^\/bales\/\d+$/.test(req.path)) return next();
    if (req.method === "DELETE" && /^\/invoice-loading-sessions\/\d+\/bales\/\d+$/.test(req.path)) return next();
    if (req.method === "DELETE" && /^\/customer-orders\/\d+\/bales\/\d+$/.test(req.path)) return next();
    if (req.method === "DELETE" && /^\/daily-bale-scans\/\d+$/.test(req.path)) return next();
    if (req.method === "DELETE" && /^\/ground-scan-items(\/\d+)?$/.test(req.path)) return next();
    if (req.method === "PATCH" && /^\/bales\/\d+\/assign-worker$/.test(req.path)) return next();
    if (req.method === "PATCH" && req.path === "/bales/bulk-assign-worker") return next();
    if (req.method === "PATCH" && /^\/customer-orders\/\d+\/loading-note$/.test(req.path)) return next();

    try {
      const context = await getActiveCompanyPermissionContext(req);
      if (["Admin", "Owner", "Developer"].includes(context.role)) return next();
      const overrideUntil = req.session?.factoryAdminOverrideUntil;
      if (overrideUntil && Date.now() < overrideUntil) return next();
      return res.status(403).json({
        message: "Admin authorization required for this action.",
        requiresAdminOverride: true,
      });
    } catch (error) {
      if (error instanceof ActiveCompanyPermissionContextError) {
        return res.status(error.status).json({ message: error.message, code: error.code });
      }
      return next(error);
    }
  });

  app.get("/api/factory/uploads/:folder/:filename", requireAuth, createContainerDocumentDownloadHandler(db));

  registerFactoryDaybookPaginationRoutes(app);
  registerFactoryStockEntryHistoryPaginationRoutes(app);
  registerFactoryStockAllocationV5PaginationRoutes(app);
  registerCentralFactoryPayrollGenerationRoute(app, requireAuth);

  registerFactoryStockRoutes(app);
  registerFactorySuppliersRoutes(app);
  registerFactoryBilingualSnapshotRoutes(app);
  registerFactoryBilingualCatalogRoutes(app);
  registerFactoryFrenchTranslationRoutes(app);
  registerFactoryProductsRoutes(app);
  registerFactoryContainerTrackingRoutes(app);
  registerFactoryContainersRoutes(app);
  registerFactoryBalesRoutes(app);
  registerFactoryCustomersRoutes(app);
  registerFactoryContainerReadAccessRoutes(app);
  registerFactoryDocsUsersRoutes(app);
  registerFactoryEmployeesPosRoutes(app);
  registerFactoryTransporterRoutes(app);
  registerFactoryStockAllocationV2Routes(app);
  registerFactoryStockAllocationV5Routes(app);
  registerFactoryShippingContainerRoutes(app);
  registerFactoryDailyScanRoutes(app);
  registerFactoryGroundScanRoutes(app);
  registerEndProductionRoutes(app, requireAuth);
  registerProductionPlannerRoutes(app);
  registerProductionPositionPlannerRoutes(app);
  registerFactoryContactRoutes(app);
  registerFactoryStaffTrackingRoutes(app);
  registerFactoryProductionWorkerLinkRoutes(app);
}
