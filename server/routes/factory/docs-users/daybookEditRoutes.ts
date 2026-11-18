/**
 * factoryDocsUsersRoutes: FactoryDaybookEdit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { registerFactoryDaybookEditRoutesPart1 } from "./registerFactoryDaybookEditRoutesPart1";
import { registerFactoryDaybookEditRoutesPart2 } from "./registerFactoryDaybookEditRoutesPart2";
import { registerFactoryDaybookEditRoutesPart3 } from "./registerFactoryDaybookEditRoutesPart3";
import { registerFactoryDaybookEditRoutesPart4 } from "./registerFactoryDaybookEditRoutesPart4";

export function registerFactoryDaybookEditRoutes(app: Express) {
  registerFactoryDaybookEditRoutesPart1(app);
  registerFactoryDaybookEditRoutesPart2(app);
  registerFactoryDaybookEditRoutesPart3(app);
  registerFactoryDaybookEditRoutesPart4(app);
}
