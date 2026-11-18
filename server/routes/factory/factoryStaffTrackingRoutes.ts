import type { Express } from "express";
import { registerFactoryStaffTrackingRoutesPart1 } from "./registerFactoryStaffTrackingRoutesPart1";
import { registerFactoryStaffTrackingRoutesPart2 } from "./registerFactoryStaffTrackingRoutesPart2";
import { registerFactoryStaffTrackingRoutesPart3 } from "./registerFactoryStaffTrackingRoutesPart3";

export function registerFactoryStaffTrackingRoutes(app: Express): void {
  registerFactoryStaffTrackingRoutesPart1(app);
  registerFactoryStaffTrackingRoutesPart2(app);
  registerFactoryStaffTrackingRoutesPart3(app);
}
