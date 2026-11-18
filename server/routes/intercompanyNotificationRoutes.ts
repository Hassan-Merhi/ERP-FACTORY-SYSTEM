import type { Express } from "express";
import { registerIntercompanyNotificationRoutesPart1 } from "./triggerIntercompanyNotifications";
import { registerIntercompanyNotificationRoutesPart2 } from "./registerIntercompanyNotificationRoutesPart2";
export { triggerIntercompanyNotifications } from "./triggerIntercompanyNotifications";

export function registerIntercompanyNotificationRoutes(app: Express) {
  registerIntercompanyNotificationRoutesPart1(app);
  registerIntercompanyNotificationRoutesPart2(app);
}
