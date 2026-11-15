import type { Express } from "express";
import { registerFactoryLocationInventoryRoutesPart1 } from "./registerFactoryLocationInventoryRoutesPart1";
import { registerFactoryLocationInventoryRoutesPart2 } from "./registerFactoryLocationInventoryRoutesPart2";

export function registerFactoryLocationInventoryRoutes(app: Express) {
  registerFactoryLocationInventoryRoutesPart1(app);
  registerFactoryLocationInventoryRoutesPart2(app);
}
