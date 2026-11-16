import type { Express, RequestHandler } from "express";

import { registerLazyRouteModule } from "./lazyRouteRegistrar";

export const phase4LazyRoutes = {
  supplierProfitCheck: (app: Express, requireAuth: RequestHandler) =>
    registerLazyRouteModule(app, {
      prefixes: ["/api/supplier-profit-check"],
      load: async () => {
        const { registerSupplierProfitCheckRoutes } = await import("./supplier-profit-check");
        return (lazyApp: Express) => registerSupplierProfitCheckRoutes(lazyApp, requireAuth);
      },
    }),
  git: (app: Express) =>
    registerLazyRouteModule(app, {
      prefixes: ["/api/git"],
      load: async () => (await import("./git")).registerGitRoutes,
    }),
  containerTracking: (app: Express) =>
    registerLazyRouteModule(app, {
      prefixes: ["/api/container-tracking"],
      load: async () => (await import("./containerTrackingRoutes")).registerContainerTrackingRoutes,
    }),
};
