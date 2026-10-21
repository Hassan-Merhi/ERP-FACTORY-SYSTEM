import type { Express } from "express";
import { RENTAL_MODULE_ACCOUNTS } from "../services/accounting/unifiedAccountingFoundation";
import { registerRentalRoutes } from "./rentalRouteFactory";

export function registerPropertiesRentalRoutes(app: Express) {
  const { income, expense } = RENTAL_MODULE_ACCOUNTS.PROPERTIES;
  registerRentalRoutes(app, "PROPERTIES", "/api/properties/rental", income, expense);
}
